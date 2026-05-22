import { resolveRoot } from "../core/paths.js";
import { detectTools, TOOL_REGISTRY } from "../core/tool-detect.js";
import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SsotStore } from "../core/ssot.js";
import { scanForAdoption } from "../core/adopt-scan.js";

interface Diagnostics {
  manifestValid: boolean;
  manifestError?: string;
  lockfileValid: boolean;
  lockfileError?: string;
  healthyLinks: { toolId: string; skillName: string; target: string }[];
  brokenLinks: { toolId: string; skillName: string; target: string; reason: string }[];
  foreignLinks: { toolId: string; skillName: string; target: string }[];
  unmanagedCandidates: string[];
}

export async function runDoctor(_args: {
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  const home = undefined; // Probes global home directory ($HOME) even in workspace scope
  const detected = await detectTools(home);

  const diag: Diagnostics = {
    manifestValid: true,
    lockfileValid: true,
    healthyLinks: [],
    brokenLinks: [],
    foreignLinks: [],
    unmanagedCandidates: [],
  };

  // 1. Manifest Health Check
  const manifestPath = join(root.path, "skills.json");
  if (existsSync(manifestPath)) {
    try {
      const content = readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.version !== 1) {
        diag.manifestValid = false;
        diag.manifestError = `Unsupported skills.json version: ${parsed.version}`;
      }
    } catch (err) {
      diag.manifestValid = false;
      diag.manifestError = err instanceof Error ? err.message : String(err);
    }
  } else {
    diag.manifestValid = false;
    diag.manifestError = "skills.json is missing";
  }

  // 2. Lockfile Health Check
  const lockfilePath = join(root.path, "skills.lock.json");
  if (existsSync(lockfilePath)) {
    try {
      const content = readFileSync(lockfilePath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.version !== 1) {
        diag.lockfileValid = false;
        diag.lockfileError = `Unsupported skills.lock.json version: ${parsed.version}`;
      }
    } catch (err) {
      diag.lockfileValid = false;
      diag.lockfileError = err instanceof Error ? err.message : String(err);
    }
  }

  // Open store safely to perform symlink validation
  let store: SsotStore | null = null;
  if (diag.manifestValid) {
    try {
      store = SsotStore.openAt(root.path);
    } catch {
      // already caught or handled by validation flags
    }
  }

  // 3. Symlink and Candidate Analysis
  for (const tool of detected) {
    if (!tool.absLinkTarget || !existsSync(tool.absLinkTarget)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(tool.absLinkTarget);
    } catch {
      continue;
    }

    for (const name of entries) {
      const linkPath = join(tool.absLinkTarget, name);
      const stat = safeLstat(linkPath);
      if (!stat) continue;

      if (stat.isSymbolicLink()) {
        const rawTarget = safeReadlink(linkPath);
        if (!rawTarget) {
          diag.brokenLinks.push({
            toolId: tool.id,
            skillName: name,
            target: "<unknown>",
            reason: "Failed to read symlink target",
          });
          continue;
        }

        const absTarget = resolve(tool.absLinkTarget, rawTarget);
        const insideSsot = absTarget.startsWith(root.path);

        if (insideSsot) {
          const expectedAuthored = join(root.path, "authored", name);
          const expectedContrib = join(root.path, "skills", name);
          const pointsToCorrectName = absTarget === expectedAuthored || absTarget === expectedContrib;
          const targetExists = existsSync(absTarget);
          const registered = store ? store.skill(name) : null;

          if (pointsToCorrectName && targetExists && registered) {
            diag.healthyLinks.push({
              toolId: tool.id,
              skillName: name,
              target: absTarget,
            });
          } else {
            let reason = "Incorrect target path or naming mismatch";
            if (!targetExists) {
              reason = "Target directory does not exist on disk";
            } else if (!registered) {
              reason = "Skill is not registered in skills.json";
            }
            diag.brokenLinks.push({
              toolId: tool.id,
              skillName: name,
              target: absTarget,
              reason,
            });
          }
        } else {
          diag.foreignLinks.push({
            toolId: tool.id,
            skillName: name,
            target: absTarget,
          });
        }
      }
    }
  }

  // Discover unmanaged candidate folders
  try {
    const scan = await scanForAdoption({ rootPath: root.path, home });
    diag.unmanagedCandidates = scan.candidates.map((c) => c.name);
  } catch {
    // ignore scanning errors during doctor
  }

  // 4. Output results
  const lines: string[] = [];
  lines.push("=== Skills Manager Diagnostics ===");
  lines.push(`SSOT Root:          ${root.path}`);
  lines.push(`Scope:              ${root.scope}`);
  lines.push(`Manifest Status:    ${diag.manifestValid ? "✓ Healthy" : `✗ Error: ${diag.manifestError}`}`);
  lines.push(`Lockfile Status:    ${diag.lockfileValid ? "✓ Healthy" : `✗ Error: ${diag.lockfileError}`}`);
  lines.push("");

  lines.push("Tools Status:");
  for (const entry of TOOL_REGISTRY) {
    const found = detected.find((d) => d.id === entry.id);
    const status = found
      ? entry.linkTarget
        ? "✓ detected (linkable)"
        : "· detected (non-native SKILL.md in v1)"
      : "· not detected";
    lines.push(`  - ${entry.id.padEnd(16)} ${status}`);
  }
  lines.push("");

  lines.push("Symlink Analysis:");
  lines.push(`  Healthy Symlinks:   ${diag.healthyLinks.length}`);
  if (diag.healthyLinks.length > 0) {
    for (const h of diag.healthyLinks) {
      lines.push(`    ✓ [${h.toolId}] ${h.skillName}`);
    }
  }

  lines.push(`  Broken/Orphaned:    ${diag.brokenLinks.length}`);
  if (diag.brokenLinks.length > 0) {
    for (const b of diag.brokenLinks) {
      lines.push(`    ✗ [${b.toolId}] ${b.skillName} -> ${b.target} (${b.reason})`);
    }
  }

  lines.push(`  Foreign Symlinks:   ${diag.foreignLinks.length}`);
  if (diag.foreignLinks.length > 0) {
    for (const f of diag.foreignLinks) {
      lines.push(`    · [${f.toolId}] ${f.skillName} -> ${f.target} (unmanaged)`);
    }
  }

  lines.push(`  Unmanaged Folders:  ${diag.unmanagedCandidates.length}`);
  if (diag.unmanagedCandidates.length > 0) {
    for (const c of diag.unmanagedCandidates) {
      lines.push(`    ? ${c} (candidate for adoption)`);
    }
  }
  lines.push("");

  // Self-Healing Guidance
  let hasWarningsOrTips = false;
  if (diag.brokenLinks.length > 0) {
    hasWarningsOrTips = true;
    lines.push("WARNING: Broken or missing symlinks were detected!");
    lines.push("  👉 Run `skills-manager init` to automatically restore correct symlinks.");
    lines.push("");
  }

  if (diag.unmanagedCandidates.length > 0) {
    hasWarningsOrTips = true;
    lines.push("TIP: Unmanaged skill folders were discovered in your tool directories!");
    lines.push("  👉 Run `skills-manager adopt <name>` or `skills-manager adopt --all` to import them into your SSOT.");
    lines.push("");
  }

  if (!diag.manifestValid || !diag.lockfileValid) {
    hasWarningsOrTips = true;
    lines.push("CRITICAL: Your configuration file parses with errors.");
    lines.push("  👉 Please verify the structure of skills.json and/or skills.lock.json.");
    lines.push("");
  }

  if (!hasWarningsOrTips) {
    lines.push("Everything is healthy and properly configured! 🎉");
  }

  process.stdout.write(lines.join("\n") + "\n");

  const healthy = diag.manifestValid && diag.lockfileValid && diag.brokenLinks.length === 0;
  return healthy ? 0 : 1;
}

function safeLstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function safeReadlink(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}
