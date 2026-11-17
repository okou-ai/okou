import { object, type infer as zInfer } from "zod";

import { composerDraftSchema } from "../validators/chat-threads";

/** A current-value precondition, not a monotonic revision or change history. */
export const conditionalComposerDraftSchema = object({
  expected: composerDraftSchema,
  draft: composerDraftSchema,
}).strict();

export type ConditionalComposerDraft = zInfer<
  typeof conditionalComposerDraftSchema
>;
