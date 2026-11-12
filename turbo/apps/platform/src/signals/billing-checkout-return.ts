import { command, computed, state } from "ccstate";
import { authenticatedIdentity$ } from "./auth.ts";

// Only the cancel-return hint lives in memory. Stripe owns Checkout state.
const canceledBy$ = state<{
  readonly orgId: string;
  readonly userId: string;
} | null>(null);

export const billingCheckoutCanceled$ = computed(async (get) => {
  const canceledBy = get(canceledBy$);
  if (!canceledBy) {
    return false;
  }
  const identity = await get(authenticatedIdentity$);
  return (
    canceledBy.orgId === identity.orgId && canceledBy.userId === identity.userId
  );
});

export const setBillingCheckoutCanceled$ = command(
  async ({ get, set }, canceled: boolean, signal: AbortSignal) => {
    if (!canceled) {
      set(canceledBy$, null);
      return;
    }
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    set(canceledBy$, { orgId: identity.orgId, userId: identity.userId });
  },
);
