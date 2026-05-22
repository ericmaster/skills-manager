import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import { PresetsStore, CURATED_PRESETS } from "../core/preset.js";

export async function runPreset(args: {
  subcommand: string | undefined;
  name: string | undefined;
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  if (!existsSync(join(root.path, "skills.json"))) {
    process.stderr.write(
      `error: not initialized at ${root.path}. Run \`skills-manager init\` first.\n`,
    );
    return 1;
  }

  const presetsStore = PresetsStore.openAt(root.path);

  if (!args.subcommand || args.subcommand === "list") {
    process.stdout.write("Presets:\n\n");
    // 1. Built-in
    process.stdout.write("Built-in Presets:\n");
    for (const [pName, p] of Object.entries(CURATED_PRESETS)) {
      process.stdout.write(`  - ${pName}:\n`);
      for (const [skName, sk] of Object.entries(p.skills)) {
        const srcInfo = sk.kind === "contrib" ? `contrib: ${sk.source?.url}` : "authored";
        process.stdout.write(`    * ${skName} (${srcInfo})\n`);
      }
    }
    process.stdout.write("\n");

    // 2. Custom
    process.stdout.write("Custom Presets:\n");
    const custom = presetsStore.presets();
    if (Object.keys(custom).length === 0) {
      process.stdout.write("  · no custom presets created yet\n");
    } else {
      for (const [pName, p] of Object.entries(custom)) {
        process.stdout.write(`  - ${pName}:\n`);
        const skillsList = Object.entries(p.skills);
        if (skillsList.length === 0) {
          process.stdout.write("    · (empty preset)\n");
        } else {
          for (const [skName, sk] of skillsList) {
            const srcInfo = sk.kind === "contrib" ? `contrib: ${sk.source?.url}` : "authored";
            process.stdout.write(`    * ${skName} (${srcInfo})\n`);
          }
        }
      }
    }
    return 0;
  }

  if (args.subcommand === "create") {
    if (!args.name) {
      process.stderr.write("error: usage: skills-manager preset create <preset-name>\n");
      return 1;
    }
    try {
      presetsStore.createPreset(args.name);
      presetsStore.commit();
      process.stdout.write(`preset "${args.name}" created successfully.\n`);
      return 0;
    } catch (err: any) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
  }

  if (args.subcommand === "add") {
    if (!args.name || !args.skill) {
      process.stderr.write("error: usage: skills-manager preset add <preset-name> <skill-name>\n");
      return 1;
    }
    const ssotStore = SsotStore.openAt(root.path);
    const skillEntry = ssotStore.skill(args.skill);
    if (!skillEntry) {
      process.stderr.write(`error: skill "${args.skill}" not found in your SSOT. You can only add installed skills to presets.\n`);
      return 1;
    }

    try {
      presetsStore.addSkillToPreset(args.name, args.skill, {
        kind: skillEntry.kind,
        source: skillEntry.source,
      });
      presetsStore.commit();
      process.stdout.write(`added skill "${args.skill}" to preset "${args.name}".\n`);
      return 0;
    } catch (err: any) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
  }

  if (args.subcommand === "remove") {
    if (!args.name || !args.skill) {
      process.stderr.write("error: usage: skills-manager preset remove <preset-name> <skill-name>\n");
      return 1;
    }
    try {
      presetsStore.removeSkillFromPreset(args.name, args.skill);
      presetsStore.commit();
      process.stdout.write(`removed skill "${args.skill}" from preset "${args.name}".\n`);
      return 0;
    } catch (err: any) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
  }

  process.stderr.write(`error: unknown preset subcommand: ${args.subcommand}\n`);
  return 1;
}
