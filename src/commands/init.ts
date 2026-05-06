import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ensureRootLayout,
  getBundledSkillsDir,
  resolveRoot,
} from "../core/paths.js";
import {
  readManifest,
  readLockfile,
  writeManifest,
  writeLockfile,
  type Manifest,
  type Lockfile,
} from "../core/manifest.js";
import {
  readState,
  writeState,
  type DetectedToolRecord,
  type State,
} from "../core/state.js";
import { detectTools, TOOL_REGISTRY } from "../core/tool-detect.js";

const BUNDLED_MANAGER_SKILL = "skills-manager";

export async function runInit(args: { local: boolean }): Promise<number> {
  const root = resolveRoot({ local: args.local });
  const alreadyInitialized = existsSync(join(root.path, "skills.json"));

  process.stdout.write(
    `Initializing skills-manager (${root.scope}): ${root.path}\n`,
  );

  ensureRootLayout(root.path);

  // Manifest + lockfile
  const manifest: Manifest = alreadyInitialized
    ? readManifest(root.path)
    : { version: 1, skills: {} };
  if (!manifest.skills[BUNDLED_MANAGER_SKILL]) {
    manifest.skills[BUNDLED_MANAGER_SKILL] = { kind: "authored" };
  }
  writeManifest(root.path, manifest);

  const lock: Lockfile = alreadyInitialized
    ? readLockfile(root.path)
    : { version: 1, skills: {} };
  writeLockfile(root.path, lock);

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

    const linkPath = join(found.absLinkTarget!, BUNDLED_MANAGER_SKILL);
    try {
      mkdirSync(dirname(linkPath), { recursive: true });
      replaceSymlink(linkPath, targetSkillDir);
      linkSummaries.push(`  ✓ ${entry.id.padEnd(12)} → ${linkPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      linkSummaries.push(`  ✗ ${entry.id.padEnd(12)} link failed: ${msg}`);
    }
  }

  const state: State = {
    version: 1,
    tools: toolRecords,
    lastDetectedAt: new Date().toISOString(),
  };
  writeState(root.path, state);

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

function replaceSymlink(linkPath: string, target: string): void {
  if (existsSync(linkPath) || isDanglingSymlink(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const current = readlinkSync(linkPath);
      if (current === target) return;
      unlinkSync(linkPath);
    } else {
      throw new Error(
        `Refusing to overwrite non-symlink at ${linkPath}. Move or remove it manually.`,
      );
    }
  }
  symlinkSync(target, linkPath, "dir");
}

function isDanglingSymlink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
