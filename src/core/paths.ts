import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RootScope = "global" | "workspace";

export interface ResolvedRoot {
  path: string;
  scope: RootScope;
}

export function resolveRoot(opts?: {
  local?: boolean;
  cwd?: string;
}): ResolvedRoot {
  const cwd = opts?.cwd ?? process.cwd();
  if (opts?.local) {
    return { path: join(cwd, ".skills-manager"), scope: "workspace" };
  }
  // Auto-detect existing workspace root by walking up from cwd.
  let dir = cwd;
  while (true) {
    const candidate = join(dir, ".skills-manager");
    if (existsSync(candidate)) {
      return { path: candidate, scope: "workspace" };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { path: join(homedir(), ".skills-manager"), scope: "global" };
}

export function ensureRootLayout(rootPath: string): void {
  const dirs = [
    rootPath,
    join(rootPath, "skills"),
    join(rootPath, "authored"),
    join(rootPath, "patches"),
    join(rootPath, ".cache"),
    join(rootPath, ".cache", "pristine"),
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }
}

/**
 * Resolves the directory containing the bundled `skills-manager` skill.
 * Works whether the package is run from a built dist/ tree (in which case
 * the bundled skills sit alongside the package root) or from source via
 * tsx/ts-node during dev.
 */
export function getBundledSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/core/paths.js → repo/src/bundled-skills exists at ../../src/bundled-skills
  // src/core/paths.ts (dev)  → repo/src/bundled-skills exists at ../bundled-skills
  const fromDist = resolve(here, "..", "..", "src", "bundled-skills");
  if (existsSync(fromDist)) return fromDist;
  const fromSrc = resolve(here, "..", "bundled-skills");
  if (existsSync(fromSrc)) return fromSrc;
  throw new Error(
    `Could not locate bundled skills directory (looked in ${fromDist} and ${fromSrc}).`,
  );
}
