import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { mockApi } from "../msw-contract.ts";

export const apiMarketingEventsHandlers = [
  mockApi(marketingEventsContract.record, ({ respond }) => {
    return respond(204);
  }),
];
