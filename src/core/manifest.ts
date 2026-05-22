export type SkillKind = "contrib" | "authored";

export interface ContribSource {
  type: "git" | "url" | "local";
  url?: string;
  path?: string;
  ref?: string;
  subpath?: string;
}

export interface SkillEntry {
  kind: SkillKind;
  source?: ContribSource;
  customized?: boolean;
}

export interface Manifest {
  version: 1;
  skills: Record<string, SkillEntry>;
}

export interface LockedSkill {
  resolvedRef?: string;
  resolvedAt?: string;
  checksum?: string;
}

export interface Lockfile {
  version: 1;
  skills: Record<string, LockedSkill>;
}
