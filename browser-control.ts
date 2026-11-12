import { z } from "zod";

/** Presentation choice only. Neither mode grants control or proves client location. */
export const browserControlModeSchema = z.enum(["remote", "host"]);
export type BrowserControlMode = z.infer<typeof browserControlModeSchema>;
