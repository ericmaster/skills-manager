# Phase 1.5 — Linker seam

## Mission

Extract symlink placement (and removal) into a single seam used by `init`, `adopt`, and the upcoming `add` (Phase 2) / `remove` (Phase 5) commands. Today the logic is duplicated across [src/commands/init.ts](../../src/commands/init.ts) (`replaceSymlink`, plus the link-fanout loop) and [src/commands/adopt.ts](../../src/commands/adopt.ts) (two inline copies), with subtly different policies. The seam concentrates the rules in one module and turns "place a Skill into a Tool's Link site" into a primitive every command can reuse.

Pure refactor — no user-visible behavior changes — except that `init` and `adopt` now report failures uniformly instead of one swallowing them and the other crashing.

## Project orientation (read first)

You are a fresh agent. Read in this order:

1. [AGENTS.md](../../AGENTS.md) — Glossary (esp. **Skill**, **Tool**, **Link site**, **SSOT**), Tool detection, Adoption.
2. [docs/adr/0001-ssot-and-symlinks.md](../adr/0001-ssot-and-symlinks.md) — load-bearing decision behind why symlinks exist at all.
3. [src/commands/init.ts](../../src/commands/init.ts) — read in full. Contains `replaceSymlink` and the link-fanout loop. The dangling-symlink and refuse-to-clobber rules live here.
4. [src/commands/adopt.ts](../../src/commands/adopt.ts) — read lines 324–345. Two inline link sites; note that `adopt` `rmSync`s a real directory at the link path *before* symlinking, because that directory was the content that just got moved into the SSOT. **This pre-removal stays in `adopt`, not in the linker.**
5. [src/core/tool-detect.ts](../../src/core/tool-detect.ts) — `DetectedTool` shape; `absLinkTarget` is the linkable directory.
6. [tests/init.test.js](../../tests/init.test.js), [tests/adopt.test.js](../../tests/adopt.test.js) — assertion patterns; tests import from `../dist/...`.

Conventions: see Phase 1's "Project orientation" — same rules. Node ≥22, ESM, TypeScript strict, no comments unless they explain a non-obvious *why*, no new dependencies.

## Deliverables

### 1. New module: `src/core/linker.ts`

Export exactly these types and functions. No others.

```ts
import type { DetectedTool } from "./tool-detect.js";

export type LinkStatus =
  | "linked"                  // created, or replaced a dangling/wrong-target symlink
  | "already-linked"          // existing symlink already points at skillDir
  | "unlinked"                // removed our symlink
  | "absent"                  // unlink: nothing was there
  | "skipped-non-symlink"     // real file or directory present; refused to touch
  | "skipped-foreign-target"  // symlink present but pointing elsewhere; left alone
  | "failed";                 // I/O error; see `message`

export interface LinkSiteResult {
  toolId: string;             // empty string when the primitive is called directly without a tool
  linkPath: string;
  status: LinkStatus;
  message?: string;
}

// Primitives — one Link site at a time.
export function linkSiteToSkill(
  linkPath: string,
  skillDir: string,
  toolId?: string,
): LinkSiteResult;

export function unlinkSiteFromSkill(
  linkPath: string,
  skillDir: string,
  toolId?: string,
): LinkSiteResult;

// Fan-out — every linkable Tool gets the same Skill at <tool.absLinkTarget>/<skillName>.
export function linkSkillIntoTools(
  skillName: string,
  skillDir: string,
  tools: DetectedTool[],
): LinkSiteResult[];

export function unlinkSkillFromTools(
  skillName: string,
  skillDir: string,
  tools: DetectedTool[],
): LinkSiteResult[];
```

Required behavior:

**`linkSiteToSkill(linkPath, skillDir, toolId?)`**
- If nothing exists at `linkPath` (and no symlink): `mkdir -p` the parent, create a directory symlink to `skillDir`, return `linked`.
- If a symlink exists:
  - Target equals `skillDir` → return `already-linked` (no I/O).
  - Target is dangling or differs → unlink and recreate to `skillDir`, return `linked`.
- If a real file or directory exists at `linkPath` → return `skipped-non-symlink` with a message explaining the caller should resolve it. **Never delete a real directory.** That policy lives in callers (per [ADR-0001](../adr/0001-ssot-and-symlinks.md) and the `adopt` flow).
- I/O error → return `failed` with the error message; never throw.
- Symlink target must be the **absolute** `skillDir` path so the link survives moves of the Tool's link directory but breaks predictably if the SSOT moves.

**`unlinkSiteFromSkill(linkPath, skillDir, toolId?)`**
- Nothing at `linkPath` → `absent`.
- Symlink whose target equals `skillDir` → unlink, return `unlinked`. This is the only case that mutates.
- Symlink to anything else (including dangling) → `skipped-foreign-target`. Don't touch — the user (or another tool) put something else there.
- Real file or directory → `skipped-non-symlink`.
- I/O error → `failed`.

**`linkSkillIntoTools(skillName, skillDir, tools)`**
- For each `tool` in `tools`: skip silently if `tool.absLinkTarget` is undefined (non-linkable; should already be filtered by callers, but defend in depth). Otherwise compute `linkPath = join(tool.absLinkTarget, skillName)` and call `linkSiteToSkill(linkPath, skillDir, tool.id)`. Collect results. Never throw — all errors land in `LinkSiteResult.failed`.

**`unlinkSkillFromTools(skillName, skillDir, tools)`**
- Symmetric to `linkSkillIntoTools`. Used by `remove` (Phase 5) and any callers that want to detach a Skill from all Tools without deleting the SSOT directory.

### 2. Refactor callers

**`src/commands/init.ts`**
- Remove the local `replaceSymlink` / `isDanglingSymlink` helpers.
- Replace the per-tool link loop (currently lines 76–105) with a single call to `linkSkillIntoTools(BUNDLED_MANAGER_SKILL, targetSkillDir, linkableDetectedTools)`.
- Format the returned `LinkSiteResult[]` into the same `✓` / `✗` lines the user sees today. Output strings should remain stable so existing tests continue to pass; if they need adjustment, update the tests to reflect the new uniform format.

**`src/commands/adopt.ts`**
- Step 4 (lines 324–333, link-plan loop): for each `site` in `linkPlan`, `rmSync(linkPath)` only when a real directory exists there (the existing-content-just-migrated case). Then call `linkSiteToSkill(site.path, targetDir, site.toolId)`. Tolerate `already-linked`, surface failures.
- Step 5 (lines 336–345, split-link site): same treatment for the split case.
- Do **not** push the `rmSync` into the linker — that's `adopt`-specific (the dir we're removing is the same content we just moved into the SSOT; the linker has no way to know that's safe).

**Reuse, don't duplicate.** When in doubt, call the linker primitive.

### 3. New tests: `tests/linker.test.js`

Pattern: `node:test`, `node:assert/strict`, `mkdtempSync`, import from `../dist/core/linker.js`.

Cover at least:

1. **`linkSiteToSkill` — fresh path.** No symlink, no file. Call it. Result `linked`; `lstat(linkPath).isSymbolicLink()` true; `readlink(linkPath)` equals `skillDir`.
2. **`linkSiteToSkill` — already correct.** Pre-create the symlink. Call again. Result `already-linked`; symlink unchanged.
3. **`linkSiteToSkill` — dangling symlink.** Symlink to a non-existent path. Call. Result `linked`; readlink now equals `skillDir`.
4. **`linkSiteToSkill` — symlink to wrong target.** Symlink to a different real dir. Call. Result `linked`; readlink now equals `skillDir`. The previous target's contents are untouched.
5. **`linkSiteToSkill` — refuses real directory.** Pre-create a real directory at `linkPath` with a file inside. Call. Result `skipped-non-symlink`; the directory and its contents are untouched.
6. **`unlinkSiteFromSkill` — removes our symlink.** Pre-create the correct symlink. Call. Result `unlinked`; path is gone.
7. **`unlinkSiteFromSkill` — leaves foreign symlink.** Symlink to a different target. Call. Result `skipped-foreign-target`; symlink intact.
8. **`unlinkSiteFromSkill` — absent path.** Call against a non-existent path. Result `absent`.
9. **`unlinkSiteFromSkill` — refuses real directory.** Real dir at path. Call. Result `skipped-non-symlink`; dir intact.
10. **Fanout link/unlink across two fake tools.** Build two `DetectedTool` shapes pointing at two tmp link directories. Call `linkSkillIntoTools` then `unlinkSkillFromTools`. Assert one result per tool, statuses `linked` then `unlinked`, and both link sites are clean afterward.
11. **Fanout never throws on per-tool failure.** Make one `absLinkTarget` undefined or unwritable; assert the other tool still gets a clean result and the failing one is recorded as `failed` (or skipped silently, depending on which case you wired). Document the chosen behavior in the assertion.

The existing `tests/init.test.js` and `tests/adopt.test.js` should continue to pass. If output formatting changed enough to break them, update the assertions but don't loosen them — the goal is uniform reporting, not weaker tests.

## Code review (mandatory)

Spend real time on this:

1. **No `rmSync` of real directories inside the linker.** Trace every branch. The linker may unlink symlinks (its own kind) but never `rm -rf` a real tree. That policy belongs to callers per [ADR-0001](../adr/0001-ssot-and-symlinks.md).
2. **Absolute symlink targets.** Confirm `skillDir` is absolute at every call site. Reject relative paths with a `failed` result rather than silently creating a relative-target symlink — that subtly breaks if the link is later moved.
3. **`adopt`'s pre-removal step.** After your refactor, does `adopt` still `rmSync` the existing real directory at the link path before calling the linker? It must, otherwise the linker will return `skipped-non-symlink` and adoption silently fails to relink.
4. **No fanout method throws.** All errors must surface as `LinkSiteResult.failed`. Test 11 enforces this — verify by injecting an unwritable parent.
5. **Output stability.** Did `init`/`adopt` user-visible output change? If yes, are existing tests updated? If no, is the `LinkSiteResult` → text mapping dead-simple?
6. **Tests are honest.** Run them with the impl gutted; they must fail.

## Verification

```bash
pnpm install
pnpm build
pnpm test
```

All three of `tests/init.test.js`, `tests/adopt.test.js`, `tests/linker.test.js` must pass; `tests/patch.test.js` is unrelated and must continue passing.

## What's out of scope (do not do)

- Wiring `runRemove` to call `unlinkSkillFromTools`. That's Phase 5; the unlink primitive ships now to keep the seam coherent, but no command consumes it yet.
- Touching `src/core/skills-cli.ts`. Phase 2.
- Changing `tool-detect.ts`, the manifest, or the lockfile schema.
- Adding npm dependencies.
- Editing `ROADMAP.md` to tick the box — the user does that after PR review.

## Done criteria

- `src/core/linker.ts` exists with the four exports above.
- `src/commands/init.ts` and `src/commands/adopt.ts` no longer contain inline symlink logic; both call into the linker.
- `tests/linker.test.js` covers the eleven listed cases and passes.
- `pnpm build` and `pnpm test` are green.
- Self-review pass completed.
- No new dependencies in `package.json`.
