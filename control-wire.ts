import { z } from "zod";

export const controlScopeSchema = z.object({
  threadId: z.string().min(1).max(200),
  attemptId: z.string().min(1).max(200),
  browserContextId: z.string().min(1).max(200),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const controlGrantSchema = z.object({
  capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(),
}).strict();

// Historical evidence only. It is not a grant, a current lease or an OCI login result.
export const controlCheckReceiptSchema = z.object({
  checkedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostId: z.string().min(1).max(200),
  scope: controlScopeSchema,
}).strict();
