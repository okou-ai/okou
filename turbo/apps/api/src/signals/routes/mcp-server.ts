import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";

import {
  MCP_DEFAULT_SCOPES,
  MCP_READ_SCOPE,
  MCP_REQUIRED_SCOPES,
  mcpServerConfig,
} from "../../lib/mcp-server-config";
import type { McpPrincipal } from "../../types/mcp";
import { request$ } from "../context/hono";
import { verifyClerkOAuthAccessToken } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { serveMcpRequest } from "../external/mcp-server";
import type { RouteEntry } from "../route-entry";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  getMcpChatThread,
  listMcpChatThreads,
} from "../services/mcp-chat-threads.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { getMcpChatMessages } from "../services/mcp-chat-messages.service";
import { getMcpChatStatus } from "../services/mcp-chat-status.service";
import { searchMcpChatMessages } from "../services/mcp-chat-search.service";
import { sendMcpChatMessage$ } from "../services/mcp-chat-send.service";
import {
  cancelMcpRun$,
  revokeQueuedMcpMessage$,
} from "../services/mcp-chat-cancellation.service";
import { awaitWithSignal, settle, onRejection } from "../utils";

const L = logger("McpServer");

async function admitMutation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  requestSignal: AbortSignal,
): Promise<T> {
  requestSignal.throwIfAborted();
  // After admission, waitUntil owns this finite operation and its dispatch
  // effects. Disconnecting stops only the HTTP response wait.
  const work = onRejection(operation(new AbortController().signal), (error) => {
    L.error("MCP mutation failed", { error });
  });
  waitUntil(work);
  return await awaitWithSignal(work, requestSignal);
}

function unavailable() {
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "MCP is temporarily unavailable",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function featureDenied() {
  return Response.json(
    {
      error: "access_denied",
      error_description: "MCP is not enabled for this account",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
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
  const features = await loadUserFeatureSwitchContext(
    get(db$),
    principal.orgId,
    principal.userId,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.McpServer, features)) {
    return featureDenied();
  }
  const historyRuntime = {
    db: set(writeDb$),
    bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
  };
  return serveMcpRequest(
    new Request(original, { signal }),
    {
      readScope: MCP_READ_SCOPE,
      scopes: principal.scopes,
      getStatus: (input, readSignal) => {
        return get(
          getMcpChatStatus(historyRuntime, principal, input, readSignal),
        );
      },
      sendMessage: async (input, operationSignal) => {
        return await admitMutation((signal) => {
          return set(
            sendMcpChatMessage$,
            { principal: { ...principal, orgRole }, input },
            signal,
          );
        }, operationSignal);
      },
      revokeQueuedMessage: async (input, operationSignal) => {
        return await admitMutation((signal) => {
          return set(revokeQueuedMcpMessage$, { principal, input }, signal);
        }, operationSignal);
      },
      cancelRun: async (input, operationSignal) => {
        return await admitMutation((signal) => {
          return set(cancelMcpRun$, { principal, input }, signal);
        }, operationSignal);
      },
      searchMessages: async (input, readSignal) => {
        return await get(
          searchMcpChatMessages(historyRuntime, principal, input, readSignal),
        );
      },
      getMessages: async (input, readSignal) => {
        return await get(
          getMcpChatMessages(historyRuntime, principal, input, readSignal),
        );
      },
      listThreads: async (input, readSignal) => {
        return await awaitWithSignal(
          listMcpChatThreads(set(writeDb$), principal, input),
          readSignal,
        );
      },
      getThread: async (input, readSignal) => {
        return await awaitWithSignal(
          getMcpChatThread(set(writeDb$), principal, input),
          readSignal,
        );
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
