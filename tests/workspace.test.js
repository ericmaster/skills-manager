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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../dist/commands/init.js";
import { runNew } from "../dist/commands/new.js";
import { runList } from "../dist/commands/list.js";
import { runCustomize } from "../dist/commands/customize.js";
import { runDoctor } from "../dist/commands/doctor.js";

function setupWorkspaceEnv() {
  const fakeHome = mkdtempSync(join(tmpdir(), "skm-home-ws-"));
  const cwd = mkdtempSync(join(tmpdir(), "skm-cwd-ws-"));

  // Pretend Claude Code is installed in global home to test native tool linking
  mkdirSync(join(fakeHome, ".claude", "skills"), { recursive: true });

  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();

  process.env.HOME = fakeHome;
  process.chdir(cwd);

  return {
    fakeHome,
    cwd,
    cleanup() {
      process.chdir(originalCwd);
      process.env.HOME = originalHome;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("workspace: init --local creates workspace SSOT and correctly resolves $HOME for tool linking", async () => {
  const env = setupWorkspaceEnv();
  try {
    // 1. Initialize workspace-local
    const code = await runInit({ local: true });
    assert.equal(code, 0);

    const root = join(env.cwd, ".skills-manager");
    assert.ok(existsSync(root), "Workspace SSOT root should exist");
    assert.ok(existsSync(join(root, "skills.json")), "skills.json exists");

    const manifest = JSON.parse(readFileSync(join(root, "skills.json"), "utf8"));
    assert.ok(manifest.skills["skills-manager"]);

    // 2. Verify that Claude Code under HOME was scanned and linked
    const linkPath = join(env.fakeHome, ".claude", "skills", "skills-manager");
    assert.ok(lstatSync(linkPath).isSymbolicLink(), "Symlink created in HOME's tool target");
    assert.equal(readlinkSync(linkPath), join(root, "authored", "skills-manager"), "Points to workspace copy");
  } finally {
    env.cleanup();
  }
});

test("workspace: multi-scope isolation prevents bleed between global and local scopes", async () => {
  const env = setupWorkspaceEnv();
  try {
    // 1. Initialize global first
    process.chdir(env.fakeHome);
    const initGlobalCode = await runInit({ local: false });
    assert.equal(initGlobalCode, 0);

    // 2. Initialize workspace-local
    process.chdir(env.cwd);
    const initLocalCode = await runInit({ local: true });
    assert.equal(initLocalCode, 0);

    // 3. Create a global authored skill (using global root)
    process.chdir(env.fakeHome);
    const newGlobalCode = await runNew({ name: "global-only-skill", flags: {} });
    assert.equal(newGlobalCode, 0);

    // 4. Create a workspace-local authored skill
    process.chdir(env.cwd);
    const newLocalCode = await runNew({ name: "local-only-skill", flags: {} });
    assert.equal(newLocalCode, 0);

    // Assert that the global skill folder was created globally
    const globalSkillDir = join(env.fakeHome, ".skills-manager", "authored", "global-only-skill");
    assert.ok(existsSync(globalSkillDir), "Global skill folder exists globally");

    // Assert that the workspace skill folder was created locally
    const workspaceSkillDir = join(env.cwd, ".skills-manager", "authored", "local-only-skill");
    assert.ok(existsSync(workspaceSkillDir), "Workspace skill folder exists locally");

    // Assert NO BLEED: global-only-skill not in workspace, local-only-skill not in global
    assert.equal(existsSync(join(env.cwd, ".skills-manager", "authored", "global-only-skill")), false);
    assert.equal(existsSync(join(env.fakeHome, ".skills-manager", "authored", "local-only-skill")), false);

    // Verify list output inside workspace only contains workspace skills
    let listOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      listOutput += chunk.toString();
      return true;
    };
    try {
      await runList({ flags: { json: true } });
    } finally {
      process.stdout.write = originalWrite;
    }

    const listed = JSON.parse(listOutput);
    const listedNames = listed.map((e) => e.name);
    assert.ok(listedNames.includes("local-only-skill"), "Should list workspace skill");
    assert.ok(!listedNames.includes("global-only-skill"), "Should NOT list global skill");
  } finally {
    env.cleanup();
  }
});

test("workspace: duplicate/overlapping skill names print a warning in list but do not block", async () => {
  const env = setupWorkspaceEnv();
  try {
    // 1. Initialize global and scaffold "overlap-skill"
    process.chdir(env.fakeHome);
    await runInit({ local: false });
    await runNew({ name: "overlap-skill", flags: {} });

    // 2. Initialize workspace and scaffold "overlap-skill"
    process.chdir(env.cwd);
    await runInit({ local: true });
    await runNew({ name: "overlap-skill", flags: {} });

    // 3. Run list in workspace scope and capture stderr warnings
    let stderrOutput = "";
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk.toString();
      return true;
    };

    let listCode;
    try {
      listCode = await runList({ flags: {} });
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    assert.equal(listCode, 0);
    assert.ok(
      stderrOutput.includes('warning: skill "overlap-skill" overlaps with a skill in global scope.'),
      "Warning message should be printed to stderr"
    );
  } finally {
    env.cleanup();
  }
});

test("workspace: customize command launches editor or prints absolute path gracefully", async () => {
  const env = setupWorkspaceEnv();
  try {
    await runInit({ local: true });
    await runNew({ name: "test-customize", flags: {} });

    // Scenario A: EDITOR environment variable is NOT set (graceful path suggestion)
    const originalEditor = process.env.EDITOR;
    delete process.env.EDITOR;

    let stdoutOutput = "";
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      stdoutOutput += chunk.toString();
      return true;
    };

    let customizeCode;
    try {
      customizeCode = await runCustomize({ skill: "test-customize", flags: {} });
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    assert.equal(customizeCode, 0);
    assert.ok(stdoutOutput.includes("test-customize"), "Should output skill name");
    assert.ok(stdoutOutput.includes("Tip: Set the EDITOR environment variable"), "Should suggest configuring EDITOR");

    // Scenario B: EDITOR is set (mocked to a quick exit 0 command)
    process.env.EDITOR = "true"; // 'true' is a built-in shell command that exits 0 immediately
    const customizeCodeWithEditor = await runCustomize({ skill: "test-customize", flags: {} });
    assert.equal(customizeCodeWithEditor, 0, "Spawning true should exit 0");

    process.env.EDITOR = originalEditor;
  } finally {
    env.cleanup();
  }
});

test("workspace: doctor health check validates json, symlinks, and self-healing", async () => {
  const env = setupWorkspaceEnv();
  try {
    await runInit({ local: true });
    await runNew({ name: "doctor-skill", flags: {} });

    // 1. Verify doctor status is fully healthy
    let docOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      docOutput += chunk.toString();
      return true;
    };

    let docCode;
    try {
      docCode = await runDoctor({ flags: {} });
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(docCode, 0, "Doctor should return healthy 0");
    assert.ok(docOutput.includes("Everything is healthy and properly configured!"), "Reports fully healthy");

    // 2. Break the symlink inside Claude Code skills to test broken symlink detection
    const linkPath = join(env.fakeHome, ".claude", "skills", "doctor-skill");
    rmSync(linkPath, { force: true });
    // Create a broken/orphaned symlink pointing to non-existent skill
    const badTarget = join(env.cwd, ".skills-manager", "authored", "missing-skill");
    writeFileSync(linkPath, ""); // create an empty file first, then make it a symlink or just symlink to a missing target
    rmSync(linkPath, { force: true });
    // create true symlink to non-existent path
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(badTarget, linkPath);
    } catch {
      // ignore symlink errors
    }

    let brokenDocOutput = "";
    process.stdout.write = (chunk) => {
      brokenDocOutput += chunk.toString();
      return true;
    };

    let brokenDocCode;
    try {
      brokenDocCode = await runDoctor({ flags: {} });
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(brokenDocCode, 1, "Doctor should return unhealthy 1 due to broken symlink");
    assert.ok(brokenDocOutput.includes("Broken/Orphaned:"), "Reports broken symlinks");
    assert.ok(brokenDocOutput.includes("Run `skills-manager init` to automatically restore"), "Provides self-healing instructions");
  } finally {
    env.cleanup();
  }
});
