import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../dist/commands/init.js";
import { runAdopt } from "../dist/commands/adopt.js";

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skm-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".hermes"), { recursive: true });
  return home;
}

function writeSkill(dir, name, body) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\n\n${body}`,
  );
  return skillDir;
}

async function withFakeHome(fn) {
  const home = makeFakeHome();
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  try {
    await runInit({ local: false });
    await fn(home);
  } finally {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("adopt with no args lists candidates", async () => {
  await withFakeHome(async (home) => {
    writeSkill(join(home, ".claude", "skills"), "alpha", "alpha body");
    const code = await runAdopt({ name: undefined, flags: {} });
    assert.equal(code, 0);
  });
});

test("adopt <name> moves a single-location skill into authored/ and symlinks", async () => {
  await withFakeHome(async (home) => {
    const claudeSkills = join(home, ".claude", "skills");
    writeSkill(claudeSkills, "alpha", "alpha body");
    const code = await runAdopt({ name: "alpha", flags: {} });
    assert.equal(code, 0);

    const ssotSkill = join(home, ".skills-manager", "authored", "alpha");
    assert.ok(existsSync(join(ssotSkill, "SKILL.md")));

    const link = join(claudeSkills, "alpha");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), ssotSkill);

    const manifest = JSON.parse(
      readFileSync(join(home, ".skills-manager", "skills.json"), "utf8"),
    );
    assert.equal(manifest.skills.alpha.kind, "authored");
  });
});

test("adopt collapses identical duplicates across tools to one SSOT copy with two symlinks", async () => {
  await withFakeHome(async (home) => {
    const claudeSkills = join(home, ".claude", "skills");
    const hermesSkills = join(home, ".hermes", "skills");
    writeSkill(claudeSkills, "beta", "same body");
    writeSkill(hermesSkills, "beta", "same body");

    const code = await runAdopt({ name: "beta", flags: {} });
    assert.equal(code, 0);

    const ssotSkill = join(home, ".skills-manager", "authored", "beta");
    assert.ok(existsSync(join(ssotSkill, "SKILL.md")));

    for (const link of [
      join(claudeSkills, "beta"),
      join(hermesSkills, "beta"),
    ]) {
      assert.ok(lstatSync(link).isSymbolicLink(), `${link} should be a symlink`);
      assert.equal(readlinkSync(link), ssotSkill);
    }
  });
});

test("adopt refuses to resolve cross-tool conflicts without --from", async () => {
  await withFakeHome(async (home) => {
    writeSkill(join(home, ".claude", "skills"), "gamma", "claude body");
    writeSkill(join(home, ".hermes", "skills"), "gamma", "hermes body");
    const code = await runAdopt({ name: "gamma", flags: {} });
    assert.equal(code, 1);

    // Untouched.
    assert.ok(
      !existsSync(
        join(home, ".skills-manager", "authored", "gamma", "SKILL.md"),
      ),
    );
  });
});

test("adopt --from picks a winner and backs up the loser", async () => {
  await withFakeHome(async (home) => {
    const claudeSkills = join(home, ".claude", "skills");
    const hermesSkills = join(home, ".hermes", "skills");
    writeSkill(claudeSkills, "delta", "claude wins");
    writeSkill(hermesSkills, "delta", "hermes loses");

    const code = await runAdopt({
      name: "delta",
      flags: { from: "claude-code" },
    });
    assert.equal(code, 0);

    const ssotSkill = join(home, ".skills-manager", "authored", "delta");
    const md = readFileSync(join(ssotSkill, "SKILL.md"), "utf8");
    assert.ok(md.includes("claude wins"));

    // Both link sites now point at the same SSOT dir.
    for (const link of [
      join(claudeSkills, "delta"),
      join(hermesSkills, "delta"),
    ]) {
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(readlinkSync(link), ssotSkill);
    }

    // Loser was backed up under .cache/adopted-backup/.
    const backupRoot = join(
      home,
      ".skills-manager",
      ".cache",
      "adopted-backup",
    );
    const backups = readdirSync(backupRoot);
    assert.ok(backups.length > 0);
    const tsDir = join(backupRoot, backups[0]);
    const hermesBackup = join(tsDir, "hermes", "delta", "SKILL.md");
    assert.ok(existsSync(hermesBackup));
    assert.ok(readFileSync(hermesBackup, "utf8").includes("hermes loses"));
  });
});

test("adopt --from --keep-other-as adopts both copies under different names", async () => {
  await withFakeHome(async (home) => {
    const claudeSkills = join(home, ".claude", "skills");
    const hermesSkills = join(home, ".hermes", "skills");
    writeSkill(claudeSkills, "epsilon", "claude flavor");
    writeSkill(hermesSkills, "epsilon", "hermes flavor");

    const code = await runAdopt({
      name: "epsilon",
      flags: { from: "claude-code", "keep-other-as": "epsilon-hermes" },
    });
    assert.equal(code, 0);

    const epsilon = join(home, ".skills-manager", "authored", "epsilon");
    const epsilonHermes = join(
      home,
      ".skills-manager",
      "authored",
      "epsilon-hermes",
    );
    assert.ok(
      readFileSync(join(epsilon, "SKILL.md"), "utf8").includes("claude flavor"),
    );
    assert.ok(
      readFileSync(join(epsilonHermes, "SKILL.md"), "utf8").includes(
        "hermes flavor",
      ),
    );

    assert.equal(
      readlinkSync(join(claudeSkills, "epsilon")),
      epsilon,
    );
    assert.equal(
      readlinkSync(join(hermesSkills, "epsilon")),
      epsilonHermes,
    );

    const manifest = JSON.parse(
      readFileSync(join(home, ".skills-manager", "skills.json"), "utf8"),
    );
    assert.equal(manifest.skills.epsilon.kind, "authored");
    assert.equal(manifest.skills["epsilon-hermes"].kind, "authored");
  });
});

test("adopt --all adopts safe candidates and skips conflicts", async () => {
  await withFakeHome(async (home) => {
    writeSkill(join(home, ".claude", "skills"), "safe-one", "x");
    writeSkill(join(home, ".claude", "skills"), "safe-two", "y");
    writeSkill(join(home, ".claude", "skills"), "conflicted", "claude side");
    writeSkill(join(home, ".hermes", "skills"), "conflicted", "hermes side");

    const code = await runAdopt({ name: undefined, flags: { all: true } });
    assert.equal(code, 0);

    for (const name of ["safe-one", "safe-two"]) {
      assert.ok(
        existsSync(
          join(home, ".skills-manager", "authored", name, "SKILL.md"),
        ),
      );
    }
    // Conflicted left untouched.
    assert.ok(
      !existsSync(
        join(home, ".skills-manager", "authored", "conflicted", "SKILL.md"),
      ),
    );
  });
});

test("adopt --dry-run does not modify state", async () => {
  await withFakeHome(async (home) => {
    const claudeSkills = join(home, ".claude", "skills");
    const orig = writeSkill(claudeSkills, "zeta", "z");
    const code = await runAdopt({
      name: "zeta",
      flags: { "dry-run": true },
    });
    assert.equal(code, 0);
    // Original directory still in place, not yet a symlink.
    assert.ok(!lstatSync(orig).isSymbolicLink());
    assert.ok(
      !existsSync(join(home, ".skills-manager", "authored", "zeta")),
    );
  });
});
