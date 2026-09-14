import { command, computed } from "ccstate";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";

import { conflict } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { startCustomConnectorAutomaticOAuthReauthorization$ } from "../services/custom-connector-oauth2.service";
import { runMcpConnectorList } from "../services/run-mcp-connectors.service";

const listRunMcpConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Run MCP connector route requires agent authentication");
  }
  const connectors = await get(
    runMcpConnectorList({
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
      customConnectorSourceIds: auth.customConnectorSourceIds,
      builtinMcpSourceIds: auth.builtinMcpSourceIds,
    }),
  );
  return { status: 200 as const, body: { connectors: [...connectors] } };
});

const reauthorizeMcpOAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      throw new Error(
        "Run MCP connector reauthorization route requires agent authentication",
      );
    }
    const body = await get(
      bodyResultOf(mcpConnectorsContract.reauthorizeOAuth),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const target = body.data.target;
    if (target.kind === "builtin") {
      // S2 supplies builtin OAuth reauthorization; none/manual never start OAuth.
      return conflict(
        "Builtin MCP OAuth reauthorization is unavailable for this run",
      );
    }
    const connectionId =
      auth.customConnectorSourceIds?.[target.customConnectorId];
    if (!connectionId) {
      return conflict("MCP OAuth reauthorization is unavailable for this run");
    }
    const result = await set(
      startCustomConnectorAutomaticOAuthReauthorization$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorId: target.customConnectorId,
        connectionId,
        scopes: body.data.scopes,
      },
      signal,
    );
    if ("status" in result) {
      return result;
    }
    return { status: 200 as const, body: result };
  },
);

export const mcpConnectorsRoutes: readonly RouteEntry[] = [
  {
    route: mcpConnectorsContract.list,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:read",
      },
      listRunMcpConnectorsInner$,
    ),
  },
  {
    route: mcpConnectorsContract.reauthorizeOAuth,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      reauthorizeMcpOAuthInner$,
    ),
  },
];
