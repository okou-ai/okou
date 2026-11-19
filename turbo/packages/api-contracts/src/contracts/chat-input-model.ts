import { object, string, type infer as zInfer } from "zod";

import { codexServiceTierSchema } from "./chat-run-options";
import { reasoningEffortSchema } from "./model-reasoning-effort";

/** Server-owned model choice captured when a chat input is enqueued. */
export const chatInputModelSelectionSchema = object({
  selectedModel: string().min(1),
  codexServiceTier: codexServiceTierSchema.nullable(),
  reasoningEffort: reasoningEffortSchema.nullable(),
}).strict();

export type ChatInputModelSelection = zInfer<
  typeof chatInputModelSelectionSchema
>;
