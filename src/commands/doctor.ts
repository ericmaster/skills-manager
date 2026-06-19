import { resolveRoot } from "../core/paths.js";
import { detectTools, TOOL_REGISTRY } from "../core/tool-detect.js";
import { existsSync, readFileSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
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

async function checkSsot(
  rootPath: string,
  scope: "global" | "workspace",
  detectedTools: any[],
): Promise<{ healthy: boolean; text: string }> {
  const diag: Diagnostics = {
    manifestValid: true,
    lockfileValid: true,
    healthyLinks: [],
    brokenLinks: [],
    foreignLinks: [],
    unmanagedCandidates: [],
  };

  // 1. Manifest Health Check
  const manifestPath = join(rootPath, "skills.json");
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
  const lockfilePath = join(rootPath, "skills.lock.json");
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
      store = SsotStore.openAt(rootPath);
    } catch {
      // already caught or handled by validation flags
    }
  }

  // 3. Symlink and Candidate Analysis
  for (const tool of detectedTools) {
    if (!tool.absLinkTarget || !existsSync(tool.absLinkTarget)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(tool.absLinkTarget);
    } catch {
      continue;
    }

    for (const rawName of entries) {
      const linkPath = join(tool.absLinkTarget, rawName);
      const stat = safeLstat(linkPath);
      if (!stat) continue;

      if (stat.isSymbolicLink()) {
        const rawTarget = safeReadlink(linkPath);
        if (!rawTarget) {
          diag.brokenLinks.push({
            toolId: tool.id,
            skillName: rawName,
            target: "<unknown>",
            reason: "Failed to read symlink target",
          });
          continue;
        }

        const isFileLink = tool.linkStrategy === "file";
        let skillName = rawName;
        if (isFileLink && rawName.endsWith(".md")) {
          skillName = rawName.slice(0, -3);
        }

        const absTarget = resolve(tool.absLinkTarget, rawTarget);
        const insideSsot = absTarget.startsWith(rootPath);

        if (insideSsot) {
          const expectedAuthored = isFileLink
            ? join(rootPath, "authored", skillName, "SKILL.md")
            : join(rootPath, "authored", skillName);
          const expectedContrib = isFileLink
            ? join(rootPath, "skills", skillName, "SKILL.md")
            : join(rootPath, "skills", skillName);
          const pointsToCorrectName = absTarget === expectedAuthored || absTarget === expectedContrib;
          const targetExists = existsSync(absTarget);
          const registered = store ? store.skill(skillName) : null;

          if (pointsToCorrectName && targetExists && registered) {
            diag.healthyLinks.push({
              toolId: tool.id,
              skillName: skillName,
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
              skillName: skillName,
              target: absTarget,
              reason,
            });
          }
        } else {
          diag.foreignLinks.push({
            toolId: tool.id,
            skillName: skillName,
            target: absTarget,
          });
        }
      }
    }
  }

  // Discover unmanaged candidate folders
  try {
    const scan = await scanForAdoption({ rootPath, home: undefined });
    diag.unmanagedCandidates = scan.candidates.map((c) => c.name);
  } catch {
    // ignore scanning errors during doctor
  }

  // 4. Output results
  const lines: string[] = [];
  lines.push(`=== Scope: ${scope.toUpperCase()} ===`);
  lines.push(`SSOT Root:          ${rootPath}`);
  lines.push(`Manifest Status:    ${diag.manifestValid ? "✓ Healthy" : `✗ Error: ${diag.manifestError}`}`);
  lines.push(`Lockfile Status:    ${diag.lockfileValid ? "✓ Healthy" : `✗ Error: ${diag.lockfileError}`}`);
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
  lines.push("");

  const healthy = diag.manifestValid && diag.lockfileValid && diag.brokenLinks.length === 0;
  return { healthy, text: lines.join("\n") };
}

export async function runDoctor(args: {
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const root = resolveRoot();
  const home = undefined; // Probes global home directory ($HOME) even in workspace scope
  const detected = await detectTools(home);

  let overallHealthy = true;

  if (args.flags.all === true) {
    const globalPath = join(homedir(), ".skills-manager");
    let globalStore: SsotStore | null = null;
    try {
      globalStore = SsotStore.openAt(globalPath);
    } catch {
      // Global not initialized yet, that's fine
    }

    const registeredWorkspaces = globalStore ? globalStore.workspaces() : [];
    let prunedAny = false;
    const validWorkspaces: string[] = [];

    for (const p of registeredWorkspaces) {
      if (!existsSync(p) || !existsSync(join(p, "skills.json"))) {
        if (globalStore) {
          globalStore.removeWorkspace(p);
          prunedAny = true;
        }
      } else {
        validWorkspaces.push(p);
      }
    }
    if (prunedAny && globalStore) {
      globalStore.commit();
    }

    process.stdout.write("=== System-wide Diagnostics (All Scopes) ===\n\n");

    for (const p of validWorkspaces) {
      const res = await checkSsot(p, "workspace", detected);
      process.stdout.write(res.text);
      if (!res.healthy) overallHealthy = false;
    }

    if (existsSync(globalPath)) {
      const res = await checkSsot(globalPath, "global", detected);
      process.stdout.write(res.text);
      if (!res.healthy) overallHealthy = false;
    } else {
      process.stdout.write(`=== Scope: GLOBAL ===\nSSOT Root:          ${globalPath}\nStatus:             Not initialized\n\n`);
    }

    // Tools Status at the end
    process.stdout.write("Tools Status:\n");
    for (const entry of TOOL_REGISTRY) {
      const found = detected.find((d) => d.id === entry.id);
      const status = found
        ? entry.linkTarget
          ? "✓ detected (linkable)"
          : "· detected (non-native SKILL.md in v1)"
        : "· not detected";
      process.stdout.write(`  - ${entry.id.padEnd(16)} ${status}\n`);
    }
    process.stdout.write("\n");

    return overallHealthy ? 0 : 1;
  } else {
    // Normal single-scope diagnostics
    const res = await checkSsot(root.path, root.scope, detected);
    process.stdout.write(res.text);

    // Tools Status at the end
    process.stdout.write("Tools Status:\n");
    for (const entry of TOOL_REGISTRY) {
      const found = detected.find((d) => d.id === entry.id);
      const status = found
        ? entry.linkTarget
          ? "✓ detected (linkable)"
          : "· detected (non-native SKILL.md in v1)"
        : "· not detected";
      process.stdout.write(`  - ${entry.id.padEnd(16)} ${status}\n`);
    }
    process.stdout.write("\n");

    return res.healthy ? 0 : 1;
  }
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
