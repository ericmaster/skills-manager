import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";

export async function runCustomize(args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  if (!args.skill) {
    process.stderr.write("error: usage: skills-manager customize <skill>\n");
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
    process.stderr.write(`error: skill "${name}" is not registered in skills.json\n`);
    return 1;
  }

  const liveDir =
    entry.kind === "contrib"
      ? join(root.path, "skills", name)
      : join(root.path, "authored", name);

  if (!existsSync(liveDir)) {
    process.stderr.write(`error: skill directory for "${name}" does not exist on disk at ${liveDir}\n`);
    return 1;
  }

  const editor = process.env.EDITOR;
  if (editor) {
    process.stdout.write(`Opening skill "${name}" directory in editor: ${editor}...\n`);
    return new Promise<number>((resolve) => {
      const child = spawn(editor, [liveDir], {
        stdio: "inherit",
        shell: true,
      });

      child.on("exit", (code) => {
        resolve(code ?? 0);
      });

      child.on("error", (err) => {
        process.stderr.write(`error: failed to launch editor "${editor}": ${err.message}\n`);
        resolve(1);
      });
    });
  } else {
    process.stdout.write(`Skill "${name}" directory path:\n  ${liveDir}\n\n`);
    process.stdout.write("Tip: Set the EDITOR environment variable to automatically open skills in your editor.\n");
    process.stdout.write(`Example: export EDITOR="code" or export EDITOR="nano"\n`);
    return 0;
  }
}

