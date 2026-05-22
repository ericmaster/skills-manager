import { detectTools, TOOL_REGISTRY } from "../core/tool-detect.js";
import { NotImplementedError } from "./_not-implemented.js";
import { resolveRoot } from "../core/paths.js";
import { join } from "node:path";

export async function runTool(args: {
  subcommand: string | undefined;
  name: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  if (args.subcommand === "list") {
    const root = resolveRoot();
    const home = undefined;
    const detected = await detectTools(home);
    process.stdout.write("Tools (detected = ✓, link target in v1 = →):\n");
    for (const entry of TOOL_REGISTRY) {
      const found = detected.find((d) => d.id === entry.id);
      const presence = found ? "✓" : "·";
      const link = entry.linkTarget && found ? ` → ${entry.linkTarget}` : "";
      process.stdout.write(`  ${presence}  ${entry.id.padEnd(12)} ${entry.label}${link}\n`);
    }
    return 0;
  }
  throw new NotImplementedError(`tool ${args.subcommand ?? ""}`.trim());
}
