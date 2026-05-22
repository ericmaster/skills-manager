import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../dist/commands/init.js";
import { resolveRoot } from "../dist/core/paths.js";
import { SsotStore } from "../dist/core/ssot.js";
import { runDoctor } from "../dist/commands/doctor.js";

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-home-doc-"));
  // Pretend Claude Code is installed so we can test tool symlinks
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    const exitCode = await fn();
    return { exitCode, output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("doctor-all: lazy registration, diagnostics and lazy pruning of workspaces", async () => {
  const home = makeFakeHome();
  const ws = mkdtempSync(join(tmpdir(), "skm-ws-doc-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;

  try {
    // 1. Initialize Global SSOT
    process.chdir(home);
    const initGlobalCode = await runInit({ local: false });
    assert.equal(initGlobalCode, 0);

    const globalRoot = join(home, ".skills-manager");

    // 2. Initialize Workspace SSOT
    process.chdir(ws);
    const initLocalCode = await runInit({ local: true });
    assert.equal(initLocalCode, 0);

    const wsRoot = join(ws, ".skills-manager");

    // 3. Trigger resolveRoot() which should register wsRoot in global state.json
    const resolved = resolveRoot({ local: true, cwd: ws });
    assert.equal(resolved.path, wsRoot);

    const globalState = JSON.parse(readFileSync(join(globalRoot, "state.json"), "utf8"));
    assert.ok(globalState.workspaces, "workspaces array should exist in global state.json");
    assert.ok(globalState.workspaces.includes(wsRoot), "workspace path should be registered in global state");

    // Create different kinds of symlinks in the fake Claude Code skills dir
    const claudeSkills = join(home, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });

    // 1. Healthy symlink: point to installed authored skill in global SSOT
    const healthyTarget = join(globalRoot, "authored", "skills-manager");
    const healthyLink = join(claudeSkills, "skills-manager");
    if (existsSync(healthyLink)) rmSync(healthyLink);
    symlinkSync(healthyTarget, healthyLink);

    // 2. Broken symlink: point to nonexistent path inside global SSOT
    const brokenTarget = join(globalRoot, "skills", "broken-skill");
    const brokenLink = join(claudeSkills, "broken-skill");
    symlinkSync(brokenTarget, brokenLink);

    // 3. Foreign symlink: point to some place completely outside the SSOT
    const outsideDir = join(home, "some-other-place");
    mkdirSync(outsideDir, { recursive: true });
    const foreignLink = join(claudeSkills, "foreign-skill");
    symlinkSync(outsideDir, foreignLink);

    // 4. Adoption Candidate: a real directory with a SKILL.md
    const adoptDir = join(claudeSkills, "adopt-me");
    mkdirSync(adoptDir, { recursive: true });
    writeFileSync(join(adoptDir, "SKILL.md"), "---\nname: adopt-me\ndescription: adopt-me\n---\n");

    // 4. Run doctor --all and capture output
    const { exitCode, output } = await captureStdout(() => runDoctor({ flags: { all: true } }));
    assert.equal(exitCode, 1); // Returns 1 because broken/unhealthy links are detected

    // Assert on output contents
    assert.match(output, /System-wide Diagnostics/);
    assert.match(output, /Healthy Symlinks:\s+1/);
    assert.match(output, /✓ \[claude-code\] skills-manager/);
    assert.match(output, /Broken\/Orphaned:\s+1/);
    assert.match(output, /✗ \[claude-code\] broken-skill/);
    assert.match(output, /Foreign Symlinks:\s+1/);
    assert.match(output, /· \[claude-code\] foreign-skill/);
    assert.match(output, /Unmanaged Folders:\s+1/);
    assert.match(output, /\? adopt-me \(candidate for adoption\)/);
    assert.match(output, /WARNING: Broken or missing symlinks/);
    assert.match(output, /Run `skills-manager init` to automatically restore/);

    // 5. Delete the workspace directory to test lazy pruning
    rmSync(ws, { recursive: true, force: true });

    // Run doctor --all again - it should prune the workspace path from global state
    const { exitCode: doctorCode2 } = await captureStdout(() => runDoctor({ flags: { all: true } }));
    // Global itself still contains the broken link, so it should exit 1
    assert.equal(doctorCode2, 1);

    const globalStateAfter = JSON.parse(readFileSync(join(globalRoot, "state.json"), "utf8"));
    assert.equal(globalStateAfter.workspaces.includes(wsRoot), false, "deleted workspace should be pruned from global state");

  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    if (existsSync(ws)) {
      rmSync(ws, { recursive: true, force: true });
    }
  }
});
