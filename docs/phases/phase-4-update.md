# Phase 4 — `update [<skill>...]` + `update --continue <skill>` + SSOT store

## Mission

Two pieces, landed together in this order:

1. **SSOT store** — extract the read/write functions from `src/core/manifest.ts` and `src/core/state.ts` behind a single `SsotStore` class (`src/core/ssot.ts`) that owns serialization, versioning, and atomic flushing. Migrate every existing caller (`init`, `adopt`, `add`, `adoption`, `adopt-scan`). No user-visible change. This phase is the heaviest lockfile consumer — `update` benefits most from the deeper interface, and landing the store first means `runUpdate` is built against the abstraction rather than retrofit into it. Mirrors how Phase 2 bundled the adoption planner before `add`.

2. **`update`** — implement the full update flow described in [AGENTS.md](../../AGENTS.md) "Update flow". This is the verb that *demonstrates* the project's headline differentiator — survivable customizations across upstream changes. The update flow has two paths: a clean apply (most common) and a conflict path that pauses for the user to resolve manually, then resumes via `--continue`. Both must leave the live skill in a working state at all times.

## Project orientation (read first)

1. [AGENTS.md](../../AGENTS.md) — re-read **Update flow** section in full. The numbered steps there are your spec.
2. [docs/adr/](../adr/) — at minimum [0001](../adr/0001-ssot-and-symlinks.md) (SSOT layout), [0002](../adr/0002-customize-in-place-with-patches.md) (patch lifecycle), [0003](../adr/0003-no-runtime-deps.md) (no deps). Load-bearing for both halves of this phase.
3. [README.md](../../README.md) — section "Updating" — user-facing contract.
4. [src/core/patch.ts](../../src/core/patch.ts) — Phase 1's helpers. You'll call `savePatch` and `applyPatch3Way` directly.
5. [src/core/skills-cli.ts](../../src/core/skills-cli.ts) — Phase 2's `resolveSource`. You'll re-call it during update to fetch the latest ref.
6. [src/core/linker.ts](../../src/core/linker.ts) — Phase 1.5's symlink seam. The swap may need to refresh symlinks; verify whether or not it does and act accordingly.
7. [src/core/adoption.ts](../../src/core/adoption.ts) — Phase 2's planner. Pattern reference; `update`'s logic is mostly linear so the planner pattern probably doesn't apply, but read so you know the option exists.
8. [src/core/manifest.ts](../../src/core/manifest.ts), [src/core/state.ts](../../src/core/state.ts), [src/core/paths.ts](../../src/core/paths.ts) — current SSOT primitives. You'll be replacing the read/write functions in `manifest.ts` and `state.ts` with the new `SsotStore`.
9. [src/commands/init.ts](../../src/commands/init.ts), [src/commands/adopt.ts](../../src/commands/adopt.ts), [src/commands/add.ts](../../src/commands/add.ts), [src/core/adopt-scan.ts](../../src/core/adopt-scan.ts) — every existing caller of `readManifest` / `writeManifest` / `readLockfile` / `writeLockfile` / `readState` / `writeState`. You'll migrate them all.
10. [tests/init.test.js](../../tests/init.test.js), [tests/add.test.js](../../tests/add.test.js) — test patterns.

**Confirm Phases 1, 2, and 3 are merged before starting.** This phase replaces the file-I/O exports of `manifest.ts` / `state.ts`; starting before Phase 3 lands will conflict.

## Deliverables

Sequence matters: SSOT store first (extract + refactor existing callers), confirmed green by running the existing test suite, then staging convention, then `runUpdate`. The existing tests are the safety net for the migration — if they don't pass after step 2, the refactor is wrong and `runUpdate` cannot start.

### 1. SSOT store: new module `src/core/ssot.ts`

Extract the read/write functions from `src/core/manifest.ts` and `src/core/state.ts` behind a single class that owns serialization, versioning, and atomic flushing. Callers stop seeing file paths, JSON shapes, and `version: 1` checks.

Exports — exactly these, no others:

```ts
import type {
  ContribSource,
  SkillEntry,
  Manifest,
  Lockfile,
  LockedSkill,
} from "./manifest.js";
import type { DetectedToolRecord, State } from "./state.js";

export class SsotStore {
  static openAt(rootPath: string): SsotStore;

  // Skills (manifest)
  skill(name: string): SkillEntry | undefined;
  skillNames(): string[];
  recordAuthoredSkill(name: string): void;
  recordContribSkill(name: string, source: ContribSource): void;
  removeSkill(name: string): void;
  setCustomized(name: string, customized: boolean): void;

  // Lockfile
  resolvedRef(name: string): string | undefined;
  pinResolvedRef(name: string, ref: string, atIso?: string): void;
  clearLock(name: string): void;

  // State
  tools(): DetectedToolRecord[];
  recordToolDetection(records: DetectedToolRecord[], nowIso?: string): void;
  lastDetectedAt(): string | undefined;

  // Flush
  commit(): void;
  dirty(): boolean;
}
```

Required behavior:

- **`openAt(rootPath)`** — read `<root>/skills.json`, `<root>/skills.lock.json`, `<root>/state.json`. Missing files default to empty `version: 1` shapes. Files with `version !== 1` throw the same error today's modules throw (no migration registry yet — see [ADR-0003](../adr/0003-no-runtime-deps.md) discipline; revisit only when v2 actually arrives).
- **All `record*` / `pin*` / `clear*` / `setCustomized` methods** — mutate in-memory state only; mark the corresponding file as dirty. Idempotent: recording an already-recorded skill with the same value is a no-op (does not flip the dirty bit).
- **`commit()`** — for each dirty file, write atomically: `writeFileSync(<path>.tmp, json)` then `renameSync(<path>.tmp, <path>)`. After commit, no files are dirty. A commit with nothing dirty performs zero I/O.
- **`dirty()`** — true if any file has unflushed changes. Useful for tests and for assertions in command code.
- **Read methods** — return `undefined` for missing entries. Read methods do not flip the dirty bit.
- **`pinResolvedRef`** — defaults `atIso` to `new Date().toISOString()` when not provided. Same for `recordToolDetection`'s `nowIso`. Injection points exist for testability.
- **The store does not own the SSOT directory layout.** `ensureRootLayout` stays in `paths.ts`. The store assumes the root exists; if files are missing it treats them as empty, but the directory itself must exist.

### 2. Refactor existing callers to use the store

Migrate every caller of `readManifest` / `writeManifest` / `readLockfile` / `writeLockfile` / `readState` / `writeState`:

- [src/commands/init.ts](../../src/commands/init.ts)
- [src/commands/adopt.ts](../../src/commands/adopt.ts)
- [src/commands/add.ts](../../src/commands/add.ts)
- [src/core/adoption.ts](../../src/core/adoption.ts) (planner / executor, wherever it touches manifest)
- [src/core/adopt-scan.ts](../../src/core/adopt-scan.ts)

Pattern: at command entry, `const store = SsotStore.openAt(rootPath)`. Replace direct file I/O with method calls. Call `store.commit()` at command exit (or per-skill in `update`). For read-only commands and the planner's read-only paths, just don't call `commit()`.

Drop the `readManifest` / `writeManifest` / `readLockfile` / `writeLockfile` exports from [src/core/manifest.ts](../../src/core/manifest.ts) and `readState` / `writeState` from [src/core/state.ts](../../src/core/state.ts). **Keep** the type exports (`Manifest`, `SkillEntry`, `ContribSource`, `Lockfile`, `LockedSkill`, `State`, `DetectedToolRecord`) — they're domain vocabulary used by the store and its consumers. The two files become pure type files.

The existing test suite (`tests/init.test.js`, `tests/adopt.test.js`, `tests/add.test.js`, `tests/adoption.test.js`, `tests/linker.test.js`, `tests/patch.test.js`) must continue to pass without modification. Run `pnpm test` after the refactor and before any update work begins; if tests fail, the migration is wrong.

### 3. Staging area convention

Use `<root>/.cache/staging/<skill>/` as the staging directory. A pending update is "live" iff this directory exists and contains a sentinel file (e.g. `.staging-meta.json`) with the resolved-ref it staged from. Define the sentinel format up-front; it's how `--continue` knows which skill is mid-update and what ref to commit back to the lockfile on success.

```jsonc
// .cache/staging/<skill>/.staging-meta.json
{
  "version": 1,
  "skillName": "<name>",
  "ref": "<resolved-ref>",
  "previousRef": "<old-ref-from-lockfile>",
  "startedAt": "<iso>"
}
```

The sentinel must be excluded from the swap into `skills/<skill>/`.

### 4. Implement `runUpdate()` in `src/commands/update.ts`

Replace the stub. Argument shape from `src/cli.ts`: `{ skills: string[], cont: boolean, flags }`.

#### `--continue <skill>` path

1. Require exactly one positional skill name. If `args.skills.length !== 1` → `error: --continue requires one skill name`, exit 1.
2. Verify `<root>/.cache/staging/<skill>/` exists with a valid `.staging-meta.json`. If not → `error: no paused update for <skill>`, exit 1.
3. Verify there are no remaining `<<<<<<<` markers anywhere in the staging tree. Walk and grep. If any are found → `error: <file> still has merge markers; finish resolving or delete .cache/staging/<skill>/ to abort`, exit 1.
4. Run the **swap** (defined below) using the staged tree and the staged ref. Remove `.cache/staging/<skill>/` after success.
5. Print `<skill>: update completed (<previousRef> → <newRef>)`, exit 0.

#### Default path (`update [<skill>...]`)

1. Resolve root, read manifest + lockfile. If not initialized → exit 1.
2. Compute the working set: if `args.skills` is non-empty, use it (validate each name exists and is `kind: "contrib"` — error and exit 1 if any aren't). Otherwise use every contrib skill in the manifest. Authored skills are always skipped silently.
3. For each skill in the working set, run the **per-skill update** flow below. Continue past per-skill errors (one bad skill shouldn't block the rest). Track outcome counts.
4. Print a final summary: `<n> updated, <m> paused on conflict, <k> failed, <s> skipped`. Exit 0 if no failures, 1 if any errored, but a "paused on conflict" is *not* an error — that's exit 0 (the user is expected to resolve and `--continue`).

#### Per-skill update flow

Mirrors AGENTS.md "Update flow" exactly:

1. **Save current patch** — call `savePatch(rootPath, name)` first thing. Captures uncommitted drift before we touch anything else. If this throws (missing pristine, etc.), record this skill as failed and continue.
2. **Refuse if a stale staging dir exists.** If `<root>/.cache/staging/<skill>/` already exists, this skill has a paused update — `error: <skill> has a pending update; resolve and run \`update --continue <skill>\` or delete .cache/staging/<skill>/`. Record as failed; continue.
3. **Re-resolve source.** Read `manifest.skills[<skill>].source` and call `resolveSource(<source-string-rebuilt-from-source-object>, rootPath)` to fetch the latest ref. Note: `resolveSource` from Phase 2 takes a string. You may need to add a sibling `resolveSourceFromManifest(source: ContribSource, rootPath)` to avoid round-tripping through the string form. If you do, update Phase 2's tests if needed (or add a new test).
4. **Short-circuit no-op.** If the resolved ref equals the lockfile's `resolvedRef` *and* the existing patch is empty (or absent), record `<skill>: already up to date` and continue. Skip the rest.
5. **Build staging tree.** Copy the resolved pristine into `<root>/.cache/staging/<skill>/`. Write the `.staging-meta.json` sentinel.
6. **Pre-stage the old pristine blobs into the staging repo.** Before calling `applyPatch3Way`, you must seed the staging dir's git object store with the *old* pristine's blobs — otherwise `git apply --3way` cannot locate the patch's pre-image and silently falls back to direct apply (no conflict markers, just hard-failure on divergence). The pattern: with the staging tree currently holding the *old* pristine's contents (from `.cache/pristine/<name>@<oldRef>/`), run `git init -q` + `git add -A` + `git commit -q -m pristine` inside `<stagingDir>`. Then overwrite the working tree with the *new* pristine's contents (the resolved upstream from step 5). The earlier commit's blobs remain in `.git/objects/`, and `applyPatch3Way`'s own `git init`+commit sequence is idempotent and preserves them. Phase 1's helper deliberately does not take a base-dir parameter; this two-step staging dance is the contract on the caller side.
7. **Apply patch.** Call `applyPatch3Way(stagingDir, patchPath)`.
8. **Clean apply** → run the **swap** (below). Print `<skill>: updated (<oldRef> → <newRef>)`. Continue.
9. **Conflict** → leave the staging tree on disk with markers, leave the live skill untouched, leave the lockfile untouched. Print `<skill>: conflict — resolve in <stagingDir> and run \`update --continue <skill>\`. Conflicted files: <list>`. Record as paused; continue.

#### The swap operation

A self-contained helper that promotes a successful staging tree to live. Steps:

1. Remove the sentinel file from the staging tree (it's metadata, not part of the skill).
2. Atomic-ish swap:
   - Move `<root>/skills/<skill>/` to `<root>/.cache/oldlive-<skill>-<timestamp>/`.
   - Move `<root>/.cache/staging/<skill>/` to `<root>/skills/<skill>/`.
   - Delete `<root>/.cache/oldlive-<skill>-<timestamp>/`.
3. Replace pristine cache: delete `.cache/pristine/<skill>@<oldRef>/`, copy the new resolved pristine into `.cache/pristine/<skill>@<newRef>/`. (You already have the new pristine on disk from the resolve step in this flow; reuse it rather than re-resolving.)
4. Update `skills.lock.json` `resolvedRef` and `resolvedAt`.
5. Tool symlinks: if symlinks point at `<root>/skills/<skill>/`, the move-rename should leave them valid (the directory at the link target is gone briefly during step 2, then back). Verify with a test. If they break, refresh them by reusing the linker helper from Phase 2.

If the swap fails partway, the `oldlive-*` directory holds the previous state and the user can recover manually. Print a recovery hint on swap failure.

### 5. New tests

Two test files. The existing test suite must continue to pass without modification — it's the safety net for the SSOT migration.

#### `tests/ssot.test.js` (store unit tests)

Pattern: `node:test`, `node:assert/strict`, `mkdtempSync` for tmp roots. Imports from `../dist/core/ssot.js`. No fake `$HOME` needed — tests work directly against tmp directories.

Cover at least:

1. **`openAt` with missing files.** Empty tmp root (with the SSOT subdirs created via `ensureRootLayout`). `openAt` succeeds. `skill("anything")` returns `undefined`; `skillNames()` is `[]`; `tools()` is `[]`; `dirty()` is `false`.
2. **Record + commit + reopen round-trips.** Record an authored skill, pin a lock ref, record tool detection. `commit()`. Open a second `SsotStore` against the same root. Same data is returned. `dirty()` is `false`.
3. **`commit` writes only dirty files.** Pre-write `skills.json` manually. Capture its `mtime`. Open store, mutate only the lockfile, `commit()`. `skills.json`'s `mtime` is unchanged; `skills.lock.json` was rewritten.
4. **Atomic write.** After `commit()`, no `<path>.tmp` files remain in the root. (Implementation must use `<path>.tmp` + `rename`.)
5. **Dirty tracking.** `dirty()` is `false` after `openAt`, `true` after a meaningful mutation, `false` after `commit()`. Re-recording the same skill with the same value does not flip dirty.
6. **Version mismatch throws.** Pre-write `skills.json` with `version: 2`. `openAt` throws.
7. **Read-only path is filesystem-clean.** Open, call read methods only, `commit()`. No file writes (verify via `mtime` comparison or by leaving the root empty and confirming nothing was created).

#### `tests/update.test.js` (integration)

Tests use local-path sources so we can deterministically simulate "upstream changed." Pattern: build pristine tree v1 in `/tmp/fixture-v1`, `runAdd` it. Then build `/tmp/fixture-v2` (same tree with one line changed in `SKILL.md`), point the manifest's source at it (or rebuild the fixture in place — local-path `add` re-resolves from path), and `runUpdate`.

Cover:

1. **No-op update.** Add, then update with no changes upstream and no local drift → `already up to date`, lockfile unchanged.
2. **Clean update.** Add v1, change live to add a line at the bottom (drift). Bump fixture to v2 (different line at the top). `update <name>` → both changes present in live skill, lockfile updated, patch reapplied.
3. **Conflict update.** Add v1, change line 5 of live. Bump fixture so line 5 is also changed differently. `update <name>` → returns "paused on conflict", live skill is unchanged, staging dir exists with merge markers, lockfile unchanged.
4. **Continue after conflict.** From the previous test's setup: manually edit the staging file to remove markers, then `runUpdate({ skills: [name], cont: true, flags: {} })` → live updated, staging dir gone, lockfile updated.
5. **`--continue` with markers still present** → exit 1, helpful message.
6. **`--continue` for a skill with no staging dir** → exit 1.
7. **Update with paused dir present (no `--continue`)** → exit 1, refuses to clobber.
8. **Update of authored skill is silently skipped.**
9. **Symlinks survive the swap.** After clean update, the link in `<fakeHome>/.claude/skills/<name>` still resolves to the live skill dir and reads the post-update content.

## Code review (mandatory)

This is the most failure-prone phase. Do all of the following:

**SSOT store and migration:**

A. **Store purity at boundaries.** After the migration, no caller outside `src/core/ssot.ts` should call `readManifest` / `writeManifest` / `readLockfile` / `writeLockfile` / `readState` / `writeState`. Run `grep -rn "readManifest\|writeManifest\|readLockfile\|writeLockfile\|readState\|writeState" src/` — the only matches should be the store itself (or zero matches if you renamed/inlined). Type imports (`import type { Manifest } from ...`) are fine.
B. **Atomic write actually happens.** `commit()` must write to `<path>.tmp` and `rename` into place. A direct `writeFileSync(path, ...)` is not atomic and a crash mid-write corrupts the file. Test 4 catches the residue case but not the order — read the implementation.
C. **Dirty-bit honesty.** Re-recording a skill with the same value should not flip dirty. Test 5 covers it; verify the implementation actually compares before mutating, rather than blindly assigning.
D. **Existing tests pass before update work begins.** Land the SSOT migration as a discrete commit (or staged step). Run `pnpm test`. If anything fails, the migration is wrong — do not start `runUpdate` until green.

**Update flow:**

1. **Live skill never broken.** Trace every error path. The live skill at `<root>/skills/<skill>/` must be either the pre-update state or the post-swap state. There is no in-between state where the directory is half-replaced or missing. Convince yourself by reading.
2. **Staging-dir state machine.** Three observable states: absent (no pending update), present-with-clean-tree (after `applyPatch3Way` clean → just before swap; should be transient), present-with-conflict-markers (paused). Confirm `--continue` rejects the third state.
3. **Sentinel exclusion.** Does the swap exclude `.staging-meta.json` from the live tree? If you forgot, the user's live skill ends up with a meta file in it. Verify with a test or assertion.
4. **Lockfile updated only on success.** A failed/paused update must not touch `skills.lock.json`. Tests 3 and 7 should fail loudly if this regresses.
5. **Old pristine cleanup.** Did you delete `.cache/pristine/<name>@<oldRef>/` after the swap? If not, pristines accumulate. Acceptable to keep them (it's content-addressed cache), but if you do, document it. Decide and stick with one policy.
6. **Concurrent updates.** Two `update` calls at once → undefined. That's fine. Don't add locking. But mention in a one-line comment that the staging dir's existence is the only mutex.
7. **Workspace mode.** Does `runUpdate` resolve via `resolveRoot()` (so it honors `<cwd>/.skills-manager/`)? Verify.
8. **Patch reapply correctness.** When local drift conflicts with upstream, the user resolves *in staging*, then `--continue` swaps. Importantly: after the swap, future `save-patch` should produce the *new* patch (drift vs new pristine), not the old one. Trace this — the new pristine is in `.cache/pristine/<name>@<newRef>/` and `savePatch` reads the lockfile's `resolvedRef`. So this works as long as the lockfile is updated *before* the next `save-patch` call. Confirm.

## Verification

```bash
pnpm build
pnpm test
```

Manual smoke (optional, recommended):
```bash
HOME=$(mktemp -d)
mkdir -p /tmp/skill-v1 && cat > /tmp/skill-v1/SKILL.md <<'EOF'
---
name: smoke
description: v1
---
line one
line two
line three
EOF
node bin/skills-manager.js init
node bin/skills-manager.js add /tmp/skill-v1

# Add local drift
echo "extra" >> $HOME/.skills-manager/skills/smoke/SKILL.md

# Bump fixture
sed -i 's/line one/LINE ONE UPSTREAM/' /tmp/skill-v1/SKILL.md
node bin/skills-manager.js update smoke
cat $HOME/.skills-manager/skills/smoke/SKILL.md   # should have both changes

# Now force a conflict
echo "drift again" >> $HOME/.skills-manager/skills/smoke/SKILL.md
node bin/skills-manager.js save-patch smoke
sed -i 's/extra/upstream-collide/' /tmp/skill-v1/SKILL.md   # collide with the saved patch
node bin/skills-manager.js update smoke   # paused
ls $HOME/.skills-manager/.cache/staging/
# resolve markers manually, then:
node bin/skills-manager.js update --continue smoke
```

## What's out of scope

- `--source <name>` filtering — explicitly deferred per AGENTS.md.
- Updating multiple skills concurrently — sequential is fine.
- Editing `ROADMAP.md`.

## Done criteria

- `src/core/ssot.ts` exists with the listed exports; `commit()` is atomic; `dirty()` tracks honestly.
- All existing callers migrated; no `readManifest` / `writeManifest` / `readLockfile` / `writeLockfile` / `readState` / `writeState` calls remain outside the store.
- `src/core/manifest.ts` and `src/core/state.ts` retain only type exports; their read/write functions are gone.
- `tests/ssot.test.js` covers the seven listed cases and passes.
- All existing tests (`tests/init.test.js`, `tests/adopt.test.js`, `tests/add.test.js`, `tests/adoption.test.js`, `tests/linker.test.js`, `tests/patch.test.js`) pass without modification.
- `src/commands/update.ts` no longer throws `NotImplementedError`.
- Both default and `--continue` paths work.
- `tests/update.test.js` covers the nine listed cases and passes.
- `pnpm build` and `pnpm test` green.
- Self-review pass completed.
