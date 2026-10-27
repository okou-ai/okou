import { halloweenContract } from "@okouai/api-contracts/contracts/halloween";
import { mockApi } from "../msw-contract.ts";

// Campaign tests opt in; ordinary homepage tests retain the disabled switch.
export const apiHalloweenHandlers = [
  mockApi(halloweenContract.status, ({ respond }) => {
    return respond(200, { phase: "unavailable" });
  }),
];
