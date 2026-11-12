import { randomUUID } from "node:crypto";

/** One in-memory observation for one privately owned browser. */
export class FrameObservation {
  #capture: object | null = null;
  #reference: string | null = null;

  begin(): object {
    this.invalidate();
    return this.#capture = Object.freeze({});
  }
  issue(capture: object): string | null {
    if (this.#capture === null || capture !== this.#capture) return null;
    this.#capture = null;
    return this.#reference = randomUUID();
  }
  consume(reference: string): boolean {
    if (this.#reference === null || reference !== this.#reference) return false;
    this.invalidate();
    return true;
  }
  invalidate(): void {
    this.#capture = null;
    this.#reference = null;
  }
}
