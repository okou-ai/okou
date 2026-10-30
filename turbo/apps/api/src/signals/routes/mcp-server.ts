import { mcpChatSearchContract } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { command, computed } from "ccstate";
import { createAppWithRoutes } from "../../app-factory-core";
import {
  MCP_DEFAULT_SCOPES,
  MCP_REQUIRED_SCOPES,
  mcpServerConfig,
} from "../../lib/mcp-server-config";
import { VERCEL_PROTECTION_BYPASS_HEADER } from "../../lib/preview-automation-bypass";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { verifyClerkOAuthAccessToken } from "../external/clerk";
import { serveMcpRequest } from "../external/mcp-server";
import type { RouteEntry } from "../route-entry";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import { mcpChatSearch } from "../services/mcp-chat-search.service";
import { awaitWithSignal, settle } from "../utils";
import { agentListRoutes } from "./agents-list";
import { chatEventsRoutes } from "./chat-events";
import { chatInputStatusRoutes } from "./chat-input-status";
import { chatThreadIndicatorRoutes } from "./chat-thread-indicators";
import { chatThreadMessageReadRoutes } from "./chat-thread-message-reads";
import { chatThreadSnapshotRoutes } from "./chat-thread-snapshots";
import { chatThreadActivitySummaryRoutes } from "./chat-threads-activity-summary";
import { chatThreadModelSelectionRoutes } from "./chat-threads-model-selection";
import { chatThreadRenameRoutes } from "./chat-threads-rename";
import { runModelsRoutes } from "./run-models";
import { runsCancelRoutes } from "./runs-cancel";

const searchInput$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(mcpChatSearchContract.search));
  return { userId: auth.userId, orgId: auth.orgId, ...query };
});
const search$ = mcpChatSearch(searchInput$);
const searchResponse$ = computed(async (get) => {
  const result = await get(search$);
  return { status: 200 as const, body: result };
});

// Search alone owns MCP presentation; other tools reuse production Web entries.
const toolRoutes: readonly RouteEntry[] = [
  ...agentListRoutes,
  ...runModelsRoutes,
  ...chatThreadIndicatorRoutes,
  ...chatThreadSnapshotRoutes,
  ...chatThreadMessageReadRoutes,
  ...chatThreadActivitySummaryRoutes,
  ...chatInputStatusRoutes,
  ...chatThreadModelSelectionRoutes,
  ...chatThreadRenameRoutes,
  ...chatEventsRoutes,
  ...runsCancelRoutes,
  {
    route: mcpChatSearchContract.search,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
        oauthScope: "okou:chat:read",
      },
      searchResponse$,
    ),
  },
];

function unavailable() {
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "MCP is temporarily unavailable",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function challenge(
  metadataUrl: string,
  error?: "invalid_token" | "insufficient_scope",
): Response {
  const status = error === "insufficient_scope" ? 403 : 401;
  const scopes =
    error === "insufficient_scope" ? MCP_REQUIRED_SCOPES : MCP_DEFAULT_SCOPES;
  const fields = [
    `resource_metadata="${metadataUrl}"`,
    `scope="${scopes.join(" ")}"`,
    ...(error ? [`error="${error}"`] : []),
  ];
  return Response.json(
    { error: error ?? "unauthorized" },
    {
      status,
      headers: {
        "WWW-Authenticate": `Bearer ${fields.join(", ")}`,
        "Cache-Control": "no-store",
      },
    },
  );
}

const metadata$ = computed(() => {
  const config = mcpServerConfig();
  if (!config) {
    return unavailable();
  }
  return Response.json(
    {
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [...MCP_DEFAULT_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "Okou MCP",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

const mcpRequest$ = command(async ({ get, set }, signal: AbortSignal) => {
  const config = mcpServerConfig();
  if (!config) {
    return unavailable();
  }
  const original = get(request$).raw;
  const authorization = original.headers.get("authorization");
  if (!authorization) {
    return challenge(config.metadataUrl);
  }
  const token = /^Bearer ([^\s,]+)$/iu.exec(authorization)?.[1];
  if (!token || token.length > 16 * 1024) {
    return challenge(config.metadataUrl, "invalid_token");
  }
  const verified = await settle(
    awaitWithSignal(verifyClerkOAuthAccessToken(token, config), signal),
    signal,
  );
  if (!verified.ok) {
    return unavailable();
  }
  if (!verified.value) {
    return challenge(config.metadataUrl, "invalid_token");
  }
  const principal = verified.value;
  if (
    !MCP_REQUIRED_SCOPES.every((scope) => {
      return principal.scopes.includes(scope);
    })
  ) {
    return challenge(config.metadataUrl, "insufficient_scope");
  }
  const membership = await settle(
    set(
      getMemberRoleAndUpdateCache$,
      principal.orgId,
      principal.userId,
      signal,
    ),
    signal,
  );
  if (!membership.ok) {
    return unavailable();
  }
  if (membership.value.kind !== "member") {
    return challenge(config.metadataUrl, "invalid_token");
  }
  return await serveMcpRequest(
    new Request(original, { signal }),
    {
      scopes: principal.scopes,
      requestWebApi: async (webRequest, operationSignal) => {
        const headers = new Headers(webRequest.headers);
        headers.set("Authorization", authorization);
        for (const name of [VERCEL_PROTECTION_BYPASS_HEADER, "cookie"]) {
          const value = original.headers.get(name);
          if (value) {
            headers.set(name, value);
          }
        }
        // In-process dispatch retains scoped OAuth authentication and native
        // validation/ownership. Only search composes MCP-specific Agent metadata.
        const app = createAppWithRoutes({
          routes: toolRoutes,
          signal: operationSignal,
        });
        return await app.fetch(new Request(webRequest, { headers }));
      },
    },
    signal,
  );
});

export const mcpServerRoutes: readonly RouteEntry[] = [
  { route: mcpServerContract.metadata, handler: metadata$ },
  { route: mcpServerContract.request, handler: mcpRequest$ },
  { route: mcpServerContract.get, handler: mcpRequest$ },
  { route: mcpServerContract.delete, handler: mcpRequest$ },
];
