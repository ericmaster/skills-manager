import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../dist/commands/init.js";
import { runAdd } from "../dist/commands/add.js";
import { runUpdate } from "../dist/commands/update.js";

const SKILL_BODY_V1 = `line one\nline two\nline three\nline four\nline five\n`;
const SKILL_BODY_V2_TOP = `LINE ONE UPSTREAM\nline two\nline three\nline four\nline five\n`;
const SKILL_BODY_V2_LINE5 = `line one\nline two\nline three\nline four\nLINE FIVE UPSTREAM\n`;

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-upd-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function writeFixture(parent, name, body, description = "test") {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
  return dir;
}

async function withInited(fn) {
  const home = fakeHome();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skm-upd-fix-"));
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

function readManifestRaw(root) {
  return JSON.parse(readFileSync(join(root, "skills.json"), "utf8"));
}
function readLockRaw(root) {
  return JSON.parse(readFileSync(join(root, "skills.lock.json"), "utf8"));
}

test("update: no-op when nothing changed", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-noop", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const root = join(home, ".skills-manager");
    const lockBefore = readLockRaw(root);
    const code = await runUpdate({
      skills: ["skill-noop"],
      cont: false,
      flags: {},
    });
    assert.equal(code, 0);
    const lockAfter = readLockRaw(root);
    assert.deepEqual(lockAfter, lockBefore);
  });
});

test("update: clean update merges drift with upstream", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-clean", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const root = join(home, ".skills-manager");
    const livePath = join(root, "skills", "skill-clean", "SKILL.md");

    // Drift: append a line to the live skill.
    const orig = readFileSync(livePath, "utf8");
    writeFileSync(livePath, orig + "drift line\n");

    // Bump fixture: replace line one upstream.
    writeFileSync(
      join(fixture, "SKILL.md"),
      `---\nname: skill-clean\ndescription: test\n---\n${SKILL_BODY_V2_TOP}`,
    );

    const code = await runUpdate({
      skills: ["skill-clean"],
      cont: false,
      flags: {},
    });
    assert.equal(code, 0);

    const merged = readFileSync(livePath, "utf8");
    assert.match(merged, /LINE ONE UPSTREAM/);
    assert.match(merged, /drift line/);

    // Lockfile updated.
    const lock = readLockRaw(root);
    assert.ok(lock.skills["skill-clean"].resolvedRef.startsWith("local@"));

    // Staging dir is gone.
    assert.equal(
      existsSync(join(root, ".cache", "staging", "skill-clean")),
      false,
    );

    // Patch reapplied: patches/skill-clean.patch reflects the drift.
    const patchPath = join(root, "patches", "skill-clean.patch");
    if (existsSync(patchPath)) {
      const body = readFileSync(patchPath, "utf8");
      assert.match(body, /drift line/);
    }
  });
});

test("update: conflict pauses with markers and lockfile unchanged", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-conf", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const root = join(home, ".skills-manager");
    const livePath = join(root, "skills", "skill-conf", "SKILL.md");

    // Drift on line 5.
    const lines = SKILL_BODY_V1.split("\n");
    lines[4] = "LINE FIVE LOCAL";
    writeFileSync(
      livePath,
      `---\nname: skill-conf\ndescription: test\n---\n${lines.join("\n")}`,
    );

    // Upstream also changes line 5 (different).
    writeFileSync(
      join(fixture, "SKILL.md"),
      `---\nname: skill-conf\ndescription: test\n---\n${SKILL_BODY_V2_LINE5}`,
    );

    const lockBefore = readLockRaw(root);
    const liveBefore = readFileSync(livePath, "utf8");

    const code = await runUpdate({
      skills: ["skill-conf"],
      cont: false,
      flags: {},
    });
    assert.equal(code, 0); // paused is not an error

    // Live untouched, lockfile untouched.
    assert.equal(readFileSync(livePath, "utf8"), liveBefore);
    assert.deepEqual(readLockRaw(root), lockBefore);

    // Staging dir present with conflict markers.
    const stagingDir = join(root, ".cache", "staging", "skill-conf");
    assert.ok(existsSync(stagingDir));
    const stagedBody = readFileSync(join(stagingDir, "SKILL.md"), "utf8");
    assert.match(stagedBody, /<<<<<<< /);
    // Sentinel exists.
    assert.ok(existsSync(join(stagingDir, ".staging-meta.json")));
  });
});

test("update --continue: resumes after manual conflict resolution", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-cont", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const root = join(home, ".skills-manager");
    const livePath = join(root, "skills", "skill-cont", "SKILL.md");

    const lines = SKILL_BODY_V1.split("\n");
    lines[4] = "LINE FIVE LOCAL";
    writeFileSync(
      livePath,
      `---\nname: skill-cont\ndescription: test\n---\n${lines.join("\n")}`,
    );
    writeFileSync(
      join(fixture, "SKILL.md"),
      `---\nname: skill-cont\ndescription: test\n---\n${SKILL_BODY_V2_LINE5}`,
    );

    const code1 = await runUpdate({
      skills: ["skill-cont"],
      cont: false,
      flags: {},
    });
    assert.equal(code1, 0);

    const stagingDir = join(root, ".cache", "staging", "skill-cont");
    assert.ok(existsSync(stagingDir));

    // Manually resolve conflict markers.
    const stagedSkillMd = join(stagingDir, "SKILL.md");
    const merged = `---\nname: skill-cont\ndescription: test\n---\nline one\nline two\nline three\nline four\nMERGED\n`;
    writeFileSync(stagedSkillMd, merged);

    const code2 = await runUpdate({
      skills: ["skill-cont"],
      cont: true,
      flags: {},
    });
    assert.equal(code2, 0);

    // Staging dir gone, live updated, lockfile updated.
    assert.equal(existsSync(stagingDir), false);
    assert.match(readFileSync(livePath, "utf8"), /MERGED/);
  });
});

test("update --continue: errors when markers still present", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-mark", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const root = join(home, ".skills-manager");
    const livePath = join(root, "skills", "skill-mark", "SKILL.md");

    const lines = SKILL_BODY_V1.split("\n");
    lines[4] = "LINE FIVE LOCAL";
    writeFileSync(
      livePath,
      `---\nname: skill-mark\ndescription: test\n---\n${lines.join("\n")}`,
    );
    writeFileSync(
      join(fixture, "SKILL.md"),
      `---\nname: skill-mark\ndescription: test\n---\n${SKILL_BODY_V2_LINE5}`,
    );
    await runUpdate({ skills: ["skill-mark"], cont: false, flags: {} });

    const code = await runUpdate({
      skills: ["skill-mark"],
      cont: true,
      flags: {},
    });
    assert.equal(code, 1);
  });
});

test("update --continue: errors when no staging dir", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-bare", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const code = await runUpdate({
      skills: ["skill-bare"],
      cont: true,
      flags: {},
    });
    assert.equal(code, 1);
  });
});

test("update: refuses to clobber paused staging dir", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-pause", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const root = join(home, ".skills-manager");
    const livePath = join(root, "skills", "skill-pause", "SKILL.md");

    const lines = SKILL_BODY_V1.split("\n");
    lines[4] = "LINE FIVE LOCAL";
    writeFileSync(
      livePath,
      `---\nname: skill-pause\ndescription: test\n---\n${lines.join("\n")}`,
    );
    writeFileSync(
      join(fixture, "SKILL.md"),
      `---\nname: skill-pause\ndescription: test\n---\n${SKILL_BODY_V2_LINE5}`,
    );

    await runUpdate({ skills: ["skill-pause"], cont: false, flags: {} });
    // Second run without --continue should refuse to clobber.
    const code = await runUpdate({
      skills: ["skill-pause"],
      cont: false,
      flags: {},
    });
    // Per-skill failure → exit 1.
    assert.equal(code, 1);
  });
});

test("update: authored skill silently skipped when not explicitly named", async () => {
  await withInited(async (home) => {
    // skills-manager (authored) is the only skill in the manifest after init.
    const code = await runUpdate({ skills: [], cont: false, flags: {} });
    assert.equal(code, 0);
    // No skills/skills-manager dir should be created (it's authored).
    const root = join(home, ".skills-manager");
    assert.equal(
      existsSync(join(root, "skills", "skills-manager")),
      false,
    );
  });
});

test("update: symlinks survive the swap", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = writeFixture(fixtureRoot, "skill-link", SKILL_BODY_V1);
    await runAdd({ source: fixture, flags: {} });
    const root = join(home, ".skills-manager");
    const livePath = join(root, "skills", "skill-link", "SKILL.md");
    const linkPath = join(home, ".claude", "skills", "skill-link");

    assert.ok(lstatSync(linkPath).isSymbolicLink());
    assert.equal(
      readlinkSync(linkPath),
      join(root, "skills", "skill-link"),
    );

    // Drift then bump.
    const orig = readFileSync(livePath, "utf8");
    writeFileSync(livePath, orig + "drift\n");
    writeFileSync(
      join(fixture, "SKILL.md"),
      `---\nname: skill-link\ndescription: test\n---\n${SKILL_BODY_V2_TOP}`,
    );

    const code = await runUpdate({
      skills: ["skill-link"],
      cont: false,
      flags: {},
    });
    assert.equal(code, 0);

    // Symlink still resolves to the live dir and reads post-update content.
    assert.ok(lstatSync(linkPath).isSymbolicLink());
    assert.equal(
      readlinkSync(linkPath),
      join(root, "skills", "skill-link"),
    );
    const linkedSkillMd = readFileSync(join(linkPath, "SKILL.md"), "utf8");
    assert.match(linkedSkillMd, /LINE ONE UPSTREAM/);
    assert.match(linkedSkillMd, /drift/);
  });
});
