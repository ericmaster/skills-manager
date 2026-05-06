import { NotImplementedError } from "./_not-implemented.js";

export async function runSavePatch(_args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  throw new NotImplementedError("save-patch");
}
