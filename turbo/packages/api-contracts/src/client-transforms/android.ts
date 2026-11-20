import {
  legacyAgentDraftTransforms,
  legacyThreadDraftTransforms,
} from "./member-chat-drafts";
import { androidChatUltrafastTransforms } from "./chat-ultrafast";
import type { ClientResponseTransform } from "./types";

// Runtime routes mount their own transforms; this aggregate is the build-time inventory.
export const androidResponseTransforms: readonly ClientResponseTransform[] = [
  ...Object.values(androidChatUltrafastTransforms),
  ...[...legacyAgentDraftTransforms, ...legacyThreadDraftTransforms].filter(
    (t) => {
      return t.client === "android";
    },
  ),
];
