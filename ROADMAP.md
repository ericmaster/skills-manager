# Roadmap

What `skills-manager` is working on, what's next, and what has been considered and deliberately deferred. Each item carries enough rationale that you can tell whether it's worth re-opening.

Living document — tick a box when the work lands. Each "Now" item links to a phase prompt under [docs/phases/](docs/phases/) designed to be fed to a fresh agent session in a single iteration. Whenever a checkbox flips to ticked, also flip the matching row in the **CLI surface** table at [AGENTS.md](AGENTS.md) from `Stub` to `Wired`.

## Now (v0.4.0 — Adapters & Programmatic API)

The next priority focuses on building adapters for non-native tools and exporting a programmatic API.

- [ ] **Adapters for non-native tools.** Translate `SKILL.md` instructions and scripts into Cursor `.mdc` system rules and Aider configurations.
- [ ] **Programmatic API export.** Export the core engine functions from the package so IDE extensions, other developer tools, or third-party wrappers can build on top of `skills-manager` programmatically.

## Released

### v0.3.0 — Tooling & Validation
- [x] **`validate [<skill>]`** wrapping `skills-check`. Formally validate `SKILL.md` schema, frontmatter compliance, and required folder structure.
- [x] **`tool list` / `tool enable <name>` / `tool disable <name>`.** Fine-grained control to selectively opt detected tools in or out of symlink management.
- [x] **Curated starter sets.** `init --preset coding`, `--preset productivity`, etc. — provision a useful, high-quality baseline of skills on first run.
- [x] **`promote <skill>` (Workspace-to-Global Migration):** Move/promote a workspace-local skill (authored or customized contrib) to the global SSOT, updating manifests and re-linking tools so it is available to all projects.
- [x] **Global Overview Diagnostics (`doctor --all` / `status`):** Provide a global overview of the user's home and detected workspace status, displaying active SSOTs, link sites, and any unmanaged skills per workspace.

### v0.2.0 — Workspace & Authoring Experience
- [x] **Workspace scope second-pass.** Workspace mode is documented in [AGENTS.md](AGENTS.md) but not yet exercised end-to-end. Verify every command honors `<cwd>/.skills-manager/` when present, guarantees strict isolation from the global store, and add a robust integration smoke test.
- [x] **`new <name>`** scaffolding command. Scaffold a new self-authored skill in `authored/<name>/` with a clean `SKILL.md` template matching the [agentskills.io](https://agentskills.io/specification) format.
- [x] **`customize <skill>`** command. Open the live skill in the user's `$EDITOR` (checking `process.env.EDITOR`, falling back to common editors or printing helpful fallback instructions).
- [x] **`doctor`** diagnostic command. Probes environment health, checks symlink validity, identifies broken/orphaned links, and provides actionable self-healing guidance.

### v0.1.0 — Core SSOT & Patch Engine
- [x] **Phase 1 — Patch helpers foundation.** [docs/phases/phase-1-patch-helpers.md](docs/phases/phase-1-patch-helpers.md)
  Pure helpers in `src/core/patch.ts`: `diffSkill`, `savePatch`, `applyPatch3Way`. No command wiring. Tests in `tests/patch.test.js`.
- [x] **Phase 1.5 — Linker seam.** [docs/phases/phase-1.5-linker-seam.md](docs/phases/phase-1.5-linker-seam.md)
  Extract symlink placement (and removal) into `src/core/linker.ts`. Refactor `init` and `adopt` to use it; ship the `unlink` half too so Phase 5 inherits a coherent seam. Pure refactor — no user-visible behavior change. Tests in `tests/linker.test.js`.
- [x] **Phase 2 — `add <source>` + source resolution + adoption planner.** [docs/phases/phase-2-add-and-source-resolution.md](docs/phases/phase-2-add-and-source-resolution.md)
  Three pieces. (1) Extract winner/loser/split logic from `runAdopt` into a pure `src/core/adoption.ts` (planner / executor / formatter); refactor `runAdopt` to use it. (2) Replace the stub in `src/core/skills-cli.ts` with a real `resolveSource()`. (3) Implement `runAdd()` end-to-end. Tests in `tests/adoption.test.js` and `tests/add.test.js`; `tests/adopt.test.js` passes unchanged.
- [x] **Phase 3 — `diff <skill>` + `save-patch <skill>`.** [docs/phases/phase-3-diff-and-save-patch.md](docs/phases/phase-3-diff-and-save-patch.md)
  Wire both commands to the helpers from Phase 1. Tests in `tests/diff-save-patch.test.js`.
- [x] **Phase 4 — `update` clean + conflict + `--continue` + SSOT store.** [docs/phases/phase-4-update.md](docs/phases/phase-4-update.md)
  Two pieces. (1) Extract `readManifest` / `writeManifest` / `readLockfile` / `writeLockfile` / `readState` / `writeState` behind a single `SsotStore` class in `src/core/ssot.ts` with atomic commit; migrate every existing caller. (2) Implement the full update flow from [AGENTS.md](AGENTS.md): save-patch → re-resolve to staging → `git apply --3way` → atomic swap, or leave conflict markers and pause. Tests in `tests/ssot.test.js` and `tests/update.test.js`; existing tests pass unchanged.
- [x] **Phase 5 — `remove <skill>` + `list`.** [docs/phases/phase-5-remove-and-list.md](docs/phases/phase-5-remove-and-list.md)
  Tear down all artifacts and tool symlinks; list with the `customized` flag. Tests in `tests/remove-list.test.js`.


## Considered, not pursuing right now

Features that exist in adjacent skill-management tools and could plausibly land here, but that the project has consciously chosen not to build. Each one has a reason and a "revisit if…" trigger so this list isn't a permanent veto — just a clear current scope.

- **Interactive TUI (fullscreen browser).** Doesn't reinforce the differentiators; the CLI surface is meant to be agent-driven via the bundled skill, not human-driven via a fullscreen UI. *Revisit if* non-agent users become a meaningful audience.
- **Built-in MCP server exposing skill operations.** The bundled agent skill at `src/bundled-skills/skills-manager/SKILL.md` already lets an LLM drive the CLI by intent. MCP would be a parallel mechanism, not an additive one. *Revisit if* a host emerges that supports MCP but not bundled skills.
- **Per-skill version history with rollback.** Orthogonal to the patch model — the patch lifecycle is *the* version-control story for contrib skills, and `authored/` skills are expected to live in user-managed git. *Revisit if* `authored/` skills need history independent of git.
- **Inter-skill dependency resolution / topological sort on install.** No observed demand and the [agentskills.io spec](https://agentskills.io/specification) doesn't model dependencies. *Revisit if* the spec adopts a deps field.
- **Hook-based session activation tied to a single tool.** Single-tool-specific (Claude Code hooks, etc.); doesn't fit the multi-agent framing. *Revisit if* a portable activation hook spec emerges.
- **Usage analytics tracking per-skill stats.** Privacy and product-value questions outweigh the benefit at this stage. *Revisit if* concrete user feedback asks for it.
- **Auto-suggesting skills based on project triggers.** Belongs in the agent layer — the consuming tool decides when to load a skill — not in `skills-manager`. *Revisit if* the spec gains a trigger-manifest concept.

If you'd like to argue any of these back onto the roadmap, open an issue and reference the rationale here so the discussion starts from current state, not first principles.
