import type { SuggestionPreset } from "@okouai/api-contracts/validators/chat-threads";
import type {
  PersistedAttachment,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";

export type ChatThreadDraftAttachments = PersistedAttachment[];
// Stored only in a private draft. Message projections skip unknown part kinds,
// including when an older API reads a draft written by a newer browser.
export type ChatThreadDraftUserMessage = {
  version: 1;
  parts: (
    | UserMessageInputDocument["parts"][number]
    | { type: "suggestion_preset"; preset: SuggestionPreset }
  )[];
};
