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
export {
  readManifest,
  writeManifest,
  readLockfile,
  writeLockfile,
  type Manifest,
  type Lockfile,
} from "./core/manifest.js";
export { readState, writeState, type State } from "./core/state.js";
