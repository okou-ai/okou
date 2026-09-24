import { accountErasureStatusContract } from "@okouai/api-contracts/contracts/account-erasure-status";
import { mockApi } from "../msw-contract.ts";

/** Default test behavior keeps account deletion inactive. Suites exercising
 * deletion replace these handlers with owned status responses. */
export const apiAccountErasureStatusHandlers = [
  mockApi(accountErasureStatusContract.capability, ({ respond }) => {
    return respond(200, {
      token: "test-account-erasure-status-capability",
    });
  }),
  mockApi(accountErasureStatusContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Status unavailable" },
    });
  }),
];
