/**
 * Subprocess interface to vercel-labs/skills.
 *
 * v1 placeholder: every method throws. Real implementations land alongside
 * the `add` and `update` commands in a follow-up plan. The shape here
 * captures the verbs we expect to drive: source resolution and per-tool
 * placement primitives.
 */

export interface ResolvedSourceRef {
  /** Final pinned ref (commit, tag, or URL with content hash). */
  ref: string;
  /** Local path to a fully resolved pristine directory. */
  pristinePath: string;
  /** Inferred skill name (matches SKILL.md frontmatter). */
  skillName: string;
}

export class SkillsCliUnavailableError extends Error {
  constructor() {
    super(
      "vercel-labs/skills CLI integration is not implemented in v1. See AGENTS.md roadmap.",
    );
    this.name = "SkillsCliUnavailableError";
  }
}

export async function resolveSource(_source: string): Promise<ResolvedSourceRef> {
  throw new SkillsCliUnavailableError();
}
