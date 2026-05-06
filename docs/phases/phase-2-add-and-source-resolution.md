# Phase 2 — `add <source>` + source resolution

## Mission

Replace the throwing stub at `src/core/skills-cli.ts` with a real `resolveSource()` that handles the three source types in the spec, then implement `runAdd()` end-to-end so a user can install a contrib skill into the SSOT and have it linked into every native-`SKILL.md` tool.

This is the first user-visible verb beyond `init` / `adopt`. After this phase, `add` followed by `list` (Phase 5) gives a complete install flow even before `update` lands.

## Project orientation (read first)

Read in order:

1. [AGENTS.md](../../AGENTS.md) — full re-read. Pay particular attention to **Source resolution**, **Directory layout**, and **Tool detection**. The CLI surface table tells you what `add` is supposed to do at the user level.
2. [README.md](../../README.md) — section "Sources" describes the three accepted inputs from a user POV.
3. [src/core/paths.ts](../../src/core/paths.ts), [src/core/manifest.ts](../../src/core/manifest.ts), [src/core/state.ts](../../src/core/state.ts), [src/core/tool-detect.ts](../../src/core/tool-detect.ts) — primitives you'll compose.
4. [src/commands/init.ts](../../src/commands/init.ts) — read in full. It already does *most* of what `add` needs: place a skill directory at the SSOT and symlink it into native-`SKILL.md` tool dirs. Reuse, don't duplicate.
5. [src/commands/adopt.ts](../../src/commands/adopt.ts) — copy its style for argument parsing, error messages, and stdout chattiness.
6. [src/core/skills-cli.ts](../../src/core/skills-cli.ts) — the file you're rewriting.
7. [tests/init.test.js](../../tests/init.test.js) — the test pattern to follow.

Conventions: see `phase-1-patch-helpers.md` "Project orientation" — same rules.

**Confirm Phase 1 is merged before starting.** This phase doesn't import from `src/core/patch.ts` directly, but the next phases assume Phase 1 exists; don't get ahead of the order.

## Deliverables

### 1. Rewrite `src/core/skills-cli.ts`

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

### 2. Implement `runAdd()` in `src/commands/add.ts`

Replace the stub. The flow:

1. Validate input. If `args.source` is missing, write `error: usage: skills-manager add <source>` and return 1.
2. Resolve the SSOT root via `resolveRoot()` and ensure layout. If `skills.json` is missing, error: not initialized.
3. Read manifest + lockfile.
4. Call `resolveSource(args.source, root.path)` → `{ ref, pristinePath, skillName, source }`.
5. Reject if `skillName` already exists in `manifest.skills` (suggest `remove` then `add`, or `update`).
6. Copy the pristine tree to `<root>/skills/<skillName>/` (a fresh, real directory — not a symlink).
7. Update manifest: `manifest.skills[skillName] = { kind: "contrib", source }`. Update lockfile: `lock.skills[skillName] = { resolvedRef: ref, resolvedAt: new Date().toISOString() }`.
8. Read `state.json` and link `<root>/skills/<skillName>/` into every linkable native-`SKILL.md` tool's link target — same logic `init` uses for the bundled skill, just for an arbitrary skill name. **Reuse, don't duplicate.** If `init` does this inline, refactor a small helper into `src/core/linker.ts` (or wherever feels least invasive) and call it from both. Pure refactor, no behavior change.
9. Print a summary: `added <name> @ <short-ref> (<source-summary>)` and a list of tools it was linked into.

Idempotency: If the operation fails midway, leave a coherent state. The simplest approach: do step 6 (copy to skills/) after the pristine cache is fully populated, do steps 7–8 atomically (write manifest *after* successful symlinking), and on any thrown error inside steps 6–8, attempt cleanup of partial copies in `skills/<name>/` before re-throwing. Do not attempt to roll back the pristine cache — it's content-addressed, harmless if stale.

### 3. New tests: `tests/add.test.js`

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

1. **Cleanup on partial failure.** If `runAdd` throws after copying to `skills/<name>/` but before writing the manifest, what's left on disk? Trace it.
2. **Symlink target stability.** If the user later moves the SSOT, all symlinks break. That's expected; not yours to solve. But confirm the symlink target is the *absolute* SSOT path, not a relative path from a tool dir.
3. **Refactor honesty.** If you extracted a `linkSkillIntoTools` helper, does `init.ts` actually call it now, or did you leave a duplicate? Don't ship duplication.
4. **Frontmatter parser.** Does it handle CRLF line endings? Tab-prefixed values? Quoted values (`name: "foo"`)? Test at least one of these or accept a constrained subset and document it.
5. **Path-injection safety.** Source strings come from the user. Make sure `safeRefSegment` strips `..`, `/`, and shell metacharacters before they hit a filesystem path. Confirm by passing a hostile fixture name.
6. **No hidden network calls in the local-path test.** Run it in `--network-disabled` mode if your harness supports it; otherwise read the test code with hostile eyes.

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
- Editing `ROADMAP.md` checkboxes — the user does that.
- Adding npm dependencies.

## Done criteria

- `src/core/skills-cli.ts` rewritten, `SkillsCliUnavailableError` removed.
- `src/commands/add.ts` no longer throws `NotImplementedError`.
- Linker helper extracted if applicable; `init.ts` uses it.
- `tests/add.test.js` covers the five listed cases and passes.
- `pnpm build` and `pnpm test` green.
- Self-review pass completed.
