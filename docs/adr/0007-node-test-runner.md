# ADR-0007 — `node --test` for the v1 test runner

**Status:** Accepted
**Date:** 2026-05-06

## Context

Project needs a test runner. The popular options in 2026 are vitest, jest, and Node's built-in `node:test`. vitest and jest add 50–200 transitive dependencies, install time, and configuration surface. Both are excellent in larger codebases that benefit from their ergonomics (snapshot testing, parallel runs, mocking helpers).

This codebase is small, mostly file-system-and-subprocess work, and tests run against built `dist/` artifacts. The ergonomics gap is narrow.

## Decision

Built-in Node test runner. Tests live in `tests/*.test.js` (plain JavaScript — they import from `dist/` after the `pretest` build step). Assertions via `node:assert/strict`. Fixtures via `node:fs.mkdtempSync`. Run with `pnpm test` → `node --test tests/`.

This decision is downstream of [ADR-0003](0003-no-runtime-deps.md) (no runtime deps); for symmetry and simplicity we extend the no-deps posture into devDependencies as well, where possible.

## Consequences

- One less reason to bump devDependencies; `pnpm install` stays fast.
- No built-in mocking, no snapshot testing, no parallel test config. We trade these for install footprint. So far the codebase hasn't needed them.
- Tests run against compiled output, which catches a class of TypeScript-vs-emitted-JS bugs that source-mode runners don't. Slower iteration loop (build before test); mitigated by `pretest`.
- If a future need (mocking framework, snapshot testing, parallelism) makes vitest/jest worth the cost, this ADR gets revisited explicitly.
