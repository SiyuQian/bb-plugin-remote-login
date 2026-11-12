import { inputIdSchema } from "./fixture-wire.ts";

export class InputReplayError extends Error {
  constructor() { super("Input operation refused."); this.name = "InputReplayError"; }
}

export class InputReplayGuard {
  #spent = new Set<string>();
  claim(inputId: unknown): void {
    const parsed = inputIdSchema.safeParse(inputId);
    if (!parsed.success || this.#spent.has(parsed.data) || this.#spent.size >= 4096) throw new InputReplayError();
    this.#spent.add(parsed.data);
  }
}
