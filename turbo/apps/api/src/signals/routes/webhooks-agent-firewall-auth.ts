import { command } from "ccstate";
import { webhookFirewallAuthContract } from "@okouai/api-contracts/contracts/webhooks";

import { badRequestMessage } from "../../lib/error";
import type { SandboxAuth } from "../../types/auth";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { verifyFirewallToken, verifySandboxToken } from "../auth/tokens";
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

const invalidBodyResponse = badRequestMessage("Invalid firewall auth body");

function verifyFirewallRequestIdentity(token: string): {
  readonly auth: SandboxAuth;
  readonly kind: "host" | "legacy";
} | null {
  const host = verifyFirewallToken(token);
  if (host) {
    return { auth: host, kind: "host" };
  }
  const legacy = verifySandboxToken(token);
  return legacy ? { auth: legacy, kind: "legacy" } : null;
}

const firewallAuthRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const authHeader = get(authorization$);
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;
    if (!token) {
      return missingAuthorizationResponse;
    }
    const identity = verifyFirewallRequestIdentity(token);
    if (!identity) {
      return invalidTokenResponse;
    }
    const { auth } = identity;

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
    // Old hosts still use the Guest callback identity plus a private envelope.
    // Only the separate host scope may omit it. Retire legacy auth after the
    // deployed-owner and Run drain tracked in #48077.
    if (identity.kind === "legacy" && !bodyResult.data.encryptedSecrets) {
      return badRequestMessage("Legacy sandbox auth requires encryptedSecrets");
    }
    const billableCacheExpiry = await set(
      resolveBillableFirewallCacheExpiry$,
      { auth, firewallBillable: bodyResult.data.firewallBillable },
      signal,
    );
    const prepared = await set(
      prepareFirewallAuthResponse$,
      auth,
      bodyResult.data,
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
