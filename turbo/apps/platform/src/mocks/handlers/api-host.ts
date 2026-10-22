import { hostContract } from "@okouai/api-contracts/contracts/host";
import { mockApi } from "../msw-contract.ts";

/** Published Site fixtures are Public unless a case supplies a restricted grant. */
export const apiHostHandlers = [
  mockApi(hostContract.sitePreview, ({ query, respond }) => {
    return respond(200, { url: `https://${query.hostname}/`, expiresAt: null });
  }),
];
