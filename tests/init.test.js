import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../dist/commands/init.js";

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-home-"));
  // Pretend Claude Code is installed so we exercise the link path.
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

test("init creates SSOT layout in fake HOME and links into ~/.claude/skills", async () => {
  const home = makeFakeHome();
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  // Run from a clean dir so resolveRoot doesn't autodetect a workspace.
  process.chdir(home);
  try {
    const code = await runInit({ local: false });
    assert.equal(code, 0);

    const root = join(home, ".skills-manager");
    assert.ok(existsSync(root), "SSOT root should exist");
    for (const sub of ["skills", "authored", "patches", ".cache/pristine"]) {
      assert.ok(existsSync(join(root, sub)), `expected dir ${sub}`);
    }

    const manifest = JSON.parse(readFileSync(join(root, "skills.json"), "utf8"));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.skills["skills-manager"]);
    assert.equal(manifest.skills["skills-manager"].kind, "authored");

    // skills.lock.json is not written until a contrib skill is pinned.
    assert.equal(existsSync(join(root, "skills.lock.json")), false);

    const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(state.version, 1);
    const claude = state.tools.find((t) => t.id === "claude-code");
    assert.ok(claude, "claude-code tool should be detected");
    assert.equal(claude.linkable, true);

    const skillDir = join(root, "authored", "skills-manager");
    assert.ok(existsSync(join(skillDir, "SKILL.md")), "bundled SKILL.md copied");

    const linkPath = join(home, ".claude", "skills", "skills-manager");
    assert.ok(lstatSync(linkPath).isSymbolicLink(), "symlink created");
    assert.equal(readlinkSync(linkPath), skillDir);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("init --local creates workspace SSOT", async () => {
  // Use a fake HOME so we don't link into the real ~/.claude.
  const fakeHome = mkdtempSync(join(tmpdir(), "skm-home-ws-"));
  const cwd = mkdtempSync(join(tmpdir(), "skm-ws-"));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.chdir(cwd);
  try {
    const code = await runInit({ local: true });
    assert.equal(code, 0);
    const root = join(cwd, ".skills-manager");
    assert.ok(existsSync(join(root, "skills.json")));
    assert.ok(existsSync(join(root, "authored", "skills-manager", "SKILL.md")));
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
