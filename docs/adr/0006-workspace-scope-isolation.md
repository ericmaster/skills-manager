# ADR-0006 — Workspace scope is fully isolated from global

**Status:** Accepted
**Date:** 2026-05-06

## Context

Some users want a per-project skill set (e.g. a repo-specific workflow skill that doesn't pollute the global agent context); others want a single global set across all projects. A naive "merge global with workspace" approach mixes the two and introduces precedence rules that are surprising under churn ("which copy is active right now?").

## Decision

Two scopes, fully isolated:

- **Global**: `~/.skills-manager/`
- **Workspace**: `<workspace>/.skills-manager/`

`resolveRoot()` walks up from `cwd`. If it finds a workspace SSOT, that scope wins for the entire CLI invocation; otherwise global. There is **no** inheritance, **no** merging, **no** fallback from workspace to global for individual skills.

Tool detection still runs against `$HOME` regardless of scope (the user's tool installs don't move with the project), but symlinks land in the active scope's link sites.

## Consequences

- Predictable behavior — what you see in `list` is what's active.
- Duplicate skill names across scopes don't surprise the user: only one scope is active at a time. If both exist, a warning prints when the inactive scope is detected nearby; no silent override.
- Users wanting a hybrid (e.g. global productivity skills + workspace-specific coding skills) must duplicate or re-author. Accepted as the price of clarity; revisit if real demand emerges.
- A workspace SSOT and a global SSOT can both be linked into the same tool's link target *only if the user has run `init` in both, in different sessions*. Tool dirs hold one symlink per skill name; later runs replace earlier ones. That's by design.
