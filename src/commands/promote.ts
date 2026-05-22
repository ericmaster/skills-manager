import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import { safeRefSegment } from "../core/skills-cli.js";
import { listLinkableTools } from "../core/tool-detect.js";
import { linkSkillIntoTools, unlinkSkillFromTools } from "../core/linker.js";

export async function runPromote(args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  if (root.scope !== "workspace") {
    process.stderr.write("error: promote can only be run within a local workspace scope.\n");
    return 1;
  }

  if (!args.skill) {
    process.stderr.write("error: usage: skills-manager promote <skill-name>\n");
    return 1;
  }

  const globalPath = join(homedir(), ".skills-manager");
  if (!existsSync(join(globalPath, "skills.json"))) {
    process.stderr.write(`error: global SSOT not initialized. Run \`skills-manager init\` globally first.\n`);
    return 1;
  }

  const localStore = SsotStore.openAt(root.path);
  const globalStore = SsotStore.openAt(globalPath);

  const localEntry = localStore.skill(args.skill);
  if (!localEntry) {
    process.stderr.write(`error: skill "${args.skill}" does not exist in workspace SSOT.\n`);
    return 1;
  }

  const globalEntry = globalStore.skill(args.skill);
  if (globalEntry && args.flags.force !== true) {
    process.stderr.write(`error: skill "${args.skill}" already exists in global SSOT. Use --force to override.\n`);
    return 1;
  }

  if (localEntry.kind === "contrib") {
    const resolvedRef = localStore.resolvedRef(args.skill);
    if (resolvedRef) {
      const safe = safeRefSegment(resolvedRef);
      const localPristine = join(root.path, ".cache", "pristine", `${args.skill}@${safe}`);
      if (!existsSync(localPristine)) {
        process.stderr.write(`error: pristine cache directory missing for skill "${args.skill}". Re-install the skill first.\n`);
        return 1;
      }
    }
  }

  process.stdout.write(`Promoting skill "${args.skill}" from workspace to global SSOT...\n`);

  const home = undefined;
  const tools = await listLinkableTools(home);
  
  // 1. Unlink local skill
  const localRecords = localStore.tools();
  const localEnabledTools = tools.filter((t) => {
    const record = localRecords.find((r) => r.id === t.id);
    return record ? record.enabled : true;
  });
  const skillDirLocal = localEntry.kind === "authored"
    ? join(root.path, "authored", args.skill)
    : join(root.path, "skills", args.skill);
  
  unlinkSkillFromTools(args.skill, skillDirLocal, localEnabledTools);

  // 2. Migrate files
  if (localEntry.kind === "authored") {
    const globalAuthPath = join(globalPath, "authored", args.skill);
    if (existsSync(globalAuthPath)) {
      rmSync(globalAuthPath, { recursive: true, force: true });
    }
    cpSync(skillDirLocal, globalAuthPath, { recursive: true });
    rmSync(skillDirLocal, { recursive: true, force: true });
    
    globalStore.recordAuthoredSkill(args.skill);
  } else {
    // Contrib skill
    const globalSkillPath = join(globalPath, "skills", args.skill);
    if (existsSync(globalSkillPath)) {
      rmSync(globalSkillPath, { recursive: true, force: true });
    }
    cpSync(skillDirLocal, globalSkillPath, { recursive: true });
    rmSync(skillDirLocal, { recursive: true, force: true });

    // Migrate patch if any
    const localPatchFile = join(root.path, "patches", `${args.skill}.patch`);
    const globalPatchFile = join(globalPath, "patches", `${args.skill}.patch`);
    if (existsSync(localPatchFile)) {
      cpSync(localPatchFile, globalPatchFile);
      rmSync(localPatchFile, { force: true });
    }

    // Migrate pristine cache
    const resolvedRef = localStore.resolvedRef(args.skill);
    if (resolvedRef) {
      const safe = safeRefSegment(resolvedRef);
      const localPristine = join(root.path, ".cache", "pristine", `${args.skill}@${safe}`);
      const globalPristine = join(globalPath, ".cache", "pristine", `${args.skill}@${safe}`);
      if (existsSync(localPristine)) {
        if (existsSync(globalPristine)) {
          rmSync(globalPristine, { recursive: true, force: true });
        }
        cpSync(localPristine, globalPristine, { recursive: true });
        rmSync(localPristine, { recursive: true, force: true });
      }
      globalStore.pinResolvedRef(args.skill, resolvedRef);
    }

    globalStore.recordContribSkill(args.skill, localEntry.source!);
  }

  // 3. Link global skill
  const globalRecords = globalStore.tools();
  const globalEnabledTools = tools.filter((t) => {
    const record = globalRecords.find((r) => r.id === t.id);
    return record ? record.enabled : true;
  });
  const skillDirGlobal = localEntry.kind === "authored"
    ? join(globalPath, "authored", args.skill)
    : join(globalPath, "skills", args.skill);
  
  linkSkillIntoTools(args.skill, skillDirGlobal, globalEnabledTools);

  // 4. Update manifests and commit
  localStore.removeSkill(args.skill);
  localStore.clearLock(args.skill);

  localStore.commit();
  globalStore.commit();

  process.stdout.write(`Successfully promoted skill "${args.skill}" to global SSOT.\n`);
  return 0;
}
