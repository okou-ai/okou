import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import {
  mcpGetChatThreadOutputSchema,
  mcpGetChatIndicatorsOutputSchema,
  mcpListChatThreadsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-messages";
import type { McpChatInputRef } from "@okouai/api-contracts/contracts/mcp-chat-references";
import { mcpSearchChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { mcpGetChatStatusOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-status";
import {
  mcpListAgentsOutputSchema,
  mcpListModelsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import { mcpCreateChatThreadOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-creation";
import { mcpUpdateChatThreadOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-thread-update";
import {
  mcpSendChatMessageOutputSchema,
  mcpRevokeQueuedMessageOutputSchema,
  mcpCancelRunOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { mcpToolErrorContentSchema } from "@okouai/api-contracts/contracts/mcp-tool-errors";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";
import { z } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { mcpServerRoutes } from "../../mcp-server";

export const resource = "https://api.mcp.example.test/mcp";

export const issuer = "https://clerk.mcp.example.test";

export const readScope = "okou:chat:read";

export const orgScope = "user:org:read";

export const requiredScopes = `${orgScope} ${readScope}`;

export const defaultScopes =
  "openid email profile user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel offline_access";

export const modernVersion = "2026-07-28";

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function measureCompactSuccess(result: unknown): {
  readonly baselineBytes: number;
  readonly compactBytes: number;
} {
  const parsed = z
    .looseObject({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
      structuredContent: z.unknown(),
    })
    .parse(result);
  expect(parsed.isError).not.toBeTruthy();
  expect(parsed.content).toHaveLength(1);
  const summary = parsed.content[0]?.text;
  if (!summary) {
    throw new Error("Expected a nonempty MCP tool summary");
  }
  expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(512);
  expect(summary).not.toBe(JSON.stringify(parsed.structuredContent));
  const baselineResult = {
    ...parsed,
    content: [
      { type: "text" as const, text: JSON.stringify(parsed.structuredContent) },
    ],
  };
  const measurement = {
    baselineBytes: jsonBytes(baselineResult),
    compactBytes: jsonBytes(parsed),
  };
  expect(measurement.compactBytes).toBeLessThanOrEqual(
    measurement.baselineBytes,
  );
  return measurement;
}

export function expectSubstantialCompactSuccess(result: unknown): void {
  const measurement = measureCompactSuccess(result);
  expect(measurement.compactBytes).toBeLessThanOrEqual(
    Math.floor(measurement.baselineBytes * 0.6),
  );
}

export function rpc(body: unknown) {
  if (typeof body !== "string") {
    return body;
  }
  const frame = body.split("\n").find((line) => {
    return line.startsWith("data: ");
  });
  if (!frame) {
    throw new Error("Expected a complete MCP SSE response");
  }
  return JSON.parse(frame.slice(6)) as unknown;
}

export function requestBody(
  method: string,
  modern = true,
  params: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      ...(modern
        ? {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": modernVersion,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "okou-test",
                version: "1",
              },
            },
          }
        : {}),
    },
  };
}

export function protocolHeaders(
  token: string,
  method: string,
  modern = true,
  toolName = "list_chat_threads",
) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": modern ? modernVersion : "2025-11-25",
    ...(modern ? { "MCP-Method": method } : {}),
    ...(modern && method === "tools/call" ? { "MCP-Name": toolName } : {}),
  };
}

export function expectFixedMcpTimestamp(value: string): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
}

export function fixedMcpTimestamp(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value))
    .toISOString()
    .replace(/Z$/u, "000Z");
}

export function createMcpServerTestApi(context: TestContext) {
  function client() {
    return setupApp({ context, routes: mcpServerRoutes })(mcpServerContract);
  }

  function fixture() {
    mockEnv("MCP_RESOURCE_URL", resource);
    mockEnv("MCP_OAUTH_ISSUER", issuer);
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = randomUUID();
    server.use(
      http.get("https://api.clerk.com/v1/jwks", () => {
        return HttpResponse.json({
          keys: [
            {
              ...keys.publicKey.export({ format: "jwk" }),
              kid,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      }),
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        { id: randomUUID(), role: "org:member", organization: { id: orgId } },
      ],
      totalCount: 1,
    });
    function token(overrides: Record<string, unknown> = {}, typ = "at+jwt") {
      const seconds = Math.floor(now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", kid, typ }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: resource,
          sub: userId,
          org_id: orgId,
          client_id: "mcp_test_client",
          scope: requiredScopes,
          iat: seconds,
          nbf: seconds - 1,
          exp: seconds + 3600,
          ...overrides,
        }),
      ).toString("base64url");
      const input = `${header}.${payload}`;
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
    }
    return { token, userId, orgId };
  }

  async function callTool(
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(token, "tools/call", true, name),
        body: requestBody("tools/call", true, { name, arguments: args }),
      }),
      [200],
    );
    const result = z
      .object({
        result: z.object({
          isError: z.boolean().optional(),
          content: z.array(
            z.object({ type: z.literal("text"), text: z.string() }),
          ),
          structuredContent: z.unknown().optional(),
        }),
      })
      .parse(rpc(response.body)).result;
    if (!result.isError && result.structuredContent !== undefined) {
      measureCompactSuccess(result);
    }
    return result;
  }

  function structuredToolError(result: Awaited<ReturnType<typeof callTool>>) {
    expect(result.isError).toBeTruthy();
    return mcpToolErrorContentSchema.parse(result.structuredContent).error;
  }

  async function getIndicators(token: string) {
    const result = await callTool(token, "get_chat_indicators");
    expect(result.isError).not.toBeTruthy();
    return mcpGetChatIndicatorsOutputSchema.parse(result.structuredContent);
  }

  async function listThreads(
    token: string,
    args: Record<string, unknown> = {},
  ) {
    const result = await callTool(token, "list_chat_threads", args);
    expect(result.isError).not.toBeTruthy();
    return mcpListChatThreadsOutputSchema.parse(result.structuredContent);
  }

  async function getThread(token: string, threadId: string) {
    const result = await callTool(token, "get_chat_thread", { threadId });
    expect(result.isError).not.toBeTruthy();
    return mcpGetChatThreadOutputSchema.parse(result.structuredContent);
  }

  async function getMessages(token: string, args: Record<string, unknown>) {
    const result = await callTool(token, "get_chat_messages", args);
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpGetChatMessagesOutputSchema.parse(result.structuredContent);
  }

  async function searchMessages(token: string, args: Record<string, unknown>) {
    const result = await callTool(token, "search_chat_messages", args);
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpSearchChatMessagesOutputSchema.parse(result.structuredContent);
  }

  async function getStatus(token: string, args: Record<string, unknown>) {
    const result = await callTool(token, "get_chat_status", args);
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpGetChatStatusOutputSchema.parse(result.structuredContent);
  }

  async function listAgents(token: string, args: Record<string, unknown> = {}) {
    const result = await callTool(token, "list_agents", args);
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpListAgentsOutputSchema.parse(result.structuredContent);
  }

  async function listModels(token: string) {
    const result = await callTool(token, "list_models");
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpListModelsOutputSchema.parse(result.structuredContent);
  }

  async function createThread(token: string, args: Record<string, unknown>) {
    const result = await callTool(token, "create_chat_thread", args);
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpCreateChatThreadOutputSchema.parse(result.structuredContent);
  }

  async function updateThread(token: string, args: Record<string, unknown>) {
    const result = await callTool(token, "update_chat_thread", args);
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpUpdateChatThreadOutputSchema.parse(result.structuredContent);
  }

  async function sendMessage(token: string, args: Record<string, unknown>) {
    const result = await callTool(token, "send_chat_message", args);
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpSendChatMessageOutputSchema.parse(result.structuredContent);
  }

  async function revokeMessage(token: string, inputRef: McpChatInputRef) {
    const result = await callTool(token, "revoke_queued_message", {
      inputRef,
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpRevokeQueuedMessageOutputSchema.parse(result.structuredContent);
  }

  async function cancelRun(token: string, runId: string) {
    const result = await callTool(token, "cancel_run", { runId });
    expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
    return mcpCancelRunOutputSchema.parse(result.structuredContent);
  }

  /**
   * A send only enqueues its input; a background pick launches its run. Poll
   * the input's status until it names that run.
   */
  async function waitForInputRunId(
    token: string,
    inputRef: McpChatInputRef,
  ): Promise<string> {
    let runId: string | undefined;
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        runId = (await getStatus(token, { inputRef })).messages?.arguments
          .runId;
        return runId;
      })(),
    ).resolves.toBeDefined();
    if (runId === undefined) {
      throw new Error("Expected the submitted input to launch a run");
    }
    return runId;
  }

  /**
   * A send only enqueues its input; without credits the background pick
   * rejects it. Poll the input's status until that rejection is visible.
   */
  async function waitForRejectedInput(
    token: string,
    inputRef: McpChatInputRef,
  ): Promise<void> {
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        return (await getStatus(token, { inputRef })).lifecycle.outcome;
      })(),
    ).resolves.toBe("rejected");
  }

  return {
    client,
    fixture,
    callTool,
    structuredToolError,
    getIndicators,
    listThreads,
    getThread,
    getMessages,
    searchMessages,
    getStatus,
    listAgents,
    listModels,
    createThread,
    updateThread,
    sendMessage,
    revokeMessage,
    cancelRun,
    waitForInputRunId,
    waitForRejectedInput,
  };
}
