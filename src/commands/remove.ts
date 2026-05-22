import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import { listLinkableTools } from "../core/tool-detect.js";

const BUNDLED_SKILL_NAME = "skills-manager";

export async function runRemove(args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  if (!args.skill) {
    process.stderr.write(`error: usage: skills-manager remove <skill>\n`);
    return 1;
  }
  const name = args.skill;

  const root = resolveRoot();
  if (!existsSync(join(root.path, "skills.json"))) {
    process.stderr.write(
      `error: not initialized at ${root.path}. Run \`skills-manager init\` first.\n`,
    );
    return 1;
  }
  ensureRootLayout(root.path);

  const store = SsotStore.openAt(root.path);
  const entry = store.skill(name);
  if (!entry) {
    process.stderr.write(`error: unknown skill "${name}"\n`);
    return 1;
  }

  // Refuse if a staging dir exists (pending update).
  const stagingDir = join(root.path, ".cache", "staging", name);
  if (existsSync(stagingDir)) {
    process.stderr.write(
      `error: ${name} has a pending update; resolve with \`update --continue ${name}\` or delete .cache/staging/${name}/ before removing\n`,
    );
    return 1;
  }

  // Warn if removing the bundled skill.
  if (name === BUNDLED_SKILL_NAME) {
    process.stderr.write(
      `warning: removing the bundled "${BUNDLED_SKILL_NAME}" skill. Running \`init\` again will reinstall it.\n`,
    );
  }

  const removed: string[] = [];

  // 1. Remove symlinks from all linkable tool dirs.
  const home = root.scope === "workspace" ? join(root.path, "..") : undefined;
  const tools = await listLinkableTools(home);
  for (const tool of tools) {
    if (!tool.absLinkTarget) continue;
    const linkPath = join(tool.absLinkTarget, name);
    if (pathExists(linkPath)) {
      rmSync(linkPath, { recursive: true, force: true });
      removed.push(linkPath);
    }
  }

  // 2. Remove the live skill directory.
  const liveDir =
    entry.kind === "contrib"
      ? join(root.path, "skills", name)
      : join(root.path, "authored", name);
  if (pathExists(liveDir)) {
    rmSync(liveDir, { recursive: true, force: true });
    removed.push(liveDir);
  }

  // 3. Remove patch file.
  const patchPath = join(root.path, "patches", `${name}.patch`);
  if (existsSync(patchPath)) {
    rmSync(patchPath, { force: true });
    removed.push(patchPath);
  }

  // 4. Remove all pristine cache dirs matching <name>@*.
  const pristineRoot = join(root.path, ".cache", "pristine");
  if (existsSync(pristineRoot)) {
    const prefix = `${name}@`;
    for (const ent of readdirSync(pristineRoot, { withFileTypes: true })) {
      if (ent.name.startsWith(prefix)) {
        const pristinePath = join(pristineRoot, ent.name);
        rmSync(pristinePath, { recursive: true, force: true });
        removed.push(pristinePath);
      }
    }
  }

  // 5. Update manifest + lockfile (filesystem first, manifest last).
  store.removeSkill(name);
  store.clearLock(name);
  store.commit();

  // Summary.
  if (removed.length === 0) {
    process.stdout.write(`${name}: removed (no files on disk)\n`);
  } else {
    process.stdout.write(`${name}: removed\n`);
    for (const p of removed) {
      process.stdout.write(`  - ${p}\n`);
    }
  }
  return 0;
}

/**
 * Check whether a path exists, including broken symlinks.
 * `existsSync` returns false for broken symlinks; `lstatSync` detects them.
 */
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
