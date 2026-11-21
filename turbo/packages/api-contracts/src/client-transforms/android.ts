import { androidLegacyIndicators } from "./chat-indicators";
import { androidChatUltrafastTransforms } from "./chat-ultrafast";
import type { ClientResponseTransform } from "./types";

// Runtime routes mount their own transforms; this aggregate is the build-time inventory.
export const androidResponseTransforms: readonly ClientResponseTransform[] = [
  androidLegacyIndicators,
  ...Object.values(androidChatUltrafastTransforms),
];
