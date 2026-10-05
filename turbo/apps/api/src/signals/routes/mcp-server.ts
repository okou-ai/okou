import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { command, computed } from "ccstate";
import { setAuthContext$ } from "../auth/auth-context";

import {
  MCP_DEFAULT_SCOPES,
  MCP_READ_SCOPE,
  MCP_REQUIRED_SCOPES,
  mcpServerConfig,
} from "../../lib/mcp-server-config";
import type { ApiOrgRole } from "../../types/auth";
import type { McpPrincipal } from "../../types/mcp";
import { request$ } from "../context/hono";
import { verifyClerkOAuthAccessToken } from "../external/clerk";
import { serveMcpRequest } from "../external/mcp-server";
import type { RouteEntry } from "../route-entry";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import { chatIndicators } from "../services/chat-thread.service";
import {
  cancelMcpRun$,
  revokeQueuedMcpMessage$,
} from "../services/mcp-chat-cancellation.service";
import {
  listMcpAgents$,
  listMcpModels$,
} from "../services/mcp-chat-discovery.service";
import { getMcpChatMessages$ } from "../services/mcp-chat-messages.service";
import { searchMcpChatMessages$ } from "../services/mcp-chat-search.service";
import { sendMcpChatMessage$ } from "../services/mcp-chat-send.service";
import { getMcpRunStatus$ } from "../services/mcp-run-status.service";
import { getMcpChatInput$ } from "../services/mcp-chat-input.service";
import { updateMcpChatThread$ } from "../services/mcp-chat-thread-update.service";
import {
  getMcpChatThread$,
  listMcpChatThreads$,
} from "../services/mcp-chat-threads.service";
import { awaitWithSignal, settle } from "../utils";

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
  const match = /^Bearer ([^\s,]+)$/iu.exec(authorization);
  const token = match?.[1];
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
  const principal: McpPrincipal = { tokenType: "oauth", ...verified.value };
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
  const orgRole = membership.value.role;
  set(setAuthContext$, { ...principal, orgRole });
  return set(
    serveAuthorizedMcp$,
    {
      principal: { ...principal, orgRole },
      request: new Request(original, { signal }),
    },
    signal,
  );
});

const serveAuthorizedMcp$ = command(
  (
    { get, set },
    {
      principal,
      request,
    }: {
      readonly principal: McpPrincipal & { readonly orgRole: ApiOrgRole };
      readonly request: Request;
    },
    signal: AbortSignal,
  ) => {
    return serveMcpRequest(
      request,
      {
        readScope: MCP_READ_SCOPE,
        scopes: principal.scopes,
        listAgents: (input, readSignal) => {
          return set(listMcpAgents$, principal, input, readSignal);
        },
        listModels: (readSignal) => {
          return set(listMcpModels$, principal, readSignal);
        },
        updateThread: (input, operationSignal) => {
          return set(
            updateMcpChatThread$,
            { principal, input },
            operationSignal,
          );
        },
        getRunStatus: (input, readSignal) => {
          return set(getMcpRunStatus$, principal, input, readSignal);
        },
        getInput: (input, readSignal) => {
          return set(getMcpChatInput$, principal, input, readSignal);
        },
        sendMessage: (input, operationSignal) => {
          return set(
            sendMcpChatMessage$,
            { principal, input },
            operationSignal,
          );
        },
        revokeQueuedMessage: (input, operationSignal) => {
          return set(
            revokeQueuedMcpMessage$,
            { principal, input },
            operationSignal,
          );
        },
        cancelRun: (input, operationSignal) => {
          return set(cancelMcpRun$, { principal, input }, operationSignal);
        },
        searchMessages: async (input, readSignal) => {
          return await set(
            searchMcpChatMessages$,
            principal,
            input,
            readSignal,
          );
        },
        getMessages: async (input, readSignal) => {
          return await set(getMcpChatMessages$, principal, input, readSignal);
        },
        getIndicators: async (readSignal) => {
          const data = await awaitWithSignal(
            get(
              chatIndicators({
                userId: principal.userId,
                orgId: principal.orgId,
              }),
            ),
            readSignal,
          );
          return { kind: "ok" as const, data };
        },
        listThreads: async (input, readSignal) => {
          return await awaitWithSignal(
            set(listMcpChatThreads$, principal, input, readSignal),
            readSignal,
          );
        },
        getThread: async (input, readSignal) => {
          return await awaitWithSignal(
            set(getMcpChatThread$, principal, input, readSignal),
            readSignal,
          );
        },
      },
      signal,
    );
  },
);

export const mcpServerRoutes: readonly RouteEntry[] = [
  { route: mcpServerContract.metadata, handler: metadata$ },
  { route: mcpServerContract.request, handler: mcpRequest$ },
  { route: mcpServerContract.get, handler: mcpRequest$ },
  { route: mcpServerContract.delete, handler: mcpRequest$ },
];
