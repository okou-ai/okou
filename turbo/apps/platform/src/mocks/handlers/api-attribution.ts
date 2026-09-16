import { marketingAcquisitionContract } from "@okouai/api-contracts/contracts/marketing-acquisition";
import { impactOnboardingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { mockApi } from "../msw-contract.ts";

export const apiAttributionHandlers = [
  mockApi(marketingAcquisitionContract.config, ({ respond }) =>
    respond(200, { shadowEnabled: false }),
  ),
  mockApi(marketingAcquisitionContract.events, ({ respond }) =>
    respond(200, { recorded: false, shadowEnabled: false, consented: false }),
  ),
  mockApi(impactOnboardingContract.record, ({ respond }) => {
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
