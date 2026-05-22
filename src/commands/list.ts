import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";
import type { ContribSource } from "../core/manifest.js";

export async function runList(args: {
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  if (!existsSync(join(root.path, "skills.json"))) {
    process.stderr.write(
      `error: not initialized at ${root.path}. Run \`skills-manager init\` first.\n`,
    );
    return 1;
  }
  ensureRootLayout(root.path);

  const store = SsotStore.openAt(root.path);
  const names = store.skillNames().sort();

  if (root.scope === "workspace") {
    const globalPath = join(homedir(), ".skills-manager");
    const globalManifestPath = join(globalPath, "skills.json");
    if (existsSync(globalManifestPath)) {
      try {
        const globalStore = SsotStore.openAt(globalPath);
        for (const name of names) {
          if (globalStore.skill(name)) {
            process.stderr.write(
              `warning: skill "${name}" overlaps with a skill in global scope. Workspace copy takes precedence.\n`,
            );
          }
        }
      } catch {
        // ignore errors reading global manifest
      }
    }
  }

  if (names.length === 0) {
    process.stdout.write("No skills installed.\n");
    return 0;
  }

  const entries = names.map((name) => {
    const entry = store.skill(name)!;
    const kind = entry.kind;
    const rawRef = store.resolvedRef(name);
    const ref = kind === "authored" ? "—" : formatRef(rawRef);
    const customized = isCustomized(root.path, name);
    const source = kind === "authored" ? "—" : summarizeSource(entry.source);
    return { name, kind, ref, customized, source };
  });

  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }

  // Padded table output.
  const nameWidth = Math.max(...entries.map((e) => e.name.length), 4);
  const kindWidth = Math.max(...entries.map((e) => e.kind.length), 4);
  const refWidth = Math.max(...entries.map((e) => e.ref.length), 3);
  const custWidth = "[customized]".length;

  for (const e of entries) {
    const custCol = e.customized ? "[customized]" : "";
    process.stdout.write(
      `${e.name.padEnd(nameWidth)}  ${e.kind.padEnd(kindWidth)}  ${e.ref.padEnd(refWidth)}  ${custCol.padEnd(custWidth)}  ${e.source}\n`,
    );
  }
  return 0;
}

function formatRef(ref: string | undefined): string {
  if (!ref) return "—";
  // Shorten hash-like refs to 12 chars.
  if (/^[0-9a-f]{13,}$/i.test(ref)) return ref.slice(0, 12);
  if (ref.length > 12) return ref.slice(0, 12);
  return ref;
}

function isCustomized(rootPath: string, name: string): boolean {
  const patchPath = join(rootPath, "patches", `${name}.patch`);
  if (!existsSync(patchPath)) return false;
  try {
    return statSync(patchPath).size > 0;
  } catch {
    return false;
  }
}

function summarizeSource(s: ContribSource | undefined): string {
  if (!s) return "—";
  switch (s.type) {
    case "git":
      return `git:${s.url ?? ""}${s.ref ? `#${s.ref}` : ""}`;
    case "url":
      return `url:${s.url ?? ""}`;
    case "local":
      return `local:${s.path ?? ""}`;
  }
}
