import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolRegistryEntry {
  /** Stable identifier, used in state.json. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Probe paths (relative to $HOME). The tool is "detected" if any exists. */
  probePaths: string[];
  /**
   * If set, the tool natively consumes the agentskills.io spec and the manager
   * will create symlinks at `<tool dir>/skills/<skill>` in v1. If undefined,
   * the tool is detected but skipped during linking.
   */
  linkTarget?: string;
}

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    probePaths: [".claude"],
    linkTarget: ".claude/skills",
  },
  {
    id: "hermes",
    label: "Hermes",
    probePaths: [".hermes"],
    linkTarget: ".hermes/skills",
  },
  {
    id: "openclaw",
    label: "Openclaw",
    probePaths: [".openclaw"],
    linkTarget: ".openclaw/skills",
  },
  {
    id: "codex",
    label: "Codex CLI",
    probePaths: [".codex", ".config/codex"],
  },
  {
    id: "cursor",
    label: "Cursor",
    probePaths: [".config/Cursor", ".cursor"],
  },
  {
    id: "antigravity-cli",
    label: "Antigravity CLI",
    probePaths: [".gemini/antigravity", ".config/antigravity"],
    linkTarget: ".gemini/skills",
  },
  {
    id: "antigravity-ide",
    label: "Antigravity IDE",
    probePaths: [".gemini/antigravity-ide"],
    linkTarget: ".gemini/antigravity-ide/skills",
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    probePaths: [".copilot"],
    linkTarget: ".copilot/skills",
  },
  {
    id: "opencode",
    label: "OpenCode",
    probePaths: [".config/opencode", ".opencode"],
  },
  {
    id: "crush",
    label: "Crush",
    probePaths: [".config/crush", ".crush"],
  },
  {
    id: "aider",
    label: "Aider",
    probePaths: [".aider", ".config/aider"],
  },
];

export interface DetectedTool extends ToolRegistryEntry {
  homePath: string;
  /** Absolute path to the link target dir (only if linkTarget is set). */
  absLinkTarget?: string;
}

export async function detectTools(home?: string): Promise<DetectedTool[]> {
  const h = home ?? homedir();
  const detected: DetectedTool[] = [];
  for (const entry of TOOL_REGISTRY) {
    const matchedProbe = entry.probePaths.find((p) => existsSync(join(h, p)));
    if (!matchedProbe) continue;
    detected.push({
      ...entry,
      homePath: join(h, matchedProbe),
      absLinkTarget: entry.linkTarget ? join(h, entry.linkTarget) : undefined,
    });
  }
  return detected;
}

export async function listLinkableTools(home?: string): Promise<DetectedTool[]> {
  const detected = await detectTools(home);
  return detected.filter((t) => !!t.linkTarget);
}
