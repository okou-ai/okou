import { marketingOnboardingContract } from "@okouai/api-contracts/contracts/marketing-onboarding";
import { marketingCheckoutContract } from "@okouai/api-contracts/contracts/marketing-checkout";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { mockApi } from "../msw-contract.ts";

export const apiAttributionHandlers = [
  mockApi(marketingCheckoutContract.record, ({ respond }) => {
    return respond(204);
  }),
  mockApi(marketingOnboardingContract.record, ({ respond }) => {
    return respond(204);
  }),
  mockApi(
    acquisitionAttributionContract.resolveGoogleAdsAccount,
    ({ respond }) => {
      return respond(200, { googleAdsAccountId: null });
    },
  ),
  mockApi(acquisitionAttributionContract.googleAdsMilestones, ({ respond }) => {
    return respond(200, { milestones: [], googleAdsAccountId: null });
  }),
  mockApi(acquisitionAttributionContract.recordSignup, ({ respond }) => {
    return respond(200, { recorded: true, googleAdsAccountId: null });
  }),
];
