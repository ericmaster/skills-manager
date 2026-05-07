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
  skillDir: string,
  toolId?: string,
): LinkSiteResult {
  const id = toolId ?? "";
  if (!isAbsolute(skillDir)) {
    return {
      toolId: id,
      linkPath,
      status: "failed",
      message: `skillDir must be an absolute path; got "${skillDir}"`,
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
      if (state.target === skillDir) {
        return { toolId: id, linkPath, status: "already-linked" };
      }
      unlinkSync(linkPath);
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(skillDir, linkPath, "dir");
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
  skillDir: string,
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
  if (state.target !== skillDir) {
    return {
      toolId: id,
      linkPath,
      status: "skipped-foreign-target",
      message: `Symlink at ${linkPath} points at ${state.target ?? "<unreadable>"}, not ${skillDir}.`,
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
    const linkPath = join(tool.absLinkTarget, skillName);
    results.push(linkSiteToSkill(linkPath, skillDir, tool.id));
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
    const linkPath = join(tool.absLinkTarget, skillName);
    results.push(unlinkSiteFromSkill(linkPath, skillDir, tool.id));
  }
  return results;
}
