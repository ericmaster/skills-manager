import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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
import { PresetsStore } from "../core/preset.js";
import { resolveSourceFromManifest } from "../core/skills-cli.js";

const BUNDLED_MANAGER_SKILL = "skills-manager";

export async function runInit(args: { local: boolean; preset?: string }): Promise<number> {
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

  if (args.preset) {
    const presetsStore = PresetsStore.openAt(root.path);
    let preset = presetsStore.preset(args.preset);
    if (!preset) {
      // Fallback to global preset store if workspace-local init
      const globalPath = join(homedir(), ".skills-manager");
      if (existsSync(globalPath)) {
        const globalPresetsStore = PresetsStore.openAt(globalPath);
        preset = globalPresetsStore.preset(args.preset);
      }
    }
    if (!preset) {
      process.stderr.write(`error: preset "${args.preset}" not found.\n`);
      return 1;
    }
    process.stdout.write(`Bootstrapping with preset: ${args.preset}\n`);
    for (const [skName, sk] of Object.entries(preset.skills)) {
      if (store.skill(skName)) {
        process.stdout.write(`  · skill "${skName}" already exists, skipping.\n`);
        continue;
      }
      if (sk.kind === "contrib" && sk.source) {
        process.stdout.write(`  Installing preset skill "${skName}"...\n`);
        try {
          const resolved = await resolveSourceFromManifest(sk.source, root.path);
          const liveDir = join(root.path, "skills", resolved.skillName);
          if (existsSync(liveDir)) {
            rmSync(liveDir, { recursive: true, force: true });
          }
          cpSync(resolved.pristinePath, liveDir, { recursive: true });
          store.recordContribSkill(resolved.skillName, resolved.source);
          store.pinResolvedRef(resolved.skillName, resolved.ref);
          process.stdout.write(`  ✓ installed preset skill: ${resolved.skillName}\n`);
        } catch (err: any) {
          process.stderr.write(`  ✗ failed to install preset skill "${skName}": ${err.message}\n`);
          return 1;
        }
      } else {
        process.stdout.write(`  · skipped non-contrib or source-less preset skill: ${skName}\n`);
      }
    }
  }

  // Detect tools and link
  const home = undefined;
  const detected = await detectTools(home);
  const toolRecords: DetectedToolRecord[] = [];
  const linkSummaries: string[] = [];
  const skipSummaries: string[] = [];
  const linkableTools: typeof detected = [];

  const existingTools = store.tools();

  for (const entry of TOOL_REGISTRY) {
    const found = detected.find((d) => d.id === entry.id);
    if (!found) continue;
    const linkable = !!found.absLinkTarget;
    const existing = existingTools.find((t) => t.id === entry.id);
    const record: DetectedToolRecord = {
      id: entry.id,
      detectedAt: new Date().toISOString(),
      linkable,
      linkTarget: found.absLinkTarget,
      enabled: existing ? existing.enabled : linkable,
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

  const linkResults = [];
  const allSkills = store.skillNames();
  for (const name of allSkills) {
    const entry = store.skill(name)!;
    const skillDir = entry.kind === "authored"
      ? join(root.path, "authored", name)
      : join(root.path, "skills", name);
    const results = linkSkillIntoTools(name, skillDir, linkableTools);
    linkResults.push(...results);
  }
  for (const r of linkResults) {
    switch (r.status) {
      case "linked":
      case "already-linked":
        linkSummaries.push(`  ✓ ${r.toolId.padEnd(12)} → ${r.linkPath}`);
        break;
      case "skipped-non-symlink":
        linkSummaries.push(
          `  ✗ ${r.toolId.padEnd(12)} link skipped: ${r.message ?? "non-symlink at link path"}`
        );
        break;
      case "failed":
      default:
        linkSummaries.push(
          `  ✗ ${r.toolId.padEnd(12)} link failed: ${r.message ?? r.status}`
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
