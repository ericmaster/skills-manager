export class NotImplementedError extends Error {
  constructor(public readonly command: string) {
    super(
      `\`skills-manager ${command}\` is not yet implemented in v1. See the roadmap in AGENTS.md.`,
    );
    this.name = "NotImplementedError";
  }
}
