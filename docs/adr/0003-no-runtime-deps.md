# ADR-0003 — No runtime npm dependencies; shell out to `git`/`tar`/`unzip`

**Status:** Accepted
**Date:** 2026-05-06

## Context

`skills-manager` needs to: clone git repos, unpack tarballs/zips, parse YAML frontmatter, generate unified diffs, apply patches with three-way merge. Every one of these has a popular npm package. Pulling them in adds install footprint, dependency surface, and lock-step upgrade work.

`skills-manager` is meant to be invoked transiently via `npx skills-manager <verb>` from any developer environment. Install time matters; install size matters more.

## Decision

Zero npm runtime dependencies. The `package.json` `dependencies` field is empty and stays empty. Functionality that would otherwise need a library is delivered by:

- `node:child_process.execFile` calling `git`, `tar`, `unzip` — assumed present on developer machines and CI.
- A handcrafted regex for YAML frontmatter (only the fields we actually need: `name`, `description`).
- Built-in `node:fs`, `node:crypto`, `node:path`, `node:os`, `node:url`, `node:util`.

Dev dependencies (TypeScript, Prettier, ESLint when added) are unrestricted — they don't affect runtime install.

## Consequences

- `npx skills-manager` boots fast; no transitive install graph.
- Locked into Node ≥22 (built-in test runner, native fetch, ESM stable). Compatible with this project's `engines` field.
- Requires `git` (≥2.42 for the patch flows), `tar`, and `unzip` on PATH. CI images and developer machines almost always have them; missing-binary failures surface as clear errors, not silent breakage.
- Contributor friction: no convenient YAML library, no diff library. The hand-rolled frontmatter parser handles the constrained subset documented in Phase 2; expanding it requires a deliberate ADR amendment, not a "just add `js-yaml`" PR.
- If a future feature genuinely needs a dep (e.g. a TUI), this ADR gets revisited explicitly.
