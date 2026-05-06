# Phase 1 — Patch helpers foundation

## Mission

Create a single module of pure helpers that the patch lifecycle commands (`diff`, `save-patch`, `update`) will call in later phases. No command wiring in this phase — just the helpers and their tests.

This is the foundation of the project's headline differentiator: **survivable customizations of contrib skills across upstream updates**. Every later phase depends on these helpers being correct.

## Project orientation (read first)

You are a fresh agent. Before writing code, read these files in order to absorb the project's shape and conventions:

1. [AGENTS.md](../../AGENTS.md) — the source-of-truth architecture doc. Pay attention to the **Glossary** (terms `Skill`, `Source`, `Contrib skill`, `Pristine`, `Patch`, `SSOT`), the **Directory layout**, the **Update flow** section, and the **Customization model** section.
2. [ROADMAP.md](../../ROADMAP.md) — confirms phase ordering and what's deferred.
3. [src/core/paths.ts](../../src/core/paths.ts) — directory conventions you'll use (`patches/<name>.patch`, `.cache/pristine/<name>@<ref>/`, `skills/<name>/`).
4. [src/core/manifest.ts](../../src/core/manifest.ts) — JSON shape conventions; for style only, this phase doesn't touch the manifest.
5. [src/commands/adopt.ts](../../src/commands/adopt.ts) — read to absorb the project's TypeScript style (strict mode, `node:fs` imports, error messages, no comments unless non-obvious).
6. [tests/init.test.js](../../tests/init.test.js) and [tests/adopt.test.js](../../tests/adopt.test.js) — your test must follow this exact pattern: `node:test`, `node:assert/strict`, `mkdtempSync` for fixtures, import from `../dist/...` (tests run after `pnpm build`).

Conventions to honor:
- Node ≥ 22, ESM, TypeScript strict.
- No new dependencies. Shell out to `git` for `git apply --3way` and `git diff --no-index`.
- No comments unless they explain a non-obvious *why*.
- Keep error messages short and actionable.

## Deliverables

### 1. New module: `src/core/patch.ts`

Export exactly these three async functions and one type. Don't add anything else.

```ts
export interface PatchApplyResult {
  status: "clean" | "conflict";
  /** When status is "conflict", paths inside `targetDir` left with merge markers. */
  conflictedPaths: string[];
}

export async function diffSkill(pristineDir: string, liveDir: string): Promise<string>;
export async function savePatch(rootPath: string, name: string): Promise<{ patchPath: string; empty: boolean }>;
export async function applyPatch3Way(targetDir: string, patchPath: string): Promise<PatchApplyResult>;
```

Required behavior:

**`diffSkill(pristineDir, liveDir)`**
- Returns the unified diff representing `liveDir` as a modification of `pristineDir`.
- Implementation: shell out to `git diff --no-index --no-color -- <pristineDir> <liveDir>`.
- `git diff --no-index` exits with code 1 when there *is* a diff; that's not an error. Treat exit codes 0 and 1 as success and capture stdout. Any other exit code throws with the captured stderr.
- Returns the empty string when there's no diff (exit 0, empty stdout).
- Rewrite the headers in the returned diff so the `a/` and `b/` paths are relative to the skill (drop the absolute prefixes). One reasonable approach: do the diff in a temp dir where `pristineDir` is symlinked as `a/` and `liveDir` as `b/`, then run the diff there. Pick whichever approach keeps the patch portable across machines — the patch file must apply correctly later from inside a fresh staging dir without absolute path baggage.

**`savePatch(rootPath, name)`**
- Resolves pristine via `skills.lock.json`'s `resolvedRef` for `<name>`. If the lockfile doesn't list a ref, throw a clear error (`"no resolved ref for <name>; was it added with \`skills-manager add\`?"`).
- Live dir is `<rootPath>/skills/<name>/`. Pristine dir is `<rootPath>/.cache/pristine/<name>@<ref>/`. If either is missing, throw with a specific message.
- Generate the diff via `diffSkill`.
- Write to `<rootPath>/patches/<name>.patch`. If the diff is empty, *delete* any pre-existing patch file (rather than writing an empty one). Return `{ patchPath, empty: true }` in that case.
- Otherwise return `{ patchPath, empty: false }`.

**`applyPatch3Way(targetDir, patchPath)`**
- Skip cleanly when `patchPath` doesn't exist or is zero-length: return `{ status: "clean", conflictedPaths: [] }` without invoking git.
- Initialize a throwaway git repo *inside* `targetDir` (`git init -q`, `git add -A`, `git -c user.email=... -c user.name=... commit -q -m base`) so that `git apply --3way` has a base tree to merge against.
- Run `git apply --3way --whitespace=nowarn <patchPath>` from `targetDir`.
- On exit code 0 with no `<<<<<<<` markers anywhere under `targetDir`: return `{ status: "clean", conflictedPaths: [] }`.
- On non-zero exit but with merge markers present: scan for files containing `<<<<<<< ` and return `{ status: "conflict", conflictedPaths: [...] }` (paths relative to `targetDir`).
- On non-zero exit with no merge markers (genuine apply failure — patch malformed, refers to missing files): throw with the captured stderr.
- Always clean up the throwaway `.git` directory inside `targetDir` at the end (success or conflict). The caller will atomically swap the resulting tree into place; a stray `.git` would pollute the live skill.

### 2. New tests: `tests/patch.test.js`

Use `node:test` and `node:assert/strict` (see `tests/init.test.js` for the pattern). Tests import from `../dist/core/patch.js` — the `pretest` script handles the build.

Cover at least these cases. Each test uses `mkdtempSync` to create an isolated temp root with a `skills/<name>/`, `.cache/pristine/<name>@v1/`, `patches/`, and a `skills.lock.json` pointing at ref `v1`.

1. **`diffSkill` — no changes.** Pristine and live identical → returns `""`.
2. **`diffSkill` — pure addition.** Add a line to `live/SKILL.md` → returns a non-empty diff that mentions the added line.
3. **`savePatch` — empty diff cleans up stale patch.** Pre-create a stale `patches/<name>.patch` with stale content. Live = pristine. After `savePatch`, the patch file is gone, and the function returned `{ empty: true }`.
4. **`savePatch` — non-empty diff writes patch.** Edit live, call `savePatch`. File exists, non-empty, returned `{ empty: false }`.
5. **`applyPatch3Way` — clean apply.** Build pristine A, generate a patch where live = A + edit, copy A to a fresh staging dir, apply patch, assert `status: "clean"` and the expected change is present.
6. **`applyPatch3Way` — conflict.** Pristine A, patch derived from `live = A` with edits to line 1. Build a *different* staging tree where line 1 has been changed upstream incompatibly. Apply → `status: "conflict"`, `conflictedPaths` non-empty, file contains `<<<<<<<`.
7. **`applyPatch3Way` — missing/empty patch is a no-op.** Returns `{ status: "clean", conflictedPaths: [] }`, target tree unchanged, no `.git` left behind.

For tests that need a baseline pristine, write a tiny SKILL.md (a frontmatter block plus a few content lines) and reuse it.

## Code review (mandatory)

Before declaring the phase done, run a critical self-review pass over your patch. Spend at least a couple of minutes on this; do not skip. Specifically check:

1. **Cleanup paths.** Does every code path in `applyPatch3Way` remove the throwaway `.git` directory? Trace success, conflict, and thrown-error cases.
2. **Path portability.** Does the diff produced by `diffSkill` apply cleanly from any directory? If you used absolute paths, that's likely a bug — `git apply` will refuse.
3. **Empty/missing inputs.** What happens if `pristineDir` is empty? If `liveDir` doesn't exist? Confirm errors are clear, not internal git output dumps.
4. **Conflict detection ambiguity.** If a SKILL.md legitimately contains `<<<<<<< ` in its prose, the conflict scan would false-positive. Document this assumption with a one-line comment in `applyPatch3Way` explaining we treat any `<<<<<<< ` as a conflict marker; future work can refine if it bites.
5. **Tests are honest.** Do they fail if you delete the implementation? Run them once with the impl gutted to confirm.
6. **No scope creep.** No new commands, no manifest writes, no tool linking. This phase is helpers + tests only.

If review uncovers issues, fix them before moving on.

## Verification

Run, in order, and confirm each step:

```bash
pnpm install     # if not already
pnpm build       # must succeed with no TS errors
pnpm test        # all tests pass, including the new patch.test.js
```

## What's out of scope (do not do)

- Wiring `runDiff` / `runSavePatch` / `runUpdate` to call these helpers. That's Phase 3 and Phase 4.
- Changing `src/core/skills-cli.ts`. That's Phase 2.
- Touching the manifest, lockfile schema, or any tool-linking code.
- Adding dependencies.
- Editing `ROADMAP.md` to tick the box — the user does that after they review your PR.

## Done criteria

- `src/core/patch.ts` exists with the three exports above.
- `tests/patch.test.js` covers all seven listed cases and passes.
- `pnpm build` and `pnpm test` are green.
- Self-review pass completed.
- No other files modified.
