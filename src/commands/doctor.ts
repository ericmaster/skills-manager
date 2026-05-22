import { resolveRoot } from "../core/paths.js";
import { detectTools, TOOL_REGISTRY } from "../core/tool-detect.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export async function runDoctor(_args: {
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  const home = root.scope === "workspace" ? join(root.path, "..") : undefined;
  const detected = await detectTools(home);

  const lines: string[] = [];
  lines.push(`SSOT root:    ${root.path}`);
  lines.push(`Scope:        ${root.scope}`);
  lines.push(`Initialized:  ${existsSync(`${root.path}/skills.json`) ? "yes" : "no"}`);
  lines.push("");
  lines.push("Tools:");
  for (const entry of TOOL_REGISTRY) {
    const found = detected.find((d) => d.id === entry.id);
    const status = found
      ? entry.linkTarget
        ? "detected (linkable)"
        : "detected (deferred — non-native SKILL.md in v1)"
      : "not found";
    lines.push(`  ${entry.id.padEnd(12)} ${status}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
