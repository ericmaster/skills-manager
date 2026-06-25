import { runInit } from "./commands/init.js";
import { runAdd } from "./commands/add.js";
import { runList } from "./commands/list.js";
import { runRemove } from "./commands/remove.js";
import { runUpdate } from "./commands/update.js";
import { runDiff } from "./commands/diff.js";
import { runSavePatch } from "./commands/save-patch.js";
import { runCustomize } from "./commands/customize.js";
import { runNew } from "./commands/new.js";
import { runTool } from "./commands/tool.js";
import { runValidate } from "./commands/validate.js";
import { runDoctor } from "./commands/doctor.js";
import { runAdopt } from "./commands/adopt.js";
import { runPreset } from "./commands/preset.js";
import { runPromote } from "./commands/promote.js";
import { runLinkLocal } from "./commands/link-local.js";

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

const HELP = `skills-manager — manage agentskills.io-format skills across AI agent tools.

Usage: skills-manager <command> [args] [flags]

Commands:
  init [--local] [--preset=<name>]
                              Bootstrap the SSOT, detect tools, install the manager skill.
  adopt [<name>] [--all]      Adopt skills already living under detected tool dirs.
  add <source>                Install a contrib skill from a git repo, URL, or local path.
  list                        List installed skills.
  remove <skill>              Uninstall a skill.
  update [<skill>...]         Re-resolve sources and reapply patches. With --continue: resume after conflict.
  diff <skill>                Show drift vs. pristine.
  save-patch <skill>          Persist current drift to patches/<skill>.patch.
  customize <skill>           Open the skill dir in $EDITOR.
  new <name>                  Scaffold a new self-authored skill.
  tool <list|enable|disable> [name]
                              Inspect or toggle linkable tools.
  validate [<skill>]          Validate skill(s) via skills-check.
  preset <list|create|add|remove> [name] [skill]
                              Manage skill presets.
  promote <skill>             Promote a workspace skill to the global SSOT.
  link-local [dir] [--dry-run]
                              Bridge a repo's .agents/skills/* into per-tool project dirs (.claude/skills)
                              via relative symlinks, for tools that don't read .agents/skills natively.
  status                      Alias for doctor --all.
  doctor                      Print environment and configuration diagnostics.
  help                        Show this help.

In v1, all commands are fully implemented.

See AGENTS.md for full documentation.`;

export async function main(rawArgs: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(rawArgs);

  if (!command || command === "help" || flags.help === true) {
    process.stdout.write(HELP + "\n");
    return command || flags.help ? 0 : 1;
  }

  try {
    switch (command) {
      case "init":
        return await runInit({
          local: flags.local === true,
          preset: typeof flags.preset === "string" ? flags.preset : undefined,
        });
      case "adopt":
        return await runAdopt({ name: positional[0], flags });
      case "add":
        return await runAdd({ source: positional[0], flags });
      case "list":
        return await runList({ flags });
      case "remove":
        return await runRemove({ skill: positional[0], flags });
      case "update":
        return await runUpdate({
          skills: positional,
          cont: flags.continue === true,
          flags,
        });
      case "diff":
        return await runDiff({ skill: positional[0], flags });
      case "save-patch":
        return await runSavePatch({ skill: positional[0], flags });
      case "customize":
        return await runCustomize({ skill: positional[0], flags });
      case "new":
        return await runNew({ name: positional[0], flags });
      case "tool":
        return await runTool({
          subcommand: positional[0],
          name: positional[1],
          flags,
        });
      case "validate":
        return await runValidate({ skill: positional[0], flags });
      case "preset":
        return await runPreset({
          subcommand: positional[0],
          name: positional[1],
          skill: positional[2],
          flags,
        });
      case "promote":
        return await runPromote({
          skill: positional[0],
          flags,
        });
      case "link-local":
        return await runLinkLocal({ dir: positional[0], flags });
      case "status":
        return await runDoctor({
          flags: { ...flags, all: true },
        });
      case "doctor":
        return await runDoctor({ flags });
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
        return 1;
    }
  } catch (err) {
    if (err instanceof Error) {
      process.stderr.write(`error: ${err.message}\n`);
    } else {
      process.stderr.write(`error: ${String(err)}\n`);
    }
    return 1;
  }
}
