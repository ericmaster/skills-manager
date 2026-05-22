import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { listLinkableTools, type DetectedTool } from "./tool-detect.js";
import type { Manifest } from "./manifest.js";
import { SsotStore } from "./ssot.js";

export interface AdoptLocation {
  /** Tool id (claude-code, hermes, ...). */
  toolId: string;
  /** Absolute path to the skill directory in that tool. */
  path: string;
  /** Hash of the skill tree (content + relative paths). */
  hash: string;
}

export type AdoptStatus =
  | { kind: "single" }
  | { kind: "duplicate-identical" }
  | { kind: "duplicate-conflict" };

export interface AdoptCandidate {
  /** Skill name (directory name under <tool>/skills/). */
  name: string;
  /** All real-dir locations of this skill across detected tools. */
  locations: AdoptLocation[];
  /** Aggregate state — single location, identical duplicates, or conflict. */
  status: AdoptStatus;
}

export interface AdoptScanResult {
  candidates: AdoptCandidate[];
  /** Names skipped because already managed (in manifest under skills/ or authored/). */
  skipped: { name: string; reason: string }[];
}

export async function scanForAdoption(opts: {
  rootPath: string;
  home?: string;
}): Promise<AdoptScanResult> {
  const tools = await listLinkableTools(opts.home);
  const store = SsotStore.openAt(opts.rootPath);
  const managed = new Set(store.skillNames());

  // Collect raw locations: { name -> [locations] }, only for real dirs with SKILL.md.
  const byName = new Map<string, AdoptLocation[]>();
  const skipped: { name: string; reason: string }[] = [];

  for (const tool of tools) {
    const dir = tool.absLinkTarget!;
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const skillPath = join(dir, name);
      const stat = safeLstat(skillPath);
      if (!stat) continue;
      if (stat.isSymbolicLink()) continue; // already managed by us or someone else
      if (!stat.isDirectory()) continue;
      if (!existsSync(join(skillPath, "SKILL.md"))) continue;
      if (managed.has(name)) {
        skipped.push({
          name,
          reason: `already in skills.json (${store.skill(name)!.kind})`,
        });
        continue;
      }
      const hash = hashSkillTree(skillPath);
      const list = byName.get(name) ?? [];
      list.push({ toolId: tool.id, path: skillPath, hash });
      byName.set(name, list);
    }
  }

  const candidates: AdoptCandidate[] = [];
  for (const [name, locations] of byName) {
    let status: AdoptStatus;
    if (locations.length === 1) {
      status = { kind: "single" };
    } else if (locations.every((l) => l.hash === locations[0]!.hash)) {
      status = { kind: "duplicate-identical" };
    } else {
      status = { kind: "duplicate-conflict" };
    }
    candidates.push({ name, locations, status });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return { candidates, skipped };
}

function safeLstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Recursive content hash of a directory tree. Hashes relative paths and file
 * bytes. Skips symlinks (their presence is recorded as the link target string).
 */
export function hashSkillTree(rootDir: string): string {
  const h = createHash("sha256");
  const files = walkSorted(rootDir);
  for (const rel of files) {
    const abs = join(rootDir, rel);
    const stat = lstatSync(abs);
    h.update(rel.split(sep).join("/"));
    h.update("\0");
    if (stat.isSymbolicLink()) {
      h.update("L");
      h.update(readFileSync(abs).toString("utf8"));
    } else if (stat.isFile()) {
      h.update("F");
      h.update(readFileSync(abs));
    } else if (stat.isDirectory()) {
      h.update("D");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

function walkSorted(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      out.push(relative(rootDir, abs));
      const stat = safeLstat(abs);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        stack.push(abs);
      }
    }
  }
  return out.sort();
}

export function findCandidate(
  result: AdoptScanResult,
  name: string,
): AdoptCandidate | undefined {
  return result.candidates.find((c) => c.name === name);
}

export function summarizeCandidate(c: AdoptCandidate): string {
  const tools = c.locations.map((l) => l.toolId).join(", ");
  switch (c.status.kind) {
    case "single":
      return `${c.name.padEnd(24)} [${tools}]`;
    case "duplicate-identical":
      return `${c.name.padEnd(24)} [${tools}] (identical copies)`;
    case "duplicate-conflict":
      return `${c.name.padEnd(24)} [${tools}] (CONFLICT — copies differ)`;
  }
}

export function manifestUsesName(m: Manifest, name: string): boolean {
  return Boolean(m.skills[name]);
}
