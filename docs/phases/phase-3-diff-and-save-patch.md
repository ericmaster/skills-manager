# Phase 3 — `diff <skill>` + `save-patch <skill>`

## Mission

Wire the user-facing `diff` and `save-patch` commands to the helpers from Phase 1. This phase is intentionally small — most of the logic lives in `src/core/patch.ts` already, so the work is argument validation, error messages, and tests.

## Project orientation (read first)

1. [AGENTS.md](../../AGENTS.md) — re-read **Customization model**.
2. [README.md](../../README.md) — section "Customizing a contrib skill" — that's the user-facing contract you're implementing.
3. [src/core/patch.ts](../../src/core/patch.ts) — Phase 1's deliverable. Read every export and its doc/error semantics. **Confirm Phase 1 and Phase 2 are merged before starting.**
4. [src/commands/adopt.ts](../../src/commands/adopt.ts) — style reference for argument parsing, error messages, and stdout output.
5. [tests/init.test.js](../../tests/init.test.js) — test pattern.

## Deliverables

### 1. Implement `runDiff()` in `src/commands/diff.ts`

Replace the stub.

Behavior:
1. If `args.skill` is missing → `error: usage: skills-manager diff <skill>`, exit 1.
2. Resolve root, ensure layout. If not initialized → exit 1 with the standard message.
3. Read manifest. If `<skill>` isn't in `manifest.skills` → `error: unknown skill "<skill>"`, exit 1.
4. If `manifest.skills[<skill>].kind === "authored"` → `<skill> is self-authored; diff has no upstream to compare against.`, exit 0 (not an error — self-authored skills legitimately have no diff base).
5. Otherwise call `diffSkill(pristineDir, liveDir)` from `src/core/patch.ts`.
6. If the diff is empty → print `<skill>: no drift from pristine.` to stdout, exit 0.
7. Otherwise write the diff verbatim to stdout, exit 0.

### 2. Implement `runSavePatch()` in `src/commands/save-patch.ts`

Replace the stub.

Behavior:
1. Same arg validation and `kind` check as `runDiff`.
2. Call `savePatch(rootPath, name)` from `src/core/patch.ts`.
3. If `{ empty: true }` → `<skill>: no drift; removed any stale patch.`, exit 0.
4. If `{ empty: false }` → `<skill>: saved patches/<skill>.patch`, exit 0.

Errors thrown by `savePatch` (missing pristine, missing lockfile entry) bubble up as the `error: <message>` printed by `main()` in `src/cli.ts` — verify by reading the `try/catch` there. If the message is unhelpful for these cases, catch and rethrow with a friendlier wrapper before exiting 1.

### 3. New tests: `tests/diff-save-patch.test.js`

Each test sets up a fake HOME, calls `runInit`, then `runAdd` with a local fixture skill. Capture stdout/stderr by replacing `process.stdout.write` / `process.stderr.write` for the duration of each test (the existing tests don't do output capture; either add a small helper inline at the top of this test file or assert side effects only).

Cover:

1. **`diff` of an unknown skill** → exit 1, stderr mentions `unknown skill`.
2. **`diff` of an authored skill** → exit 0, message about authored having no diff base. (Use the bundled `skills-manager` skill that `init` installs as authored.)
3. **`diff` of a contrib skill, no drift** → exit 0, message `no drift from pristine`.
4. **`diff` of a contrib skill with drift** → exit 0, stdout contains a unified diff with the changed line.
5. **`save-patch` of a contrib skill, no drift, with a stale patch present** → patch file deleted, exit 0, friendly message.
6. **`save-patch` of a contrib skill with drift** → patch file written non-empty, exit 0.
7. **`save-patch` errors when called before `add`** → exit 1.

For "with drift" cases, after `runAdd`, write a few extra lines to the live `SKILL.md` directly with `writeFileSync`.

## Code review (mandatory)

1. **Authored guard.** Does `runDiff` correctly skip authored skills? Did you use `kind === "authored"` and not `=== "contrib"` (the latter would miss any future kind we add)? Authored is the explicit exclusion; everything else needs a diff.
2. **Exit codes.** "No drift" is exit 0, not 1. "Unknown skill" is exit 1. "Authored, no diff" is exit 0. Trace each branch.
3. **Output goes to the right stream.** Diff content → stdout (so users can pipe it). Errors → stderr.
4. **Stale-patch deletion.** Does the test for "no drift with stale patch present" actually verify `existsSync(patchPath) === false` after the call?
5. **Re-runs are stable.** Run `save-patch` twice in a row on the same drift — second run should produce an identical patch file, not append or duplicate.

## Verification

```bash
pnpm build
pnpm test
```

Manual smoke (optional):
```bash
HOME=$(mktemp -d)
node bin/skills-manager.js init
node bin/skills-manager.js add /tmp/fake-skill
echo "extra line" >> $HOME/.skills-manager/skills/<name>/SKILL.md
node bin/skills-manager.js diff <name>
node bin/skills-manager.js save-patch <name>
cat $HOME/.skills-manager/patches/<name>.patch
```

## What's out of scope

- `update` (next phase) — even though `save-patch` is the implicit first step of `update`, do not anticipate that here.
- `customize <skill>` (open in `$EDITOR`) — separate, deferred verb.
- Editing `ROADMAP.md`.

## Done criteria

- `src/commands/diff.ts` and `src/commands/save-patch.ts` no longer throw `NotImplementedError`.
- `tests/diff-save-patch.test.js` covers all listed cases and passes.
- `pnpm build` and `pnpm test` green.
- Self-review pass completed.
