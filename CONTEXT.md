# skills-manager

A single source of truth (SSOT) and lifecycle manager for AI agent skills across native-SKILL.md tools.

## Language

**SSOT**:
The single source of truth directory where all skill files live. Can be user-global (`~/.skills-manager/`) or workspace-local (`<workspace>/.skills-manager/`).
_Avoid_: Local cache, store, config dir.

**Skill**:
A capability directory containing a `SKILL.md` (with name and description YAML frontmatter), optionally containing scripts, references, and assets.
_Avoid_: Agent command, tool configuration, prompt rule.

**Contrib skill**:
An external skill installed into the SSOT from a remote or local **Source**. Tracked in `skills.json` and mirrored in the pristine cache.
_Avoid_: Remote skill, package, plugin.

**Self-authored skill**:
A locally written skill created by the user that lives in the `authored/` folder. It does not have a pristine cache entry or patch.
_Avoid_: Custom skill, local skill, user skill.

**Pristine**:
An unmodified copy of a **Contrib skill** at a resolved upstream ref, stored in `.cache/pristine/<name>@<ref>/` as a diff base for patches.
_Avoid_: Original, default copy, upstream base.

**Patch**:
A unified diff at `patches/<name>.patch` capturing the user's local customized drift in their live skill directory versus the pristine copy.
_Avoid_: Diff file, modification, custom patch.

**Link site**:
A directory inside a native **Tool's** link target (e.g. `~/.claude/skills/<name>`) exposed as a symlink pointing directly to the corresponding skill under the SSOT.
_Avoid_: Skill link, install path, export site.

**Tool**:
An AI agent CLI or IDE application (e.g. Claude Code, Antigravity CLI) that is detected via filesystem probes.
_Avoid_: Consumer, runtime, client application.

**Tool Enablement**:
The active state of a native **Tool** (tracked in `state.json`), representing whether the linker should manage symlinks for it.
_Avoid_: Tool status, active tool, registration.

**Preset**:
A named collection of skills (e.g., `coding`, `productivity`) that can be bulk-installed upon bootstrap or managed via the CLI.
_Avoid_: Bundle, starter set, template.

**Custom Preset**:
A user-defined **Preset** created via the CLI and persisted in `presets.json` under the SSOT root.
_Avoid_: User template, user bundle.

**Promotion**:
The process of migrating a workspace-local skill (and any associated pristine cache and patch files) up to the global SSOT.
_Avoid_: Upgrade, push, globalize, publish.

## Example Dialogue

> **Dev**: "I noticed Claude Code isn't picking up my custom prompt edits."
> 
> **Domain Expert**: "Did you customize a **Contrib skill** or a **Self-authored skill**? If it's a **Contrib skill**, you edit the files in-place under the **SSOT** `skills/` directory. The manager will preserve those edits by generating a **Patch** vs. **Pristine** when you perform an update."
> 
> **Dev**: "It's a customized contrib skill, but I only want these changes active for this project."
> 
> **Domain Expert**: "Then you should initialize a workspace-local **SSOT** by running `init` with `--local`. The workspace **Scope** is fully isolated, and the manager will update the **Link sites** to point to your workspace-local SSOT instead of the global one."
