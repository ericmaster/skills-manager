# Phase 5 — `remove <skill>` + `list`

## Mission

Two simpler commands bundled into one phase: tear down a skill completely, and show what's installed. Together with the earlier phases, this completes the patch-lifecycle slice — `add`, `list`, `diff`, `save-patch`, `update`, `remove` cover the full user journey.

## Project orientation (read first)

1. [AGENTS.md](../../AGENTS.md) — re-read **Directory layout** and **CLI surface** for the spec rows on `remove` and `list`.
2. [README.md](../../README.md) — confirms user-facing wording.
3. [src/commands/add.ts](../../src/commands/add.ts) — Phase 2. Whatever it creates, this phase must tear down.
4. [src/commands/adopt.ts](../../src/commands/adopt.ts) — style reference for argument parsing and stdout output.
5. [src/core/state.ts](../../src/core/state.ts) — to read the list of detected tools and their link targets.
6. [tests/init.test.js](../../tests/init.test.js), [tests/add.test.js](../../tests/add.test.js) — test patterns.

**Confirm Phases 1–4 are merged before starting.**

## Deliverables

### 1. Implement `runRemove()` in `src/commands/remove.ts`

Replace the stub.

Behavior:
1. If `args.skill` is missing → `error: usage: skills-manager remove <skill>`, exit 1.
2. Resolve root, ensure layout. If not initialized → exit 1.
3. Read manifest. If `<skill>` not present → `error: unknown skill "<skill>"`, exit 1.
4. Read state.json to enumerate linkable tools.
5. Refuse if `<root>/.cache/staging/<skill>/` exists → `error: <skill> has a pending update; resolve with \`update --continue <skill>\` or delete .cache/staging/<skill>/ before removing`, exit 1.
6. Determine the live dir based on `kind`: `<root>/skills/<skill>/` for contrib, `<root>/authored/<skill>/` for authored.
7. Tear down, in this order, each step tolerant of "already gone":
   - For each linkable tool, delete `<linkTarget>/<skill>` if it exists. (Whether it's a symlink or — somehow — a real dir, remove it.)
   - Delete `<root>/skills/<skill>/` (if contrib) or `<root>/authored/<skill>/` (if authored).
   - Delete `<root>/patches/<skill>.patch` if present.
   - Delete every `<root>/.cache/pristine/<skill>@*/` directory. (Glob the prefix — there may be multiple historical refs if Phase 4 chose to keep them.)
8. Update manifest: delete `manifest.skills[<skill>]`. Update lockfile: delete `lock.skills[<skill>]`.
9. Print a summary listing each location that was removed (skip "not present" silently). Exit 0.

Edge cases:
- `<skill>` is the bundled `skills-manager` skill (an authored skill installed at `init` time). Allow removal but print a warning that future `init` will reinstall it. Don't refuse.
- Symlinks pointing at a non-existent target: `existsSync` returns false on a broken symlink. Use `lstatSync` (in a try/catch) to detect the symlink itself before deciding the path is absent.

### 2. Implement `runList()` in `src/commands/list.ts`

Replace the stub.

Behavior:
1. Resolve root, ensure layout. If not initialized → exit 1.
2. Read manifest + lockfile.
3. If no skills, print `No skills installed.` and exit 0.
4. Otherwise print one line per skill. Format suggestion (pick something stable and document it):
   ```
   <name>  <kind>  <ref-or-—>  <customized?>  <source-summary>
   ```
   Where:
   - `kind` is `contrib` or `authored`.
   - `ref` is the lockfile's `resolvedRef`, shortened to 12 chars if it looks like a hash, otherwise verbatim. `—` for authored.
   - `customized?` is `[customized]` if `<root>/patches/<name>.patch` exists and is non-empty, otherwise blank.
   - `source-summary` is `git:<url>#<ref>` / `url:<url>` / `local:<path>` / `—` for authored.
5. Sort alphabetically by name.
6. Use a tab-aligned or padded layout — read from a TTY, not piped through `column`. Don't add a dependency.
7. Support `--json` flag: print `JSON.stringify(list, null, 2)` instead, where each entry is `{ name, kind, ref, customized, source }`. Useful for the bundled agent skill to parse.

### 3. New tests: `tests/remove-list.test.js`

Cover:

**`list`:**
1. **Empty list.** After `init` only, `list` prints `No skills installed.` … wait — `init` installs the bundled `skills-manager` skill as authored. So `list` after `init` should show *one* entry. Adapt: after `init`, expect exactly one row, the bundled skill.
2. **List with contrib skill.** After `init` + `add <local-fixture>`, list shows two rows.
3. **List with `--json`.** Output parses as JSON, has the expected shape.
4. **Customized flag.** After adding a contrib skill and writing a non-empty patch file directly, list output contains `[customized]` for that row.

**`remove`:**
5. **Remove unknown skill** → exit 1.
6. **Remove a contrib skill** removes: `skills/<name>/`, `patches/<name>.patch` (if present), `.cache/pristine/<name>@*`, every tool symlink. Manifest no longer lists it.
7. **Remove an authored skill** removes `authored/<name>/` and tool symlinks. No pristine or patch to remove.
8. **Remove blocks when staging exists.** Manually create `<root>/.cache/staging/<name>/` → `remove <name>` exits 1.
9. **Remove of bundled `skills-manager` skill** prints a warning but succeeds.

## Code review (mandatory)

1. **Symlink detection.** Did you handle broken symlinks properly? Test 6 should catch this if you wrote it with a fake tool dir whose target you delete first.
2. **Order of operations in remove.** If manifest is updated *before* filesystem teardown and the teardown throws, the manifest is out of sync with disk. Conventional fix: filesystem first, manifest last (so a partial failure is recoverable by re-running `remove`). Confirm your order.
3. **List output is reproducible.** Same set of skills → same output. Sort matters.
4. **`--json` shape doesn't drift from the table shape.** Same fields. Easier to consume programmatically.
5. **No accidental dependency on `init` having installed Claude Code.** If the test's fake HOME doesn't `mkdirSync .claude`, no symlink exists; `remove` should still succeed (no-op on missing tool dirs). Test this.
6. **Hidden-file handling.** When deleting `.cache/pristine/<name>@*`, glob `<name>@*` literally, not `<name>*` (which would match a different skill named `<name>foo@v1`). Confirm.

## Verification

```bash
pnpm build
pnpm test
```

Manual smoke:
```bash
HOME=$(mktemp -d)
node bin/skills-manager.js init
node bin/skills-manager.js list                          # bundled skill only
node bin/skills-manager.js add /tmp/fake-skill
node bin/skills-manager.js list                          # two rows
node bin/skills-manager.js list --json | jq .
echo "drift" >> $HOME/.skills-manager/skills/<name>/SKILL.md
node bin/skills-manager.js save-patch <name>
node bin/skills-manager.js list                          # row shows [customized]
node bin/skills-manager.js remove <name>
node bin/skills-manager.js list                          # one row again
ls $HOME/.skills-manager/skills/                         # gone
ls $HOME/.skills-manager/.cache/pristine/                # gone
```

## What's out of scope

- `customize`, `new`, `tool`, `validate`, `doctor` — those are separate items in the **Next** section of [ROADMAP.md](../../ROADMAP.md).
- Editing `ROADMAP.md`.

## Done criteria

- `src/commands/remove.ts` and `src/commands/list.ts` no longer throw `NotImplementedError`.
- `tests/remove-list.test.js` covers the nine listed cases and passes.
- `pnpm build` and `pnpm test` green.
- Self-review pass completed.
