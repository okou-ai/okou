import { object, enum as zEnum, type infer as zInfer } from "zod";

import { reasoningEffortSchema } from "./model-reasoning-effort";
import { runModelIdSchema } from "./run-model-id";

export const codexServiceTierSchema = zEnum(["fast"]);

export const selectedModelRequestSchema = runModelIdSchema;

export const chatRunOptionsRequestSchema = object({
  /** Update the selected model's effort. */
  reasoningEffort: reasoningEffortSchema.optional(),
  codexServiceTier: codexServiceTierSchema.optional(),
});

export type CodexServiceTier = zInfer<typeof codexServiceTierSchema>;
export type ChatRunOptionsRequest = zInfer<typeof chatRunOptionsRequestSchema>;
