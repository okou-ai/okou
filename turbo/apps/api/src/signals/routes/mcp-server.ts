import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import {
  chatEventsContract,
  chatSearchContract,
  chatThreadEventsContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import { command, computed } from "ccstate";
import { createAppWithRoutes } from "../../app-factory-core";
import {
  MCP_DEFAULT_SCOPES,
  MCP_REQUIRED_SCOPES,
  mcpServerConfig,
} from "../../lib/mcp-server-config";
import { VERCEL_PROTECTION_BYPASS_HEADER } from "../../lib/preview-automation-bypass";
import { request$ } from "../context/hono";
import { verifyClerkOAuthAccessToken } from "../external/clerk";
import { serveMcpRequest } from "../external/mcp-server";
import type { RouteEntry } from "../route-entry";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import { awaitWithSignal, settle } from "../utils";
import { agentsRoutes } from "./agents";
import { chatEventsRoutes } from "./chat-events";
import { chatThreadRoutes } from "./chat-threads";
import { runModelsRoutes } from "./run-models";
import { runsCancelRoutes } from "./runs-cancel";

// These are the production Web route entries, not an MCP business registry.
const webContracts: ReadonlySet<AppRoute> = Object.freeze(
  new Set([
    agentsMainContract.list,
    runModelsMainContract.list,
    chatThreadsContract.snapshot,
    chatThreadsContract.events,
    chatThreadsContract.indicators,
    chatThreadEventsContract.snapshot,
    chatThreadEventsContract.rows,
    chatSearchContract.search,
    chatThreadActivitySummaryContract.summarize,
    chatEventsContract.send,
    chatThreadRenameContract.rename,
    chatThreadModelSelectionContract.update,
    runsCancelContract.cancel,
  ]),
);
const webRoutes = [
  ...agentsRoutes,
  ...runModelsRoutes,
  ...chatThreadRoutes,
  ...chatEventsRoutes,
  ...runsCancelRoutes,
].filter((entry) => {
  return webContracts.has(entry.route);
});

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

const mcpRequest$ = command(async ({ get, set }, rootSignal: AbortSignal) => {
  const config = mcpServerConfig();
  if (!config) {
    return unavailable();
  }
  const original = get(request$).raw;
  const signal = AbortSignal.any([rootSignal, original.signal]);
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
        // In-process HTTP dispatch still runs the production Web validation,
        // scoped OAuth authentication, ownership checks and side effects.
        const app = createAppWithRoutes({
          routes: webRoutes,
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
