---
name: skills-manager
description: Manage agentskills.io-format skills via the skills-manager CLI. Use when the user asks to install, list, update, customize, diff, validate, or remove agent skills, or to scaffold a new skill. Operates on the user's single source of truth at ~/.skills-manager/ (or a workspace-local .skills-manager/) and reapplies customizations across re-downloads via unified-diff patches.
license: MIT
metadata:
  author: skills-manager
  version: "0.3.1"
---

# skills-manager

You are working with a user who has the `skills-manager` CLI installed. It manages [agentskills.io](https://agentskills.io/specification)-format skills across all of the user's AI agent tools, with a single source of truth at `~/.skills-manager/` (user-global) or `<workspace>/.skills-manager/` (workspace-local).

Use this skill whenever the user asks you to:

- Add, install, or download a skill from a source (git repo, URL, local path).
- List, find, or audit installed skills.
- Update one or all skills.
- Customize a contrib skill (and have the customization survive future updates).
- Show diffs between a customized skill and its pristine.
- Save the current customization as a patch.
- Scaffold a new self-authored skill.
- Create, configure, or apply skill presets.
- Migrate/promote a workspace-local skill up to the global SSOT.
- Validate skills or diagnose the manager's environment.
- Inspect or toggle which tools the manager links skills into.

## How it works (model the user has set up)

- `~/.skills-manager/` is the **single source of truth**. Every skill on the host lives there.
- `~/.skills-manager/skills/` holds **contrib** skills (downloaded from a source). `~/.skills-manager/authored/` holds **self-authored** skills.
- Each agent tool sees its skills via **symlinks** from its own dir (e.g. `~/.claude/skills/<name>` → `~/.skills-manager/.../skills/<name>`).
- Local edits to contrib skills are stored as **unified-diff patches** in `~/.skills-manager/patches/<name>.patch`. They reapply on every `update`. A pristine snapshot is kept in `~/.skills-manager/.cache/pristine/<name>@<ref>/`.
- Workspace-local `.skills-manager/` directories are isolated from global; the CLI warns when names overlap.

## Command reference

Run `skills-manager <verb> [args]` from a terminal.

| Verb | Purpose |
|------|---------|
| `init [--local] [--preset=<name>]` | Bootstrap the SSOT, detect agent tools, install this manager skill, link it into native-SKILL.md tools. Use `--local` for workspace scope. Supports bootstrapping with a preset. |
| `add <source>` | Install a contrib skill from a git repo (owner/repo or URL), direct URL, or local path. |
| `list` | List installed skills with source, ref, and whether they're customized (drifted vs. pristine). |
| `remove <skill>` | Uninstall a skill (removes its files, patch, pristine, and tool symlinks). |
| `update [<skill>...]` | Re-resolve sources and reapply patches. Bare `update` = all skills. |
| `update --continue <skill>` | Resume a paused update after manually resolving conflicts. |
| `diff <skill>` | Show drift vs. pristine for a customized skill. |
| `save-patch <skill>` | Persist current drift to `patches/<skill>.patch`. |
| `customize <skill>` | Open the skill dir in `$EDITOR`. |
| `new <name>` | Scaffold a new self-authored skill in `authored/<name>/`. |
| `preset <list\|create\|add\|remove>` | Configure custom presets, add/remove skills, or list presets. |
| `promote <skill>` | Migrate a workspace-local skill (authored or contrib) to the global SSOT. |
| `tool list` | Show detected tools and which are link targets. |
| `tool enable <name>` / `tool disable <name>` | Enable or disable a tool for symlink linking immediately. |
| `validate [<skill>]` | Validate a skill (or all skills) via `skills-check` subprocess. |
| `doctor [--all]` | Print environment diagnostics. Use `--all` to run across all registered workspace and global scopes. |

All verbs in this command set are fully implemented and integrated.

## Workflow guidance

1. **Always check the user's intended scope first.** If the current working directory contains `.skills-manager/`, prefer workspace scope; otherwise default to global. Mention which one you're operating on.
2. **Before destructive actions** (remove, force-update with conflicts), confirm with the user.
3. **When a customization has drifted**, default to `skills-manager save-patch <skill>` before any `update`, so the latest edits are captured.
4. **On update conflicts**, do not force-resolve. The CLI leaves a staging dir with conflict markers; help the user resolve them and then run `skills-manager update --continue <skill>`.
5. **Prefer named skills over paths** when invoking the CLI; the manager resolves names against both `skills/` and `authored/`.
6. **Keep self-authored separate from contrib.** Self-authored skills live in `authored/`, do not have patches, and should be edited directly. Contrib skills live in `skills/` and customizations belong in `patches/`.

## Common patterns

- "Add the X skill from anthropics/skills" → `skills-manager add anthropics/skills/<x>` (the CLI handles git resolution and pinning).
- "Update everything" → `skills-manager update`.
- "What did I change in the X skill?" → `skills-manager diff x`.
- "Make my edit to X stick across updates" → `skills-manager save-patch x`.
- "Start a new skill called Y" → `skills-manager new y`, then edit `~/.skills-manager/authored/y/SKILL.md`.
- "Create a new preset called frontend with the journal skill" → `skills-manager preset create frontend` and `skills-manager preset add frontend journal`.
- "Move the workspace skill to global" → `skills-manager promote <skill>`.

## Limitations to surface honestly

- v1 only links into tools that natively consume the agentskills.io `SKILL.md` spec (Claude Code, Antigravity CLI, GitHub Copilot CLI; Hermes and Openclaw if installed). Cursor, Codex, OpenCode, Crush, and Aider are detected but not yet linked — adapters are on the roadmap.

See `ROADMAP.md` in the source repo for full architecture, decisions, and roadmap.
