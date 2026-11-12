import { z } from "zod";

export const inputIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const frameRefSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const fixtureInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().int().min(0).max(799), y: z.number().int().min(0).max(599) }).strict(),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal("key"), key: z.enum(["Backspace", "Tab", "Enter", "ArrowLeft", "ArrowRight"]) }).strict(),
  z.object({ type: z.literal("wheel"), deltaY: z.number().int().min(-600).max(600).refine((value) => value !== 0) }).strict(),
]);
export const fixtureFrameSchema = z.object({
  png: z.string().min(16).max(1_500_000).regex(/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 === 0),
  width: z.literal(800), height: z.literal(600), frameRef: frameRefSchema,
}).strict();
export type FixtureInput = z.infer<typeof fixtureInputSchema>;
export type FixtureFrame = z.infer<typeof fixtureFrameSchema>;
