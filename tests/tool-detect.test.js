import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTools,
  listLinkableTools,
  TOOL_REGISTRY,
} from "../dist/core/tool-detect.js";

test("registry: GitHub Copilot CLI is a linkable native-SKILL.md tool", () => {
  const copilot = TOOL_REGISTRY.find((t) => t.id === "copilot");
  assert.ok(copilot, "copilot should be in TOOL_REGISTRY");
  assert.equal(copilot.label, "GitHub Copilot CLI");
  assert.deepEqual(copilot.probePaths, [".copilot"]);
  assert.equal(copilot.linkTarget, ".copilot/skills");
});

test("detect: copilot detected from ~/.copilot with correct link target", async () => {
  const home = mkdtempSync(join(tmpdir(), "skm-home-detect-"));
  try {
    mkdirSync(join(home, ".copilot"), { recursive: true });

    const detected = await detectTools(home);
    const copilot = detected.find((t) => t.id === "copilot");
    assert.ok(copilot, "copilot should be detected when ~/.copilot exists");
    assert.equal(copilot.absLinkTarget, join(home, ".copilot/skills"));

    const linkable = await listLinkableTools(home);
    assert.ok(
      linkable.some((t) => t.id === "copilot"),
      "copilot should be linkable",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detect: antigravity detected from ~/.gemini/antigravity and is linkable", async () => {
  const home = mkdtempSync(join(tmpdir(), "skm-home-detect-agy-"));
  try {
    mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });

    const detected = await detectTools(home);
    const agy = detected.find((t) => t.id === "antigravity-cli");
    assert.ok(agy, "antigravity-cli should be detected");
    assert.equal(agy.absLinkTarget, join(home, ".gemini/skills"));

    const linkable = await listLinkableTools(home);
    assert.ok(
      linkable.some((t) => t.id === "antigravity-cli"),
      "antigravity-cli should be linkable",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detect: empty home detects no tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "skm-home-empty-"));
  try {
    const detected = await detectTools(home);
    assert.equal(detected.length, 0, "no tools should be detected in empty home");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
