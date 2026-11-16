import type { ClientResponseTransform } from "./types";
import { androidProjectEventsTransform } from "./project-events";

// Runtime routes mount their own transforms; this aggregate is the build-time inventory.
export const androidResponseTransforms: readonly ClientResponseTransform[] = [
  androidProjectEventsTransform,
];
