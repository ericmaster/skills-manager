// Add-command integration. Local-source branch is fully covered here.
// Git and direct-URL branches are exercised manually until a fixture-server
// pattern lands — see docs/phases/phase-2-add-and-source-resolution.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../dist/commands/init.js";
import { runAdd } from "../dist/commands/add.js";

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-add-home-"));
  // Pretend Claude Code is installed so we exercise linking.
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
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skm-add-src-"));
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

test("add from a local directory installs into SSOT and links into native tools", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "alpha-skill", "hello");
    const code = await runAdd({ source: fixture, flags: {} });
    assert.equal(code, 0);

    const root = join(home, ".skills-manager");
    assert.ok(existsSync(join(root, "skills", "alpha-skill", "SKILL.md")));

    // Pristine cache populated with name@<safeRef>/SKILL.md.
    const pristineRoot = join(root, ".cache", "pristine");
    const entries = readdirSync(pristineRoot).filter((d) =>
      d.startsWith("alpha-skill@"),
    );
    assert.equal(entries.length, 1);
    assert.ok(
      existsSync(join(pristineRoot, entries[0], "SKILL.md")),
      "pristine SKILL.md should exist",
    );

    const manifest = JSON.parse(
      readFileSync(join(root, "skills.json"), "utf8"),
    );
    assert.equal(manifest.skills["alpha-skill"].kind, "contrib");
    assert.equal(manifest.skills["alpha-skill"].source.type, "local");

    const lock = JSON.parse(
      readFileSync(join(root, "skills.lock.json"), "utf8"),
    );
    assert.ok(lock.skills["alpha-skill"].resolvedRef.startsWith("local@"));

    const linkPath = join(home, ".claude", "skills", "alpha-skill");
    assert.ok(lstatSync(linkPath).isSymbolicLink());
    assert.equal(readlinkSync(linkPath), join(root, "skills", "alpha-skill"));
  });
});

test("add fails when not initialized", async () => {
  const home = fakeHome();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skm-add-src-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    const fixture = makeFixtureSkill(fixtureRoot, "ghost", "x");
    const code = await runAdd({ source: fixture, flags: {} });
    assert.equal(code, 1);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("add fails on duplicate", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "dupe", "x");
    const first = await runAdd({ source: fixture, flags: {} });
    assert.equal(first, 0);
    const second = await runAdd({ source: fixture, flags: {} });
    assert.equal(second, 1);
  });
});

test("add of a multi-SKILL.md source without subpath errors with candidates", async () => {
  await withInited(async (home, fixtureRoot) => {
    // Build a fixture with two SKILL.md files in subdirectories — no top-level SKILL.md.
    const root = join(fixtureRoot, "bundle");
    mkdirSync(root, { recursive: true });
    makeFixtureSkill(root, "one", "a");
    makeFixtureSkill(root, "two", "b");
    let err;
    try {
      await runAdd({ source: root, flags: {} });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "should throw");
    assert.match(err.message, /multiple SKILL\.md/);
    assert.match(err.message, /one/);
    assert.match(err.message, /two/);
  });
});

test("add fails when SKILL.md lacks a name field", async () => {
  await withInited(async (home, fixtureRoot) => {
    const dir = join(fixtureRoot, "noname");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\ndescription: missing name\n---\nbody\n`,
    );
    let err;
    try {
      await runAdd({ source: dir, flags: {} });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "should throw");
    assert.match(err.message, /required `name` field/);
  });
});
