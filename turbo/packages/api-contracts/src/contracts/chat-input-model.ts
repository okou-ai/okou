import { z } from "zod";
import { reasoningEffortSchema } from "./model-reasoning-effort";

/** Server-owned model choice captured when a chat input is enqueued. */
export const chatInputModelSelectionSchema = z
  .object({
    selectedModel: z.string().min(1),
    // Stored inputs can predate Ultrafast retirement; they run on Standard.
    codexServiceTier: z
      .enum(["fast", "ultrafast"])
      .nullable()
      .transform((tier) => {
        return tier === "fast" ? tier : null;
      }),
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict();

export type ChatInputModelSelection = z.infer<
  typeof chatInputModelSelectionSchema
>;
