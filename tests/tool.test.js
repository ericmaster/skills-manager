import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../dist/commands/init.js";
import { runTool } from "../dist/commands/tool.js";

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-home-tool-"));
  // Pretend Claude Code is installed so we exercise the link path.
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

test("tool: lists, enables and disables managing state and symlinks", async () => {
  const home = makeFakeHome();
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);

  try {
    const initCode = await runInit({ local: false });
    assert.equal(initCode, 0);

    const root = join(home, ".skills-manager");
    const linkPath = join(home, ".claude", "skills", "skills-manager");
    
    // Default should be symlinked
    assert.ok(lstatSync(linkPath).isSymbolicLink(), "should be linked initially");

    // Disable the tool
    const disableCode = await runTool({ subcommand: "disable", name: "claude-code", flags: {} });
    assert.equal(disableCode, 0);

    // Link should be unlinked
    assert.equal(existsSync(linkPath), false, "should be unlinked after disable");

    const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    const claudeRec = state.tools.find((t) => t.id === "claude-code");
    assert.equal(claudeRec.enabled, false, "should record enabled = false in state.json");

    // Enable the tool
    const enableCode = await runTool({ subcommand: "enable", name: "claude-code", flags: {} });
    assert.equal(enableCode, 0);

    // Link should be restored
    assert.ok(lstatSync(linkPath).isSymbolicLink(), "should be linked after enable");

    const state2 = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    const claudeRec2 = state2.tools.find((t) => t.id === "claude-code");
    assert.equal(claudeRec2.enabled, true, "should record enabled = true in state.json");

  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
