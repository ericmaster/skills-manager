import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../dist/commands/init.js";
import { runPreset } from "../dist/commands/preset.js";

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-home-pres-"));
  return home;
}

test("preset: custom preset operations", async () => {
  const home = makeFakeHome();
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);

  try {
    const initCode = await runInit({ local: true });
    assert.equal(initCode, 0);

    // Create custom preset
    const createCode = await runPreset({
      subcommand: "create",
      name: "mypreset",
      skill: undefined,
      flags: {},
    });
    assert.equal(createCode, 0);

    const root = join(home, ".skills-manager");
    const presetsPath = join(root, "presets.json");
    assert.ok(existsSync(presetsPath), "presets.json should be created");

    const presets = JSON.parse(readFileSync(presetsPath, "utf8"));
    assert.ok(presets.presets["mypreset"], "mypreset should be in presets.json");

    // Add skill to custom preset
    const addCode = await runPreset({
      subcommand: "add",
      name: "mypreset",
      skill: "skills-manager",
      flags: {},
    });
    assert.equal(addCode, 0);

    const presets2 = JSON.parse(readFileSync(presetsPath, "utf8"));
    assert.ok(presets2.presets["mypreset"].skills["skills-manager"], "skills-manager skill should be in preset");

    // Remove skill from preset
    const rmSkillCode = await runPreset({
      subcommand: "remove",
      name: "mypreset",
      skill: "skills-manager",
      flags: {},
    });
    assert.equal(rmSkillCode, 0);

    const presets3 = JSON.parse(readFileSync(presetsPath, "utf8"));
    assert.equal(Object.keys(presets3.presets["mypreset"].skills).length, 0, "preset should be empty");

  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
