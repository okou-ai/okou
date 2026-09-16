import { command, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { marketingAcquisitionContract } from "@okouai/api-contracts/contracts/marketing-acquisition";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import {
  bestEffort,
  createDeferredPromise,
  setDaemon,
  type DeferredPromise,
} from "../utils.ts";

interface OnboardingIdentity {
  readonly userId: string;
  readonly orgId: string;
}

const entry$ = state<DeferredPromise<OnboardingIdentity> | null>(null);
const attempts = localStorageSignals("acquisition_onboarding_attempts");

export const enterAcquisitionOnboarding$ = command(
  ({ get }, identity: OnboardingIdentity) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.MarketingAcquisitionShadow]) {
      return;
    }
    const entry = get(entry$);
    if (entry && !entry.settled()) {
      entry.resolve(identity);
    }
  },
);

const sendOnboardingAcquisition$ = command(
  async ({ get, set }, identity: OnboardingIdentity, signal: AbortSignal) => {
    signal.throwIfAborted();
    const key = `${identity.userId}:${identity.orgId}`;
    const previous = (get(attempts.get$) ?? "").split("\n").filter(Boolean);
    if (previous.includes(key)) {
      return;
    }
    // Record the attempt before sending. Navigation, reloads and failures do
    // not retry this optional onboarding attribution request.
    set(attempts.set$, [...previous, key].join("\n"));
    // Use the same session-token provider as the canonical App API client.
    // Marketing cookies carry attribution, not the authenticated identity.
    const token = await get(apiClientRuntime$).getToken(signal);
    signal.throwIfAborted();
    if (
      !token ||
      !get(featureSwitch$)[FeatureSwitchKey.MarketingAcquisitionShadow]
    ) {
      return;
    }
    const client = initClient(marketingAcquisitionContract, {
      baseUrl: resolveApiBaseForTarget("www"),
    });
    await client.record({
      headers: { authorization: `Bearer ${token}` },
      fetchOptions: {
        credentials: "include",
        keepalive: true,
        signal,
      },
    });
  },
);

/** The root owns the request so onboarding navigation never waits for it. */
export const setupOnboardingAcquisition$ = command(
  ({ set }, signal: AbortSignal): void => {
    const entry = createDeferredPromise<OnboardingIdentity>(signal);
    set(entry$, entry);
    setDaemon(async (ownerSignal) => {
      const identity = await entry.promise;
      ownerSignal.throwIfAborted();
      const requestSignal = AbortSignal.any([
        ownerSignal,
        AbortSignal.timeout(10_000),
      ]);
      await bestEffort(
        set(sendOnboardingAcquisition$, identity, requestSignal),
        ownerSignal,
      );
    }, signal);
  },
);
