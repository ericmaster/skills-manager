import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveRoot } from "../core/paths.js";
import { SsotStore } from "../core/ssot.js";

const execFile = promisify(execFileCb);

export async function runValidate(args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  if (!existsSync(join(root.path, "skills.json"))) {
    process.stderr.write(
      `error: not initialized at ${root.path}. Run \`skills-manager init\` first.\n`,
    );
    return 1;
  }

  const store = SsotStore.openAt(root.path);

  if (args.skill) {
    // Validate a specific skill
    const skillEntry = store.skill(args.skill);
    if (!skillEntry) {
      process.stderr.write(`error: skill "${args.skill}" is not registered in the SSOT.\n`);
      return 1;
    }

    const skillDir =
      skillEntry.kind === "authored"
        ? join(root.path, "authored", args.skill)
        : join(root.path, "skills", args.skill);

    if (!existsSync(skillDir)) {
      process.stderr.write(`error: skill directory does not exist at ${skillDir}\n`);
      return 1;
    }

    return await validatePath(args.skill, skillDir);
  } else {
    // Validate all installed skills
    const skillNames = store.skillNames();
    if (skillNames.length === 0) {
      process.stdout.write("No skills installed to validate.\n");
      return 0;
    }

    let overallSuccess = true;
    for (const name of skillNames) {
      const skillEntry = store.skill(name)!;
      const skillDir =
        skillEntry.kind === "authored"
          ? join(root.path, "authored", name)
          : join(root.path, "skills", name);

      if (!existsSync(skillDir)) {
        process.stderr.write(`error: skill directory missing for "${name}" at ${skillDir}\n`);
        overallSuccess = false;
        continue;
      }

      process.stdout.write(`Validating skill "${name}"...\n`);
      const exitCode = await validatePath(name, skillDir);
      if (exitCode !== 0) {
        overallSuccess = false;
      }
    }

    return overallSuccess ? 0 : 1;
  }
}

interface LintFinding {
  file: string;
  field: string;
  level: "error" | "warning" | "info";
  message: string;
  fixable?: boolean;
}

// skills-check's `lint` reports missing author/license/repository as errors, but those
// are only required to publish a skill to a registry. skills-manager manages skills
// locally and never publishes them, so these notices are surfaced for awareness but must
// not fail validation. Malformed publish fields (invalid SPDX id, non-URL repository)
// carry different messages and remain fatal.
function isPublishReadinessNotice(f: LintFinding): boolean {
  return f.level === "error" && /required field for publish/i.test(f.message);
}

async function validatePath(skillName: string, path: string): Promise<number> {
  // `skills-check check` is a registry-staleness command that takes no path; the metadata
  // and format validator is `lint`. Use its JSON output so we can decide pass/fail.
  let raw: string;
  try {
    const { stdout } = await execFile("npx", [
      "-y",
      "skills-check",
      "lint",
      "--format",
      "json",
      path,
    ]);
    raw = stdout;
  } catch (err: any) {
    // lint exits non-zero when it finds errors, but still writes the JSON report to stdout.
    if (typeof err?.stdout === "string" && err.stdout.trim().startsWith("{")) {
      raw = err.stdout;
    } else {
      if (err?.stdout) process.stdout.write(err.stdout);
      if (err?.stderr) process.stderr.write(err.stderr);
      process.stderr.write(
        `✗ Could not validate skill "${skillName}" (skills-check did not run).\n`,
      );
      return 1;
    }
  }

  let report: { findings?: LintFinding[] };
  try {
    report = JSON.parse(raw);
  } catch {
    if (raw) process.stdout.write(raw);
    process.stderr.write(
      `✗ Validation failed for skill "${skillName}" (unparseable checker output).\n`,
    );
    return 1;
  }

  const findings = report.findings ?? [];
  const fatal = findings.filter((f) => f.level === "error" && !isPublishReadinessNotice(f));
  const publishNotices = findings.filter(isPublishReadinessNotice);

  for (const f of fatal) {
    process.stderr.write(`  ✗ ${f.field}: ${f.message}\n`);
  }
  for (const f of publishNotices) {
    process.stdout.write(`  ℹ ${f.field}: ${f.message} (publish-only, not required locally)\n`);
  }

  if (fatal.length > 0) {
    process.stderr.write(
      `✗ Validation failed for skill "${skillName}" (${fatal.length} error${fatal.length === 1 ? "" : "s"}).\n`,
    );
    return 1;
  }

  process.stdout.write(`✓ Skill "${skillName}" is valid.\n`);
  return 0;
}
