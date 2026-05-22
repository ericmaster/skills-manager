import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readlinkSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  planAdoption,
  executeAdoptPlan,
} from "../dist/core/adoption.js";

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), "skm-adoption-"));
  for (const d of [
    "skills",
    "authored",
    "patches",
    ".cache",
    ".cache/pristine",
  ]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  // Empty manifest so executor's writeManifest-after-readManifest works.
  writeFileSync(
    join(root, "skills.json"),
    JSON.stringify({ version: 1, skills: {} }, null, 2) + "\n",
  );
  return root;
}

function loc(toolId, path, hash) {
  return { toolId, path, hash };
}

test("planAdoption — single location", () => {
  const root = mkRoot();
  try {
    const candidate = {
      name: "alpha",
      locations: [loc("claude-code", "/tmp/claude/alpha", "h1")],
      status: { kind: "single" },
    };
    const r = planAdoption({ candidate, flags: {}, rootPath: root });
    assert.equal(r.ok, true);
    assert.equal(r.plan.mode, "single");
    assert.equal(r.plan.primary.toolId, "claude-code");
    assert.equal(r.plan.primary.sourcePath, "/tmp/claude/alpha");
    assert.equal(r.plan.primary.targetDir, join(root, "authored", "alpha"));
    assert.equal(r.plan.removals.length, 0);
    assert.equal(r.plan.links.length, 1);
    assert.equal(r.plan.links[0].linkPath, "/tmp/claude/alpha");
    assert.deepEqual(r.plan.manifestEntries, [
      { name: "alpha", kind: "authored" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — duplicate-identical", () => {
  const root = mkRoot();
  try {
    const candidate = {
      name: "beta",
      locations: [
        loc("claude-code", "/tmp/claude/beta", "h"),
        loc("hermes", "/tmp/hermes/beta", "h"),
      ],
      status: { kind: "duplicate-identical" },
    };
    const r = planAdoption({ candidate, flags: {}, rootPath: root });
    assert.equal(r.ok, true);
    assert.equal(r.plan.mode, "duplicate-identical");
    assert.equal(r.plan.primary.toolId, "claude-code");
    assert.equal(r.plan.removals.length, 1);
    assert.equal(r.plan.removals[0].toolId, "hermes");
    assert.equal(r.plan.removals[0].backupTo, undefined);
    assert.equal(r.plan.links.length, 2);
    const targets = new Set(r.plan.links.map((l) => l.targetDir));
    assert.equal(targets.size, 1);
    assert.deepEqual(r.plan.manifestEntries, [
      { name: "beta", kind: "authored" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — conflict-takeover with --from", () => {
  const root = mkRoot();
  try {
    const candidate = {
      name: "gamma",
      locations: [
        loc("claude-code", "/tmp/claude/gamma", "h1"),
        loc("hermes", "/tmp/hermes/gamma", "h2"),
      ],
      status: { kind: "duplicate-conflict" },
    };
    const r = planAdoption({
      candidate,
      flags: { from: "claude-code" },
      rootPath: root,
    });
    assert.equal(r.ok, true);
    assert.equal(r.plan.mode, "conflict-takeover");
    assert.equal(r.plan.primary.toolId, "claude-code");
    assert.equal(r.plan.removals.length, 1);
    assert.equal(r.plan.removals[0].toolId, "hermes");
    assert.ok(r.plan.removals[0].backupTo);
    assert.ok(r.plan.removals[0].backupTo.includes(".cache/adopted-backup/"));
    assert.equal(r.plan.links.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — conflict-split with --from + --keep-other-as", () => {
  const root = mkRoot();
  try {
    const candidate = {
      name: "delta",
      locations: [
        loc("claude-code", "/tmp/claude/delta", "h1"),
        loc("hermes", "/tmp/hermes/delta", "h2"),
      ],
      status: { kind: "duplicate-conflict" },
    };
    const r = planAdoption({
      candidate,
      flags: { from: "claude-code", keepOtherAs: "delta-hermes" },
      rootPath: root,
    });
    assert.equal(r.ok, true);
    assert.equal(r.plan.mode, "conflict-split");
    assert.ok(r.plan.split);
    assert.equal(r.plan.split.targetName, "delta-hermes");
    assert.equal(r.plan.split.toolId, "hermes");
    assert.equal(r.plan.removals.length, 0);
    assert.equal(r.plan.manifestEntries.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — conflict without --from is an error", () => {
  const root = mkRoot();
  try {
    const candidate = {
      name: "epsilon",
      locations: [
        loc("claude-code", "/tmp/claude/epsilon", "h1"),
        loc("hermes", "/tmp/hermes/epsilon", "h2"),
      ],
      status: { kind: "duplicate-conflict" },
    };
    const r = planAdoption({ candidate, flags: {}, rootPath: root });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /claude-code/);
    assert.match(r.error.message, /hermes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — --keep-other-as without --from is an error", () => {
  const root = mkRoot();
  try {
    const candidate = {
      name: "zeta",
      locations: [
        loc("claude-code", "/tmp/claude/zeta", "h1"),
        loc("hermes", "/tmp/hermes/zeta", "h2"),
      ],
      status: { kind: "duplicate-conflict" },
    };
    const r = planAdoption({
      candidate,
      flags: { keepOtherAs: "zeta-other" },
      rootPath: root,
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /--from/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — --from value not in candidate locations", () => {
  const root = mkRoot();
  try {
    const candidate = {
      name: "eta",
      locations: [
        loc("claude-code", "/tmp/claude/eta", "h1"),
        loc("hermes", "/tmp/hermes/eta", "h2"),
      ],
      status: { kind: "duplicate-conflict" },
    };
    const r = planAdoption({
      candidate,
      flags: { from: "openclaw" },
      rootPath: root,
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /claude-code/);
    assert.match(r.error.message, /hermes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — target authored/<name>/ already exists", () => {
  const root = mkRoot();
  try {
    mkdirSync(join(root, "authored", "theta"));
    const candidate = {
      name: "theta",
      locations: [loc("claude-code", "/tmp/claude/theta", "h1")],
      status: { kind: "single" },
    };
    const r = planAdoption({ candidate, flags: {}, rootPath: root });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planAdoption — split target dir already exists", () => {
  const root = mkRoot();
  try {
    mkdirSync(join(root, "authored", "iota-other"));
    const candidate = {
      name: "iota",
      locations: [
        loc("claude-code", "/tmp/claude/iota", "h1"),
        loc("hermes", "/tmp/hermes/iota", "h2"),
      ],
      status: { kind: "duplicate-conflict" },
    };
    const r = planAdoption({
      candidate,
      flags: { from: "claude-code", keepOtherAs: "iota-other" },
      rootPath: root,
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFakeSkillTree(root, toolId, skillName, body) {
  const dir = join(root, toolId, "skills", skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: t\n---\n${body}\n`,
  );
  return dir;
}

test("executeAdoptPlan — dry run does not touch the filesystem", () => {
  const root = mkRoot();
  try {
    const fakeWorld = mkdtempSync(join(tmpdir(), "skm-fakeworld-"));
    try {
      const claudePath = makeFakeSkillTree(fakeWorld, "claude", "kappa", "x");
      const candidate = {
        name: "kappa",
        locations: [loc("claude-code", claudePath, "h1")],
        status: { kind: "single" },
      };
      const planned = planAdoption({ candidate, flags: {}, rootPath: root });
      assert.equal(planned.ok, true);

      const before = JSON.parse(
        readFileSync(join(root, "skills.json"), "utf8"),
      );

      const result = executeAdoptPlan(planned.plan, { dryRun: true });
      assert.ok(result.performed.length > 0);
      assert.equal(result.linkResults.length, 0);

      // Nothing on disk should have changed.
      assert.ok(existsSync(claudePath));
      assert.ok(lstatSync(claudePath).isDirectory());
      assert.ok(!lstatSync(claudePath).isSymbolicLink());
      assert.ok(!existsSync(join(root, "authored", "kappa")));
      const after = JSON.parse(
        readFileSync(join(root, "skills.json"), "utf8"),
      );
      assert.deepEqual(after, before);
    } finally {
      rmSync(fakeWorld, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeAdoptPlan — real run moves, links, writes manifest", () => {
  const root = mkRoot();
  try {
    const fakeWorld = mkdtempSync(join(tmpdir(), "skm-fakeworld-"));
    try {
      const claudePath = makeFakeSkillTree(fakeWorld, "claude", "lambda", "y");
      const candidate = {
        name: "lambda",
        locations: [loc("claude-code", claudePath, "h1")],
        status: { kind: "single" },
      };
      const planned = planAdoption({ candidate, flags: {}, rootPath: root });
      assert.equal(planned.ok, true);

      const result = executeAdoptPlan(planned.plan);
      assert.ok(result.linkResults.every((r) => r.status === "linked"));

      const targetDir = join(root, "authored", "lambda");
      assert.ok(existsSync(join(targetDir, "SKILL.md")));
      assert.ok(lstatSync(claudePath).isSymbolicLink());
      assert.equal(readlinkSync(claudePath), targetDir);

      const manifest = JSON.parse(
        readFileSync(join(root, "skills.json"), "utf8"),
      );
      assert.equal(manifest.skills.lambda.kind, "authored");
    } finally {
      rmSync(fakeWorld, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
