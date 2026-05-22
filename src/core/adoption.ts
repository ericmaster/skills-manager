import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { AdoptCandidate } from "./adopt-scan.js";
import {
  linkSiteToSkill,
  type LinkSiteResult,
} from "./linker.js";
import { SsotStore } from "./ssot.js";

export interface AdoptPlanInput {
  candidate: AdoptCandidate;
  flags: { from?: string; keepOtherAs?: string };
  rootPath: string;
}

export type AdoptMode =
  | "single"
  | "duplicate-identical"
  | "conflict-takeover"
  | "conflict-split";

export interface AdoptPlan {
  mode: AdoptMode;
  name: string;
  rootPath: string;
  primary: { sourcePath: string; targetDir: string; toolId: string };
  split?: {
    sourcePath: string;
    targetDir: string;
    targetName: string;
    toolId: string;
  };
  /** When `backupTo` is set, the executor will copy the dir there first.
   *  The path contains the `__TS__` placeholder, replaced at execute time
   *  so all removals share one timestamp. */
  removals: { path: string; toolId: string; backupTo?: string }[];
  links: { linkPath: string; targetDir: string; toolId: string }[];
  manifestEntries: { name: string; kind: "authored" }[];
}

export interface AdoptPlanError {
  message: string;
}

export type PlanResult =
  | { ok: true; plan: AdoptPlan }
  | { ok: false; error: AdoptPlanError };

export interface AdoptExecResult {
  performed: {
    kind: "rename" | "backup" | "remove" | "link" | "manifest-write";
    detail: string;
  }[];
  linkResults: LinkSiteResult[];
}

const TS_PLACEHOLDER = "__TS__";

export function planAdoption(input: AdoptPlanInput): PlanResult {
  const { candidate, flags, rootPath } = input;
  const targetDir = join(rootPath, "authored", candidate.name);

  const toolList = candidate.locations.map((l) => l.toolId).join(", ");

  if (flags.keepOtherAs && !flags.from) {
    return {
      ok: false,
      error: {
        message:
          "`--keep-other-as` also requires `--from <tool>` to pick the primary copy.",
      },
    };
  }

  if (
    flags.from &&
    !candidate.locations.some((l) => l.toolId === flags.from)
  ) {
    return {
      ok: false,
      error: {
        message: `\`--from "${flags.from}"\` not in candidate locations [${toolList}].`,
      },
    };
  }

  let mode: AdoptMode;
  let primaryLoc;
  let otherLocs: typeof candidate.locations = [];

  if (candidate.status.kind === "single") {
    mode = "single";
    primaryLoc = candidate.locations[0]!;
  } else if (candidate.status.kind === "duplicate-identical") {
    mode = "duplicate-identical";
    primaryLoc = candidate.locations[0]!;
    otherLocs = candidate.locations.slice(1);
  } else {
    if (!flags.from) {
      return {
        ok: false,
        error: {
          message: `${candidate.name} has differing copies in [${toolList}]. Pick one with \`--from <tool>\`, or split with \`--from <tool> --keep-other-as <new-name>\`.`,
        },
      };
    }
    primaryLoc = candidate.locations.find((l) => l.toolId === flags.from)!;
    otherLocs = candidate.locations.filter((l) => l.toolId !== flags.from);
    mode = flags.keepOtherAs ? "conflict-split" : "conflict-takeover";
  }

  if (existsSync(targetDir)) {
    return {
      ok: false,
      error: {
        message: `\`${targetDir}\` already exists; refusing to overwrite. Move it aside and retry.`,
      },
    };
  }

  let split: AdoptPlan["split"] | undefined;
  if (mode === "conflict-split") {
    const otherLoc = otherLocs[0]!;
    const otherDir = join(rootPath, "authored", flags.keepOtherAs!);
    if (existsSync(otherDir)) {
      return {
        ok: false,
        error: {
          message: `\`${otherDir}\` already exists; pick a different \`--keep-other-as\` name.`,
        },
      };
    }
    split = {
      sourcePath: otherLoc.path,
      targetDir: otherDir,
      targetName: flags.keepOtherAs!,
      toolId: otherLoc.toolId,
    };
  }

  const removals: AdoptPlan["removals"] = [];
  const links: AdoptPlan["links"] = [
    { linkPath: primaryLoc.path, targetDir, toolId: primaryLoc.toolId },
  ];
  const manifestEntries: AdoptPlan["manifestEntries"] = [
    { name: candidate.name, kind: "authored" },
  ];

  if (mode === "duplicate-identical") {
    for (const l of otherLocs) {
      removals.push({ path: l.path, toolId: l.toolId });
      links.push({ linkPath: l.path, targetDir, toolId: l.toolId });
    }
  } else if (mode === "conflict-takeover") {
    for (const l of otherLocs) {
      removals.push({
        path: l.path,
        toolId: l.toolId,
        backupTo: join(
          rootPath,
          ".cache",
          "adopted-backup",
          TS_PLACEHOLDER,
          l.toolId,
          candidate.name,
        ),
      });
      links.push({ linkPath: l.path, targetDir, toolId: l.toolId });
    }
  } else if (mode === "conflict-split") {
    // The split loser is moved (not removed/backed up) and gets its own link site.
    links.push({
      linkPath: split!.sourcePath,
      targetDir: split!.targetDir,
      toolId: split!.toolId,
    });
    manifestEntries.push({ name: split!.targetName, kind: "authored" });
  }

  return {
    ok: true,
    plan: {
      mode,
      name: candidate.name,
      rootPath,
      primary: {
        sourcePath: primaryLoc.path,
        targetDir,
        toolId: primaryLoc.toolId,
      },
      split,
      removals,
      links,
      manifestEntries,
    },
  };
}

function safeTsSegment(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function isRealDirectory(p: string): boolean {
  try {
    const stat = lstatSync(p);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

function resolveBackupPath(
  templated: string,
  tsSegment: string,
): string {
  return templated.split(TS_PLACEHOLDER).join(tsSegment);
}

export function executeAdoptPlan(
  plan: AdoptPlan,
  opts?: { dryRun?: boolean; nowIso?: string },
): AdoptExecResult {
  const dryRun = !!opts?.dryRun;
  const tsSegment = safeTsSegment(opts?.nowIso ?? new Date().toISOString());
  const performed: AdoptExecResult["performed"] = [];
  const linkResults: LinkSiteResult[] = [];

  // 1. Move primary into authored/<name>/.
  if (!dryRun) {
    mkdirSync(dirname(plan.primary.targetDir), { recursive: true });
    renameSync(plan.primary.sourcePath, plan.primary.targetDir);
  }
  performed.push({
    kind: "rename",
    detail: `moved ${plan.primary.toolId} copy → ${plan.primary.targetDir}`,
  });

  // 2. Move split loser if present.
  if (plan.split) {
    if (!dryRun) {
      mkdirSync(dirname(plan.split.targetDir), { recursive: true });
      renameSync(plan.split.sourcePath, plan.split.targetDir);
    }
    performed.push({
      kind: "rename",
      detail: `moved ${plan.split.toolId} copy → ${plan.split.targetDir}`,
    });
  }

  // 3. & 4. Removals (with or without backup).
  for (const r of plan.removals) {
    if (r.backupTo) {
      const resolved = resolveBackupPath(r.backupTo, tsSegment);
      if (!dryRun) {
        mkdirSync(dirname(resolved), { recursive: true });
        cpSync(r.path, resolved, { recursive: true });
        rmSync(r.path, { recursive: true, force: true });
      }
      performed.push({
        kind: "backup",
        detail: `backed up ${r.toolId} copy → ${resolved}`,
      });
    } else {
      if (!dryRun) {
        rmSync(r.path, { recursive: true, force: true });
      }
      performed.push({
        kind: "remove",
        detail: `removed ${r.toolId} copy at ${r.path}`,
      });
    }
  }

  // 5. Symlinks. Pre-remove any real directory still sitting at the link
  //    path (defensive — only happens for the split loser's site after the
  //    rename has already moved it; primary site is already gone after step 1).
  if (!dryRun) {
    for (const l of plan.links) {
      if (isRealDirectory(l.linkPath)) {
        rmSync(l.linkPath, { recursive: true, force: true });
      }
      const result = linkSiteToSkill(l.linkPath, l.targetDir, l.toolId);
      linkResults.push(result);
      performed.push({
        kind: "link",
        detail: `linked ${l.toolId} → ${l.linkPath}`,
      });
    }
  } else {
    for (const l of plan.links) {
      performed.push({
        kind: "link",
        detail: `linked ${l.toolId} → ${l.linkPath}`,
      });
    }
  }

  // 6. Manifest entries.
  if (!dryRun && plan.manifestEntries.length) {
    const store = SsotStore.openAt(plan.rootPath);
    for (const entry of plan.manifestEntries) {
      if (entry.kind === "authored") {
        store.recordAuthoredSkill(entry.name);
      }
    }
    store.commit();
  }
  if (plan.manifestEntries.length) {
    performed.push({
      kind: "manifest-write",
      detail: `recorded in skills.json`,
    });
  }

  return { performed, linkResults };
}

export function formatAdoptPlan(plan: AdoptPlan): string[] {
  const lines: string[] = [];
  lines.push(`adopt: ${plan.name}`);
  lines.push(
    `  primary copy: ${plan.primary.toolId} (${plan.primary.sourcePath})`,
  );
  for (const r of plan.removals) {
    const tag =
      plan.mode === "duplicate-identical"
        ? " — identical"
        : " — backup + relink";
    lines.push(`  also at:      ${r.toolId} (${r.path})${tag}`);
  }
  if (plan.split) {
    lines.push(
      `  keep other as: ${plan.split.targetName} (from ${plan.split.toolId})`,
    );
  }
  return lines;
}

export function formatAdoptResult(
  plan: AdoptPlan,
  result: AdoptExecResult,
  opts?: { dryRun?: boolean },
): string[] {
  const lines: string[] = [];
  if (opts?.dryRun) {
    lines.push("  (dry-run — no changes made)");
    return lines;
  }
  for (const action of result.performed) {
    if (action.kind === "remove") continue; // silent for identical-duplicate cleanup
    lines.push(`  ✓ ${action.detail}`);
  }
  // Link failures override the optimistic perform line emitted above.
  for (const lr of result.linkResults) {
    if (lr.status === "linked" || lr.status === "already-linked") continue;
    lines.push(
      `  ✗ link ${lr.status} at ${lr.linkPath}: ${lr.message ?? lr.status}`,
    );
  }
  return lines;
}
