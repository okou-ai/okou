import { computed, type Computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { v5 as uuidv5 } from "uuid";
import { userFeatureSwitchContext } from "./feature-switches.service";

/** Gate new format behavior, not the safety of an already accepted input. */
export function presentationFormatEnabled({
  orgId,
  userId,
}: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<boolean>> {
  const context$ = userFeatureSwitchContext(orgId, userId);
  return computed(async (get) => {
    return isFeatureEnabled(
      FeatureSwitchKey.PresentationOutputFormat,
      await get(context$),
    );
  });
}

/** One accepted selection input per originating Run, independent of the choice. */
export function presentationFormatContinuationEventId(
  sourceRunId: string,
): string {
  return uuidv5("presentation-format-selection:v1", sourceRunId);
}

/** Publication rolled back because the source or current default changed. */
export class PresentationFormatPublicationConflict extends Error {
  constructor() {
    super("Presentation format selection is no longer available");
  }
}
