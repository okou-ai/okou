import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { clerkUser$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

// Fixed at the start of this rollout (2026-09-21 15:13:25 Asia/Shanghai).
// Account age, workspace changes and billing updates must not move the cohort.
const VIDEO_PICKER_ACCOUNT_CUTOFF = Date.parse("2026-09-21T07:13:25.000Z");

/** Picker visibility only; generation permissions remain independent. */
export const videoPickersVisible$ = computed(async (get) => {
  const user = await get(clerkUser$);
  if (!user) {
    return false;
  }
  const createdAt = user.createdAt?.getTime();
  if (createdAt !== undefined && createdAt < VIDEO_PICKER_ACCOUNT_CUTOFF) {
    return true;
  }
  return get(featureSwitch$)[FeatureSwitchKey.NewUserVideoPickers];
});
