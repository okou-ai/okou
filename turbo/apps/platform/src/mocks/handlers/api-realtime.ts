import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";

import { now } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

export const apiRealtimeHandlers = [
  mockApi(platformRealtimeTokenContract.create, ({ respond }) => {
    const issued = now();
    return respond(200, {
      token: "mock-token",
      clientId: "test-user-123",
      issued,
      expires: issued + 60 * 60 * 1000,
      capability: '{"*":["*"]}',
    });
  }),
];
