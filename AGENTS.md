# skills-manager

> Single source of truth for project development. `CLAUDE.md` points here.
> Keep lean: minimum words, no fluff or history. Architecture and functional requirements only — user-facing docs live in [README.md](README.md). Update with every drift.

## Glossary

| Term | Meaning |
|------|---------|
| **Skill** | Directory matching the [agentskills.io spec](https://agentskills.io/specification): a `SKILL.md` with required `name` and `description` frontmatter, optionally `scripts/`, `references/`, `assets/`. Extra frontmatter preserved verbatim. |
| **Source** | Origin of a contrib skill: git repo (multi- or single-skill), direct URL to file/tarball, or local path. |
| **Contrib skill** | Skill installed from an external source. Tracked in `skills.json`, mirrored to pristine cache, optionally patched. |
| **Self-authored skill** | Skill the user wrote locally. Lives in `authored/`, no pristine, no patch. |
| **Pristine** | Unmodified contrib skill at resolved upstream ref, kept in `.cache/pristine/<name>@<ref>/`. Diff base. |
| **Patch** | Unified diff at `patches/<name>.patch` representing user customization vs. pristine. |
| **SSOT** | `~/.skills-manager/` (user) or `<workspace>/.skills-manager/` (workspace). The only place skill files live; tool dirs hold symlinks. |
| **Scope** | *user-global* (default) or *workspace-local*. Fully isolated — no inheritance. |
| **Tool** | AI agent CLI/IDE that consumes skills. Detected by filesystem probes. |
| **Link site** | Path under a Tool's link target where a Skill is exposed via symlink to its SSOT location (e.g. `~/.claude/skills/<name>`). Created and removed only by the linker (`src/core/linker.ts`). |

## Directory layout

```
~/.skills-manager/
├── skills.json              # declared skills + sources
├── skills.lock.json         # resolved refs/commits/checksums
├── state.json               # detected tools, link targets, cache stamps
├── skills/<name>/SKILL.md   # contrib skills, linked into tools
├── authored/<name>/SKILL.md # self-authored skills, linked into tools
├── patches/<name>.patch
└── .cache/pristine/<name>@<ref>/
```

Workspace scope (`<workspace>/.skills-manager/`) is identical in shape and fully isolated from global. Duplicate skill names print a warning; do not block.

## Layer cake

```
┌─────────────────────────────────────────────────────────┐
│  Bundled `skills-manager` agent skill (SKILL.md)        │  ← agents read
│  Tells the agent when/how to call the CLI               │
├─────────────────────────────────────────────────────────┤
│  `skills-manager` CLI (Node/TypeScript)                 │  ← humans run
│  Owns SSOT, manifest, patches, update orchestration     │
├─────────────────────────────────────────────────────────┤
│  vercel-labs/skills CLI (subprocess)                    │  ← we wrap
│  Source resolution, multi-agent linking primitives      │
└─────────────────────────────────────────────────────────┘
```

The CLI shells out to `npx skills <verb> ...` for source resolution and tool installation primitives. Invocation contracts stubbed in `src/core/skills-cli.ts`, finalized when `add` / `update` are implemented.

## Tool detection

`src/core/tool-detect.ts` probes for canonical config dirs and binaries on `PATH`. Runs every invocation; cached in `state.json`, invalidated when probe outputs change.

| Tool | Probe | Native SKILL.md? | v1 link target |
|------|-------|------------------|----------------|
| Claude Code | `~/.claude/` exists | Yes | `~/.claude/skills/` |
| hermes | `~/.hermes/` exists | Yes (assumed) | `~/.hermes/skills/` |
| openclaw | `~/.openclaw/` exists | Yes (assumed) | `~/.openclaw/skills/` |
| Codex CLI | `codex` on PATH or `~/.codex/` | Pending | n/a v1 |
| Cursor | `~/.config/Cursor/` or app dir | No (`.mdc`) | n/a v1 |
| Antigravity CLI | `~/.gemini/antigravity/` exists | Yes | `~/.gemini/skills/` |
| Antigravity IDE | `~/.gemini/antigravity-ide/` exists | Yes | `~/.gemini/config/global_workflows/` |
| GitHub Copilot CLI | `~/.copilot/` exists | Yes | `~/.copilot/skills/` |
| OpenCode | `~/.config/opencode/` exists | Pending | n/a v1 |
| Crush | `~/.config/crush/` exists | Pending | n/a v1 |
| Aider | `aider` on PATH | No | n/a v1 |

Non-native tools listed in `doctor` output, skipped during linking with a "v1 limitation" note. Adapters deferred.

## Source resolution

| Type | Resolution |
|------|------------|
| Git repo (multi-skill) | Clone shallow → resolve `<subpath>/<name>/SKILL.md` |
| Git repo (single skill) | Clone shallow → root is the skill |
| Direct URL | Fetch → unpack/place |
| Local path | Symlink-into-pristine; treated as remote-less repo |

All resolution goes through `vercel-labs/skills`; final pinned ref recorded in `skills.lock.json`.

## Update flow

`skills-manager update [<name>...]` per skill:

1. **Save current patch** — regenerate `patches/<name>.patch` from `skills/<name>/` vs. on-disk pristine, capturing uncommitted drift before overwrite.
2. **Re-resolve source** — fetch latest matching ref into a staging dir (not into `skills/<name>/`).
3. **Apply patch** with `git apply --3way` against new pristine in staging.
4. **Clean apply** — atomically swap `skills/<name>/` to staging, replace pristine cache, update `skills.lock.json`.
5. **Conflict** — leave staging with conflict markers, do not swap, keep live `skills/<name>/` untouched, instruct user to resolve in staging and resume with `update --continue <name>`.
6. **`--continue`** — re-runs steps 4–5 against the resolved staging tree.

Scope: `update` (all) or `update <skill>...`. `--source <name>` filtering deferred.

## Customization model

Contrib skills are edit-in-place at `~/.skills-manager/skills/<name>/`. `diff` shows drift vs. pristine; `save-patch` regenerates `patches/<name>.patch`. Save-patch runs implicitly at every `update` start.

Self-authored skills (`authored/<name>/`) are not patched — the directory is the source.

## Adoption

For users with skills already installed in tool dirs (e.g. real `~/.claude/skills/<name>/` directories from before SSOT). `adopt` is opt-in and never runs implicitly — `init` only reports candidates via `doctor`-style output.

Scan rules in `src/core/adopt-scan.ts`:

- Walk every linkable tool's link target (`~/.claude/skills/`, etc.).
- Candidate = real directory containing `SKILL.md`. Symlinks are ignored (already managed somewhere).
- Skip names already present in `skills.json`.
- Group by skill name across tools; classify as **single**, **duplicate-identical** (sha256 of tree matches), or **duplicate-conflict**.

Adoption (`adopt <name>` / `adopt --all`):

1. Move winning copy into `authored/<name>/`. v1 always adopts as `authored`; contrib adoption deferred until `add` is wired.
2. Identical duplicates: silently delete the redundant copies.
3. Conflicting duplicates: require `--from <tool>`; back losing copies up to `.cache/adopted-backup/<iso>/<tool>/<name>/`. Optional `--keep-other-as <new-name>` to adopt the loser as a separately-named authored skill instead of discarding it.
4. Replace each original location with a symlink into `authored/<name>/`.
5. Record in `skills.json` as `kind: "authored"`.
6. `--dry-run` prints the plan only.

`adopt --all` adopts every non-conflicting candidate and lists the conflicts at the end.

## CLI surface

| Command | Status | Effect |
|---------|--------|--------|
| `init [--local]` | Wired | Create SSOT root, scaffold manifest+state, detect tools, install bundled agent skill, link into native tools. `--local` → `<cwd>/.skills-manager/`. |
| `adopt [<name>] [--all]` | Wired | Pull pre-existing real-dir skills out of detected tool dirs into the SSOT. Default kind: `authored`. Flags: `--from <tool>` and `--keep-other-as <name>` for cross-tool conflicts; `--dry-run`. |
| `add <source>` | Wired | Install contrib skill from a source. |
| `list` | Wired | List installed skills with source + ref + customized flag. |
| `remove <skill>` | Wired | Remove skill, patch, pristine, tool symlinks. |
| `update [<skill>...]` | Wired | Re-resolve sources and reapply patches. |
| `update --continue <skill>` | Wired | Resume a paused update after manual conflict resolution. |
| `diff <skill>` | Wired | Show patch drift between live skill and pristine. |
| `save-patch <skill>` | Wired | Persist drift to `patches/<skill>.patch`. |
| `customize <skill>` | Wired | Open skill dir in `$EDITOR`. |
| `new <name>` | Wired | Scaffold new self-authored skill in `authored/<name>/`. |
| `tool list` | Planned (v0.3.0) | Show detected tools and link status. |
| `tool enable <name>` / `tool disable <name>` | Planned (v0.3.0) | Opt a detected tool in or out of linking. |
| `validate [<skill>]` | Planned (v0.3.0) | Wraps `skills-check`. |
| `promote <skill>` | Planned (v0.3.0) | Move/promote a workspace-local skill to the global SSOT. |
| `link-local [dir] [--dry-run]` | Wired | Bridge a repo's `.agents/skills/*` packs into per-tool project skill dirs (`.claude/skills`) via relative, clone-portable symlinks — for tools that don't yet read the tool-agnostic `.agents/skills` convention natively. Idempotent; refuses to clobber real dirs. |
| `doctor [--all]` / `status` | Planned (v0.3.0) | Print global diagnostic status, active SSOTs, link sites, and workspace overviews. |
| `doctor` | Wired | Print SSOT root, detected tools, dependencies, warnings. |

Stubs throw `NotImplemented`; surface is stable and discoverable.

## Bundled agent skill

`src/bundled-skills/skills-manager/SKILL.md`. Copied (not symlinked) into `<root>/authored/skills-manager/` during `init`, then linked into each native-SKILL.md tool dir. Teaches the consuming agent when to invoke the CLI.

## Roadmap

Phased plan, plus the explicit list of features considered and deferred, lives in [ROADMAP.md](ROADMAP.md). Check it before proposing a new direction.

## Architecture decisions

Load-bearing decisions are recorded as ADRs in [docs/adr/](docs/adr/). Read the relevant ones before proposing architectural changes — many directions look attractive in isolation but were considered and deliberately closed off there.

## Conventions

- **Node:** ≥ 22.
- **Package manager:** pnpm.
- **Language:** TypeScript, strict mode.
- **Lint/format:** Prettier defaults; ESLint with `@typescript-eslint` (added when needed).
- **Testing:** `node --test` (built-in runner) for v1, no extra deps.
- **Commits:** Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).
- **Distribution:** `npm publish` as `skills-manager`; `npx skills-manager <verb>` or global install.
