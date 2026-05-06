import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DetectedToolRecord {
  id: string;
  detectedAt: string;
  linkable: boolean;
  linkTarget?: string;
  enabled: boolean;
}

export interface State {
  version: 1;
  tools: DetectedToolRecord[];
  lastDetectedAt?: string;
}

const STATE_FILE = "state.json";

export function readState(rootPath: string): State {
  const p = join(rootPath, STATE_FILE);
  if (!existsSync(p)) return { version: 1, tools: [] };
  const data = JSON.parse(readFileSync(p, "utf8")) as State;
  if (data.version !== 1) {
    throw new Error(`Unsupported state.json version: ${data.version}`);
  }
  return data;
}

export function writeState(rootPath: string, state: State): void {
  writeFileSync(join(rootPath, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}
