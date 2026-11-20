import {
  legacyAgentDraftTransforms,
  legacyThreadDraftTransforms,
} from "./member-chat-drafts";
import { iosChatUltrafastTransforms } from "./chat-ultrafast";
import type { ClientResponseTransform } from "./types";
import {
  iosEmailChatRowsTransform,
  iosEmailChatCatchUpTransform,
} from "./email-chat-context";

// Complete compatibility inventory for build-time checks. Runtime routes import
// their own transforms directly and never load this aggregate registry.
export const iosResponseTransforms: readonly ClientResponseTransform[] = [
  ...Object.values(iosChatUltrafastTransforms),
  ...[...legacyAgentDraftTransforms, ...legacyThreadDraftTransforms].filter(
    (t) => t.client === "ios",
  ),
  iosEmailChatRowsTransform,
  iosEmailChatCatchUpTransform,
];
