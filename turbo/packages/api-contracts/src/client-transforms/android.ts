import type { ClientResponseTransform } from "./types";
import { androidProjectSortOrderTransform } from "./project-sort-order";

// Runtime routes mount their own transforms; this aggregate is the build-time inventory.
export const androidResponseTransforms: readonly ClientResponseTransform[] = [
  androidProjectSortOrderTransform,
];
