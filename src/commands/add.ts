import { NotImplementedError } from "./_not-implemented.js";

export async function runAdd(_args: {
  source: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  throw new NotImplementedError("add");
}
