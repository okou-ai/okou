import { object, string, enum as zEnum, type infer as zInfer } from "zod";

import { reasoningEffortSchema } from "./model-reasoning-effort";

/** Server-owned model choice captured when a chat input is enqueued. */
export const chatInputModelSelectionSchema = object({
  selectedModel: string().min(1),
  // Stored inputs can predate Ultrafast retirement; they run on Standard.
  codexServiceTier: zEnum(["fast", "ultrafast"])
    .nullable()
    .transform((tier) => {
      return tier === "fast" ? tier : null;
    }),
  reasoningEffort: reasoningEffortSchema.nullable(),
}).strict();

export type ChatInputModelSelection = zInfer<
  typeof chatInputModelSelectionSchema
>;
