import { command } from "ccstate";
import {
  billingCheckoutContract,
  type GoogleAdsPaidConversion,
} from "@okouai/api-contracts/contracts/billing";

import { IN_VITEST } from "../../env.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { waitLoopUntil } from "../utils.ts";
import {
  fireGoogleAdsConversion,
  GOOGLE_ADS_ADSMARCH_PAID_AFTER_ONBOARDING_SEND_TO,
  GOOGLE_ADS_ADSMARCH_PAID_IN_ONBOARDING_SEND_TO,
} from "./google-ads-conversion.ts";

const PAID_IN_ONBOARDING_CONVERSION_KEY =
  "googleAds.18407336975.paidInOnboardingConversion";
const PAID_AFTER_ONBOARDING_CONVERSION_KEY =
  "googleAds.18407336975.paidAfterOnboardingConversion";
const CHECKOUT_POLL_LIMIT = IN_VITEST ? 2 : 90;
const CHECKOUT_POLL_INTERVAL_MS = 1000;

const paidInOnboardingStorage = localStorageSignals(
  PAID_IN_ONBOARDING_CONVERSION_KEY,
);
const paidAfterOnboardingStorage = localStorageSignals(
  PAID_AFTER_ONBOARDING_CONVERSION_KEY,
);

type GoogleAdsPaidConversionKind =
  | "paid_in_onboarding"
  | "paid_after_onboarding";

export const fireGoogleAdsPaidConversion$ = command(
  (
    { get, set },
    kind: GoogleAdsPaidConversionKind,
    conversion: GoogleAdsPaidConversion,
  ): void => {
    const storage =
      kind === "paid_in_onboarding"
        ? paidInOnboardingStorage
        : paidAfterOnboardingStorage;
    const sendTo =
      kind === "paid_in_onboarding"
        ? GOOGLE_ADS_ADSMARCH_PAID_IN_ONBOARDING_SEND_TO
        : GOOGLE_ADS_ADSMARCH_PAID_AFTER_ONBOARDING_SEND_TO;
    const fired = fireGoogleAdsConversion({
      accountId: conversion.googleAdsAccountId,
      sendTo,
      dedupeValue: conversion.transactionId,
      value: kind === "paid_in_onboarding" ? conversion.valueUsd : 40,
      storedDedupeValue: get(storage.get$),
      transactionId: conversion.transactionId,
    });
    if (fired) {
      set(storage.set$, conversion.transactionId);
    }
  },
);

export const completeGoogleAdsPaidCheckout$ = command(
  async (
    { get, set },
    args: {
      readonly sessionId: string;
      readonly kind: GoogleAdsPaidConversionKind;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(billingCheckoutContract);
    let attempts = 0;
    await waitLoopUntil(
      async (loopSignal) => {
        attempts += 1;
        const result = await accept(
          client.complete({
            body: { sessionId: args.sessionId },
            fetchOptions: { signal: loopSignal },
          }),
          [200],
        );
        loopSignal.throwIfAborted();
        if (result.body.completed) {
          if (result.body.googleAdsConversion) {
            set(
              fireGoogleAdsPaidConversion$,
              args.kind,
              result.body.googleAdsConversion,
            );
          }
          return true;
        }
        if (attempts >= CHECKOUT_POLL_LIMIT) {
          throw new Error("Checkout completion timed out");
        }
        return false;
      },
      CHECKOUT_POLL_INTERVAL_MS,
      signal,
      { retryTransientErrors: false },
    );
  },
);
