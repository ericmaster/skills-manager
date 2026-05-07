# Architecture Decision Records

Short, append-only notes capturing decisions that shape `skills-manager`. Each ADR explains the context, the decision, and the consequences. Format: Michael Nygard's classic short form.

Read these before proposing architectural changes — many directions look attractive in isolation but were considered and deliberately closed off here. If a candidate refactor contradicts an ADR, raise it explicitly: either the friction is real enough to revisit the decision, or the candidate doesn't fit.

## Status values

- **Accepted** — current. The codebase reflects this.
- **Superseded by ADR-XXXX** — kept for history; the linked ADR is current.
- **Deprecated** — no longer reflects the codebase, no replacement.

## Index

- [0001 — SSOT under `~/.skills-manager/`; tools get symlinks](0001-ssot-and-symlinks.md)
- [0002 — Customize contrib skills in-place with patches against a pristine cache](0002-customize-in-place-with-patches.md)
- [0003 — No runtime npm dependencies; shell out to `git`/`tar`/`unzip`](0003-no-runtime-deps.md)
- [0004 — Wrap `vercel-labs/skills` as a subprocess for source resolution](0004-wrap-vercel-labs-skills.md)
- [0005 — Detect tools by filesystem probe](0005-tool-detection-by-probe.md)
- [0006 — Workspace scope is fully isolated from global](0006-workspace-scope-isolation.md)
- [0007 — `node --test` for the v1 test runner](0007-node-test-runner.md)
- [0008 — `adopt` produces only authored skills in v1](0008-adopt-as-authored-only.md)

## Adding a new ADR

1. Pick the next number (`NNNN`).
2. Copy the structure of any existing ADR — title, Status/Date header, Context, Decision, Consequences.
3. Add a line to the index above.
4. Keep it tight: one screen if possible. ADRs are signposts, not essays.
