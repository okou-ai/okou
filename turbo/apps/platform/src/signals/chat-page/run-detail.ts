import { computed, type Computed } from "ccstate";
import { runsByIdContract } from "@okouai/api-contracts/contracts/run-routes";
import type { GetRunResponse } from "@okouai/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";

export interface RunDetailSignals {
  readonly runId: string;
  readonly detail$: Computed<Promise<GetRunResponse | undefined>>;
}

function createRunDetailSignals(runId: string): RunDetailSignals {
  return {
    runId,
    detail$: computed(async (get) => {
      if (!get(featureSwitch$)[FeatureSwitchKey.OkouDebug]) {
        return undefined;
      }
      const result = await accept(
        get(apiClient$)(runsByIdContract).getById({ params: { id: runId } }),
        [200, 404],
      );
      return result.status === 200 ? result.body : undefined;
    }),
  };
}

/** Keep each run's computed stable for the lifetime of its chat thread. */
export function createRunDetailSignalsRegistry() {
  return createCardSignalsRegistry((runId: string) => {
    return runId;
  }, createRunDetailSignals);
}
