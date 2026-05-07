# ADR-0001 — SSOT under `~/.skills-manager/`; tools get symlinks

**Status:** Accepted
**Date:** 2026-05-06

## Context

Each agent tool has its own canonical skill directory: Claude Code reads `~/.claude/skills/`, Hermes reads `~/.hermes/skills/`, etc. A user with multiple tools either duplicates skills across them (drift, no shared edits) or commits to one tool (lock-in). There is no shared concept of "this is *the* skill, regardless of which tool consumes it."

## Decision

Single source of truth for skill *content* lives at `~/.skills-manager/` (global) or `<workspace>/.skills-manager/` (workspace). Skill files only ever live under the SSOT — `skills/<name>/` for contrib, `authored/<name>/` for self-authored. Tool directories receive **symlinks** at their canonical paths (e.g. `~/.claude/skills/<name>` → `~/.skills-manager/{authored,skills}/<name>/`).

Symlink targets are absolute paths into the SSOT. The linker (`src/core/linker.ts`) is the only module that creates or removes them; it refuses to touch real directories at a Link site, leaving that policy to callers.

## Consequences

- Edit once = updated for every tool. Removes the cross-tool drift that motivated the project.
- Deleting a tool's config dir doesn't lose skill content; re-running `init` re-establishes the symlinks.
- Tools that don't natively read `SKILL.md` (Cursor `.mdc`, Aider, etc.) are detected but not linked in v1; adapters are deferred (see ROADMAP "Next").
- Migrating the SSOT to a different path requires re-running `init` — every symlink target is absolute and breaks under a move. Acceptable because moves are rare and the breakage is loud (tools just stop seeing the skill).
- Adoption (`adopt`) is the migration path for users with pre-existing real directories under tool dirs: move the content into the SSOT, replace the original location with a symlink.
