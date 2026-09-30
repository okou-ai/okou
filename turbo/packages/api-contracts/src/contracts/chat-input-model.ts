import { z } from "zod";
import { reasoningEffortSchema } from "./model-reasoning-effort";

/** Server-owned model choice captured when a chat input is enqueued. */
export const chatInputModelSelectionSchema = z
  .object({
    selectedModel: z.string().min(1),
    codexServiceTier: z.enum(["fast", "ultrafast"]).nullable(),
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict();

export type ChatInputModelSelection = z.infer<
  typeof chatInputModelSelectionSchema
>;
