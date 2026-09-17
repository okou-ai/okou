import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { mockApi } from "../msw-contract.ts";

// The server reward rollout defaults to off. Quest tests opt into real fixtures.
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
