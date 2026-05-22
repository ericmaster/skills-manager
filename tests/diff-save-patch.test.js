// diff + save-patch integration tests.
//
// Per the phase 3 brief, we assert side effects (exit codes, file system
// state) rather than capturing stdout/stderr — capturing process.stdout in
// the same process as Node's test runner is brittle, since the runner emits
// events through the same stream during async ticks.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../dist/commands/init.js";
import { runAdd } from "../dist/commands/add.js";
import { runDiff } from "../dist/commands/diff.js";
import { runSavePatch } from "../dist/commands/save-patch.js";

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-diffsp-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function makeFixtureSkill(parent, name, body, { description = "test" } = {}) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
  return dir;
}

async function withInited(fn) {
  const home = fakeHome();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skm-diffsp-src-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    await runInit({ local: false });
    await fn(home, fixtureRoot);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("diff: unknown skill exits 1", async () => {
  await withInited(async () => {
    const code = await runDiff({ skill: "nope", flags: {} });
    assert.equal(code, 1);
  });
});

test("diff: missing arg exits 1", async () => {
  await withInited(async () => {
    const code = await runDiff({ skill: undefined, flags: {} });
    assert.equal(code, 1);
  });
});

test("diff: authored skill exits 0 (no upstream to diff)", async () => {
  await withInited(async () => {
    const code = await runDiff({ skill: "skills-manager", flags: {} });
    assert.equal(code, 0);
  });
});

test("diff: contrib skill with no drift exits 0", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "alpha", "hello");
    const addCode = await runAdd({ source: fixture, flags: {} });
    assert.equal(addCode, 0);
    const code = await runDiff({ skill: "alpha", flags: {} });
    assert.equal(code, 0);
  });
});

test("diff: contrib skill with drift exits 0 (drift is non-error)", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "beta", "hello");
    await runAdd({ source: fixture, flags: {} });
    appendFileSync(
      join(home, ".skills-manager", "skills", "beta", "SKILL.md"),
      "extra-line-marker\n",
    );
    const code = await runDiff({ skill: "beta", flags: {} });
    assert.equal(code, 0);
  });
});

test("save-patch: missing arg exits 1", async () => {
  await withInited(async () => {
    const code = await runSavePatch({ skill: undefined, flags: {} });
    assert.equal(code, 1);
  });
});

test("save-patch: unknown skill exits 1", async () => {
  await withInited(async () => {
    const code = await runSavePatch({ skill: "ghost", flags: {} });
    assert.equal(code, 1);
  });
});

test("save-patch: authored skill is a no-op (exit 0, no patch written)", async () => {
  await withInited(async (home) => {
    const code = await runSavePatch({ skill: "skills-manager", flags: {} });
    assert.equal(code, 0);
    const patchPath = join(
      home,
      ".skills-manager",
      "patches",
      "skills-manager.patch",
    );
    assert.equal(existsSync(patchPath), false);
  });
});

test("save-patch: no drift removes a stale patch file", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "gamma", "hello");
    await runAdd({ source: fixture, flags: {} });

    const patchPath = join(home, ".skills-manager", "patches", "gamma.patch");
    mkdirSync(join(home, ".skills-manager", "patches"), { recursive: true });
    writeFileSync(patchPath, "stale-content\n");
    assert.ok(existsSync(patchPath));

    const code = await runSavePatch({ skill: "gamma", flags: {} });
    assert.equal(code, 0);
    assert.equal(existsSync(patchPath), false);
  });
});

test("save-patch: drift writes a non-empty patch and is stable across re-runs", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "delta", "hello");
    await runAdd({ source: fixture, flags: {} });
    appendFileSync(
      join(home, ".skills-manager", "skills", "delta", "SKILL.md"),
      "drift-marker\n",
    );

    const code1 = await runSavePatch({ skill: "delta", flags: {} });
    assert.equal(code1, 0);
    const patchPath = join(home, ".skills-manager", "patches", "delta.patch");
    assert.ok(existsSync(patchPath));
    const body1 = readFileSync(patchPath, "utf8");
    assert.ok(body1.length > 0);
    assert.match(body1, /drift-marker/);

    // Re-run should be byte-identical, not duplicated.
    const code2 = await runSavePatch({ skill: "delta", flags: {} });
    assert.equal(code2, 0);
    const body2 = readFileSync(patchPath, "utf8");
    assert.equal(body2, body1);
  });
});
