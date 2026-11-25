import { antigravityPersonalSubscriptionContract as contract } from "@okouai/api-contracts/client/antigravity-personal-subscription";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import {
  availableFeatureSwitchKeys$,
  featureSwitches$,
} from "../../external/feature-switch.ts";

const revision$ = state(0);
export const refreshAntigravitySubscription$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});

export const antigravitySubscription$ = computed(async (get) => {
  get(revision$);
  if (
    !(await get(availableFeatureSwitchKeys$)).includes(
      FeatureSwitchKey.GeminiAntigravity,
    )
  ) {
    return null;
  }
  const enabled = (await get(featureSwitches$))[
    FeatureSwitchKey.GeminiAntigravity
  ];
  const client = get(apiClient$)(contract, { apiBase: "api" });
  const result = await accept(client.get(), [200, 404]);
  if (
    result.status !== 200 ||
    (!enabled &&
      (result.body.status === "disconnected" ||
        result.body.status === "unassigned"))
  ) {
    return null;
  }
  return { enabled, profile: result.body };
});

export const changeAntigravitySubscription$ = command(
  async (
    { get, set },
    action: "connect" | { disconnect: string },
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(contract, { apiBase: "api" });
    if (action === "connect") {
      await accept(client.start({ body: {}, fetchOptions: { signal } }), [200]);
    } else {
      await accept(
        client.disconnect({
          params: { bindingId: action.disconnect },
          fetchOptions: { signal },
        }),
        [200],
      );
    }
    signal.throwIfAborted();
    set(refreshAntigravitySubscription$);
  },
);
