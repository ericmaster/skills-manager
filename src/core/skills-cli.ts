/**
 * Source resolution.
 *
 * Phase 2 implements this directly with `git`, `tar`, and `node:fs` rather
 * than shelling out to `npx skills`. ADR-0004 left the subprocess door open;
 * we walked through it for a different reason: the patch / pristine model
 * needs a deterministic local pristine path, which is simpler to produce
 * here than to round-trip through the upstream CLI.
 *
 * `.zip` archives are not yet supported; surface a clear error if the user
 * passes one. Add when needed.
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import type { ContribSource } from "./manifest.js";

const execFile = promisify(execFileCb);

export interface ResolvedSourceRef {
  /** Pinned ref: commit hash for git, "url@<sha256>" for url, "local@<sha256>" for local. */
  ref: string;
  /** Absolute path inside <root>/.cache/pristine/<name>@<safeRef>/. */
  pristinePath: string;
  /** From SKILL.md frontmatter `name:`. */
  skillName: string;
  /** Normalized — matches the manifest schema. */
  source: ContribSource;
}

interface ParsedSource {
  type: "git" | "url" | "local";
  url?: string;
  ref?: string;
  subpath?: string;
  path?: string;
}

export function parseSource(input: string): ParsedSource {
  // git@host:org/repo.git[#ref][?path=subpath]
  // https://host/org/repo.git[#ref][?path=subpath]
  // https://host/path/to/file.{tar.gz,tgz,SKILL.md} → url
  // anything-else-resolvable-on-disk → local

  if (input.startsWith("git@")) {
    return splitGit(input);
  }

  if (input.startsWith("https://") || input.startsWith("http://")) {
    // Strip query/fragment for type detection.
    const stripped = input.split(/[?#]/)[0]!;
    if (stripped.endsWith(".git") || /github\.com|gitlab\.com|bitbucket\.org/.test(stripped)) {
      // Treat as git unless it clearly points at a downloadable artifact.
      if (
        stripped.endsWith(".tar.gz") ||
        stripped.endsWith(".tgz") ||
        stripped.endsWith(".zip") ||
        stripped.endsWith("SKILL.md")
      ) {
        return { type: "url", url: input };
      }
      return splitGit(input);
    }
    if (
      stripped.endsWith(".tar.gz") ||
      stripped.endsWith(".tgz") ||
      stripped.endsWith(".zip") ||
      stripped.endsWith("SKILL.md")
    ) {
      return { type: "url", url: input };
    }
    throw new Error(
      `unrecognized source: ${input} (URL must end in .git, .tar.gz, .tgz, .zip, or SKILL.md)`,
    );
  }

  if (existsSync(input)) {
    return { type: "local", path: input };
  }

  throw new Error(`unrecognized source: ${input}`);
}

function splitGit(input: string): ParsedSource {
  // Order of fragments is fixed: <url>[?path=<sub>][#<ref>]
  let url = input;
  let ref: string | undefined;
  let subpath: string | undefined;

  const hashIdx = url.indexOf("#");
  if (hashIdx >= 0) {
    ref = url.slice(hashIdx + 1) || undefined;
    url = url.slice(0, hashIdx);
  }
  const qIdx = url.indexOf("?");
  if (qIdx >= 0) {
    const qs = url.slice(qIdx + 1);
    url = url.slice(0, qIdx);
    for (const pair of qs.split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k === "path") subpath = decodeURIComponent(v);
    }
  }
  return { type: "git", url, ref, subpath };
}

export async function resolveSource(
  source: string,
  rootPath: string,
): Promise<ResolvedSourceRef> {
  const parsed = parseSource(source);
  switch (parsed.type) {
    case "local":
      return resolveLocal(parsed, rootPath);
    case "git":
      return resolveGit(parsed, rootPath);
    case "url":
      return resolveUrl(parsed, rootPath);
  }
}

/**
 * Re-resolve a source from a manifest entry, without round-tripping through
 * the string form. Used by `update` to fetch the latest ref of a previously
 * added skill.
 */
export async function resolveSourceFromManifest(
  source: ContribSource,
  rootPath: string,
): Promise<ResolvedSourceRef> {
  switch (source.type) {
    case "local":
      if (!source.path) throw new Error("local source missing path");
      return resolveLocal({ type: "local", path: source.path }, rootPath);
    case "git":
      if (!source.url) throw new Error("git source missing url");
      return resolveGit(
        {
          type: "git",
          url: source.url,
          ref: source.ref,
          subpath: source.subpath,
        },
        rootPath,
      );
    case "url":
      if (!source.url) throw new Error("url source missing url");
      return resolveUrl({ type: "url", url: source.url }, rootPath);
  }
}

async function resolveLocal(
  parsed: ParsedSource,
  rootPath: string,
): Promise<ResolvedSourceRef> {
  const src = parsed.path!;
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`local source must be an existing directory: ${src}`);
  }
  const stage = mkdtempSync(join(tmpdir(), "skm-local-"));
  try {
    cpSync(src, join(stage, "skill"), { recursive: true });
    const inner = join(stage, "skill");
    const skillMdPath = locateSingleSkillMd(inner);
    const { name } = parseSkillFrontmatter(readFileSync(skillMdPath, "utf8"), skillMdPath);
    const hash = hashTree(inner);
    const ref = `local@${hash}`;
    const pristinePath = installToPristine(rootPath, name, ref, inner);
    return {
      ref,
      pristinePath,
      skillName: name,
      source: { type: "local", path: src },
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function resolveGit(
  parsed: ParsedSource,
  rootPath: string,
): Promise<ResolvedSourceRef> {
  const stage = mkdtempSync(join(tmpdir(), "skm-git-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (parsed.ref) args.push("--branch", parsed.ref);
    args.push(parsed.url!, stage);
    await execFile("git", args, { maxBuffer: 64 * 1024 * 1024 });

    const { stdout: head } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: stage,
    });
    const commit = head.trim();

    rmSync(join(stage, ".git"), { recursive: true, force: true });

    const skillRoot = parsed.subpath ? join(stage, parsed.subpath) : stage;
    if (!existsSync(skillRoot) || !statSync(skillRoot).isDirectory()) {
      throw new Error(`subpath not found in repo: ${parsed.subpath}`);
    }
    const skillMdPath = locateSingleSkillMd(skillRoot);
    const { name } = parseSkillFrontmatter(readFileSync(skillMdPath, "utf8"), skillMdPath);
    const ref = commit;
    const pristinePath = installToPristine(rootPath, name, ref, skillRoot);
    return {
      ref,
      pristinePath,
      skillName: name,
      source: {
        type: "git",
        url: parsed.url,
        ref: parsed.ref,
        subpath: parsed.subpath,
      },
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function resolveUrl(
  parsed: ParsedSource,
  rootPath: string,
): Promise<ResolvedSourceRef> {
  const url = parsed.url!;
  const stage = mkdtempSync(join(tmpdir(), "skm-url-"));
  try {
    const stripped = url.split(/[?#]/)[0]!;
    const downloadPath = join(stage, basename(stripped));
    await downloadTo(url, downloadPath);

    const skillRoot = join(stage, "skill");
    mkdirSync(skillRoot, { recursive: true });

    if (stripped.endsWith(".tar.gz") || stripped.endsWith(".tgz")) {
      await execFile(
        "tar",
        ["-xzf", downloadPath, "-C", skillRoot, "--strip-components=1"],
        { maxBuffer: 64 * 1024 * 1024 },
      );
    } else if (stripped.endsWith(".zip")) {
      throw new Error(
        ".zip URL sources are not supported yet. Use a tarball or git source.",
      );
    } else if (stripped.endsWith("SKILL.md")) {
      cpSync(downloadPath, join(skillRoot, "SKILL.md"));
    } else {
      throw new Error(`unsupported URL artifact: ${url}`);
    }

    const skillMdPath = locateSingleSkillMd(skillRoot);
    const { name } = parseSkillFrontmatter(readFileSync(skillMdPath, "utf8"), skillMdPath);
    const hash = hashTree(skillRoot);
    const ref = `url@${hash}`;
    const pristinePath = installToPristine(rootPath, name, ref, skillRoot);
    return {
      ref,
      pristinePath,
      skillName: name,
      source: { type: "url", url },
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

/**
 * Walk the tree once, collect every SKILL.md, and pick the one at the root if
 * unambiguous. If multiple exist below the root, throw with the candidates so
 * the user can pass the appropriate subpath.
 */
function locateSingleSkillMd(rootDir: string): string {
  const found: string[] = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile() && ent.name === "SKILL.md") {
        found.push(abs);
      }
    }
  }
  if (found.length === 0) {
    throw new Error(`no SKILL.md found under ${rootDir}`);
  }
  const atRoot = join(rootDir, "SKILL.md");
  if (existsSync(atRoot)) return atRoot;
  if (found.length > 1) {
    const list = found.map((p) => relative(rootDir, p)).join(", ");
    throw new Error(
      `multiple SKILL.md files found, pass a subpath. Candidates: ${list}`,
    );
  }
  return found[0]!;
}

export function parseSkillFrontmatter(
  body: string,
  filePath: string,
): { name: string; description?: string } {
  // Normalize CRLF.
  const text = body.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) {
    throw new Error(`SKILL.md missing YAML frontmatter at ${filePath}`);
  }
  const block = m[1]!;
  const nameLine = /^name:[\t ]*(.+?)[\t ]*$/m.exec(block);
  const descLine = /^description:[\t ]*(.+?)[\t ]*$/m.exec(block);
  if (!nameLine) {
    throw new Error(`SKILL.md missing required \`name\` field at ${filePath}`);
  }
  return {
    name: stripQuotes(nameLine[1]!),
    description: descLine ? stripQuotes(descLine[1]!) : undefined,
  };
}

function stripQuotes(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function hashTree(rootDir: string): string {
  const h = createHash("sha256");
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        files.push(relative(rootDir, abs));
      }
    }
  }
  files.sort();
  for (const rel of files) {
    h.update(rel.split(sep).join("/"));
    h.update("\0");
    h.update(readFileSync(join(rootDir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

export function safeRefSegment(ref: string): string {
  // Strip path traversal, separators, shell metacharacters.
  return ref.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "ref";
}

function installToPristine(
  rootPath: string,
  name: string,
  ref: string,
  sourceDir: string,
): string {
  const safe = safeRefSegment(ref);
  const dest = join(rootPath, ".cache", "pristine", `${name}@${safe}`);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) return dest;
  // Atomic-ish: stage, then rename.
  const tmp = `${dest}.tmp-${process.pid}`;
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  cpSync(sourceDir, tmp, { recursive: true });
  renameSync(tmp, dest);
  return dest;
}
