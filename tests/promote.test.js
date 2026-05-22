import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../dist/commands/init.js";
import { runPromote } from "../dist/commands/promote.js";
import { SsotStore } from "../dist/core/ssot.js";

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-home-prom-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

test("promote: moves an authored skill from workspace to global", async () => {
  const home = makeFakeHome();
  const ws = mkdtempSync(join(tmpdir(), "skm-ws-prom-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;

  try {
    // 1. Initialize Global SSOT
    process.chdir(home);
    const initGlobalCode = await runInit({ local: false });
    assert.equal(initGlobalCode, 0);

    // 2. Initialize Workspace SSOT
    process.chdir(ws);
    const initLocalCode = await runInit({ local: true });
    assert.equal(initLocalCode, 0);

    const wsRoot = join(ws, ".skills-manager");
    const globalRoot = join(home, ".skills-manager");

    // Initially, skills-manager is local (in workspace)
    const wsStore = JSON.parse(readFileSync(join(wsRoot, "skills.json"), "utf8"));
    assert.ok(wsStore.skills["skills-manager"], "should exist in workspace initially");

    // The tool symlink should point to workspace
    const linkPath = join(home, ".claude", "skills", "skills-manager");
    assert.equal(
      readlinkSync(linkPath),
      join(wsRoot, "authored", "skills-manager"),
      "symlink should point to workspace"
    );

    // 3. Promote skill
    const promoteCode = await runPromote({ skill: "skills-manager", flags: { force: true } });
    assert.equal(promoteCode, 0);

    // Now it should be gone from workspace and present in global
    const wsStoreAfter = JSON.parse(readFileSync(join(wsRoot, "skills.json"), "utf8"));
    assert.equal(wsStoreAfter.skills["skills-manager"], undefined, "should be removed from workspace");

    const globalStoreAfter = JSON.parse(readFileSync(join(globalRoot, "skills.json"), "utf8"));
    assert.ok(globalStoreAfter.skills["skills-manager"], "should exist in global");

    // Symlink should now point to global
    assert.equal(
      readlinkSync(linkPath),
      join(globalRoot, "authored", "skills-manager"),
      "symlink should point to global"
    );

  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("promote: rejects contrib skill if pristine cache is missing", async () => {
  const home = makeFakeHome();
  const ws = mkdtempSync(join(tmpdir(), "skm-ws-prom-contrib-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;

  try {
    // 1. Initialize Global SSOT
    process.chdir(home);
    const initGlobalCode = await runInit({ local: false });
    assert.equal(initGlobalCode, 0);

    // 2. Initialize Workspace SSOT
    process.chdir(ws);
    const initLocalCode = await runInit({ local: true });
    assert.equal(initLocalCode, 0);

    const wsRoot = join(ws, ".skills-manager");

    // Register a contrib skill "contrib-skill" without its pristine cache
    const wsStore = SsotStore.openAt(wsRoot);
    wsStore.recordContribSkill("contrib-skill", { type: "git", url: "https://github.com/voodootikigod/skills-check" });
    wsStore.pinResolvedRef("contrib-skill", "abcdef123");
    
    // Create live skill directory
    const liveDir = join(wsRoot, "skills", "contrib-skill");
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, "SKILL.md"), "---\nname: contrib-skill\ndescription: test\n---\n");
    wsStore.commit();

    // 3. Promote skill without pristine cache -> should fail with exit code 1
    const promoteCode = await runPromote({ skill: "contrib-skill", flags: {} });
    assert.equal(promoteCode, 1);

    // 4. Create the pristine cache
    const pristineDir = join(wsRoot, ".cache", "pristine", "contrib-skill@abcdef123");
    mkdirSync(pristineDir, { recursive: true });
    writeFileSync(join(pristineDir, "SKILL.md"), "---\nname: contrib-skill\ndescription: test\n---\n");

    // 5. Promote skill with pristine cache -> should succeed with exit code 0
    const promoteCodeSuccess = await runPromote({ skill: "contrib-skill", flags: {} });
    assert.equal(promoteCodeSuccess, 0);

  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
