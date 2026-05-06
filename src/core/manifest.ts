import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type SkillKind = "contrib" | "authored";

export interface ContribSource {
  type: "git" | "url" | "local";
  url?: string;
  path?: string;
  ref?: string;
  subpath?: string;
}

export interface SkillEntry {
  kind: SkillKind;
  source?: ContribSource;
  customized?: boolean;
}

export interface Manifest {
  version: 1;
  skills: Record<string, SkillEntry>;
}

export interface LockedSkill {
  resolvedRef?: string;
  resolvedAt?: string;
  checksum?: string;
}

export interface Lockfile {
  version: 1;
  skills: Record<string, LockedSkill>;
}

const MANIFEST = "skills.json";
const LOCKFILE = "skills.lock.json";

export function readManifest(rootPath: string): Manifest {
  const p = join(rootPath, MANIFEST);
  if (!existsSync(p)) return { version: 1, skills: {} };
  const data = JSON.parse(readFileSync(p, "utf8")) as Manifest;
  if (data.version !== 1) {
    throw new Error(`Unsupported skills.json version: ${data.version}`);
  }
  return data;
}

export function writeManifest(rootPath: string, manifest: Manifest): void {
  writeFileSync(join(rootPath, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
}

export function readLockfile(rootPath: string): Lockfile {
  const p = join(rootPath, LOCKFILE);
  if (!existsSync(p)) return { version: 1, skills: {} };
  const data = JSON.parse(readFileSync(p, "utf8")) as Lockfile;
  if (data.version !== 1) {
    throw new Error(`Unsupported skills.lock.json version: ${data.version}`);
  }
  return data;
}

export function writeLockfile(rootPath: string, lock: Lockfile): void {
  writeFileSync(join(rootPath, LOCKFILE), JSON.stringify(lock, null, 2) + "\n");
}
