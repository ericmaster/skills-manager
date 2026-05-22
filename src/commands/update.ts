import { execFile as execFileCb } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { applyPatch3Way, savePatch } from "../core/patch.js";
import {
  resolveSourceFromManifest,
  safeRefSegment,
} from "../core/skills-cli.js";
import { SsotStore } from "../core/ssot.js";
import type { ContribSource } from "../core/manifest.js";
import { listLinkableTools } from "../core/tool-detect.js";
import { linkSkillIntoTools } from "../core/linker.js";

const execFile = promisify(execFileCb);

const STAGING_META = ".staging-meta.json";

interface StagingMeta {
  version: 1;
  skillName: string;
  ref: string;
  previousRef: string | undefined;
  startedAt: string;
}

export async function runUpdate(args: {
  skills: string[];
  cont: boolean;
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

  if (args.cont) {
    return runContinue(root.path, args.skills);
  }
  return runDefault(root.path, args.skills);
}

async function runContinue(
  rootPath: string,
  skills: string[],
): Promise<number> {
  if (skills.length !== 1) {
    process.stderr.write(`error: --continue requires one skill name\n`);
    return 1;
  }
  const name = skills[0]!;
  const stagingDir = join(rootPath, ".cache", "staging", name);
  const metaPath = join(stagingDir, STAGING_META);
  if (!existsSync(stagingDir) || !existsSync(metaPath)) {
    process.stderr.write(`error: no paused update for ${name}\n`);
    return 1;
  }
  let meta: StagingMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as StagingMeta;
    if (meta.version !== 1) throw new Error("unsupported version");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `error: invalid staging metadata for ${name}: ${msg}\n`,
    );
    return 1;
  }
  const conflicted = scanForConflictMarkers(stagingDir);
  if (conflicted.length > 0) {
    process.stderr.write(
      `error: ${conflicted[0]} still has merge markers; finish resolving or delete .cache/staging/${name}/ to abort\n`,
    );
    return 1;
  }
  const store = SsotStore.openAt(rootPath);
  try {
    await swap(rootPath, name, meta, store);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${name}: swap failed: ${msg}\n`);
    return 1;
  }
  const oldRef = meta.previousRef ?? "<unknown>";
  process.stdout.write(
    `${name}: update completed (${shorten(oldRef)} → ${shorten(meta.ref)})\n`,
  );
  return 0;
}

async function runDefault(
  rootPath: string,
  requested: string[],
): Promise<number> {
  const store = SsotStore.openAt(rootPath);
  let workingSet: string[];
  if (requested.length > 0) {
    for (const name of requested) {
      const entry = store.skill(name);
      if (!entry) {
        process.stderr.write(`error: unknown skill "${name}"\n`);
        return 1;
      }
      if (entry.kind !== "contrib") {
        process.stderr.write(
          `error: ${name} is ${entry.kind}; only contrib skills can be updated\n`,
        );
        return 1;
      }
    }
    workingSet = requested;
  } else {
    workingSet = store.skillNames().filter((n) => {
      const e = store.skill(n);
      return e?.kind === "contrib";
    });
  }

  let updated = 0;
  let paused = 0;
  let failed = 0;
  let skipped = 0;

  for (const name of workingSet) {
    const outcome = await updateOne(rootPath, name, store);
    switch (outcome.kind) {
      case "updated":
        updated++;
        process.stdout.write(
          `${name}: updated (${shorten(outcome.oldRef)} → ${shorten(outcome.newRef)})\n`,
        );
        break;
      case "noop":
        skipped++;
        process.stdout.write(`${name}: already up to date\n`);
        break;
      case "paused":
        paused++;
        process.stdout.write(
          `${name}: conflict — resolve in ${outcome.stagingDir} and run \`update --continue ${name}\`. Conflicted files: ${outcome.conflicts.join(", ")}\n`,
        );
        break;
      case "failed":
        failed++;
        process.stderr.write(`error: ${name}: ${outcome.message}\n`);
        break;
    }
  }

  process.stdout.write(
    `\n${updated} updated, ${paused} paused on conflict, ${failed} failed, ${skipped} skipped\n`,
  );
  return failed > 0 ? 1 : 0;
}

type UpdateOutcome =
  | { kind: "updated"; oldRef: string; newRef: string }
  | { kind: "noop" }
  | { kind: "paused"; stagingDir: string; conflicts: string[] }
  | { kind: "failed"; message: string };

async function updateOne(
  rootPath: string,
  name: string,
  store: SsotStore,
): Promise<UpdateOutcome> {
  // Step 1: Save current patch first (capture uncommitted drift).
  try {
    await savePatch(rootPath, name);
  } catch (err) {
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const stagingDir = join(rootPath, ".cache", "staging", name);
  // Step 2: Refuse if a staging dir already exists.
  if (existsSync(stagingDir)) {
    return {
      kind: "failed",
      message: `${name} has a pending update; resolve and run \`update --continue ${name}\` or delete .cache/staging/${name}/`,
    };
  }

  const entry = store.skill(name);
  if (!entry || entry.kind !== "contrib" || !entry.source) {
    return { kind: "failed", message: `${name} is not a contrib skill` };
  }
  const oldRef = store.resolvedRef(name);
  if (!oldRef) {
    return { kind: "failed", message: `${name} has no resolvedRef in lockfile` };
  }

  // Step 3: Re-resolve source.
  let resolved;
  try {
    resolved = await resolveSourceFromManifest(
      entry.source as ContribSource,
      rootPath,
    );
  } catch (err) {
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const newRef = resolved.ref;
  const newPristineDir = resolved.pristinePath;

  const patchPath = join(rootPath, "patches", `${name}.patch`);
  const patchEmpty =
    !existsSync(patchPath) || statSync(patchPath).size === 0;

  // Step 4: Short-circuit no-op.
  if (newRef === oldRef && patchEmpty) {
    return { kind: "noop" };
  }

  // Step 5+6+7: Build staging tree, pre-stage old pristine into git, swap to new.
  const oldPristineDir = join(
    rootPath,
    ".cache",
    "pristine",
    `${name}@${safeRefSegment(oldRef)}`,
  );
  if (!existsSync(oldPristineDir)) {
    return {
      kind: "failed",
      message: `old pristine missing at ${oldPristineDir}`,
    };
  }

  try {
    cpSync(oldPristineDir, stagingDir, { recursive: true });
    await execFile("git", ["init", "-q"], { cwd: stagingDir });
    const ident = [
      "-c",
      "user.email=skills-manager@local",
      "-c",
      "user.name=skills-manager",
    ];
    await execFile("git", [...ident, "add", "-A"], { cwd: stagingDir });
    await execFile(
      "git",
      [...ident, "commit", "-q", "--allow-empty", "-m", "pristine"],
      { cwd: stagingDir },
    );

    // Replace working tree with new pristine (preserve .git, then write sentinel).
    clearWorkingTree(stagingDir);
    cpSync(newPristineDir, stagingDir, { recursive: true });
    const meta: StagingMeta = {
      version: 1,
      skillName: name,
      ref: newRef,
      previousRef: oldRef,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(stagingDir, STAGING_META), JSON.stringify(meta, null, 2) + "\n");
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    return {
      kind: "failed",
      message: `failed to build staging: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 7 (continued): Apply patch.
  let result;
  try {
    result = await applyPatch3Way(stagingDir, patchPath);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.status === "conflict") {
    return {
      kind: "paused",
      stagingDir,
      conflicts: result.conflictedPaths,
    };
  }

  // Clean apply → swap.
  try {
    const meta: StagingMeta = JSON.parse(
      readFileSync(join(stagingDir, STAGING_META), "utf8"),
    );
    await swap(rootPath, name, meta, store);
  } catch (err) {
    return {
      kind: "failed",
      message: `swap failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { kind: "updated", oldRef, newRef };
}

/**
 * Promote a successful staging tree to live. The staging dir's existence is
 * the only mutex against concurrent updates; this helper assumes the caller
 * has already verified the tree is conflict-free.
 */
async function swap(
  rootPath: string,
  name: string,
  meta: StagingMeta,
  store: SsotStore,
): Promise<void> {
  const stagingDir = join(rootPath, ".cache", "staging", name);
  const liveDir = join(rootPath, "skills", name);
  const newRef = meta.ref;
  const oldRef = meta.previousRef;

  // 1. Remove sentinel from staging tree.
  const sentinelPath = join(stagingDir, STAGING_META);
  if (existsSync(sentinelPath)) {
    rmSync(sentinelPath, { force: true });
  }

  // 2. Atomic-ish swap.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const oldLive = join(rootPath, ".cache", `oldlive-${name}-${ts}`);
  const liveExisted = existsSync(liveDir);
  if (liveExisted) {
    renameSync(liveDir, oldLive);
  }
  try {
    renameSync(stagingDir, liveDir);
  } catch (err) {
    // Recovery hint: oldlive holds the previous state.
    if (liveExisted) {
      try {
        renameSync(oldLive, liveDir);
      } catch {
        /* leave oldlive in place for manual recovery */
      }
    }
    throw err;
  }
  if (liveExisted) {
    rmSync(oldLive, { recursive: true, force: true });
  }

  // 3. Replace pristine cache.
  if (oldRef && oldRef !== newRef) {
    const oldPristineDir = join(
      rootPath,
      ".cache",
      "pristine",
      `${name}@${safeRefSegment(oldRef)}`,
    );
    rmSync(oldPristineDir, { recursive: true, force: true });
  }
  // New pristine is already at .cache/pristine/<name>@<safeRef(newRef)>/ from
  // resolveSourceFromManifest; nothing to copy.

  // 4. Update lockfile.
  store.pinResolvedRef(name, newRef);
  store.commit();

  // 5. Refresh tool symlinks. The renameSync chain leaves the dir at liveDir,
  // so existing symlinks pointing at liveDir remain valid. Re-link defensively
  // in case any went stale.
  const tools = await listLinkableTools();
  linkSkillIntoTools(name, liveDir, tools);
}

function clearWorkingTree(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git") continue;
    rmSync(join(dir, ent.name), { recursive: true, force: true });
  }
}

function scanForConflictMarkers(root: string): string[] {
  const found: string[] = [];
  const skip = new Set([".git"]);
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        let body: string;
        try {
          body = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (body.includes("<<<<<<< ")) {
          found.push(relative(root, full));
        }
      }
    }
  };
  walk(root);
  return found;
}

function shorten(ref: string): string {
  return ref.length > 12 ? ref.slice(0, 12) : ref;
}
