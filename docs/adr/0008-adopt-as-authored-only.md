# ADR-0008 — `adopt` produces only authored skills in v1

**Status:** Accepted
**Date:** 2026-05-06

## Context

`adopt` exists to migrate users with pre-existing skill directories under tool dirs (e.g. a real `~/.claude/skills/<name>/` from before they installed `skills-manager`) into the SSOT. The on-disk content alone tells us nothing about its origin: it might have been hand-written, cloned from a git repo, downloaded from a URL, or copied from a colleague.

If we record an adopted skill as `kind: "contrib"` we have to pick a `source`, which we'd be guessing. If we get it wrong, `update` will later "update" the skill to a tree the user didn't expect.

## Decision

`adopt` always records `kind: "authored"`. The patch lifecycle (`save-patch`, `update`) does not apply to authored skills; they have no pristine and no upstream. Users who *want* contrib semantics for an adopted skill must run `remove <name>` followed by `add <source>` once they know the upstream.

A future `adopt --as-contrib --source <url>` is plausible after `add` lands and source resolution is reliable. Tracked in ROADMAP "Considered, not pursuing right now" if it gets formalized.

## Consequences

- No guessing-driven incorrect provenance. The cost of a mis-recorded source (silent rewrite on `update`) is much higher than the cost of asking the user to re-add explicitly.
- Adopted skills lose nothing functionally — they live in the SSOT, link into tools, and can be edited freely. They just don't participate in the patch lifecycle.
- The adoption code path is simpler — no branching on `--from-contrib`/`--from-authored`. One outcome.
- Users who adopt-then-realize-it-was-contrib have a clear escape hatch (remove + add).
