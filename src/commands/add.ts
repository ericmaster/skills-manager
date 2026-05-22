import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import { linkSkillIntoTools } from "../core/linker.js";
import { resolveSource } from "../core/skills-cli.js";
import { listLinkableTools } from "../core/tool-detect.js";

export async function runAdd(args: {
  source: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  if (!args.source) {
    process.stderr.write(`error: usage: skills-manager add <source>\n`);
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

  const resolved = await resolveSource(args.source, root.path);
  const { skillName, ref, pristinePath, source } = resolved;

  if (store.skill(skillName)) {
    process.stderr.write(
      `error: skill "${skillName}" already installed. Use \`skills-manager remove ${skillName}\` then \`add\`, or \`update\` to refresh.\n`,
    );
    return 1;
  }

  const liveDir = join(root.path, "skills", skillName);
  let copied = false;
  try {
    if (existsSync(liveDir)) {
      throw new Error(
        `skills/${skillName}/ already exists on disk but is not in skills.json. Move it aside and retry.`,
      );
    }
    cpSync(pristinePath, liveDir, { recursive: true });
    copied = true;

    store.recordContribSkill(skillName, source);
    store.pinResolvedRef(skillName, ref);

    const tools = await listLinkableTools();
    const linkResults = linkSkillIntoTools(skillName, liveDir, tools);

    // Manifest writes go last — only commit when symlinking has run.
    store.commit();

    const shortRef = ref.length > 12 ? ref.slice(0, 12) : ref;
    const sourceSummary = summarizeSource(source);
    process.stdout.write(`added ${skillName} @ ${shortRef} (${sourceSummary})\n`);
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
  } catch (err) {
    if (copied) {
      rmSync(liveDir, { recursive: true, force: true });
    }
    throw err;
  }
}

function summarizeSource(s: {
  type: "git" | "url" | "local";
  url?: string;
  path?: string;
}): string {
  switch (s.type) {
    case "git":
      return `git: ${s.url}`;
    case "url":
      return `url: ${s.url}`;
    case "local":
      return `local: ${s.path}`;
  }
}
