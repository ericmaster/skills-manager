import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContribSource } from "./manifest.js";

export interface PresetSkill {
  kind: "contrib" | "authored";
  source?: ContribSource;
}

export interface Preset {
  skills: Record<string, PresetSkill>;
}

export interface PresetsManifest {
  version: 1;
  presets: Record<string, Preset>;
}

export const CURATED_PRESETS: Record<string, Preset> = {
  coding: {
    skills: {
      "git-commit": {
        kind: "contrib",
        source: {
          type: "git",
          url: "https://github.com/voodootikigod/git-commit-skill.git",
        },
      },
      "explain-code": {
        kind: "contrib",
        source: {
          type: "git",
          url: "https://github.com/voodootikigod/explain-code-skill.git",
        },
      },
    },
  },
  productivity: {
    skills: {
      journal: {
        kind: "contrib",
        source: {
          type: "git",
          url: "https://github.com/voodootikigod/journal-skill.git",
        },
      },
      todo: {
        kind: "contrib",
        source: {
          type: "git",
          url: "https://github.com/voodootikigod/todo-skill.git",
        },
      },
    },
  },
};

export class PresetsStore {
  readonly #filePath: string;
  #data: PresetsManifest;
  #dirty = false;

  private constructor(filePath: string, data: PresetsManifest) {
    this.#filePath = filePath;
    this.#data = data;
  }

  static openAt(rootPath: string): PresetsStore {
    const filePath = join(rootPath, "presets.json");
    let data: PresetsManifest;
    if (existsSync(filePath)) {
      try {
        data = JSON.parse(readFileSync(filePath, "utf8")) as PresetsManifest;
        if (data.version !== 1) {
          throw new Error(`Unsupported presets.json version: ${data.version}`);
        }
      } catch {
        data = { version: 1, presets: {} };
      }
    } else {
      data = { version: 1, presets: {} };
    }
    return new PresetsStore(filePath, data);
  }

  presets(): Record<string, Preset> {
    return { ...this.#data.presets };
  }

  preset(name: string): Preset | undefined {
    return this.#data.presets[name] ?? CURATED_PRESETS[name];
  }

  createPreset(name: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new Error(`Invalid preset name: "${name}"`);
    }
    if (this.#data.presets[name] || CURATED_PRESETS[name]) {
      throw new Error(`Preset "${name}" already exists`);
    }
    this.#data.presets[name] = { skills: {} };
    this.#dirty = true;
  }

  addSkillToPreset(presetName: string, skillName: string, skill: PresetSkill): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillName)) {
      throw new Error(`Invalid skill name: "${skillName}"`);
    }
    const p = this.#data.presets[presetName];
    if (!p) {
      throw new Error(`Preset "${presetName}" does not exist`);
    }
    p.skills[skillName] = { ...skill };
    this.#dirty = true;
  }

  removeSkillFromPreset(presetName: string, skillName: string): void {
    const p = this.#data.presets[presetName];
    if (!p) {
      throw new Error(`Preset "${presetName}" does not exist`);
    }
    if (!(skillName in p.skills)) {
      throw new Error(`Skill "${skillName}" not found in preset "${presetName}"`);
    }
    delete p.skills[skillName];
    this.#dirty = true;
  }

  commit(): void {
    if (!this.#dirty) return;
    const json = JSON.stringify(this.#data, null, 2) + "\n";
    const tmp = `${this.#filePath}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, this.#filePath);
    this.#dirty = false;
  }
}
