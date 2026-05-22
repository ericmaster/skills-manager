import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SsotStore } from "../dist/core/ssot.js";
import { ensureRootLayout } from "../dist/core/paths.js";

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "skm-ssot-"));
  ensureRootLayout(root);
  return root;
}

test("openAt with missing files returns empty defaults", () => {
  const root = freshRoot();
  try {
    const store = SsotStore.openAt(root);
    assert.equal(store.skill("anything"), undefined);
    assert.deepEqual(store.skillNames(), []);
    assert.deepEqual(store.tools(), []);
    assert.equal(store.lastDetectedAt(), undefined);
    assert.equal(store.dirty(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record + commit + reopen round-trips data", () => {
  const root = freshRoot();
  try {
    const a = SsotStore.openAt(root);
    a.recordAuthoredSkill("alpha");
    a.recordContribSkill("beta", { type: "local", path: "/tmp/beta" });
    a.pinResolvedRef("beta", "local@abc", "2026-01-01T00:00:00Z");
    a.recordToolDetection(
      [
        {
          id: "claude-code",
          detectedAt: "2026-01-01T00:00:00Z",
          linkable: true,
          linkTarget: "/home/u/.claude/skills",
          enabled: true,
        },
      ],
      "2026-01-01T00:00:00Z",
    );
    assert.equal(a.dirty(), true);
    a.commit();
    assert.equal(a.dirty(), false);

    const b = SsotStore.openAt(root);
    assert.equal(b.skill("alpha")?.kind, "authored");
    assert.equal(b.skill("beta")?.kind, "contrib");
    assert.equal(b.skill("beta")?.source?.path, "/tmp/beta");
    assert.equal(b.resolvedRef("beta"), "local@abc");
    assert.equal(b.tools()[0].id, "claude-code");
    assert.equal(b.lastDetectedAt(), "2026-01-01T00:00:00Z");
    assert.equal(b.dirty(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit writes only dirty files", async () => {
  const root = freshRoot();
  try {
    // Pre-write skills.json so we have a known mtime to compare.
    const skillsPath = join(root, "skills.json");
    writeFileSync(
      skillsPath,
      JSON.stringify({ version: 1, skills: { preexisting: { kind: "authored" } } }, null, 2) + "\n",
    );
    // Wait a beat so subsequent mtimes are observably different.
    await new Promise((r) => setTimeout(r, 10));
    const before = statSync(skillsPath).mtimeMs;

    const store = SsotStore.openAt(root);
    store.pinResolvedRef("preexisting", "local@xyz", "2026-01-01T00:00:00Z");
    store.commit();

    const after = statSync(skillsPath).mtimeMs;
    assert.equal(after, before, "skills.json mtime should be unchanged");
    assert.ok(
      existsSync(join(root, "skills.lock.json")),
      "skills.lock.json should be written",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit uses atomic write — no .tmp residue", () => {
  const root = freshRoot();
  try {
    const store = SsotStore.openAt(root);
    store.recordAuthoredSkill("alpha");
    store.pinResolvedRef("alpha", "ref", "2026-01-01T00:00:00Z");
    store.recordToolDetection([], "2026-01-01T00:00:00Z");
    store.commit();
    const stragglers = readdirSync(root).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(stragglers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty tracking — re-record same value is a no-op", () => {
  const root = freshRoot();
  try {
    const store = SsotStore.openAt(root);
    assert.equal(store.dirty(), false);
    store.recordAuthoredSkill("alpha");
    assert.equal(store.dirty(), true);
    store.commit();
    assert.equal(store.dirty(), false);
    store.recordAuthoredSkill("alpha");
    assert.equal(store.dirty(), false, "re-record same value should not flip dirty");

    store.recordContribSkill("beta", { type: "local", path: "/p" });
    assert.equal(store.dirty(), true);
    store.commit();
    assert.equal(store.dirty(), false);
    store.recordContribSkill("beta", { type: "local", path: "/p" });
    assert.equal(store.dirty(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version mismatch throws", () => {
  const root = freshRoot();
  try {
    writeFileSync(
      join(root, "skills.json"),
      JSON.stringify({ version: 2, skills: {} }) + "\n",
    );
    assert.throws(() => SsotStore.openAt(root), /Unsupported skills\.json version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only path is filesystem-clean", () => {
  const root = freshRoot();
  try {
    const store = SsotStore.openAt(root);
    store.skill("nope");
    store.skillNames();
    store.resolvedRef("nope");
    store.tools();
    store.lastDetectedAt();
    store.commit();
    // No SSOT JSON files should have been materialized.
    assert.equal(existsSync(join(root, "skills.json")), false);
    assert.equal(existsSync(join(root, "skills.lock.json")), false);
    assert.equal(existsSync(join(root, "state.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
