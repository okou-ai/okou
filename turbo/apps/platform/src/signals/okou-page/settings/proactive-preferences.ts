import { proactiveLearningContract } from "@okouai/api-contracts/client/proactive-nightly";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/client/proactive-suggestions";
import { accept } from "../../../lib/accept.ts";
import { featureSwitches$ } from "../../external/feature-switch.ts";
import { createProactivePreference } from "./proactive-preference-resource.ts";

function createWorkflowPreference(
  contract:
    typeof proactiveLearningContract | typeof proactiveSuggestionsContract,
) {
  return createProactivePreference(
    featureSwitches$,
    async (client) => {
      return (await accept(client(contract).get(), [200])).body;
    },
    async (client, enabled, signal) => {
      const result = await accept(
        client(contract).update({
          body: { enabled },
          fetchOptions: { signal },
        }),
        [200],
      );
      return { saved: true, value: result.body };
    },
  );
}

export const proactiveLearningSignals = createWorkflowPreference(
  proactiveLearningContract,
);
export const proactiveSuggestionsSignals = createWorkflowPreference(
  proactiveSuggestionsContract,
);
