// Phase 5 — remove + list integration tests.
// Covers the nine cases listed in docs/phases/phase-5-remove-and-list.md.

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
import { runList } from "../dist/commands/list.js";
import { runRemove } from "../dist/commands/remove.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-rl-home-"));
  // Pretend Claude Code is installed so we exercise linking.
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

function makeFixtureSkill(parent, name, body) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`,
  );
  return dir;
}

async function withInited(fn) {
  const home = fakeHome();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skm-rl-src-"));
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

/** Capture stdout for the duration of fn(). */
async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

/** Capture stderr for the duration of fn(). */
async function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join("");
}

// ── list tests ───────────────────────────────────────────────────────────────

test("list: after init shows bundled skills-manager skill", async () => {
  await withInited(async (_home, _fixtureRoot) => {
    const output = await captureStdout(async () => {
      const code = await runList({ flags: {} });
      assert.equal(code, 0);
    });
    // init installs the bundled skills-manager as an authored skill.
    assert.match(output, /skills-manager/);
    assert.match(output, /authored/);
  });
});

test("list: after init + add shows two rows", async () => {
  await withInited(async (_home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "alpha-skill", "hello");
    await runAdd({ source: fixture, flags: {} });

    const output = await captureStdout(async () => {
      const code = await runList({ flags: {} });
      assert.equal(code, 0);
    });
    const lines = output.trim().split("\n");
    assert.equal(lines.length, 2, `expected 2 lines, got: ${output}`);
    assert.match(output, /alpha-skill/);
    assert.match(output, /skills-manager/);
  });
});

test("list: --json outputs parseable JSON with expected shape", async () => {
  await withInited(async (_home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "beta-skill", "data");
    await runAdd({ source: fixture, flags: {} });

    const output = await captureStdout(async () => {
      const code = await runList({ flags: { json: true } });
      assert.equal(code, 0);
    });
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    for (const entry of parsed) {
      assert.ok("name" in entry);
      assert.ok("kind" in entry);
      assert.ok("ref" in entry);
      assert.ok("customized" in entry);
      assert.ok("source" in entry);
    }
    const names = parsed.map((e) => e.name).sort();
    assert.deepEqual(names, ["beta-skill", "skills-manager"]);
  });
});

test("list: customized flag shown when non-empty patch file present", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "gamma-skill", "original");
    await runAdd({ source: fixture, flags: {} });

    const root = join(home, ".skills-manager");
    const patchPath = join(root, "patches", "gamma-skill.patch");
    writeFileSync(patchPath, "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-original\n+modified\n");

    const output = await captureStdout(async () => {
      const code = await runList({ flags: {} });
      assert.equal(code, 0);
    });
    assert.match(output, /\[customized\]/);
  });
});

// ── remove tests ─────────────────────────────────────────────────────────────

test("remove: unknown skill exits 1", async () => {
  await withInited(async (_home, _fixtureRoot) => {
    let code;
    await captureStderr(async () => {
      code = await runRemove({ skill: "nonexistent", flags: {} });
    });
    assert.equal(code, 1);
  });
});

test("remove: contrib skill cleans up all artifacts", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "delta-skill", "hello");
    await runAdd({ source: fixture, flags: {} });

    const root = join(home, ".skills-manager");

    // Verify everything was created by add.
    assert.ok(existsSync(join(root, "skills", "delta-skill", "SKILL.md")));
    const linkPath = join(home, ".claude", "skills", "delta-skill");
    assert.ok(lstatSync(linkPath).isSymbolicLink());

    // Write a patch file to verify it gets cleaned up.
    const patchPath = join(root, "patches", "delta-skill.patch");
    writeFileSync(patchPath, "fake patch");

    // Verify pristine exists.
    const pristineRoot = join(root, ".cache", "pristine");
    const pristineEntries = readdirSync(pristineRoot).filter((d) =>
      d.startsWith("delta-skill@"),
    );
    assert.ok(pristineEntries.length > 0);

    // Now remove.
    const output = await captureStdout(async () => {
      const code = await runRemove({ skill: "delta-skill", flags: {} });
      assert.equal(code, 0);
    });
    assert.match(output, /delta-skill: removed/);

    // Verify everything is gone.
    assert.ok(!existsSync(join(root, "skills", "delta-skill")));
    assert.ok(!pathExists(linkPath)); // broken symlinks count
    assert.ok(!existsSync(patchPath));
    const remainingPristine = readdirSync(pristineRoot).filter((d) =>
      d.startsWith("delta-skill@"),
    );
    assert.equal(remainingPristine.length, 0);

    // Verify manifest no longer lists it.
    const manifest = JSON.parse(
      readFileSync(join(root, "skills.json"), "utf8"),
    );
    assert.equal(manifest.skills["delta-skill"], undefined);

    const lock = JSON.parse(
      readFileSync(join(root, "skills.lock.json"), "utf8"),
    );
    assert.equal(lock.skills["delta-skill"], undefined);
  });
});

test("remove: authored skill removes authored dir and tool symlinks", async () => {
  await withInited(async (home, _fixtureRoot) => {
    const root = join(home, ".skills-manager");

    // The bundled skills-manager is an authored skill. Let's create another
    // authored skill to test with, so we don't trigger the warning.
    const authoredDir = join(root, "authored", "my-custom");
    mkdirSync(authoredDir, { recursive: true });
    writeFileSync(
      join(authoredDir, "SKILL.md"),
      "---\nname: my-custom\ndescription: test\n---\nbody\n",
    );
    // Manually record in manifest.
    const manifestPath = join(root, "skills.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.skills["my-custom"] = { kind: "authored" };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const output = await captureStdout(async () => {
      const code = await runRemove({ skill: "my-custom", flags: {} });
      assert.equal(code, 0);
    });
    assert.match(output, /my-custom: removed/);
    assert.ok(!existsSync(authoredDir));

    // Manifest should not list my-custom.
    const updated = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(updated.skills["my-custom"], undefined);
  });
});

test("remove: blocks when staging exists", async () => {
  await withInited(async (home, fixtureRoot) => {
    const fixture = makeFixtureSkill(fixtureRoot, "eta-skill", "hello");
    await runAdd({ source: fixture, flags: {} });

    const root = join(home, ".skills-manager");
    // Manually create staging dir.
    const stagingDir = join(root, ".cache", "staging", "eta-skill");
    mkdirSync(stagingDir, { recursive: true });

    let code;
    const stderr = await captureStderr(async () => {
      code = await runRemove({ skill: "eta-skill", flags: {} });
    });
    assert.equal(code, 1);
    assert.match(stderr, /pending update/);
  });
});

test("remove: bundled skills-manager skill warns but succeeds", async () => {
  await withInited(async (home, _fixtureRoot) => {
    const root = join(home, ".skills-manager");
    assert.ok(existsSync(join(root, "authored", "skills-manager", "SKILL.md")));

    let stderr = "";
    const output = await captureStdout(async () => {
      stderr = await captureStderr(async () => {
        const code = await runRemove({ skill: "skills-manager", flags: {} });
        assert.equal(code, 0);
      });
    });
    assert.match(stderr, /warning.*reinstall/);
    assert.match(output, /skills-manager: removed/);
    assert.ok(!existsSync(join(root, "authored", "skills-manager")));
  });
});

/** Like existsSync but also detects broken symlinks via lstatSync. */
function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
