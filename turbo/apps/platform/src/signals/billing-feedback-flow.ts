import { command, computed, state } from "ccstate";
import type { BillingFeedbackKind } from "@okouai/core/billing-feedback";
import { captureBillingFunnelEvent } from "../lib/posthog.ts";
import { authenticatedSessionKey$ } from "./auth.ts";

interface FeedbackRequest {
  readonly id: string;
  readonly kind: BillingFeedbackKind;
  readonly sessionKey: string | null;
}

const request$ = state<FeedbackRequest | null>(null);
const upgrade$ = state<{
  readonly id: string;
  readonly sessionKey: string | null;
  readonly checkoutStarted: boolean;
} | null>(null);

export const pendingBillingFeedback$ = computed((get) => {
  const request = get(request$);
  return request?.sessionKey === get(authenticatedSessionKey$) ? request : null;
});

export const requestBillingFeedback$ = command(
  ({ get, set }, kind: BillingFeedbackKind) => {
    set(request$, {
      id: crypto.randomUUID(),
      kind,
      sessionKey: get(authenticatedSessionKey$),
    });
  },
);

/** Logical dialog actions own the attempt, independently of React ref replays. */
export const beginBillingUpgrade$ = command(({ get, set }) => {
  if (get(upgrade$)) {
    return;
  }
  const id = crypto.randomUUID();
  set(upgrade$, {
    id,
    sessionKey: get(authenticatedSessionKey$),
    checkoutStarted: false,
  });
  captureBillingFunnelEvent("billing_upgrade_dialog_opened", {
    billing_attempt_id: id,
  });
});

export const finishBillingUpgrade$ = command(
  ({ get, set }, dismissed = true) => {
    const attempt = get(upgrade$);
    if (!attempt) {
      return;
    }
    set(upgrade$, null);
    const sameIdentity = attempt.sessionKey === get(authenticatedSessionKey$);
    captureBillingFunnelEvent("billing_upgrade_dialog_closed", {
      billing_attempt_id: attempt.id,
      checkout_started: attempt.checkoutStarted,
      close_reason: dismissed ? "dismissed" : "navigation",
    });
    if (dismissed && !attempt.checkoutStarted && sameIdentity) {
      set(request$, {
        id: attempt.id,
        kind: "upgrade_dismissed",
        sessionKey: attempt.sessionKey,
      });
    }
  },
);

export const markBillingCheckoutStarted$ = command(
  ({ get, set }, kind: "plan" | "usage_pack" | "credits") => {
    const attempt = get(upgrade$);
    if (attempt) {
      set(upgrade$, { ...attempt, checkoutStarted: true });
    }
    captureBillingFunnelEvent("billing_checkout_started", {
      billing_attempt_id: attempt?.id,
      checkout_kind: kind,
    });
  },
);

export const markBillingPurchaseCompleted$ = command(
  ({ get, set }, checkoutKind?: "plan" | "usage_pack" | "credits") => {
    const attempt = get(upgrade$);
    if (attempt) {
      set(upgrade$, { ...attempt, checkoutStarted: true });
    }
    set(request$, null);
    if (checkoutKind) {
      captureBillingFunnelEvent("billing_purchase_completed", {
        checkout_kind: checkoutKind,
        billing_attempt_id: attempt?.id,
      });
    }
  },
);
