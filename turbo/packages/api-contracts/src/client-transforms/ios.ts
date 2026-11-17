import type { ClientResponseTransform } from "./types";
import {
  iosEmailChatRowsTransform,
  iosEmailChatCatchUpTransform,
} from "./email-chat-context";

import { iosProjectSortOrderTransform } from "./project-sort-order";

// Complete compatibility inventory for build-time checks. Runtime routes import
// their own transforms directly and never load this aggregate registry.
export const iosResponseTransforms: readonly ClientResponseTransform[] = [
  iosEmailChatRowsTransform,
  iosEmailChatCatchUpTransform,
  iosProjectSortOrderTransform,
];
