import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import { listLinkableTools } from "../core/tool-detect.js";
import { linkSkillIntoTools } from "../core/linker.js";

export async function runNew(args: {
  name: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  if (!args.name) {
    process.stderr.write("error: usage: skills-manager new <name>\n");
    return 1;
  }
  const name = args.name;

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    process.stderr.write(
      `error: invalid skill name "${name}". Names must start with a letter or digit and contain only letters, digits, dots, hyphens, or underscores.\n`,
    );
    return 1;
  }

  const root = resolveRoot();
  if (!existsSync(join(root.path, "skills.json"))) {
    process.stderr.write(
      `error: not initialized at ${root.path}. Run \`skills-manager init\` first.\n`,
    );
    return 1;
  }
  ensureRootLayout(root.path);

  const store = SsotStore.openAt(root.path);

  // Check if already registered in skills.json
  if (store.skill(name)) {
    process.stderr.write(
      `error: skill "${name}" is already registered in skills.json. Use a different name or remove the existing skill first.\n`,
    );
    return 1;
  }

  // Check if directories already exist on disk
  const liveContribDir = join(root.path, "skills", name);
  const liveAuthoredDir = join(root.path, "authored", name);

  if (existsSync(liveContribDir) || existsSync(liveAuthoredDir)) {
    process.stderr.write(
      `error: skill directory for "${name}" already exists on disk. Move it aside or remove it first.\n`,
    );
    return 1;
  }

  // Create authored/<name> and subfolders
  const targetDir = liveAuthoredDir;
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, "scripts"), { recursive: true });
  mkdirSync(join(targetDir, "references"), { recursive: true });

  // Write SKILL.md template
  const skillMdContent = `---
name: "${name}"
description: "Scaffolded skill for ${name}"
---

# ${name}

Detailed instructions for the agent.

## When to use this skill
- Use this when...

## How to use it
- Step-by-step guidance for the agent.
`;

  writeFileSync(join(targetDir, "SKILL.md"), skillMdContent, "utf8");

  // Record authored skill in manifest
  store.recordAuthoredSkill(name);

  // Link to detected native tools
  const home = undefined;
  const tools = await listLinkableTools(home);
  const linkResults = linkSkillIntoTools(name, targetDir, tools);

  // Write manifest
  store.commit();

  process.stdout.write(`created self-authored skill "${name}" at authored/${name}/\n`);
  if (linkResults.length === 0) {
    process.stdout.write("  · no native-SKILL.md tools detected to link into\n");
  } else {
    for (const r of linkResults) {
      switch (r.status) {
        case "linked":
        case "already-linked":
          process.stdout.write(`  ✓ ${r.toolId} → ${r.linkPath}\n`);
          break;
        case "skipped-non-symlink":
        case "skipped-foreign-target":
          process.stdout.write(
            `  ✗ ${r.toolId} link skipped: ${r.message ?? r.status}\n`,
          );
          break;
        case "failed":
        default:
          process.stdout.write(
            `  ✗ ${r.toolId} link failed: ${r.message ?? r.status}\n`,
          );
          break;
      }
    }
  }

  return 0;
}
