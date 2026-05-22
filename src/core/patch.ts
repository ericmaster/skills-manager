import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { SsotStore } from "./ssot.js";
import { safeRefSegment } from "./skills-cli.js";

const execFileP = promisify(execFile);

export interface PatchApplyResult {
  status: "clean" | "conflict";
  /** When status is "conflict", paths inside `targetDir` left with merge markers. */
  conflictedPaths: string[];
}

interface ExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export async function diffSkill(
  pristineDir: string,
  liveDir: string,
): Promise<string> {
  if (!existsSync(pristineDir)) {
    throw new Error(`pristine dir does not exist: ${pristineDir}`);
  }
  if (!existsSync(liveDir)) {
    throw new Error(`live dir does not exist: ${liveDir}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "skm-diff-"));
  try {
    cpSync(pristineDir, join(tmp, "a"), { recursive: true });
    cpSync(liveDir, join(tmp, "b"), { recursive: true });
    try {
      const { stdout } = await execFileP(
        "git",
        [
          "diff",
          "--no-index",
          "--no-color",
          "--binary",
          "--src-prefix=",
          "--dst-prefix=",
          "--",
          "a",
          "b",
        ],
        { cwd: tmp, maxBuffer: 64 * 1024 * 1024 },
      );
      return stdout;
    } catch (e) {
      const err = e as ExecError;
      if (err.code === 1) {
        return err.stdout ?? "";
      }
      throw new Error(err.stderr?.trim() || "git diff --no-index failed");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function savePatch(
  rootPath: string,
  name: string,
): Promise<{ patchPath: string; empty: boolean }> {
  const ref = SsotStore.openAt(rootPath).resolvedRef(name);
  if (!ref) {
    throw new Error(
      `no resolved ref for ${name}; was it added with \`skills-manager add\`?`,
    );
  }
  const liveDir = join(rootPath, "skills", name);
  const pristineDir = join(
    rootPath,
    ".cache",
    "pristine",
    `${name}@${safeRefSegment(ref)}`,
  );
  if (!existsSync(liveDir)) {
    throw new Error(`live skill dir missing: ${liveDir}`);
  }
  if (!existsSync(pristineDir)) {
    throw new Error(`pristine cache missing: ${pristineDir}`);
  }
  const diff = await diffSkill(pristineDir, liveDir);
  const patchPath = join(rootPath, "patches", `${name}.patch`);
  mkdirSync(dirname(patchPath), { recursive: true });
  if (diff === "") {
    if (existsSync(patchPath)) unlinkSync(patchPath);
    return { patchPath, empty: true };
  }
  writeFileSync(patchPath, diff);
  return { patchPath, empty: false };
}

export async function applyPatch3Way(
  targetDir: string,
  patchPath: string,
): Promise<PatchApplyResult> {
  if (!existsSync(patchPath) || statSync(patchPath).size === 0) {
    return { status: "clean", conflictedPaths: [] };
  }
  const gitDir = join(targetDir, ".git");
  const ident = [
    "-c",
    "user.email=skills-manager@local",
    "-c",
    "user.name=skills-manager",
  ];
  try {
    await execFileP("git", ["init", "-q"], { cwd: targetDir });
    await execFileP("git", [...ident, "add", "-A"], { cwd: targetDir });
    await execFileP(
      "git",
      [...ident, "commit", "-q", "--allow-empty", "-m", "base"],
      { cwd: targetDir },
    );
    let applyError: ExecError | undefined;
    try {
      await execFileP(
        "git",
        ["apply", "--3way", "--whitespace=nowarn", patchPath],
        { cwd: targetDir, maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (e) {
      applyError = e as ExecError;
    }
    if (!applyError) {
      return { status: "clean", conflictedPaths: [] };
    }
    // Treats any "<<<<<<< " as a conflict marker; rare false positives in prose are acceptable for now.
    const conflicted = scanForConflictMarkers(targetDir);
    if (conflicted.length > 0) {
      return { status: "conflict", conflictedPaths: conflicted };
    }
    throw new Error(
      applyError.stderr?.trim() || "git apply --3way failed",
    );
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
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
