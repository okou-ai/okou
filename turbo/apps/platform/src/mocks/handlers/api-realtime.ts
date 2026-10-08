import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";

import { now } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

export const apiRealtimeHandlers = [
  mockApi(platformRealtimeTokenContract.create, ({ respond }) => {
    return respond(200, {
      keyName: "mock-ably-key",
      clientId: "test-user-123",
      timestamp: now(),
      ttl: 60 * 60 * 1000,
      capability: '{"*":["*"]}',
      nonce: crypto.randomUUID(),
      mac: "mock-signature",
    });
  }),
];
