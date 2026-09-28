import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { mockApi } from "../msw-contract.ts";

// Rewards are unavailable by default so unrelated pages render no quest entry.
// Quest tests opt into real fixtures.
const unavailable = Object.freeze({
  error: {
    code: "FORBIDDEN",
    message: "Get started rewards are not available for this organization",
  },
});

export const apiGetStartedHandlers = [
  mockApi(getStartedContract.status, ({ respond }) => {
    return respond(403, unavailable);
  }),
  mockApi(getStartedContract.checkin, ({ respond }) => {
    return respond(403, unavailable);
  }),
  mockApi(getStartedContract.submitShare, ({ respond }) => {
    return respond(403, unavailable);
  }),
];
