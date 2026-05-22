# ADR-0009 — Track local workspace scopes via lazy global state registration

**Status:** Accepted
**Date:** 2026-05-22

## Context

`skills-manager` supports two scopes: *user-global* (default) and *workspace-local* (isolated scope stored at `<workspace>/.skills-manager/`). 

In v0.3.0, we want to support global diagnostics (`doctor --all` / `status`) which presents a unified health overview of the global SSOT and all active workspace SSOTs across the user's filesystem. 

However, because `skills-manager` workspace directories are simply created locally via `init --local` or exists as normal folders, there is no native way for a global CLI invocation to automatically discover where every workspace-local SSOT resides on the host machine. 

We considered two primary approaches for workspace discovery:
1. **Active disk scanning:** Walk directory trees starting from `$HOME` or other paths looking for `.skills-manager/` folders.
2. **Centralized state registry:** Register workspace absolute paths inside the global user state (`~/.skills-manager/state.json`) and query them directly.

## Decision

We will use a centralized state registry stored in the user-global `~/.skills-manager/state.json`. To keep tracking robust, self-healing, and low-overhead, registration and pruning will occur lazily:

- **Lazy Registration:** Every time any `skills-manager` command is executed within a workspace-local scope, the CLI will check if the current workspace path is registered in the global `state.json`. If not, it will be added dynamically.
- **Lazy Pruning:** When `doctor --all` / `status` is executed, it will verify the existence of each registered workspace path. Any workspace directory that has been deleted, moved, or no longer contains a valid `.skills-manager/` folder will be pruned from the global `state.json` registry.

## Consequences

- **Performance:** `doctor --all` runs in milliseconds because it performs direct filesystem checks on a predefined list of paths, completely avoiding costly and slow recursive directory traversals.
- **Privacy & Security:** Zero unauthorized walking of sensitive directories on the developer's filesystem. No potential permission error loops.
- **Self-Healing:** Workspaces that are deleted or moved are pruned cleanly without leaving orphaned records, keeping the global registry minimal and current.
- **Limitation:** Workspaces created via manual file copies or initialized without subsequently running a `skills-manager` command will not show up in `doctor --all` until a command is run inside them, or until they are visited and run. This is acceptable as those workspaces are effectively dormant.
