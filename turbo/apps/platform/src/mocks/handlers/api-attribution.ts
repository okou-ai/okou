import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { mockApi } from "../msw-contract.ts";

export const apiAttributionHandlers = [
  mockApi(impactMarketingContract.handoff, ({ respond }) => {
    return respond(200, { handoff: null });
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
