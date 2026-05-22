import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import { savePatch } from "../core/patch.js";

export async function runSavePatch(args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  if (!args.skill) {
    process.stderr.write(`error: usage: skills-manager save-patch <skill>\n`);
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
      `${args.skill} is self-authored; nothing to save (no upstream pristine).\n`,
    );
    return 0;
  }

  const result = await savePatch(root.path, args.skill);
  if (result.empty) {
    process.stdout.write(
      `${args.skill}: no drift; removed any stale patch.\n`,
    );
    return 0;
  }
  const rel = relative(root.path, result.patchPath);
  process.stdout.write(`${args.skill}: saved ${rel}\n`);
  return 0;
}
