# ADR-0005 — Detect tools by filesystem probe

**Status:** Accepted
**Date:** 2026-05-06

## Context

`skills-manager` needs to know which agent tools the user has installed so it can link skills into the right canonical directories. The available shapes:

1. **Ask the user.** Add a config step ("which tools do you use?"). Friction; users get it wrong; new tools require explicit re-config.
2. **Detect by filesystem probe.** Check for canonical config dirs (`~/.claude/`, `~/.hermes/`, etc.) and binaries on PATH. Zero-config bootstrap.
3. **Detect by querying each tool's CLI.** Heaviest; assumes every tool has a discoverable CLI; many don't.

## Decision

Filesystem probe. The registry lives in [src/core/tool-detect.ts](../../src/core/tool-detect.ts) as a static `TOOL_REGISTRY`: each entry has a tool ID, label, candidate probe paths (relative to `$HOME`), and an optional `linkTarget` for tools that natively consume the agentskills.io spec.

Detection runs on every CLI invocation (cheap — a handful of `existsSync` calls). Results cache in `state.json` for diagnostics and are refreshed implicitly when the probes change.

## Consequences

- `skills-manager init` works on a fresh machine without any user input — the most common case "just works."
- Adding support for a new tool is a one-entry edit to the registry; no migration, no schema bump.
- A tool installed *after* `init` will not be picked up until the user re-runs `init` (or a future `doctor --refresh`). Documented; acceptable.
- A tool that left config dirs behind after uninstall produces a false positive. Linker operations are idempotent and harmless against a stale dir, so this is benign.
- Probes are intentionally generous (multiple candidate paths per tool: `.codex` *and* `.config/codex`). Trades a bit of false-positive risk for resilience to config-path drift.
