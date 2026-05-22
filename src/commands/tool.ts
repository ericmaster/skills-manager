import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRoot } from "../core/paths.js";
import { detectTools, TOOL_REGISTRY } from "../core/tool-detect.js";
import { SsotStore } from "../core/ssot.js";
import { linkSiteToSkill, unlinkSiteFromSkill } from "../core/linker.js";
import type { DetectedToolRecord } from "../core/state.js";

export async function runTool(args: {
  subcommand: string | undefined;
  name: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  if (!existsSync(join(root.path, "skills.json"))) {
    process.stderr.write(
      `error: not initialized at ${root.path}. Run \`skills-manager init\` first.\n`,
    );
    return 1;
  }

  const store = SsotStore.openAt(root.path);
  const detected = await detectTools();

  if (!args.subcommand || args.subcommand === "list") {
    process.stdout.write("Tools (detected = ✓, link target = →, status = [ON/OFF]):\n");
    const records = store.tools();
    for (const entry of TOOL_REGISTRY) {
      const found = detected.find((d) => d.id === entry.id);
      const record = records.find((r) => r.id === entry.id);
      
      const presence = found ? "✓" : "·";
      const link = entry.linkTarget && found ? ` → ${entry.linkTarget}` : "";
      
      let statusStr = "";
      if (entry.linkTarget) {
        const enabled = record ? record.enabled : true;
        statusStr = enabled ? " [ON]" : " [OFF]";
      } else {
        statusStr = " [N/A]";
      }
      
      process.stdout.write(
        `  ${presence}  ${entry.id.padEnd(16)} ${entry.label.padEnd(18)}${statusStr}${link}\n`,
      );
    }
    return 0;
  }

  if (args.subcommand === "enable" || args.subcommand === "disable") {
    if (!args.name) {
      process.stderr.write(`error: usage: skills-manager tool ${args.subcommand} <tool-id>\n`);
      return 1;
    }

    const registryEntry = TOOL_REGISTRY.find((e) => e.id === args.name);
    if (!registryEntry) {
      process.stderr.write(`error: unknown tool "${args.name}". Supported tools are: ${TOOL_REGISTRY.map(t => t.id).join(", ")}\n`);
      return 1;
    }

    if (!registryEntry.linkTarget) {
      process.stderr.write(`error: tool "${args.name}" does not natively support SKILL.md in v1.\n`);
      return 1;
    }

    const isEnable = args.subcommand === "enable";
    const foundTool = detected.find((d) => d.id === args.name);

    // Update state record
    const records = store.tools();
    let record = records.find((r) => r.id === args.name);
    if (record) {
      record.enabled = isEnable;
    } else {
      record = {
        id: args.name,
        detectedAt: new Date().toISOString(),
        linkable: !!registryEntry.linkTarget,
        linkTarget: foundTool?.absLinkTarget ?? join(process.env.HOME ?? "", registryEntry.linkTarget),
        enabled: isEnable,
      };
      records.push(record);
    }
    store.recordToolDetection(records);

    // Immediately link/unlink if detected locally
    if (foundTool && foundTool.absLinkTarget) {
      const skills = store.skillNames();
      for (const skillName of skills) {
        const entry = store.skill(skillName)!;
        const skillDir = entry.kind === "authored"
          ? join(root.path, "authored", skillName)
          : join(root.path, "skills", skillName);
        
        const linkPath = join(foundTool.absLinkTarget, skillName);
        if (isEnable) {
          const res = linkSiteToSkill(linkPath, skillDir, foundTool.id);
          if (res.status === "linked") {
            process.stdout.write(`  ✓ linked ${skillName} into ${args.name} → ${linkPath}\n`);
          }
        } else {
          const res = unlinkSiteFromSkill(linkPath, skillDir, foundTool.id);
          if (res.status === "unlinked") {
            process.stdout.write(`  ✓ unlinked ${skillName} from ${args.name}\n`);
          }
        }
      }
    } else {
      process.stdout.write(`  · ${registryEntry.label} is not currently detected on this system; symlinks will be managed once detected.\n`);
    }

    store.commit();
    process.stdout.write(`tool "${args.name}" is now ${isEnable ? "enabled" : "disabled"}.\n`);
    return 0;
  }

  process.stderr.write(`error: unknown tool subcommand: ${args.subcommand}\n`);
  return 1;
}
