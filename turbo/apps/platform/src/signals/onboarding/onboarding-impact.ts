import { command, state } from "ccstate";
import { impactOnboardingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import {
  bestEffort,
  createDeferredPromise,
  type DeferredPromise,
} from "../utils.ts";

interface OnboardingIdentity {
  readonly userId: string;
  readonly orgId: string;
}

const entry$ = state<DeferredPromise<OnboardingIdentity> | null>(null);
const attempts = localStorageSignals("impact_onboarding_attempts");

export const enterImpactOnboarding$ = command(
  ({ get }, identity: OnboardingIdentity) => {
    const entry = get(entry$);
    if (entry && !entry.settled()) {
      entry.resolve(identity);
    }
  },
);

const sendOnboardingImpact$ = command(
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
    // This Marketing-owned API uses cookies only. The App's authenticated
    // client would add bearer/client headers and require an extra preflight.
    const client = initClient(impactOnboardingContract, {
      baseUrl: resolveApiBaseForTarget("www"),
    });
    await client.record({
      fetchOptions: {
        credentials: "include",
        keepalive: true,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    });
  },
);

/** The root owns the request so onboarding navigation never waits for it. */
export const runOnboardingImpact$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const entry = createDeferredPromise<OnboardingIdentity>(signal);
    set(entry$, entry);
    const identity = await entry.promise;
    signal.throwIfAborted();
    await bestEffort(set(sendOnboardingImpact$, identity, signal), signal);
  },
);
