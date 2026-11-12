import { randomUUID } from "node:crypto";

/** A new ID for a fabricated logical HTTP command, never a transport retry. */
export function inputRequest(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value, "event") && !Object.hasOwn(value, "inputId")) {
    return { ...value, inputId: randomUUID() };
  }
  return value;
}
