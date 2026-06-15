import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../dist/commands/init.js";
import { runValidate } from "../dist/commands/validate.js";
import { SsotStore } from "../dist/core/ssot.js";

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-home-val-"));
  return home;
}

test("validate: fails when not initialized", async () => {
  const home = makeFakeHome();
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);

  try {
    const exitCode = await runValidate({ skill: undefined, flags: {} });
    assert.equal(exitCode, 1);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("validate: succeeds with no skills when initialized", async () => {
  const home = makeFakeHome();
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);

  try {
    const initCode = await runInit({ local: true });
    assert.equal(initCode, 0);

    // Remove the automatically installed manager skill from manifest to test 'no skills' case
    const ssotRoot = join(home, ".skills-manager");
    const manifestPath = join(ssotRoot, "skills.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.skills = {};
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const exitCode = await runValidate({ skill: undefined, flags: {} });
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("validate: invokes npx skills-check and succeeds for valid skills, fails for invalid ones", async () => {
  const home = makeFakeHome();
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  process.env.HOME = home;
  process.chdir(home);

  // Setup mock npx in PATH
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const npxPath = join(binDir, "npx");
  writeFileSync(
    npxPath,
    `#!/bin/sh
case "$*" in
  *invalid-skill*)
    # Genuine structural error -> must fail validation.
    echo '{"files":1,"findings":[{"file":"SKILL.md","field":"name","level":"error","message":"Missing required field: name"}],"errors":1,"warnings":0,"infos":0}'
    exit 1 ;;
  *publish-skill*)
    # Only publish-readiness errors -> must NOT fail validation (skmgr never publishes).
    echo '{"files":1,"findings":[{"file":"SKILL.md","field":"author","level":"error","message":"Missing required field for publish: author"}],"errors":1,"warnings":0,"infos":0}'
    exit 1 ;;
  *)
    echo '{"files":1,"findings":[],"errors":0,"warnings":0,"infos":0}'
    exit 0 ;;
esac
`
  );
  chmodSync(npxPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;

  try {
    const initCode = await runInit({ local: true });
    assert.equal(initCode, 0);

    const ssotRoot = join(home, ".skills-manager");
    const store = SsotStore.openAt(ssotRoot);

    // 1. Create a valid authored skill
    const validDir = join(ssotRoot, "authored", "valid-skill");
    mkdirSync(validDir, { recursive: true });
    writeFileSync(join(validDir, "SKILL.md"), "---\nname: valid-skill\ndescription: valid\n---\n");
    store.recordAuthoredSkill("valid-skill");

    // 2. Create an invalid authored skill
    const invalidDir = join(ssotRoot, "authored", "invalid-skill");
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, "SKILL.md"), "invalid frontmatter");
    store.recordAuthoredSkill("invalid-skill");

    // 3. Create a skill that only lacks publish-readiness fields (author/license/repository)
    const publishDir = join(ssotRoot, "authored", "publish-skill");
    mkdirSync(publishDir, { recursive: true });
    writeFileSync(join(publishDir, "SKILL.md"), "---\nname: publish-skill\ndescription: ok\n---\n");
    store.recordAuthoredSkill("publish-skill");

    store.commit();

    // Validate specific valid skill -> succeeds
    const exitCodeValid = await runValidate({ skill: "valid-skill", flags: {} });
    assert.equal(exitCodeValid, 0);

    // Validate specific invalid skill -> fails
    const exitCodeInvalid = await runValidate({ skill: "invalid-skill", flags: {} });
    assert.equal(exitCodeInvalid, 1);

    // Publish-only missing fields are not required for local skills -> succeeds
    const exitCodePublish = await runValidate({ skill: "publish-skill", flags: {} });
    assert.equal(exitCodePublish, 0);

    // Validate all skills -> fails overall since one is invalid
    const exitCodeAll = await runValidate({ skill: undefined, flags: {} });
    assert.equal(exitCodeAll, 1);

  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    rmSync(home, { recursive: true, force: true });
  }
});
