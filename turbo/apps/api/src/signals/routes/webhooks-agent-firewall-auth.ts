import { command } from "ccstate";
import { webhookFirewallAuthContract } from "@okouai/api-contracts/contracts/webhooks";

import { badRequestMessage } from "../../lib/error";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { isSandboxToken, verifySandboxToken } from "../auth/tokens";
import {
  resolveBillableFirewallCacheExpiry$,
  resolveFirewallAuth,
} from "../services/agent-webhook-firewall-auth.service";

const firewallAuthBody$ = bodyResultOf(webhookFirewallAuthContract.resolve);

const missingAuthorizationResponse = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Missing authorization",
      code: "UNAUTHORIZED",
    }),
  }),
});

const invalidTokenResponse = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid token",
      code: "UNAUTHORIZED",
    }),
  }),
});

const invalidBodyResponse = badRequestMessage(
  "encryptedSecrets and authHeaders are required",
);

const firewallAuthRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const authHeader = get(authorization$);
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;
    if (!token) {
      return missingAuthorizationResponse;
    }
    if (!isSandboxToken(token)) {
      return invalidTokenResponse;
    }

    const auth = verifySandboxToken(token);
    if (!auth) {
      return invalidTokenResponse;
    }

    const bodyResult = await get(firewallAuthBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      if (
        bodyResult.response.body.error.message ===
        "Invalid JSON in request body"
      ) {
        return badRequestMessage("Invalid JSON body");
      }
      return invalidBodyResponse;
    }

    const billableCacheExpiry = await set(
      resolveBillableFirewallCacheExpiry$,
      { auth, firewallBillable: bodyResult.data.firewallBillable },
      signal,
    );
    return await resolveFirewallAuth(
      set(writeDb$),
      auth,
      bodyResult.data,
      billableCacheExpiry,
    );
  },
);

export const webhooksAgentFirewallAuthRoutes: readonly RouteEntry[] = [
  {
    route: webhookFirewallAuthContract.resolve,
    handler: firewallAuthRoute$,
  },
];
