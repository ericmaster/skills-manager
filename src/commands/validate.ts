import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";

const execFile = promisify(execFileCb);

export async function runValidate(args: {
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

  const store = SsotStore.openAt(root.path);

  if (args.skill) {
    // Validate a specific skill
    const skillEntry = store.skill(args.skill);
    if (!skillEntry) {
      process.stderr.write(`error: skill "${args.skill}" is not registered in the SSOT.\n`);
      return 1;
    }

    const skillDir =
      skillEntry.kind === "authored"
        ? join(root.path, "authored", args.skill)
        : join(root.path, "skills", args.skill);

    if (!existsSync(skillDir)) {
      process.stderr.write(`error: skill directory does not exist at ${skillDir}\n`);
      return 1;
    }

    return await validatePath(args.skill, skillDir);
  } else {
    // Validate all installed skills
    const skillNames = store.skillNames();
    if (skillNames.length === 0) {
      process.stdout.write("No skills installed to validate.\n");
      return 0;
    }

    let overallSuccess = true;
    for (const name of skillNames) {
      const skillEntry = store.skill(name)!;
      const skillDir =
        skillEntry.kind === "authored"
          ? join(root.path, "authored", name)
          : join(root.path, "skills", name);

      if (!existsSync(skillDir)) {
        process.stderr.write(`error: skill directory missing for "${name}" at ${skillDir}\n`);
        overallSuccess = false;
        continue;
      }

      process.stdout.write(`Validating skill "${name}"...\n`);
      const exitCode = await validatePath(name, skillDir);
      if (exitCode !== 0) {
        overallSuccess = false;
      }
    }

    return overallSuccess ? 0 : 1;
  }
}

async function validatePath(skillName: string, path: string): Promise<number> {
  try {
    const { stdout, stderr } = await execFile("npx", ["-y", "skills-check", "check", path]);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.stdout.write(`✓ Skill "${skillName}" is valid.\n`);
    return 0;
  } catch (err: any) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    process.stderr.write(`✗ Validation failed for skill "${skillName}"\n`);
    return 1;
  }
}
