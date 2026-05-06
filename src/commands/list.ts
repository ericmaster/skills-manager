import { NotImplementedError } from "./_not-implemented.js";

export async function runList(_args: {
  flags: Record<string, string | boolean>;
}): Promise<number> {
  throw new NotImplementedError("list");
}
