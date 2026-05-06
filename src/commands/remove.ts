import { NotImplementedError } from "./_not-implemented.js";

export async function runRemove(_args: {
  skill: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  throw new NotImplementedError("remove");
}
