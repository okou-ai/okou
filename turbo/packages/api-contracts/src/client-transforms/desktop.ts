import type { ClientResponseTransform } from "./types";
import { computerUseClaimTransforms } from "./computer-use-claim";

// Complete compatibility inventory for build-time checks. Runtime routes import
// their own transforms directly and never load this aggregate registry.
export const desktopResponseTransforms: readonly ClientResponseTransform[] = [
  ...computerUseClaimTransforms,
];
