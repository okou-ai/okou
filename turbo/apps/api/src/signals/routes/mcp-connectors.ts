import { command, computed } from "ccstate";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";

import { conflict } from "../../lib/error";
import { env } from "../../lib/env";
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
      builtinConnectorSourceIds: auth.builtinConnectorSourceIds,
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
      const connectionId =
        auth.builtinConnectorSourceIds?.[target.connectorSlug];
      const descriptors = await get(
        runMcpConnectorList({
          orgId: auth.orgId,
          userId: auth.userId,
          runId: auth.runId,
          builtinConnectorSourceIds: auth.builtinConnectorSourceIds,
        }),
      );
      signal.throwIfAborted();
      if (
        !connectionId ||
        !descriptors.some((connector) => {
          return (
            connector.target.kind === "builtin" &&
            connector.target.connectorSlug === target.connectorSlug &&
            connector.connectionId === connectionId
          );
        })
      ) {
        return conflict(
          "MCP reauthorization is unavailable for this run's account",
        );
      }
      const url = new URL(
        `/connectors/${encodeURIComponent(target.connectorSlug)}/reconnect/${encodeURIComponent(connectionId)}`,
        env("APP_URL"),
      );
      return {
        status: 200 as const,
        body: {
          kind: "reconnect" as const,
          connectionId,
          authorizationUrl: url.toString(),
        },
      };
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
    return {
      status: 200 as const,
      body: { ...result, kind: "oauth" as const },
    };
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
