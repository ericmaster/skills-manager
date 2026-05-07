# ADR-0002 — Customize contrib skills in-place with patches against a pristine cache

**Status:** Accepted
**Date:** 2026-05-06

## Context

Users want to tweak contrib skills (rename a section, add a project-specific example, drop a paragraph) while still pulling improvements from the upstream source. The available shapes:

1. **Fork-per-skill** — user maintains a fork of every contrib skill's repo. High overhead, scattered git history, no story for direct-URL or local-path sources.
2. **Overlay** — user keeps an "additions" file alongside the original. Doesn't compose for edits or removals; the user can't *change* upstream content.
3. **Mutate-in-place, lose lineage** — user edits the live skill freely, but on `update` the changes vanish or conflict opaquely with no diff base.
4. **Mutate-in-place, persist a patch** — user edits live; tool derives a diff against the unmodified upstream content; on `update`, re-resolve upstream and reapply the patch with explicit conflict surfacing.

## Decision

Option 4. Live skills under `skills/<name>/` are edited directly. An immutable copy of the resolved upstream tree lives at `.cache/pristine/<name>@<ref>/`. `save-patch <name>` runs `git diff --no-index pristine live` and writes the result to `patches/<name>.patch`. `update <name>` re-resolves upstream into a staging tree, then `git apply --3way` reapplies the patch:

- Clean apply → atomically swap the staging tree into `skills/<name>/`, refresh pristine, update `skills.lock.json`.
- Conflict → leave the staging tree with merge markers and instruct the user to resolve, then resume with `update --continue`.

`save-patch` runs implicitly at the start of every `update` to capture uncommitted drift before the swap.

## Consequences

- "Survivable customization across upstream updates" becomes the project's headline differentiator.
- Conflicts surface explicitly via merge markers — the user always knows when their patch is at risk.
- No fork repository per skill required; works equally for git, direct-URL, and local-path sources.
- Patches can rot if upstream diverges far enough that `git apply --3way` cannot reconcile. That's the trade-off and is expected; the user ends up resolving by hand once.
- `authored/` skills do not participate in this lifecycle — they have no upstream and no pristine; users version them via their own git if they want history.
- The patch file format is a unified diff. It's portable, human-readable, and reviewable in a PR.
