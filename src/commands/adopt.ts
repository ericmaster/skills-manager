import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import {
  readManifest,
  writeManifest,
  type Manifest,
} from "../core/manifest.js";
import {
  findCandidate,
  scanForAdoption,
  summarizeCandidate,
  type AdoptCandidate,
  type AdoptLocation,
  type AdoptScanResult,
} from "../core/adopt-scan.js";
import { linkSiteToSkill, type LinkSiteResult } from "../core/linker.js";

export interface AdoptArgs {
  /** Skill name to adopt; optional. */
  name: string | undefined;
  flags: Record<string, string | boolean>;
}

export async function runAdopt(args: AdoptArgs): Promise<number> {
  const root = resolveRoot();
  if (!existsSync(join(root.path, "skills.json"))) {
    process.stderr.write(
      `error: not initialized at ${root.path}. Run \`skills-manager init\` first.\n`,
    );
    return 1;
  }
  ensureRootLayout(root.path);

  const all = args.flags.all === true;
  const dryRun = args.flags["dry-run"] === true;
  const from =
    typeof args.flags.from === "string" ? args.flags.from : undefined;
  const keepOtherAs =
    typeof args.flags["keep-other-as"] === "string"
      ? (args.flags["keep-other-as"] as string)
      : undefined;

  const scan = await scanForAdoption({ rootPath: root.path });

  // No name and no --all: list candidates and exit.
  if (!args.name && !all) {
    return printScan(scan);
  }

  if (all && args.name) {
    process.stderr.write(`error: pass either <name> or --all, not both.\n`);
    return 1;
  }

  if (all) {
    return await adoptAll(scan, root.path, { dryRun });
  }

  const candidate = findCandidate(scan, args.name!);
  if (!candidate) {
    process.stderr.write(
      `error: no adoptable skill named "${args.name}". Run \`skills-manager adopt\` to list candidates.\n`,
    );
    return 1;
  }
  return await adoptOne(candidate, root.path, {
    dryRun,
    from,
    keepOtherAs,
  });
}

function printScan(scan: AdoptScanResult): number {
  if (scan.candidates.length === 0) {
    process.stdout.write(
      "No unmanaged skills found in detected tool directories.\n",
    );
    if (scan.skipped.length) {
      process.stdout.write("\nAlready managed:\n");
      for (const s of scan.skipped) {
        process.stdout.write(`  · ${s.name} (${s.reason})\n`);
      }
    }
    return 0;
  }
  process.stdout.write("Adoptable skills:\n");
  for (const c of scan.candidates) {
    process.stdout.write(`  ${summarizeCandidate(c)}\n`);
  }
  const conflicts = scan.candidates.filter(
    (c) => c.status.kind === "duplicate-conflict",
  );
  if (conflicts.length) {
    process.stdout.write(
      `\n${conflicts.length} conflict(s). Resolve with \`adopt <name> --from <tool>\` ` +
        `or \`adopt <name> --keep-other-as <new-name>\`.\n`,
    );
  }
  process.stdout.write(
    "\nAdopt one with `skills-manager adopt <name>` or all safe ones with `--all`.\n",
  );
  if (scan.skipped.length) {
    process.stdout.write("\nAlready managed (skipped):\n");
    for (const s of scan.skipped) {
      process.stdout.write(`  · ${s.name} (${s.reason})\n`);
    }
  }
  return 0;
}

async function adoptAll(
  scan: AdoptScanResult,
  rootPath: string,
  opts: { dryRun: boolean },
): Promise<number> {
  const safe = scan.candidates.filter(
    (c) => c.status.kind !== "duplicate-conflict",
  );
  const conflicts = scan.candidates.filter(
    (c) => c.status.kind === "duplicate-conflict",
  );
  if (safe.length === 0 && conflicts.length === 0) {
    process.stdout.write("Nothing to adopt.\n");
    return 0;
  }
  let failures = 0;
  for (const c of safe) {
    const code = await adoptOne(c, rootPath, {
      dryRun: opts.dryRun,
      from: undefined,
      keepOtherAs: undefined,
    });
    if (code !== 0) failures++;
  }
  if (conflicts.length) {
    process.stdout.write(
      `\nSkipped ${conflicts.length} conflict(s) — adopt them individually with --from or --keep-other-as:\n`,
    );
    for (const c of conflicts) {
      process.stdout.write(`  · ${summarizeCandidate(c)}\n`);
    }
  }
  return failures > 0 ? 1 : 0;
}

async function adoptOne(
  candidate: AdoptCandidate,
  rootPath: string,
  opts: {
    dryRun: boolean;
    from: string | undefined;
    keepOtherAs: string | undefined;
  },
): Promise<number> {
  // Pick the winner location.
  let winner: AdoptLocation;
  let losers: AdoptLocation[] = [];

  if (candidate.status.kind === "single") {
    winner = candidate.locations[0]!;
  } else if (candidate.status.kind === "duplicate-identical") {
    // All identical — pick first deterministically; treat the rest as
    // additional link sites (no backup needed since content matches).
    winner = candidate.locations[0]!;
    losers = candidate.locations.slice(1);
  } else {
    // Conflict — require --from or --keep-other-as.
    if (opts.from) {
      const picked = candidate.locations.find((l) => l.toolId === opts.from);
      if (!picked) {
        process.stderr.write(
          `error: --from "${opts.from}" not in candidate locations [${candidate.locations
            .map((l) => l.toolId)
            .join(", ")}].\n`,
        );
        return 1;
      }
      winner = picked;
      losers = candidate.locations.filter((l) => l.toolId !== opts.from);
    } else if (opts.keepOtherAs) {
      // keep-other-as: requires --from too, to know which is "the one".
      // Without --from we don't know which copy is "primary."
      process.stderr.write(
        `error: --keep-other-as also requires --from <tool> to pick the primary copy.\n`,
      );
      return 1;
    } else {
      process.stderr.write(
        `error: ${candidate.name} has differing copies in [${candidate.locations
          .map((l) => l.toolId)
          .join(", ")}]. Pick one with --from <tool>, or split with --from <tool> --keep-other-as <new-name>.\n`,
      );
      return 1;
    }
  }

  const targetName = candidate.name;
  const targetDir = join(rootPath, "authored", targetName);

  if (existsSync(targetDir)) {
    process.stderr.write(
      `error: ${targetDir} already exists; refusing to overwrite. Move it aside and retry.\n`,
    );
    return 1;
  }

  const linkPlan: { toolId: string; path: string }[] = [
    { toolId: winner.toolId, path: winner.path },
    ...losers.map((l) => ({ toolId: l.toolId, path: l.path })),
  ];

  // Optional split: keep a conflict loser as a separately-named adopted skill.
  let splitPlan:
    | {
        sourcePath: string;
        targetName: string;
        targetDir: string;
        toolId: string;
      }
    | undefined;
  if (
    opts.keepOtherAs &&
    opts.from &&
    candidate.status.kind === "duplicate-conflict"
  ) {
    const otherLoc = candidate.locations.find(
      (l) => l.toolId !== opts.from,
    );
    if (!otherLoc) {
      process.stderr.write(
        `error: no other location to keep as ${opts.keepOtherAs}.\n`,
      );
      return 1;
    }
    const otherDir = join(rootPath, "authored", opts.keepOtherAs);
    if (existsSync(otherDir)) {
      process.stderr.write(
        `error: ${otherDir} already exists; pick a different --keep-other-as name.\n`,
      );
      return 1;
    }
    splitPlan = {
      sourcePath: otherLoc.path,
      targetName: opts.keepOtherAs,
      targetDir: otherDir,
      toolId: otherLoc.toolId,
    };
    // Remove the split loser from the link plan — its dir gets repurposed.
    const idx = linkPlan.findIndex(
      (p) => p.toolId === otherLoc.toolId && p.path === otherLoc.path,
    );
    if (idx >= 0) linkPlan.splice(idx, 1);
  }

  process.stdout.write(`adopt: ${candidate.name}\n`);
  process.stdout.write(`  primary copy: ${winner.toolId} (${winner.path})\n`);
  for (const l of losers) {
    if (splitPlan && l.path === splitPlan.sourcePath) continue;
    process.stdout.write(
      `  also at:      ${l.toolId} (${l.path})${
        candidate.status.kind === "duplicate-identical"
          ? " — identical"
          : " — backup + relink"
      }\n`,
    );
  }
  if (splitPlan) {
    process.stdout.write(
      `  keep other as: ${splitPlan.targetName} (from ${splitPlan.toolId})\n`,
    );
  }
  if (opts.dryRun) {
    process.stdout.write("  (dry-run — no changes made)\n");
    return 0;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  // 1. Move winner into authored/<name>/.
  mkdirSync(dirname(targetDir), { recursive: true });
  renameSync(winner.path, targetDir);
  process.stdout.write(`  ✓ moved ${winner.toolId} copy → ${targetDir}\n`);

  // 2. Handle split loser (move into authored/<other-name>/).
  if (splitPlan) {
    renameSync(splitPlan.sourcePath, splitPlan.targetDir);
    process.stdout.write(
      `  ✓ moved ${splitPlan.toolId} copy → ${splitPlan.targetDir}\n`,
    );
  }

  // 3. Back up + remove conflicting losers (only if content-different).
  for (const l of losers) {
    if (splitPlan && l.path === splitPlan.sourcePath) continue;
    if (candidate.status.kind === "duplicate-conflict") {
      const backupDir = join(
        rootPath,
        ".cache",
        "adopted-backup",
        ts,
        l.toolId,
        candidate.name,
      );
      mkdirSync(dirname(backupDir), { recursive: true });
      cpSync(l.path, backupDir, { recursive: true });
      rmSync(l.path, { recursive: true, force: true });
      process.stdout.write(
        `  ✓ backed up ${l.toolId} copy → ${backupDir}\n`,
      );
    } else {
      // Identical: no backup, just remove so we can symlink in its place.
      rmSync(l.path, { recursive: true, force: true });
    }
  }

  // 4. Symlink primary into all link sites.
  for (const site of linkPlan) {
    const linkPath = site.path;
    if (isRealDirectory(linkPath)) {
      rmSync(linkPath, { recursive: true, force: true });
    }
    const result = linkSiteToSkill(linkPath, targetDir, site.toolId);
    reportLink(result);
  }

  // 5. Symlink split skill into its single source tool.
  if (splitPlan) {
    const linkPath = splitPlan.sourcePath;
    if (isRealDirectory(linkPath)) {
      rmSync(linkPath, { recursive: true, force: true });
    }
    const result = linkSiteToSkill(linkPath, splitPlan.targetDir, splitPlan.toolId);
    reportLink(result, ` (as ${splitPlan.targetName})`);
  }

  // 6. Update manifest.
  const manifest = readManifest(rootPath);
  manifest.skills[candidate.name] = { kind: "authored" };
  if (splitPlan) {
    manifest.skills[splitPlan.targetName] = { kind: "authored" };
  }
  writeManifest(rootPath, manifest);
  process.stdout.write(`  ✓ recorded in skills.json\n`);

  return 0;
}

function isRealDirectory(p: string): boolean {
  try {
    const stat = lstatSync(p);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

function reportLink(result: LinkSiteResult, suffix = ""): void {
  switch (result.status) {
    case "linked":
    case "already-linked":
      process.stdout.write(
        `  ✓ linked ${result.toolId} → ${result.linkPath}${suffix}\n`,
      );
      return;
    case "skipped-non-symlink":
    case "skipped-foreign-target":
      process.stdout.write(
        `  ✗ link skipped at ${result.linkPath}: ${result.message ?? result.status}\n`,
      );
      return;
    case "failed":
    default:
      process.stdout.write(
        `  ✗ link failed at ${result.linkPath}: ${result.message ?? result.status}\n`,
      );
      return;
  }
}

// Re-export type for tests / external callers.
export type { Manifest };
