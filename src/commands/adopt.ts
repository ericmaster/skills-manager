import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureRootLayout, resolveRoot } from "../core/paths.js";
import { type Manifest } from "../core/manifest.js";
import {
  findCandidate,
  scanForAdoption,
  summarizeCandidate,
  type AdoptCandidate,
  type AdoptScanResult,
} from "../core/adopt-scan.js";
import {
  executeAdoptPlan,
  formatAdoptPlan,
  formatAdoptResult,
  planAdoption,
  type AdoptPlan,
} from "../core/adoption.js";

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

  const home = root.scope === "workspace" ? join(root.path, "..") : undefined;
  const scan = await scanForAdoption({ rootPath: root.path, home });

  if (!args.name && !all) {
    return printScan(scan);
  }

  if (all && args.name) {
    process.stderr.write(`error: pass either <name> or --all, not both.\n`);
    return 1;
  }

  if (all) {
    return adoptAll(scan, root.path, { dryRun });
  }

  const candidate = findCandidate(scan, args.name!);
  if (!candidate) {
    process.stderr.write(
      `error: no adoptable skill named "${args.name}". Run \`skills-manager adopt\` to list candidates.\n`,
    );
    return 1;
  }
  return adoptOne(candidate, root.path, { dryRun, from, keepOtherAs });
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

function adoptOne(
  candidate: AdoptCandidate,
  rootPath: string,
  opts: {
    dryRun: boolean;
    from: string | undefined;
    keepOtherAs: string | undefined;
  },
): number {
  const planResult = planAdoption({
    candidate,
    flags: { from: opts.from, keepOtherAs: opts.keepOtherAs },
    rootPath,
  });
  if (!planResult.ok) {
    process.stderr.write(`error: ${planResult.error.message}\n`);
    return 1;
  }
  const { plan } = planResult;

  for (const line of formatAdoptPlan(plan)) {
    process.stdout.write(line + "\n");
  }

  if (opts.dryRun) {
    const result = executeAdoptPlan(plan, { dryRun: true });
    for (const line of formatAdoptResult(plan, result, { dryRun: true })) {
      process.stdout.write(line + "\n");
    }
    return 0;
  }

  const result = executeAdoptPlan(plan);
  for (const line of formatAdoptResult(plan, result)) {
    process.stdout.write(line + "\n");
  }
  return 0;
}

function adoptAll(
  scan: AdoptScanResult,
  rootPath: string,
  opts: { dryRun: boolean },
): number {
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

  // Build plans up front so the preview is a complete picture.
  const plans: AdoptPlan[] = [];
  let planErrors = 0;
  for (const c of safe) {
    const pr = planAdoption({
      candidate: c,
      flags: { from: undefined, keepOtherAs: undefined },
      rootPath,
    });
    if (!pr.ok) {
      process.stderr.write(`error: ${c.name}: ${pr.error.message}\n`);
      planErrors++;
      continue;
    }
    plans.push(pr.plan);
  }

  for (const plan of plans) {
    for (const line of formatAdoptPlan(plan)) {
      process.stdout.write(line + "\n");
    }
  }

  if (opts.dryRun) {
    for (const plan of plans) {
      const result = executeAdoptPlan(plan, { dryRun: true });
      for (const line of formatAdoptResult(plan, result, { dryRun: true })) {
        process.stdout.write(line + "\n");
      }
    }
    if (conflicts.length) {
      process.stdout.write(
        `\nSkipped ${conflicts.length} conflict(s) — adopt them individually with --from or --keep-other-as:\n`,
      );
      for (const c of conflicts) {
        process.stdout.write(`  · ${summarizeCandidate(c)}\n`);
      }
    }
    return planErrors > 0 ? 1 : 0;
  }

  const nowIso = new Date().toISOString();
  let execFailures = 0;
  for (const plan of plans) {
    try {
      const result = executeAdoptPlan(plan, { nowIso });
      for (const line of formatAdoptResult(plan, result)) {
        process.stdout.write(line + "\n");
      }
    } catch (err) {
      execFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${plan.name}: ${msg}\n`);
    }
  }

  if (conflicts.length) {
    process.stdout.write(
      `\nSkipped ${conflicts.length} conflict(s) — adopt them individually with --from or --keep-other-as:\n`,
    );
    for (const c of conflicts) {
      process.stdout.write(`  · ${summarizeCandidate(c)}\n`);
    }
  }

  return planErrors > 0 || execFailures > 0 ? 1 : 0;
}

export type { Manifest };
