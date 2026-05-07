# ADR-0004 — Wrap `vercel-labs/skills` as a subprocess for source resolution

**Status:** Accepted
**Date:** 2026-05-06

## Context

Source resolution (handle git URLs with refs and subpaths, direct URLs, local paths; unpack; pin to a content-addressed ref) and per-tool placement primitives (write the right files into the right canonical directory for each tool) are non-trivial. `vercel-labs/skills` already implements them and is actively maintained.

`skills-manager` adds three things on top: a manifest (`skills.json`), a patch lifecycle, and an update orchestration that survives upstream changes. None of those are in `vercel-labs/skills`. The base capabilities are.

## Decision

`skills-manager` shells out to `npx skills <verb>` for source resolution and per-tool placement primitives. The subprocess contract lives at [src/core/skills-cli.ts](../../src/core/skills-cli.ts) — one module, one place where the verb shapes are defined and matched. `skills-manager` owns:

- The SSOT layout (per [ADR-0001](0001-ssot-and-symlinks.md))
- `skills.json`, `skills.lock.json`, `state.json`
- `patches/<name>.patch` and the pristine cache
- Update orchestration with conflict pause/resume
- Tool detection (per [ADR-0005](0005-tool-detection-by-probe.md))
- Adoption flow

## Consequences

- Less code to maintain; `vercel-labs/skills` improvements propagate for free.
- Hard dependency on the upstream CLI's invocation contract. Changes there are felt here. Mitigation: the subprocess contract is isolated to one module, so a wrap-fork is feasible if the project ever diverges.
- Integration tests for `add` / `update` need `npx skills` resolvable. Local-path sources are fully testable without the subprocess; remote sources are not. Phase 2 acknowledges this — git/URL branches are exercised manually until a fixture-server pattern lands.
- If `vercel-labs/skills` adopts conflicting opinions about the SSOT layout, this ADR gets revisited. Today the projects compose cleanly: `vercel-labs/skills` knows about source types and tool dirs; `skills-manager` knows about durability.
