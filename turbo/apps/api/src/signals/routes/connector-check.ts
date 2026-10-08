import {
  CONNECTOR_CHECK_AWS_CONTEXT_HEADER,
  CONNECTOR_CHECK_AWS_CONTEXT_INSUFFICIENT,
  connectorCheckContract,
} from "@okouai/api-contracts/contracts/connector-check";
import { command } from "ccstate";

import {
  organizationAuthContext$,
  type AuthErrorResponse,
} from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { resolveConnectorCheck$ } from "../services/connector-check.service";
import { notFound } from "../../lib/error";

function missingAgentRunReadCapability(): AuthErrorResponse {
  return {
    status: 403,
    body: {
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    },
  };
}

const checkInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(connectorCheckContract.check));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (
    auth.tokenType === "agent" &&
    !auth.capabilities.includes("agent-run:read")
  ) {
    return missingAgentRunReadCapability();
  }

  const result = await set(
    resolveConnectorCheck$,
    {
      request: bodyResult.data,
      orgId: auth.orgId,
      userId: auth.userId,
      stateSource:
        auth.tokenType === "agent"
          ? { kind: "run", runId: auth.runId }
          : { kind: "stored" },
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "not-found") {
    return notFound("Agent run not found");
  }
  if (result.awsContextIncomplete === true) {
    set(
      setResHeader$,
      CONNECTOR_CHECK_AWS_CONTEXT_HEADER,
      CONNECTOR_CHECK_AWS_CONTEXT_INSUFFICIENT,
    );
  }
  return { status: 200 as const, body: result.diagnostic };
});

export const connectorCheckRoutes: readonly RouteEntry[] = [
  {
    route: connectorCheckContract.check,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      checkInner$,
    ),
  },
];
