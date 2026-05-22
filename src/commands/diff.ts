import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import { diffSkill } from "../core/patch.js";
import { safeRefSegment } from "../core/skills-cli.js";

export async function runDiff(args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  if (!args.skill) {
    process.stderr.write(`error: usage: skills-manager diff <skill>\n`);
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
  const entry = store.skill(args.skill);
  if (!entry) {
    process.stderr.write(`error: unknown skill "${args.skill}"\n`);
    return 1;
  }

  if (entry.kind === "authored") {
    process.stdout.write(
      `${args.skill} is self-authored; diff has no upstream to compare against.\n`,
    );
    return 0;
  }

  const ref = store.resolvedRef(args.skill);
  if (!ref) {
    process.stderr.write(
      `error: no resolved ref for ${args.skill}; was it added with \`skills-manager add\`?\n`,
    );
    return 1;
  }

  const liveDir = join(root.path, "skills", args.skill);
  const pristineDir = join(
    root.path,
    ".cache",
    "pristine",
    `${args.skill}@${safeRefSegment(ref)}`,
  );

  const diff = await diffSkill(pristineDir, liveDir);
  if (diff === "") {
    process.stdout.write(`${args.skill}: no drift from pristine.\n`);
    return 0;
  }
  process.stdout.write(diff);
  return 0;
}
