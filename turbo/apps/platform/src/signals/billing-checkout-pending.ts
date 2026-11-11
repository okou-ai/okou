// The hosted Stripe Checkout this browser most recently sent a member to. It
// lets the app recognize a checkout that was left without paying, whether the
// member used Stripe's back link or simply closed the tab.
import { command, computed } from "ccstate";
import type { BillingSurveyCheckoutKind } from "@okouai/api-contracts/contracts/billing";
import { BILLING_SURVEY_CHECKOUT_KINDS } from "@okouai/api-contracts/validators/billing";
import { literal, number, object, string, enum as zEnum } from "zod";
import { now } from "../lib/time.ts";
import { authenticatedIdentity$ } from "./auth.ts";
import { localStorageSignals } from "./external/local-storage.ts";
import { jsonParseOr } from "./utils.ts";

const pendingCheckoutSchema = object({
  version: literal(1),
  sessionId: string().min(1),
  orgId: string(),
  userId: string(),
  kind: zEnum(BILLING_SURVEY_CHECKOUT_KINDS),
  startedAt: number(),
  returnedAt: number().nullable(),
});

type PendingBillingCheckout = ReturnType<typeof pendingCheckoutSchema.parse>;

const pendingStorage = localStorageSignals("billing-checkout-pending");

export const pendingBillingCheckout$ = computed(
  (get): PendingBillingCheckout | null => {
    const raw = get(pendingStorage.get$);
    if (!raw) {
      return null;
    }
    const parsed = pendingCheckoutSchema.safeParse(jsonParseOr(raw, null));
    return parsed.success ? parsed.data : null;
  },
);

/** Called right before the browser leaves for a hosted Stripe Checkout. */
export const markBillingCheckoutPending$ = command(
  async (
    { get, set },
    kind: BillingSurveyCheckoutKind,
    sessionId: string | undefined,
    signal: AbortSignal,
  ) => {
    if (!sessionId) {
      // A draining older API cannot identify the checkout for verification.
      set(pendingStorage.clear$);
      return;
    }
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const pending: PendingBillingCheckout = {
      version: 1,
      sessionId,
      orgId: identity.orgId,
      userId: identity.userId,
      kind,
      startedAt: now(),
      returnedAt: null,
    };
    set(pendingStorage.set$, JSON.stringify(pending));
  },
);

/** Stripe sent the member back through the checkout's cancel URL. */
export const markBillingCheckoutReturned$ = command(({ get, set }) => {
  const pending = get(pendingBillingCheckout$);
  if (!pending) {
    return;
  }
  set(pendingStorage.set$, JSON.stringify({ ...pending, returnedAt: now() }));
});

/** The checkout completed, or its survey was answered or dismissed. */
export const clearPendingBillingCheckout$ = command(({ set }) => {
  set(pendingStorage.clear$);
});
