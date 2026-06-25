import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * Project-local tool dirs that do NOT (yet) read the tool-agnostic `.agents/skills/` convention
 * natively and therefore need a bridge symlink. `.agents/skills/` is the canonical, committed source;
 * each entry here gets a sibling `<repo>/<dir>/<name>` symlink pointing back at it (relative, so it
 * stays valid in every clone/worktree). Add tools here as their native `.agents/` support is confirmed
 * absent — e.g. GitHub Copilot already reads `.agents/` and is intentionally omitted.
 */
const BRIDGE_TOOLS: { id: string; dir: string }[] = [
  { id: "claude-code", dir: ".claude/skills" },
];

type BridgeStatus =
  | "linked"
  | "already-linked"
  | "skipped-non-symlink"
  | "failed";

interface BridgeResult {
  toolId: string;
  linkPath: string;
  status: BridgeStatus;
  message?: string;
}

function ensureRelativeLink(
  linkPath: string,
  relTarget: string,
  toolId: string,
  dryRun: boolean,
): BridgeResult {
  let state: "absent" | "symlink" | "real";
  let current = "";
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      state = "symlink";
      try {
        current = readlinkSync(linkPath);
      } catch {
        current = "";
      }
    } else {
      state = "real";
    }
  } catch {
    state = "absent";
  }

  if (state === "real") {
    return {
      toolId,
      linkPath,
      status: "skipped-non-symlink",
      message: `Refusing to overwrite non-symlink at ${linkPath}. Move or remove it manually.`,
    };
  }
  if (state === "symlink" && current === relTarget) {
    return { toolId, linkPath, status: "already-linked" };
  }
  if (dryRun) {
    return { toolId, linkPath, status: "linked", message: "(dry-run)" };
  }
  try {
    if (state === "symlink") unlinkSync(linkPath);
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(relTarget, linkPath, "dir");
    return { toolId, linkPath, status: "linked" };
  } catch (err) {
    return {
      toolId,
      linkPath,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * `skills-manager link-local [dir]` — bridge a repo's tool-agnostic `.agents/skills/<name>/` packs into
 * the per-tool project skill dirs (currently `.claude/skills/`) via relative symlinks, so tools that
 * don't read `.agents/skills/` natively still pick the skills up. Idempotent and safe to commit. This is
 * the per-repo analog of the global SSOT → `~/.claude/skills` linking that `new`/`adopt` perform.
 */
export async function runLinkLocal(args: {
  dir: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const dir = args.dir ?? process.cwd();
  const dryRun = args.flags["dry-run"] === true || args.flags.n === true;
  const agentsSkills = join(dir, ".agents", "skills");

  if (!existsSync(agentsSkills)) {
    process.stdout.write(`no .agents/skills/ found under ${dir} — nothing to bridge\n`);
    return 0;
  }

  const names = readdirSync(agentsSkills, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(agentsSkills, e.name, "SKILL.md")))
    .map((e) => e.name);

  if (names.length === 0) {
    process.stdout.write(`no skill packs (dirs with SKILL.md) under ${agentsSkills}\n`);
    return 0;
  }

  let failures = 0;
  for (const name of names) {
    for (const tool of BRIDGE_TOOLS) {
      const linkPath = join(dir, tool.dir, name);
      // relative target from the link's directory back to the canonical .agents/skills/<name> pack.
      const relTarget = relative(dirname(linkPath), join(agentsSkills, name));
      const r = ensureRelativeLink(linkPath, relTarget, tool.id, dryRun);
      switch (r.status) {
        case "linked":
        case "already-linked":
          process.stdout.write(
            `  ✓ ${name} → ${tool.dir}/${name}${r.message ? ` ${r.message}` : ""}\n`,
          );
          break;
        default:
          failures++;
          process.stdout.write(`  ✗ ${name} (${tool.id}): ${r.message ?? r.status}\n`);
      }
    }
  }

  process.stdout.write(
    `${dryRun ? "would bridge" : "bridged"} ${names.length} skill(s) from .agents/skills/ into ${BRIDGE_TOOLS
      .map((t) => t.dir)
      .join(", ")}\n`,
  );
  return failures > 0 ? 1 : 0;
}
