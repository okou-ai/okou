import { command } from "ccstate";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { reloadAgents$ } from "../agent.ts";
import { discardApiBootstrapResponse } from "../api-client-base.ts";
import { invalidateOrgModelPolicies$ } from "../external/org-model-policies.ts";
import { reloadUserModelPreference$ } from "../external/user-model-preference.ts";
import { refreshOrg$ } from "../org.ts";
import { reloadOnboardingStatus$ } from "../okou-page/onboarding.ts";
import { resetOnboardingDraft$ } from "./onboarding-state.ts";
import {
  clearSourcesFirstDraft$,
  sourcesFirstDraft$,
} from "./onboarding-sources-first-state.ts";

export const completeOnboarding$ = command(
  async (
    { get, set },
    redeemCode: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const createClient = get(apiClient$);
    if (redeemCode) {
      const redeemClient = createClient(billingRedeemCodeContract);
      await accept(
        redeemClient.create({
          body: { code: redeemCode },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
    }

    const onboardingClient = createClient(onboardingCompleteContract);
    const timezone =
      new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    // The industry answer can be absent after a resumed run or a prompt
    // handoff, while the model choice still applies.
    const { industry, provider } = get(sourcesFirstDraft$);
    await accept(
      onboardingClient.complete({
        query: provider === null ? {} : { modelProvider: provider },
        body: industry === null ? { timezone } : { timezone, industry },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    // Completion provisions org defaults such as model policies. Snapshots
    // prefetched into the onboarding page's HTML predate them.
    for (const route of [
      orgContract.get,
      modelPoliciesMainContract.list,
      userModelPreferenceContract.get,
    ]) {
      discardApiBootstrapResponse(route.method, route.path);
    }
    set(refreshOrg$);
    set(invalidateOrgModelPolicies$);
    set(reloadUserModelPreference$);
    set(clearSourcesFirstDraft$);
    // Both a prior route and the Worker's HTML prefetch can retain an empty
    // list from before the status endpoint provisioned the default agent.
    set(reloadAgents$);
    set(reloadOnboardingStatus$);
    set(resetOnboardingDraft$);
  },
);
