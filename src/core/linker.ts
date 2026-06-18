import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { DetectedTool } from "./tool-detect.js";

export type LinkStatus =
  | "linked"
  | "already-linked"
  | "unlinked"
  | "absent"
  | "skipped-non-symlink"
  | "skipped-foreign-target"
  | "failed";

export interface LinkSiteResult {
  toolId: string;
  linkPath: string;
  status: LinkStatus;
  message?: string;
}

interface LinkSiteState {
  kind: "absent" | "symlink" | "real";
  target?: string;
}

function inspect(linkPath: string): LinkSiteState {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return { kind: "absent" };
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(linkPath);
    } catch {
      // Symlink exists but readlink failed — treat like a foreign symlink.
      return { kind: "symlink", target: "" };
    }
    return { kind: "symlink", target };
  }
  return { kind: "real" };
}

export function linkSiteToSkill(
  linkPath: string,
  targetPath: string,
  toolId?: string,
  linkStrategy: "dir" | "file" = "dir",
): LinkSiteResult {
  const id = toolId ?? "";
  if (!isAbsolute(targetPath)) {
    return {
      toolId: id,
      linkPath,
      status: "failed",
      message: `targetPath must be an absolute path; got "${targetPath}"`,
    };
  }
  const state = inspect(linkPath);
  try {
    if (state.kind === "real") {
      return {
        toolId: id,
        linkPath,
        status: "skipped-non-symlink",
        message: `Refusing to overwrite non-symlink at ${linkPath}. Move or remove it manually.`,
      };
    }
    if (state.kind === "symlink") {
      if (state.target === targetPath) {
        return { toolId: id, linkPath, status: "already-linked" };
      }
      unlinkSync(linkPath);
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(targetPath, linkPath, linkStrategy === "dir" ? "dir" : "file");
    return { toolId: id, linkPath, status: "linked" };
  } catch (err) {
    return {
      toolId: id,
      linkPath,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function unlinkSiteFromSkill(
  linkPath: string,
  targetPath: string,
  toolId?: string,
): LinkSiteResult {
  const id = toolId ?? "";
  const state = inspect(linkPath);
  if (state.kind === "absent") {
    return { toolId: id, linkPath, status: "absent" };
  }
  if (state.kind === "real") {
    return {
      toolId: id,
      linkPath,
      status: "skipped-non-symlink",
      message: `Refusing to remove non-symlink at ${linkPath}.`,
    };
  }
  if (state.target !== targetPath) {
    return {
      toolId: id,
      linkPath,
      status: "skipped-foreign-target",
      message: `Symlink at ${linkPath} points at ${state.target ?? "<unreadable>"}, not ${targetPath}.`,
    };
  }
  try {
    unlinkSync(linkPath);
    return { toolId: id, linkPath, status: "unlinked" };
  } catch (err) {
    return {
      toolId: id,
      linkPath,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function linkSkillIntoTools(
  skillName: string,
  skillDir: string,
  tools: DetectedTool[],
): LinkSiteResult[] {
  const results: LinkSiteResult[] = [];
  for (const tool of tools) {
    if (!tool.absLinkTarget) continue;
    const isFileLink = tool.linkStrategy === "file";
    const linkPath = isFileLink
      ? join(tool.absLinkTarget, `${skillName}.md`)
      : join(tool.absLinkTarget, skillName);
    const targetPath = isFileLink
      ? join(skillDir, "SKILL.md")
      : skillDir;
    results.push(linkSiteToSkill(linkPath, targetPath, tool.id, isFileLink ? "file" : "dir"));
  }
  return results;
}

export function unlinkSkillFromTools(
  skillName: string,
  skillDir: string,
  tools: DetectedTool[],
): LinkSiteResult[] {
  const results: LinkSiteResult[] = [];
  for (const tool of tools) {
    if (!tool.absLinkTarget) continue;
    const isFileLink = tool.linkStrategy === "file";
    const linkPath = isFileLink
      ? join(tool.absLinkTarget, `${skillName}.md`)
      : join(tool.absLinkTarget, skillName);
    const targetPath = isFileLink
      ? join(skillDir, "SKILL.md")
      : skillDir;
    results.push(unlinkSiteFromSkill(linkPath, targetPath, tool.id));
  }
  return results;
}
