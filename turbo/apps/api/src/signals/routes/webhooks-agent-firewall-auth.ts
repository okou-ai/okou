import { command } from "ccstate";
import { webhookFirewallAuthContract } from "@okouai/api-contracts/contracts/webhooks";

import { badRequestMessage } from "../../lib/error";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { isSandboxToken, verifySandboxToken } from "../auth/tokens";
import { admitCustomConnectorNetworkRequest$ } from "../services/custom-connector-network-auth.service";
import {
  resolveBillableFirewallCacheExpiry$,
  prepareFirewallAuthResponse$,
  admitPreparedFirewallAuthResponse$,
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

    if (
      bodyResult.data.networkAdmission &&
      !bodyResult.data.matchedFirewall?.customConnectorId
    ) {
      return badRequestMessage(
        "Network admission requires a matched custom connector",
      );
    }
    if (bodyResult.data.networkAdmission) {
      const matched = bodyResult.data.matchedFirewall;
      const request = bodyResult.data.networkRequest;
      if (
        !matched?.customConnectorId ||
        !request ||
        Object.keys(bodyResult.data.authHeaders).length !== 0 ||
        bodyResult.data.authBase !== undefined ||
        bodyResult.data.authQuery !== undefined ||
        bodyResult.data.authAwsSigv4 !== undefined
      ) {
        return badRequestMessage(
          "Network-only admission requires a target, intent and empty application auth",
        );
      }
      return await set(
        admitCustomConnectorNetworkRequest$,
        {
          auth,
          request,
          matched: { ...matched, customConnectorId: matched.customConnectorId },
        },
        signal,
      );
    }
    if (!bodyResult.data.encryptedSecrets) {
      return invalidBodyResponse;
    }
    const billableCacheExpiry = await set(
      resolveBillableFirewallCacheExpiry$,
      { auth, firewallBillable: bodyResult.data.firewallBillable },
      signal,
    );
    const prepared = await set(
      prepareFirewallAuthResponse$,
      auth,
      {
        ...bodyResult.data,
        encryptedSecrets: bodyResult.data.encryptedSecrets,
      },
      billableCacheExpiry,
      signal,
    );
    signal.throwIfAborted();
    return await set(
      admitPreparedFirewallAuthResponse$,
      {
        auth,
        response: prepared,
      },
      signal,
    );
  },
);

export const webhooksAgentFirewallAuthRoutes: readonly RouteEntry[] = [
  {
    route: webhookFirewallAuthContract.resolve,
    handler: firewallAuthRoute$,
  },
];
