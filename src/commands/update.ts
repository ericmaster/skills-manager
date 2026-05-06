import { NotImplementedError } from "./_not-implemented.js";

export async function runUpdate(_args: {
  skills: string[];
  cont: boolean;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  throw new NotImplementedError("update");
}
