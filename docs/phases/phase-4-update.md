# Phase 4 — `update [<skill>...]` + `update --continue <skill>`

## Mission

Implement the full update flow described in [AGENTS.md](../../AGENTS.md) "Update flow". This is the verb that *demonstrates* the project's headline differentiator — survivable customizations across upstream changes.

The update flow has two paths: a clean apply (most common) and a conflict path that pauses for the user to resolve manually, then resumes via `--continue`. Both must leave the live skill in a working state at all times.

## Project orientation (read first)

1. [AGENTS.md](../../AGENTS.md) — re-read **Update flow** section in full. The numbered steps there are your spec.
2. [README.md](../../README.md) — section "Updating" — user-facing contract.
3. [src/core/patch.ts](../../src/core/patch.ts) — Phase 1's helpers. You'll call `savePatch` and `applyPatch3Way` directly.
4. [src/core/skills-cli.ts](../../src/core/skills-cli.ts) — Phase 2's `resolveSource`. You'll re-call it during update to fetch the latest ref.
5. [src/commands/add.ts](../../src/commands/add.ts) — Phase 2. The linker helper extracted there should be reused at update-time too (a swap may need to refresh symlinks; verify whether or not it does and act accordingly).
6. [src/core/manifest.ts](../../src/core/manifest.ts), [src/core/paths.ts](../../src/core/paths.ts) — primitives.
7. [tests/init.test.js](../../tests/init.test.js), [tests/add.test.js](../../tests/add.test.js) — test patterns.

**Confirm Phases 1, 2, and 3 are merged before starting.**

## Deliverables

### 1. Staging area convention

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

### 2. Implement `runUpdate()` in `src/commands/update.ts`

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

### 3. New tests: `tests/update.test.js`

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

- `src/commands/update.ts` no longer throws `NotImplementedError`.
- Both default and `--continue` paths work.
- `tests/update.test.js` covers the nine listed cases and passes.
- `pnpm build` and `pnpm test` green.
- Self-review pass completed.
