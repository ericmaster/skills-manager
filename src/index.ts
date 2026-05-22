export { main } from "./cli.js";
export { runInit } from "./commands/init.js";
export {
  resolveRoot,
  getBundledSkillsDir,
  ensureRootLayout,
  type ResolvedRoot,
} from "./core/paths.js";
export {
  detectTools,
  listLinkableTools,
  type DetectedTool,
  TOOL_REGISTRY,
} from "./core/tool-detect.js";
export type {
  ContribSource,
  Lockfile,
  LockedSkill,
  Manifest,
  SkillEntry,
  SkillKind,
} from "./core/manifest.js";
export type { DetectedToolRecord, State } from "./core/state.js";
export { SsotStore } from "./core/ssot.js";
