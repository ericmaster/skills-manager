import { NotImplementedError } from "./_not-implemented.js";

export async function runNew(_args: {
  name: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  throw new NotImplementedError("new");
}
