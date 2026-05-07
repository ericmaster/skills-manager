# Phase 2 — `add <source>` + source resolution + adoption planner

## Mission

Three pieces, landed together in this order:

1. **Adoption planner refactor** — extract the winner/loser/split decision logic from `runAdopt` into a pure module (`src/core/adoption.ts`) with planner / executor / formatter functions. Crystallizes the plan/execute/format pattern that future commands with branching decisions (`update` in Phase 4, `remove` in Phase 5) will reuse. No user-visible change.
2. **Source resolution** — replace the throwing stub at `src/core/skills-cli.ts` with a real `resolveSource()` that handles the three source types in the spec.
3. **`add <source>`** — implement `runAdd()` end-to-end so a user can install a contrib skill into the SSOT and have it linked into every native-`SKILL.md` tool.

The adoption refactor lands first to establish the pattern. `runAdd` itself is implemented imperatively — its logic is linear (resolve → reject duplicate → copy → manifest → link → print) with no plan-shaped branching. Don't force the planner pattern where it doesn't fit; revisit only if a future feature pushes `add` into plan-shaped territory.

This is the first user-visible verb beyond `init` / `adopt`. After this phase, `add` followed by `list` (Phase 5) gives a complete install flow even before `update` lands.

## Project orientation (read first)

Read in order:

1. [AGENTS.md](../../AGENTS.md) — full re-read. **Source resolution**, **Directory layout**, **Tool detection**, **Adoption**.
2. [docs/adr/0001-ssot-and-symlinks.md](../adr/0001-ssot-and-symlinks.md), [docs/adr/0004-wrap-vercel-labs-skills.md](../adr/0004-wrap-vercel-labs-skills.md), [docs/adr/0008-adopt-as-authored-only.md](../adr/0008-adopt-as-authored-only.md) — load-bearing decisions for both halves of this phase.
3. [README.md](../../README.md) — section "Sources" describes the three accepted inputs from a user POV.
4. [src/core/paths.ts](../../src/core/paths.ts), [src/core/manifest.ts](../../src/core/manifest.ts), [src/core/state.ts](../../src/core/state.ts), [src/core/tool-detect.ts](../../src/core/tool-detect.ts), [src/core/linker.ts](../../src/core/linker.ts), [src/core/adopt-scan.ts](../../src/core/adopt-scan.ts) — primitives you'll compose.
5. [src/commands/init.ts](../../src/commands/init.ts), [src/commands/adopt.ts](../../src/commands/adopt.ts) — read both in full. `init` shows the place-skill-and-symlink pattern; `adopt` is the file you'll refactor.
6. [src/core/skills-cli.ts](../../src/core/skills-cli.ts) — the file you're rewriting.
7. [tests/init.test.js](../../tests/init.test.js), [tests/adopt.test.js](../../tests/adopt.test.js) — test patterns. The `adopt.test.js` integration suite must continue to pass unchanged after the refactor — it is the safety net.

Conventions: see `phase-1-patch-helpers.md` "Project orientation" — same rules.

**Confirm Phase 1 and Phase 1.5 are merged before starting.** This phase imports `linkSkillIntoTools` from `src/core/linker.ts` (Phase 1.5). It doesn't use `src/core/patch.ts` directly, but the next phases assume Phase 1 exists; don't get ahead of the order.

## Deliverables

Sequence matters: build the adoption planner (and refactor `adopt`) first so the pattern is in place and the existing integration tests confirm the refactor is faithful before any new code lands. Then source resolution. Then `runAdd`.

### 1. Adoption planner: new module `src/core/adoption.ts`

Extract the winner/loser/split decision logic from `runAdopt` ([src/commands/adopt.ts:154-353](../../src/commands/adopt.ts#L154-L353)) into a pure module with three responsibilities: plan, execute, format. The plan is a uniform `AdoptPlan` value with a `mode` tag for the formatter; execution is a single pass over the action arrays.

Exports — exactly these, no others:

```ts
import type { AdoptCandidate } from "./adopt-scan.js";
import type { LinkSiteResult } from "./linker.js";

export interface AdoptPlanInput {
  candidate: AdoptCandidate;
  flags: { from?: string; keepOtherAs?: string };  // pre-parsed by the CLI layer
  rootPath: string;
}

export type AdoptMode =
  | "single"
  | "duplicate-identical"
  | "conflict-takeover"
  | "conflict-split";

export interface AdoptPlan {
  mode: AdoptMode;
  name: string;
  primary: { sourcePath: string; targetDir: string; toolId: string };
  split?: { sourcePath: string; targetDir: string; targetName: string; toolId: string };
  removals: { path: string; toolId: string; backupTo?: string }[];   // backupTo set ⇒ backup-then-remove
  links: { linkPath: string; targetDir: string; toolId: string }[];
  manifestEntries: { name: string; kind: "authored" }[];
}

export interface AdoptPlanError { message: string }

export type PlanResult =
  | { ok: true; plan: AdoptPlan }
  | { ok: false; error: AdoptPlanError };

export function planAdoption(input: AdoptPlanInput): PlanResult;

export interface AdoptExecResult {
  performed: { kind: "rename" | "backup" | "remove" | "link" | "manifest-write"; detail: string }[];
  linkResults: LinkSiteResult[];
}

export function executeAdoptPlan(
  plan: AdoptPlan,
  opts?: { dryRun?: boolean; nowIso?: string },
): AdoptExecResult;

export function formatAdoptPlan(plan: AdoptPlan): string[];
export function formatAdoptResult(
  plan: AdoptPlan,
  result: AdoptExecResult,
  opts?: { dryRun?: boolean },
): string[];
```

Required behavior:

**`planAdoption`** — pure with one allowed read (`existsSync` for precondition checks). No `process.stdout`, no writes, no throws. Every error returns `{ ok: false, error }`.

- `candidate.status.kind === "single"` → `mode: "single"`. Primary is the only location. No removals. Links = [primary site only]. Manifest = [primary].
- `candidate.status.kind === "duplicate-identical"` → `mode: "duplicate-identical"`. Primary = `locations[0]`. Removals = `locations[1..]` with no `backupTo` (identical content, safe to drop). Links = every location's path → primary target. Manifest = [primary].
- `candidate.status.kind === "duplicate-conflict"` and `flags.from` set, no `keepOtherAs` → `mode: "conflict-takeover"`. Primary = `locations.find(l => l.toolId === flags.from)`. Removals = other locations with `backupTo` set to a timestamped path under `<rootPath>/.cache/adopted-backup/<ts>/<toolId>/<name>/`. Links = all locations → primary target. Manifest = [primary].
- `candidate.status.kind === "duplicate-conflict"` and both `flags.from` and `flags.keepOtherAs` set → `mode: "conflict-split"`. Primary = matching `from`. Split = the other location, with its own `targetDir` (`<rootPath>/authored/<keepOtherAs>/`) and `targetName`. Removals = []. Links = [primary site → primary target, split site → split target]. Manifest = [primary, split].
- Validation errors (all `{ ok: false }`):
  - `keepOtherAs` set without `from` → "`--keep-other-as` also requires `--from <tool>` to pick the primary copy."
  - `from` value not in `candidate.locations[].toolId` → "`--from \"<value>\"` not in candidate locations [<list>]."
  - `duplicate-conflict` without `from` → "<name> has differing copies in [<list>]. Pick one with `--from <tool>`, or split with `--from <tool> --keep-other-as <new-name>`."
  - `<rootPath>/authored/<name>/` already exists → "`<targetDir>` already exists; refusing to overwrite. Move it aside and retry."
  - `<rootPath>/authored/<keepOtherAs>/` already exists → "`<otherDir>` already exists; pick a different `--keep-other-as` name."
- Backup paths share one timestamp per plan; `executeAdoptPlan` receives it via `opts.nowIso` (default `new Date().toISOString()` at execute time), so all backups for one plan land under the same `<ts>/` directory.

**`executeAdoptPlan`** — performs side effects in this order, returns `AdoptExecResult` describing what happened:

1. Rename `plan.primary.sourcePath` → `plan.primary.targetDir`.
2. If `plan.split`: rename `split.sourcePath` → `split.targetDir`.
3. For each removal with `backupTo`: `cp -r path backupTo`, then `rm -rf path`.
4. For each removal without `backupTo`: `rm -rf path`.
5. For each link: pre-remove a real directory at `linkPath` (the same defensive `rmSync` `adopt` does today; the linker refuses real dirs by design — see ADR-0001), then call `linkSiteToSkill(linkPath, targetDir, toolId)`. Collect results into `linkResults`.
6. Write manifest entries via `readManifest`/`writeManifest` from `src/core/manifest.ts`.

When `opts.dryRun === true`: skip every side effect (no rename, no rm, no mkdir, no manifest write, no link calls). `performed[]` still describes what *would* happen so callers can preview; `linkResults` is empty in this mode. Trace every branch — dry-run must not touch the filesystem.

Filesystem failures (cross-device rename, permission denied) propagate as exceptions. The executor isn't responsible for transactional rollback; the caller (today: `runAdopt`) decides.

**`formatAdoptPlan` / `formatAdoptResult`** — pure: no I/O, return `string[]`. Match the user-visible output of today's `adoptOne` so the existing `tests/adopt.test.js` integration tests continue passing without assertion changes. `formatAdoptResult` appends `(dry-run — no changes made)` when `opts.dryRun` is true.

### 2. Refactor `src/commands/adopt.ts`

Replace the inline planning logic with calls to the new module. Target structure:

- `runAdopt`: parse flags, run scan, dispatch to `printScan` / `adoptAll` / `adoptOne`. Unchanged at this level.
- `adoptOne(candidate, rootPath, opts)`: `planAdoption(...)` → if `!ok`, print `error.message` to stderr and return 1 → print `formatAdoptPlan(plan)` lines → if dry-run, print result formatter and return 0 → `executeAdoptPlan(plan)` → print `formatAdoptResult(plan, result)` lines → return 0.
- `adoptAll(scan, rootPath, opts)`: build plans for every safe candidate up front via `planAdoption`. Print all plans (combined preview). If dry-run, stop and return 0. Otherwise execute each in order, collecting results, then print combined results. Conflict candidates remain listed at the end as skipped. **Note:** this changes `adopt --all`'s user-visible output from today's per-candidate interleaved format to a combined-preview-then-combined-results format. Intentional — the new shape makes `--all --dry-run` actually previewable. The existing `tests/adopt.test.js` `--all` case asserts only on filesystem state, so it passes unchanged.

What to remove: every `let winner` / `let losers`, the `linkPlan`/`splitPlan` build-up (lines 215–261), all `process.stdout.write` calls inside `adoptOne`'s side-effect block (lines 263–351), the local `isRealDirectory` / `reportLink` helpers (those move into the executor / formatter as appropriate). `printScan` stays as-is; it predates the planner pattern and isn't plan-shaped.

Existing `tests/adopt.test.js` integration tests must pass without modification. They are the safety net — if they fail, the refactor is wrong.

### 3. Rewrite `src/core/skills-cli.ts`

Drop the `SkillsCliUnavailableError`. Implement `resolveSource()` for the three source types from [AGENTS.md](../../AGENTS.md) "Source resolution":

```ts
export interface ResolvedSourceRef {
  ref: string;            // commit hash for git, "url@<sha256>" for url, "local@<sha256>" for local
  pristinePath: string;   // absolute path inside <root>/.cache/pristine/<name>@<safeRef>/
  skillName: string;      // from SKILL.md frontmatter `name:` field
  source: ContribSource;  // normalized; matches the manifest schema
}

export async function resolveSource(
  source: string,
  rootPath: string,
): Promise<ResolvedSourceRef>;
```

Source-string parsing:

- Begins with `https://` or `git@` and ends in `.git` (or has `github.com`/`gitlab.com`/`bitbucket.org` host) → **git repo**.
  - Optional `#<ref>` fragment chooses the ref (default: remote HEAD).
  - Optional `:<subpath>` after `.git` chooses a subdirectory inside the repo (multi-skill repo case). Pick a syntax that won't collide with URL parsing — using `#<ref>` for ref and `?path=<subpath>` is reasonable, but match what `vercel-labs/skills` already accepts if it's documented; otherwise document your choice in a one-line comment.
- Begins with `https://` or `http://` and ends in `.tar.gz`, `.tgz`, `.zip`, or `SKILL.md` → **direct URL**.
- Anything else, treated as a **local path** if it exists on disk.
- Unrecognized → throw with a clear `unrecognized source: ...` message.

Per-type behavior:

- **Git**: `git clone --depth 1` (or `--depth 1 --branch <ref>` if a ref is given) into a temp dir, then `git rev-parse HEAD` for the pinned ref, then move the resolved subpath into `<root>/.cache/pristine/<name>@<shortHash>/`. Walk the tree to find `SKILL.md` and read its `name:` frontmatter — that's `skillName`. If multiple `SKILL.md`s exist and no subpath was given, throw with a list of candidates.
- **Direct URL**: download to a temp file. For tarball/zip, unpack. For raw `SKILL.md`, place it as the only file in a fresh dir. Compute sha256 of the canonical content, use that as `ref`. Move into pristine cache.
- **Local**: copy the directory tree into the pristine cache (don't symlink — pristine must be immutable from the user's perspective, and `git apply --3way` later needs a real tree). Compute sha256 of the tree, use as `ref`.

Frontmatter parsing: read just the YAML block between the first `---` and the second `---` of `SKILL.md`. Don't pull in a YAML dependency — a small regex for `^name:\s*(.+)$` and `^description:\s*(.+)$` is enough. If `name:` is missing, throw `SKILL.md missing required \`name\` field at <path>`.

Helpers worth co-locating in this file (not exported): `cloneGit`, `downloadUrl`, `unpackTarball`, `unpackZip`, `parseSkillFrontmatter`, `safeRefSegment` (sanitize `ref` for use in a path).

Use `node:child_process` (`execFile`, never raw `exec` with shell=true) for git, tar, and unzip. `tar` and `unzip` are present in standard CI; if you'd rather avoid `unzip`, you can require git ≥ 2.42 and skip zip support for now (note this in a one-liner comment and surface the limitation as a clean error). **Do not add npm dependencies.**

Network-dependent behavior is hard to test. Structure `resolveSource` so the local-path branch is fully exercisable from the test suite without network.

### 4. Implement `runAdd()` in `src/commands/add.ts`

Replace the stub. The flow:

1. Validate input. If `args.source` is missing, write `error: usage: skills-manager add <source>` and return 1.
2. Resolve the SSOT root via `resolveRoot()` and ensure layout. If `skills.json` is missing, error: not initialized.
3. Read manifest + lockfile.
4. Call `resolveSource(args.source, root.path)` → `{ ref, pristinePath, skillName, source }`.
5. Reject if `skillName` already exists in `manifest.skills` (suggest `remove` then `add`, or `update`).
6. Copy the pristine tree to `<root>/skills/<skillName>/` (a fresh, real directory — not a symlink).
7. Update manifest: `manifest.skills[skillName] = { kind: "contrib", source }`. Update lockfile: `lock.skills[skillName] = { resolvedRef: ref, resolvedAt: new Date().toISOString() }`.
8. Detect linkable tools (`listLinkableTools()` from `src/core/tool-detect.ts`) and call `linkSkillIntoTools(skillName, <root>/skills/<skillName>, tools)` from `src/core/linker.ts` (Phase 1.5). Don't reimplement symlink placement.
9. Print a summary: `added <name> @ <short-ref> (<source-summary>)` and a list of tools it was linked into (formatted from the returned `LinkSiteResult[]`).

Idempotency: If the operation fails midway, leave a coherent state. The simplest approach: do step 6 (copy to skills/) after the pristine cache is fully populated, do steps 7–8 atomically (write manifest *after* successful symlinking), and on any thrown error inside steps 6–8, attempt cleanup of partial copies in `skills/<name>/` before re-throwing. Do not attempt to roll back the pristine cache — it's content-addressed, harmless if stale.

### 5. New tests

Two new test files, plus the existing `tests/adopt.test.js` continuing to pass unchanged.

#### `tests/adoption.test.js` (planner unit tests)

Pattern: `node:test`, `node:assert/strict`. Imports from `../dist/core/adoption.js`. Planner cases build `AdoptCandidate` / `AdoptLocation` fixtures inline — no fake `$HOME` needed. Executor cases use `mkdtempSync` for a tmp root with a real tool-dir layout.

Cover at least:

1. **`planAdoption` — single location.** One location. Assert `mode: "single"`, primary set, removals empty, one link entry, one manifest entry.
2. **`planAdoption` — duplicate-identical.** Two locations, identical hash. Assert `mode: "duplicate-identical"`, primary = first, removals = rest with `backupTo` undefined, links cover both sites pointing at primary target, manifest has primary only.
3. **`planAdoption` — conflict-takeover with `--from`.** Two conflicting locations, `flags.from` matches one. Assert `mode: "conflict-takeover"`, removals[0].`backupTo` set under `.cache/adopted-backup/<ts>/`, links cover both sites.
4. **`planAdoption` — conflict-split with `--from` + `--keep-other-as`.** Same as 3 plus `keepOtherAs`. Assert `mode: "conflict-split"`, primary + split present, removals empty, two manifest entries.
5. **`planAdoption` — conflict without `--from`.** `{ ok: false }` with a message naming the available tool ids.
6. **`planAdoption` — `--keep-other-as` without `--from`.** `{ ok: false }`, specific message.
7. **`planAdoption` — `--from` value not in candidate locations.** `{ ok: false }` listing available tool ids.
8. **`planAdoption` — target dir already exists.** Pre-create `authored/<name>/`. `{ ok: false }`.
9. **`planAdoption` — split target dir already exists.** Pre-create `authored/<keepOtherAs>/`. `{ ok: false }`.
10. **`executeAdoptPlan` — dry-run.** Real fixture (tool dirs, skill content). Plan, then `executeAdoptPlan(plan, { dryRun: true })`. Assert `performed[]` describes the moves; on-disk state unchanged (no rename, no rm, no manifest write).
11. **`executeAdoptPlan` — real run.** Same fixture, `dryRun: false`. Assert manifest entries present, every `linkResults.status` is `"linked"`, files in expected locations.

#### `tests/add.test.js` (integration)

Pattern: `node:test`, `node:assert/strict`, fake HOME via `mkdtempSync`, run `runInit` first then `runAdd`. Tests import from `../dist/...`.

Cover at least:

1. **Add from a local directory.** Build a fixture skill on disk with a valid `SKILL.md`. Call `runAdd({ source: <fixture path>, flags: {} })`. Assert: `skills/<name>/SKILL.md` exists, `.cache/pristine/<name>@<ref>/SKILL.md` exists, `skills.json` lists it as `kind: "contrib"`, `skills.lock.json` has a `resolvedRef`, and a symlink exists in `<fakeHome>/.claude/skills/<name>` pointing at the SSOT skill dir.
2. **Add fails when not initialized.** Run `runAdd` against a fresh fake HOME with no `init`. Assert exit code 1 and the error message.
3. **Add fails on duplicate.** Run twice with the same source. Second call exits 1 with a clear message.
4. **Add of a multi-`SKILL.md` source without subpath.** Build a fixture with two `SKILL.md`s in subdirectories. Assert the error lists both candidates.
5. **Add fails when `SKILL.md` lacks a `name:` field.** Fixture without name → exit 1, specific message.

Skip git and direct-URL tests in this phase to avoid network. Note in a comment at the top of the test file that those branches are exercised manually until a fixture-server pattern is added.

## Code review (mandatory)

Spend real time on this:

1. **Planner purity.** `planAdoption` must not touch `process.stdout`, `fs.writeFileSync`, or anything that mutates state. The only filesystem read allowed is `existsSync` for the "target dir not already there" precondition. If you find yourself reaching for anything else, push it into the executor.
2. **Dry-run is filesystem-clean.** `executeAdoptPlan(plan, { dryRun: true })` must not call `renameSync`, `rmSync`, `mkdirSync`, `cpSync`, `writeManifest`, or the linker. Trace every branch.
3. **Adopt output parity.** Run `tests/adopt.test.js` after the refactor. It must pass without assertion changes. If user-visible output strings drifted, either restore them or document why the change is acceptable and update the tests deliberately.
4. **Cleanup on partial failure.** If `runAdd` throws after copying to `skills/<name>/` but before writing the manifest, what's left on disk? Trace it.
5. **Symlink target stability.** If the user later moves the SSOT, all symlinks break. That's expected; not yours to solve. But confirm the symlink target is the *absolute* SSOT path, not a relative path from a tool dir.
6. **Linker reuse.** Confirm `add` calls `linkSkillIntoTools` from `src/core/linker.ts`, and the adoption executor calls `linkSiteToSkill`. No file should re-roll symlink logic.
7. **Frontmatter parser.** Does it handle CRLF line endings? Tab-prefixed values? Quoted values (`name: "foo"`)? Test at least one of these or accept a constrained subset and document it.
8. **Path-injection safety.** Source strings come from the user. Make sure `safeRefSegment` strips `..`, `/`, and shell metacharacters before they hit a filesystem path. Confirm by passing a hostile fixture name.
9. **No hidden network calls in the local-path test.** Run it in `--network-disabled` mode if your harness supports it; otherwise read the test code with hostile eyes.

## Verification

```bash
pnpm install
pnpm build
pnpm test
```

Manual smoke (optional but encouraged):
```bash
mkdir -p /tmp/fake-skill && cat > /tmp/fake-skill/SKILL.md <<'EOF'
---
name: smoke-test
description: temporary
---
hello
EOF
HOME=$(mktemp -d) node bin/skills-manager.js init
HOME=$(mktemp -d) node bin/skills-manager.js add /tmp/fake-skill   # adapt to one HOME
```

## What's out of scope

- `update`, `diff`, `save-patch`, `remove`, `list`. Future phases.
- Forcing `runAdd` into the planner pattern. `add` is linear; revisit only if a future feature pushes it into plan-shaped territory.
- Editing `ROADMAP.md` checkboxes — the user does that.
- Adding npm dependencies.

## Done criteria

- `src/core/adoption.ts` exists with the listed exports; planner is pure, executor is dry-run safe.
- `src/commands/adopt.ts` no longer contains inline winner/loser/split logic — it composes planner + executor + formatter.
- `tests/adoption.test.js` covers the eleven listed cases and passes.
- `tests/adopt.test.js` continues to pass without modification.
- `src/core/skills-cli.ts` rewritten, `SkillsCliUnavailableError` removed.
- `src/commands/add.ts` no longer throws `NotImplementedError`.
- `add` calls `linkSkillIntoTools` from `src/core/linker.ts`; no inline symlink logic.
- `tests/add.test.js` covers the five listed cases and passes.
- `pnpm build` and `pnpm test` green.
- Self-review pass completed.
