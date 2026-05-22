import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ensureRootLayout,
  getBundledSkillsDir,
  resolveRoot,
} from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import type { DetectedToolRecord } from "../core/state.js";
import { detectTools, TOOL_REGISTRY } from "../core/tool-detect.js";
import { linkSkillIntoTools } from "../core/linker.js";

const BUNDLED_MANAGER_SKILL = "skills-manager";

export async function runInit(args: { local: boolean }): Promise<number> {
  const root = resolveRoot({ local: args.local });

  process.stdout.write(
    `Initializing skills-manager (${root.scope}): ${root.path}\n`,
  );

  ensureRootLayout(root.path);

  const store = SsotStore.openAt(root.path);
  store.recordAuthoredSkill(BUNDLED_MANAGER_SKILL);

  // Install bundled skill into authored/
  const bundledDir = getBundledSkillsDir();
  const sourceSkillDir = join(bundledDir, BUNDLED_MANAGER_SKILL);
  if (!existsSync(sourceSkillDir)) {
    throw new Error(
      `Bundled skill missing at ${sourceSkillDir}. Did the package build correctly?`,
    );
  }
  const targetSkillDir = join(root.path, "authored", BUNDLED_MANAGER_SKILL);
  cpSync(sourceSkillDir, targetSkillDir, { recursive: true });
  process.stdout.write(`  ✓ installed authored skill: ${BUNDLED_MANAGER_SKILL}\n`);

  // Detect tools and link
  const detected = await detectTools();
  const toolRecords: DetectedToolRecord[] = [];
  const linkSummaries: string[] = [];
  const skipSummaries: string[] = [];
  const linkableTools: typeof detected = [];

  for (const entry of TOOL_REGISTRY) {
    const found = detected.find((d) => d.id === entry.id);
    if (!found) continue;
    const linkable = !!found.absLinkTarget;
    const record: DetectedToolRecord = {
      id: entry.id,
      detectedAt: new Date().toISOString(),
      linkable,
      linkTarget: found.absLinkTarget,
      enabled: linkable,
    };
    toolRecords.push(record);

    if (!linkable) {
      skipSummaries.push(
        `  · ${entry.id.padEnd(12)} detected but skipped (non-native SKILL.md in v1)`,
      );
      continue;
    }
    linkableTools.push(found);
  }

  const linkResults = linkSkillIntoTools(
    BUNDLED_MANAGER_SKILL,
    targetSkillDir,
    linkableTools,
  );
  for (const r of linkResults) {
    switch (r.status) {
      case "linked":
      case "already-linked":
        linkSummaries.push(`  ✓ ${r.toolId.padEnd(12)} → ${r.linkPath}`);
        break;
      case "skipped-non-symlink":
        linkSummaries.push(
          `  ✗ ${r.toolId.padEnd(12)} link skipped: ${r.message ?? "non-symlink at link path"}`,
        );
        break;
      case "failed":
      default:
        linkSummaries.push(
          `  ✗ ${r.toolId.padEnd(12)} link failed: ${r.message ?? r.status}`,
        );
        break;
    }
  }

  store.recordToolDetection(toolRecords);
  store.commit();

  if (linkSummaries.length === 0 && skipSummaries.length === 0) {
    process.stdout.write("  · no agent tools detected on this host\n");
  } else {
    if (linkSummaries.length) {
      process.stdout.write("\nLinked into:\n");
      for (const s of linkSummaries) process.stdout.write(s + "\n");
    }
    if (skipSummaries.length) {
      process.stdout.write("\nSkipped (deferred to a follow-up release):\n");
      for (const s of skipSummaries) process.stdout.write(s + "\n");
    }
  }

  process.stdout.write(
    `\nDone. Run \`skills-manager doctor\` to inspect setup.\n`,
  );
  return 0;
}
