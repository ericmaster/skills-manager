import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ContribSource,
  Lockfile,
  Manifest,
  SkillEntry,
} from "./manifest.js";
import type { DetectedToolRecord, State } from "./state.js";

const MANIFEST = "skills.json";
const LOCKFILE = "skills.lock.json";
const STATE_FILE = "state.json";

export class SsotStore {
  readonly #rootPath: string;
  #manifest: Manifest;
  #lock: Lockfile;
  #state: State;
  #manifestDirty = false;
  #lockDirty = false;
  #stateDirty = false;

  private constructor(
    rootPath: string,
    manifest: Manifest,
    lock: Lockfile,
    state: State,
  ) {
    this.#rootPath = rootPath;
    this.#manifest = manifest;
    this.#lock = lock;
    this.#state = state;
  }

  static openAt(rootPath: string): SsotStore {
    const manifest = readVersioned<Manifest>(
      join(rootPath, MANIFEST),
      { version: 1, skills: {} },
      "skills.json",
    );
    const lock = readVersioned<Lockfile>(
      join(rootPath, LOCKFILE),
      { version: 1, skills: {} },
      "skills.lock.json",
    );
    const state = readVersioned<State>(
      join(rootPath, STATE_FILE),
      { version: 1, tools: [] },
      "state.json",
    );
    return new SsotStore(rootPath, manifest, lock, state);
  }

  // Skills (manifest) -------------------------------------------------------

  skill(name: string): SkillEntry | undefined {
    const e = this.#manifest.skills[name];
    return e ? { ...e } : undefined;
  }

  skillNames(): string[] {
    return Object.keys(this.#manifest.skills);
  }

  recordAuthoredSkill(name: string): void {
    const next: SkillEntry = { kind: "authored" };
    const existing = this.#manifest.skills[name];
    if (existing && entryEquals(existing, next)) return;
    this.#manifest.skills[name] = next;
    this.#manifestDirty = true;
  }

  recordContribSkill(name: string, source: ContribSource): void {
    const next: SkillEntry = { kind: "contrib", source };
    const existing = this.#manifest.skills[name];
    if (existing && entryEquals(existing, next)) return;
    this.#manifest.skills[name] = next;
    this.#manifestDirty = true;
  }

  removeSkill(name: string): void {
    if (!(name in this.#manifest.skills)) return;
    delete this.#manifest.skills[name];
    this.#manifestDirty = true;
  }

  setCustomized(name: string, customized: boolean): void {
    const entry = this.#manifest.skills[name];
    if (!entry) return;
    if (Boolean(entry.customized) === customized) return;
    if (customized) {
      entry.customized = true;
    } else {
      delete entry.customized;
    }
    this.#manifestDirty = true;
  }

  // Lockfile ----------------------------------------------------------------

  resolvedRef(name: string): string | undefined {
    return this.#lock.skills[name]?.resolvedRef;
  }

  pinResolvedRef(name: string, ref: string, atIso?: string): void {
    const at = atIso ?? new Date().toISOString();
    const existing = this.#lock.skills[name];
    if (existing && existing.resolvedRef === ref && existing.resolvedAt === at) {
      return;
    }
    this.#lock.skills[name] = {
      ...existing,
      resolvedRef: ref,
      resolvedAt: at,
    };
    this.#lockDirty = true;
  }

  clearLock(name: string): void {
    if (!(name in this.#lock.skills)) return;
    delete this.#lock.skills[name];
    this.#lockDirty = true;
  }

  // State -------------------------------------------------------------------

  tools(): DetectedToolRecord[] {
    return this.#state.tools.map((t) => ({ ...t }));
  }

  recordToolDetection(records: DetectedToolRecord[], nowIso?: string): void {
    const at = nowIso ?? new Date().toISOString();
    if (
      this.#state.lastDetectedAt === at &&
      toolsEqual(this.#state.tools, records)
    ) {
      return;
    }
    this.#state.tools = records.map((r) => ({ ...r }));
    this.#state.lastDetectedAt = at;
    this.#stateDirty = true;
  }

  lastDetectedAt(): string | undefined {
    return this.#state.lastDetectedAt;
  }

  // Flush -------------------------------------------------------------------

  commit(): void {
    if (this.#manifestDirty) {
      atomicWriteJson(join(this.#rootPath, MANIFEST), this.#manifest);
      this.#manifestDirty = false;
    }
    if (this.#lockDirty) {
      atomicWriteJson(join(this.#rootPath, LOCKFILE), this.#lock);
      this.#lockDirty = false;
    }
    if (this.#stateDirty) {
      atomicWriteJson(join(this.#rootPath, STATE_FILE), this.#state);
      this.#stateDirty = false;
    }
  }

  dirty(): boolean {
    return this.#manifestDirty || this.#lockDirty || this.#stateDirty;
  }
}

function readVersioned<T extends { version: number }>(
  filePath: string,
  empty: T,
  filename: string,
): T {
  if (!existsSync(filePath)) return empty;
  const data = JSON.parse(readFileSync(filePath, "utf8")) as T;
  if (data.version !== 1) {
    throw new Error(`Unsupported ${filename} version: ${data.version}`);
  }
  return data;
}

function atomicWriteJson(path: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, json);
  renameSync(tmp, path);
}

function entryEquals(a: SkillEntry, b: SkillEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (Boolean(a.customized) !== Boolean(b.customized)) return false;
  return sourceEquals(a.source, b.source);
}

function sourceEquals(
  a: ContribSource | undefined,
  b: ContribSource | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.url === b.url &&
    a.path === b.path &&
    a.ref === b.ref &&
    a.subpath === b.subpath
  );
}

function toolsEqual(
  a: DetectedToolRecord[],
  b: DetectedToolRecord[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.detectedAt !== y.detectedAt ||
      x.linkable !== y.linkable ||
      x.linkTarget !== y.linkTarget ||
      x.enabled !== y.enabled
    ) {
      return false;
    }
  }
  return true;
}
