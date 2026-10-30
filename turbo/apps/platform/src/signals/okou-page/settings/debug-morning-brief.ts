import { debugMorningBriefContract } from "@okouai/api-contracts/client/debug-morning-brief";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { command, computed } from "ccstate";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

export const debugMorningBriefEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.OkouDebug];
});
export const runDebugMorningBrief$ = command(
  async ({ get }, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(debugMorningBriefContract).run({
        body: { requestId: crypto.randomUUID() },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    return result.body;
  },
);
