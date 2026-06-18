import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  linkSiteToSkill,
  unlinkSiteFromSkill,
  linkSkillIntoTools,
  unlinkSkillFromTools,
} from "../dist/core/linker.js";

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `linker-${prefix}-`));
}

function makeSkillDir(workspace, name = "skill") {
  const dir = join(workspace, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return dir;
}

test("linkSiteToSkill — fresh path creates symlink", () => {
  const ws = tmp("fresh");
  try {
    const skillDir = makeSkillDir(ws);
    const linkPath = join(ws, "tool", "skills", "skill");
    const result = linkSiteToSkill(linkPath, skillDir, "claude-code");
    assert.equal(result.status, "linked");
    assert.equal(result.toolId, "claude-code");
    assert.ok(lstatSync(linkPath).isSymbolicLink());
    assert.equal(readlinkSync(linkPath), skillDir);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("linkSiteToSkill — already correct symlink is a no-op", () => {
  const ws = tmp("already");
  try {
    const skillDir = makeSkillDir(ws);
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "skill");
    symlinkSync(skillDir, linkPath, "dir");
    const beforeIno = lstatSync(linkPath).ino;

    const result = linkSiteToSkill(linkPath, skillDir, "claude-code");
    assert.equal(result.status, "already-linked");
    assert.equal(lstatSync(linkPath).ino, beforeIno);
    assert.equal(readlinkSync(linkPath), skillDir);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("linkSiteToSkill — replaces dangling symlink", () => {
  const ws = tmp("dangling");
  try {
    const skillDir = makeSkillDir(ws);
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "skill");
    symlinkSync(join(ws, "does-not-exist"), linkPath, "dir");
    assert.ok(lstatSync(linkPath).isSymbolicLink());

    const result = linkSiteToSkill(linkPath, skillDir, "tool");
    assert.equal(result.status, "linked");
    assert.equal(readlinkSync(linkPath), skillDir);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("linkSiteToSkill — replaces symlink pointing at wrong target without disturbing previous target", () => {
  const ws = tmp("wrong-target");
  try {
    const skillDir = makeSkillDir(ws, "wanted");
    const otherDir = makeSkillDir(ws, "other");
    writeFileSync(join(otherDir, "marker.txt"), "preserve me");
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "skill");
    symlinkSync(otherDir, linkPath, "dir");

    const result = linkSiteToSkill(linkPath, skillDir, "tool");
    assert.equal(result.status, "linked");
    assert.equal(readlinkSync(linkPath), skillDir);
    assert.ok(existsSync(join(otherDir, "marker.txt")));
    assert.equal(readFileSync(join(otherDir, "marker.txt"), "utf8"), "preserve me");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("linkSiteToSkill — refuses real directory at link path", () => {
  const ws = tmp("real-dir");
  try {
    const skillDir = makeSkillDir(ws);
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "skill");
    mkdirSync(linkPath);
    writeFileSync(join(linkPath, "preexisting.txt"), "untouched");

    const result = linkSiteToSkill(linkPath, skillDir, "tool");
    assert.equal(result.status, "skipped-non-symlink");
    assert.ok(result.message);
    assert.ok(lstatSync(linkPath).isDirectory());
    assert.ok(!lstatSync(linkPath).isSymbolicLink());
    assert.equal(readFileSync(join(linkPath, "preexisting.txt"), "utf8"), "untouched");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("unlinkSiteFromSkill — removes our own symlink", () => {
  const ws = tmp("unlink-ours");
  try {
    const skillDir = makeSkillDir(ws);
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "skill");
    symlinkSync(skillDir, linkPath, "dir");

    const result = unlinkSiteFromSkill(linkPath, skillDir, "tool");
    assert.equal(result.status, "unlinked");
    assert.ok(!existsSync(linkPath));
    let lstatErr;
    try {
      lstatSync(linkPath);
    } catch (e) {
      lstatErr = e;
    }
    assert.ok(lstatErr, "link path should be gone");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("unlinkSiteFromSkill — leaves foreign symlink alone", () => {
  const ws = tmp("unlink-foreign");
  try {
    const ourSkill = makeSkillDir(ws, "ours");
    const foreignTarget = makeSkillDir(ws, "foreign");
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "skill");
    symlinkSync(foreignTarget, linkPath, "dir");

    const result = unlinkSiteFromSkill(linkPath, ourSkill, "tool");
    assert.equal(result.status, "skipped-foreign-target");
    assert.ok(lstatSync(linkPath).isSymbolicLink());
    assert.equal(readlinkSync(linkPath), foreignTarget);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("unlinkSiteFromSkill — absent path returns absent", () => {
  const ws = tmp("unlink-absent");
  try {
    const skillDir = makeSkillDir(ws);
    const linkPath = join(ws, "tool", "skills", "nope");
    const result = unlinkSiteFromSkill(linkPath, skillDir, "tool");
    assert.equal(result.status, "absent");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("unlinkSiteFromSkill — refuses real directory", () => {
  const ws = tmp("unlink-real");
  try {
    const skillDir = makeSkillDir(ws);
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "skill");
    mkdirSync(linkPath);
    writeFileSync(join(linkPath, "keep.txt"), "still here");

    const result = unlinkSiteFromSkill(linkPath, skillDir, "tool");
    assert.equal(result.status, "skipped-non-symlink");
    assert.ok(lstatSync(linkPath).isDirectory());
    assert.equal(readFileSync(join(linkPath, "keep.txt"), "utf8"), "still here");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("fanout link/unlink across two fake tools", () => {
  const ws = tmp("fanout");
  try {
    const skillDir = makeSkillDir(ws);
    const toolA = { id: "a", absLinkTarget: join(ws, "tool-a", "skills") };
    const toolB = { id: "b", absLinkTarget: join(ws, "tool-b", "skills") };

    const linkResults = linkSkillIntoTools("skill", skillDir, [toolA, toolB]);
    assert.equal(linkResults.length, 2);
    assert.equal(linkResults[0].status, "linked");
    assert.equal(linkResults[0].toolId, "a");
    assert.equal(linkResults[1].status, "linked");
    assert.equal(linkResults[1].toolId, "b");
    for (const t of [toolA, toolB]) {
      const p = join(t.absLinkTarget, "skill");
      assert.ok(lstatSync(p).isSymbolicLink());
      assert.equal(readlinkSync(p), skillDir);
    }

    const unlinkResults = unlinkSkillFromTools("skill", skillDir, [toolA, toolB]);
    assert.equal(unlinkResults.length, 2);
    assert.equal(unlinkResults[0].status, "unlinked");
    assert.equal(unlinkResults[1].status, "unlinked");
    for (const t of [toolA, toolB]) {
      const p = join(t.absLinkTarget, "skill");
      assert.ok(!existsSync(p));
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Behavior: undefined absLinkTarget is silently skipped (no result entry);
// I/O errors (e.g. unwritable parent) surface as a `failed` LinkSiteResult.
// The other tool always gets a clean result regardless.
test("fanout never throws on per-tool failure", () => {
  const ws = tmp("fanout-fail");
  let unwritableParent;
  try {
    const skillDir = makeSkillDir(ws);

    // Tool A: valid.
    const toolA = { id: "a", absLinkTarget: join(ws, "tool-a", "skills") };

    // Tool B: undefined absLinkTarget → silent skip.
    const toolUndef = { id: "undef", absLinkTarget: undefined };

    // Tool C: parent dir made read-only so symlink creation fails.
    unwritableParent = join(ws, "tool-c", "skills");
    mkdirSync(unwritableParent, { recursive: true });
    chmodSync(unwritableParent, 0o500);
    const toolC = { id: "c", absLinkTarget: join(unwritableParent, "nested") };

    const results = linkSkillIntoTools("skill", skillDir, [toolA, toolUndef, toolC]);
    // Undefined target was filtered silently — no entry for it.
    assert.equal(results.length, 2);
    const a = results.find((r) => r.toolId === "a");
    const c = results.find((r) => r.toolId === "c");
    assert.equal(a.status, "linked");
    assert.equal(c.status, "failed");
    assert.ok(c.message);
  } finally {
    if (unwritableParent && existsSync(unwritableParent)) {
      chmodSync(unwritableParent, 0o700);
    }
    rmSync(ws, { recursive: true, force: true });
  }
});

test("linkSiteToSkill — rejects relative skillDir", () => {
  const ws = tmp("relative");
  try {
    const linkPath = join(ws, "tool", "skills", "skill");
    const result = linkSiteToSkill(linkPath, "relative/path", "tool");
    assert.equal(result.status, "failed");
    assert.ok(result.message);
    assert.ok(!existsSync(linkPath));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("linkSiteToSkill — file strategy links file instead of dir", () => {
  const ws = tmp("file-strategy");
  try {
    const skillDir = makeSkillDir(ws, "file-skill");
    const linkParent = join(ws, "tool", "skills");
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(linkParent, "file-skill.md");
    
    // Simulate linkStrategy="file" where targetPath is skillDir/SKILL.md
    const targetPath = join(skillDir, "SKILL.md");
    const result = linkSiteToSkill(linkPath, targetPath, "antigravity-ide", "file");
    
    assert.equal(result.status, "linked");
    assert.ok(lstatSync(linkPath).isSymbolicLink());
    assert.equal(readlinkSync(linkPath), targetPath);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
