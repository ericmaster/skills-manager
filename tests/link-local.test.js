import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLinkLocal } from "../dist/commands/link-local.js";

function tmpRepo() {
  return mkdtempSync(join(tmpdir(), "link-local-"));
}

function agentSkill(repo, name) {
  const dir = join(repo, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
  return dir;
}

test("link-local bridges .agents/skills into .claude/skills as a relative symlink", async () => {
  const repo = tmpRepo();
  try {
    agentSkill(repo, "my-lesson");
    const rc = await runLinkLocal({ dir: repo, flags: {} });
    assert.equal(rc, 0);
    const link = join(repo, ".claude", "skills", "my-lesson");
    assert.ok(lstatSync(link).isSymbolicLink(), "bridge should be a symlink");
    assert.equal(readlinkSync(link), "../../.agents/skills/my-lesson", "should be relative + clone-portable");
    // resolves to the real SKILL.md
    assert.ok(existsSync(join(link, "SKILL.md")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("link-local is idempotent", async () => {
  const repo = tmpRepo();
  try {
    agentSkill(repo, "a");
    assert.equal(await runLinkLocal({ dir: repo, flags: {} }), 0);
    assert.equal(await runLinkLocal({ dir: repo, flags: {} }), 0); // second run: already-linked, no error
    assert.ok(lstatSync(join(repo, ".claude", "skills", "a")).isSymbolicLink());
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("link-local refuses to clobber a real (non-symlink) dir", async () => {
  const repo = tmpRepo();
  try {
    agentSkill(repo, "a");
    mkdirSync(join(repo, ".claude", "skills", "a"), { recursive: true }); // a real dir squats the link path
    const rc = await runLinkLocal({ dir: repo, flags: {} });
    assert.equal(rc, 1, "should report failure rather than destroy a real dir");
    assert.ok(!lstatSync(join(repo, ".claude", "skills", "a")).isSymbolicLink());
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("link-local is a no-op when .agents/skills is absent", async () => {
  const repo = tmpRepo();
  try {
    assert.equal(await runLinkLocal({ dir: repo, flags: {} }), 0);
    assert.ok(!existsSync(join(repo, ".claude")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("link-local --dry-run writes nothing", async () => {
  const repo = tmpRepo();
  try {
    agentSkill(repo, "a");
    const rc = await runLinkLocal({ dir: repo, flags: { "dry-run": true } });
    assert.equal(rc, 0);
    assert.ok(!existsSync(join(repo, ".claude", "skills", "a")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
