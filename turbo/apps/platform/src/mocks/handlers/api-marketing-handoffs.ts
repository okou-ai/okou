import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { mockApi } from "../msw-contract.ts";

/** App bootstrap enrolls a Marketing handoff session while the switch is on. */
export const apiMarketingHandoffsHandlers = [
  mockApi(marketingHandoffsContract.session, ({ respond }) => {
    return respond(200, { ready: true as const });
  }),
];
