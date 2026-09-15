import { computed, type Computed } from "ccstate";
import { runsByIdContract } from "@okouai/api-contracts/contracts/run-routes";
import type { GetRunResponse } from "@okouai/api-contracts/contracts/runs";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { personalModelProviderAccountRevision$ } from "../external/personal-model-providers.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";

export interface RunDetailSignals {
  readonly runId: string;
  readonly detail$: Computed<Promise<GetRunResponse | undefined>>;
  readonly recoveryAccount$: Computed<
    Promise<ModelProviderResponse | undefined>
  >;
}

function createRunDetailSignals(runId: string): RunDetailSignals {
  const detail$ = computed(async (get) => {
    const result = await accept(
      get(apiClient$)(runsByIdContract).getById({ params: { id: runId } }),
      [200, 404],
    );
    return result.status === 200 ? result.body : undefined;
  });
  return {
    runId,
    detail$,
    recoveryAccount$: computed(async (get) => {
      const source = (await get(detail$))?.source;
      if (source?.account.status !== "connected") {
        return undefined;
      }
      get(personalModelProviderAccountRevision$);
      const result = await accept(
        get(apiClient$)(personalModelProviderAccountsByIdContract).getById({
          params: { id: source.account.id },
          query: { runId },
        }),
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
