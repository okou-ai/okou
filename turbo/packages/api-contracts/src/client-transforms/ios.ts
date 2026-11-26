import { iosAntigravitySubscriptionTransforms } from "./antigravity-subscription";
import { iosVoiceDraftTransforms } from "./voice-draft";
import { iosChatUltrafastTransforms } from "./chat-ultrafast";
import type { ClientResponseTransform } from "./types";
import { iosChatContextTransforms } from "./native-chat-context";

// Complete compatibility inventory for build-time checks. Runtime routes import
// their own transforms directly and never load this aggregate registry.
export const iosResponseTransforms: readonly ClientResponseTransform[] = [
  ...Object.values(iosVoiceDraftTransforms),
  ...Object.values(iosChatUltrafastTransforms),
  ...Object.values(iosChatContextTransforms),
  ...Object.values(iosAntigravitySubscriptionTransforms),
];
