import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPatch3Way,
  diffSkill,
  savePatch,
} from "../dist/core/patch.js";

const SKILL_BODY = `---\nname: demo\ndescription: test\n---\n\nline one\nline two\nline three\n`;

function makeFixture(name = "demo") {
  const root = mkdtempSync(join(tmpdir(), "skm-patch-"));
  const skill = join(root, "skills", name);
  const pristine = join(root, ".cache", "pristine", `${name}@v1`);
  mkdirSync(skill, { recursive: true });
  mkdirSync(pristine, { recursive: true });
  mkdirSync(join(root, "patches"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), SKILL_BODY);
  writeFileSync(join(pristine, "SKILL.md"), SKILL_BODY);
  writeFileSync(
    join(root, "skills.lock.json"),
    JSON.stringify({ version: 1, skills: { [name]: { resolvedRef: "v1" } } }, null, 2) +
      "\n",
  );
  return { root, skill, pristine, name };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test("diffSkill: identical pristine and live → empty diff", async () => {
  const { root, pristine, skill } = makeFixture();
  try {
    const diff = await diffSkill(pristine, skill);
    assert.equal(diff, "");
  } finally {
    cleanup(root);
  }
});

test("diffSkill: pure addition produces a diff with the new line", async () => {
  const { root, pristine, skill } = makeFixture();
  try {
    writeFileSync(join(skill, "SKILL.md"), SKILL_BODY + "line four added\n");
    const diff = await diffSkill(pristine, skill);
    assert.notEqual(diff, "");
    assert.ok(diff.includes("line four added"), "diff should mention added line");
    assert.ok(diff.includes("a/SKILL.md") || diff.includes("a/"), "headers should be relative");
  } finally {
    cleanup(root);
  }
});

test("savePatch: empty diff cleans up stale patch and returns empty=true", async () => {
  const { root, name } = makeFixture();
  try {
    const patchPath = join(root, "patches", `${name}.patch`);
    writeFileSync(patchPath, "stale content from a previous run\n");
    assert.ok(existsSync(patchPath));
    const result = await savePatch(root, name);
    assert.equal(result.empty, true);
    assert.equal(result.patchPath, patchPath);
    assert.equal(existsSync(patchPath), false, "stale patch should be removed");
  } finally {
    cleanup(root);
  }
});

test("savePatch: non-empty diff writes patch file and returns empty=false", async () => {
  const { root, skill, name } = makeFixture();
  try {
    writeFileSync(join(skill, "SKILL.md"), SKILL_BODY + "line four added\n");
    const result = await savePatch(root, name);
    assert.equal(result.empty, false);
    assert.ok(existsSync(result.patchPath));
    const body = readFileSync(result.patchPath, "utf8");
    assert.ok(body.length > 0);
    assert.ok(body.includes("line four added"));
  } finally {
    cleanup(root);
  }
});

test("savePatch: throws when no resolved ref in lockfile", async () => {
  const { root, name } = makeFixture();
  try {
    writeFileSync(
      join(root, "skills.lock.json"),
      JSON.stringify({ version: 1, skills: {} }, null, 2) + "\n",
    );
    await assert.rejects(() => savePatch(root, name), /no resolved ref/);
  } finally {
    cleanup(root);
  }
});

test("applyPatch3Way: clean apply onto a tree matching pristine", async () => {
  const { root, pristine, skill, name } = makeFixture();
  try {
    writeFileSync(join(skill, "SKILL.md"), SKILL_BODY + "line four added\n");
    const { patchPath } = await savePatch(root, name);
    const staging = join(root, "staging");
    cpSync(pristine, staging, { recursive: true });
    const result = await applyPatch3Way(staging, patchPath);
    assert.equal(result.status, "clean");
    assert.deepEqual(result.conflictedPaths, []);
    const applied = readFileSync(join(staging, "SKILL.md"), "utf8");
    assert.ok(applied.includes("line four added"));
    assert.equal(existsSync(join(staging, ".git")), false, ".git should be cleaned up");
  } finally {
    cleanup(root);
  }
});

test("applyPatch3Way: conflict when staging diverges from pristine on the same line", async () => {
  const { root, skill, name } = makeFixture();
  try {
    const mineBody = SKILL_BODY.replace("line one", "line one (mine)");
    writeFileSync(join(skill, "SKILL.md"), mineBody);
    const { patchPath } = await savePatch(root, name);

    const staging = mkdtempSync(join(tmpdir(), "skm-staging-"));
    try {
      // Pre-stage the patch's pre-image blob (pristine) into the staging
      // repo's object store so `git apply --3way` can locate it. Phase 4's
      // update flow does the equivalent when populating staging from cache.
      writeFileSync(join(staging, "SKILL.md"), SKILL_BODY);
      const ident = [
        "-c", "user.email=skills-manager@local",
        "-c", "user.name=skills-manager",
      ];
      execFileSync("git", ["init", "-q"], { cwd: staging });
      execFileSync("git", [...ident, "add", "-A"], { cwd: staging });
      execFileSync("git", [...ident, "commit", "-q", "-m", "pristine"], { cwd: staging });

      const theirsBody = SKILL_BODY.replace("line one", "line one (theirs)");
      writeFileSync(join(staging, "SKILL.md"), theirsBody);

      const result = await applyPatch3Way(staging, patchPath);
      assert.equal(result.status, "conflict");
      assert.ok(result.conflictedPaths.length > 0);
      const merged = readFileSync(join(staging, "SKILL.md"), "utf8");
      assert.ok(merged.includes("<<<<<<<"), "expected conflict marker in file");
      assert.equal(existsSync(join(staging, ".git")), false, ".git should be cleaned up");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } finally {
    cleanup(root);
  }
});

test("applyPatch3Way: missing or empty patch is a no-op without creating .git", async () => {
  const target = mkdtempSync(join(tmpdir(), "skm-target-"));
  try {
    writeFileSync(join(target, "SKILL.md"), SKILL_BODY);
    const before = readFileSync(join(target, "SKILL.md"), "utf8");

    const missing = join(target, "no-such.patch");
    const r1 = await applyPatch3Way(target, missing);
    assert.equal(r1.status, "clean");
    assert.deepEqual(r1.conflictedPaths, []);
    assert.equal(existsSync(join(target, ".git")), false);

    const empty = join(target, "empty.patch");
    writeFileSync(empty, "");
    const r2 = await applyPatch3Way(target, empty);
    assert.equal(r2.status, "clean");
    assert.deepEqual(r2.conflictedPaths, []);
    assert.equal(existsSync(join(target, ".git")), false);

    const after = readFileSync(join(target, "SKILL.md"), "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
