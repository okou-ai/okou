import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import {
  mcpGetChatThreadOutputSchema,
  mcpListChatThreadsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-messages";
import { mcpSearchChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { mcpGetChatStatusOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-status";
import {
  mcpListAgentsOutputSchema,
  mcpListModelsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import { mcpCreateChatThreadOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-creation";
import { mcpUpdateChatThreadOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-thread-update";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import {
  mcpSendChatMessageOutputSchema,
  mcpRevokeQueuedMessageOutputSchema,
  mcpCancelRunOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { featureSwitchesRoutes } from "../feature-switches";
import { mcpServerRoutes } from "../mcp-server";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { modelPoliciesRoutes } from "../model-policies";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { seedRetentionOutputEvent$ } from "../../../test-fixtures/chat-event-retention";
import {
  completeRunWithoutCallbacksFixture,
  holdChatThreadRowLockFixture,
  setQueuedUserMessageCreatedAtFixture,
  timeoutRunWithoutCallbacksFixture,
} from "../../../test-fixtures/chat-events";
import {
  rejectSearchablePromptFixture,
  setChatSearchEventTimestampPrecisionFixture,
  updateChatSearchSourceThreadFixture,
} from "../../../test-fixtures/chat-event-search";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateChatEventSnapshotHead } from "./helpers/runtime-state";
import {
  deleteFakeChatEventObject,
  installFakeChatEventR2,
  writeFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";

const context = testContext();
const resource = "https://api.mcp.example.test/mcp";
const issuer = "https://clerk.mcp.example.test";
const readScope = "okou:chat:read";
const orgScope = "user:org:read";
const requiredScopes = `${orgScope} ${readScope}`;
const defaultScopes =
  "openid email profile user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel offline_access";
const modernVersion = "2026-07-28";

function client() {
  return setupApp({ context, routes: mcpServerRoutes })(mcpServerContract);
}

function rpc(body: unknown) {
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

function requestBody(
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

function protocolHeaders(
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

async function fixture(enabled = true) {
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
  createRouteMocks(context).clerk.session(userId, orgId);
  if (enabled) {
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({
        headers: { authorization: "Bearer clerk-session" },
        body: { switches: { [FeatureSwitchKey.McpServer]: true } },
      }),
      [200],
    );
  }
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
  return z
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
}

async function listThreads(token: string, args: Record<string, unknown> = {}) {
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

async function revokeMessage(token: string, threadId: string, inputId: string) {
  const result = await callTool(token, "revoke_queued_message", {
    threadId,
    inputId,
  });
  expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
  return mcpRevokeQueuedMessageOutputSchema.parse(result.structuredContent);
}

async function cancelRun(token: string, runId: string) {
  const result = await callTool(token, "cancel_run", { runId });
  expect(result.isError, JSON.stringify(result.content)).not.toBeTruthy();
  return mcpCancelRunOutputSchema.parse(result.structuredContent);
}

async function projectSearchMessages(threadIds: string[]) {
  await accept(
    setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
      testChatEventSearchProjectionContract,
    ).project({ body: { chat_thread_ids: threadIds } }),
    [200],
  );
}

async function messageFixture() {
  const f = await threadFixture();
  await createRunsApi(context).ensureOrgModelProvider(f.actor);
  async function send(
    prompt: string,
    threadId?: string,
    userMessage?: UserMessageDocument,
  ) {
    const response = await f.chat.requestSendEvent(
      f.actor,
      { agentId: f.agent.agentId, prompt, threadId, userMessage },
      [201],
    );
    if (response.status !== 201 || response.body.runId !== null) {
      throw new Error("Expected a canonical no-credit message without a run");
    }
    return response.body;
  }
  return { ...f, send };
}

async function snapshotMessages(threadId: string) {
  await accept(
    setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
      testChatEventSearchProjectionContract,
    ).project({ body: { chat_thread_ids: [threadId] } }),
    [200],
  );
  await accept(
    setupApp({ context, routes: testChatEventSnapshotRoutes })(
      testChatEventSnapshotContract,
    ).snapshot({ body: { chat_thread_ids: [threadId], r2_object_keys: [] } }),
    [200],
  );
}

async function threadFixture() {
  const auth = await fixture();
  const bdd = createBddApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user({ userId: auth.userId, orgId: auth.orgId });
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "MCP discovery agent",
    visibility: "private",
  });
  return { auth, actor, agent, bdd, chat };
}

async function chatRunFixture() {
  const auth = await fixture();
  const bdd = createBddApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user({ userId: auth.userId, orgId: auth.orgId });
  const runs = createRunsApi(context);
  const callbacks = createChatCallbacksApi(context);
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "MCP activity agent",
    visibility: "private",
  });
  return { auth, actor, chat, agent, runs };
}

async function creationFixture() {
  const f = await threadFixture();
  const runs = createRunsApi(context);
  const { providerId } = await runs.ensureOrgModelProvider(f.actor);
  await runs.updateOrgModelPolicies(
    f.actor,
    (["claude-sonnet-5", "claude-sonnet-4-6"] as const).map((model) => {
      return {
        model,
        isDefault: model === "claude-sonnet-5",
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      };
    }),
  );
  return { ...f, runs, providerId };
}

describe("MCP chat discovery and creation", () => {
  it("lists only visible Agents with bounded descriptions and principal-bound pagination", async () => {
    const f = await threadFixture();
    const peer = f.bdd.user({ orgId: f.auth.orgId });
    const shared = await f.bdd.createAgent(peer, {
      displayName: "Shared Agent",
      visibility: "public",
      description: "Public description ".repeat(500),
    });
    const hidden = await f.bdd.createAgent(peer, {
      displayName: "PRIVATE_AGENT_CANARY",
      visibility: "private",
    });
    const otherOrg = f.bdd.user();
    const foreign = await f.bdd.createAgent(otherOrg, {
      displayName: "FOREIGN_ORG_CANARY",
      visibility: "public",
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: randomUUID(),
          role: "org:member",
          organization: { id: f.auth.orgId },
        },
      ],
      totalCount: 1,
    });
    const token = f.auth.token();
    let page = await listAgents(token, { limit: 1 });
    const firstCursor = page.nextCursor;
    if (!firstCursor) {
      throw new Error("Expected visible Agents to span multiple pages");
    }
    const agents = [...page.agents];
    while (page.nextCursor !== null) {
      expect(agents.length).toBeLessThan(10);
      page = await listAgents(token, { limit: 1, cursor: page.nextCursor });
      agents.push(...page.agents);
    }
    const ids = agents.map((agent) => {
      return agent.agentId;
    });
    expect(ids).toContain(f.agent.agentId);
    expect(ids).toContain(shared.agentId);
    expect(ids).not.toContain(hidden.agentId);
    expect(ids).not.toContain(foreign.agentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      agents.find((agent) => {
        return agent.agentId === shared.agentId;
      }),
    ).toMatchObject({ name: "Shared Agent", descriptionTruncated: true });
    expect(JSON.stringify(agents)).not.toContain("CANARY");
    const tampered = `${firstCursor.startsWith("A") ? "B" : "A"}${firstCursor.slice(1)}`;
    for (const args of [
      { limit: 1, cursor: tampered },
      { limit: 2, cursor: firstCursor },
    ]) {
      expect((await callTool(token, "list_agents", args)).isError).toBeTruthy();
    }
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: peer.userId,
        orgId: f.auth.orgId,
      },
      { [FeatureSwitchKey.McpServer]: true },
    );
    expect(
      (
        await callTool(f.auth.token({ sub: peer.userId }), "list_agents", {
          limit: 1,
          cursor: firstCursor,
        })
      ).isError,
    ).toBeTruthy();
    const longToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      expect(
        (
          await callTool(longToken, "list_agents", {
            limit: 1,
            cursor: firstCursor,
          })
        ).isError,
      ).toBeTruthy();
      expect((await listAgents(longToken)).agents.length).toBeGreaterThan(0);
    });
  });

  it("does not initialize missing model policies through a discovery read", async () => {
    const auth = await fixture();
    const first = await callTool(auth.token(), "list_models");
    expect(first.isError).toBeTruthy();
    expect(first.structuredContent).toBeUndefined();
    await expect(callTool(auth.token(), "list_models")).resolves.toStrictEqual(
      first,
    );
  });

  it.each([false, true])(
    "reports pending model setup after a plan downgrade with personal priority %s",
    async (personalSubscriptionPriority) => {
      const f = await threadFixture();
      const runs = createRunsApi(context);
      const { subscriptionId } = await runs.grantProEntitlement(f.actor);
      await runs.updateOrgModelPolicies(f.actor, [
        {
          model: "gpt-5.6-luna",
          isDefault: true,
          defaultProviderType: "codex-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
        },
      ]);
      await updateFeatureSwitchesForUser(
        context,
        { userId: f.auth.userId, orgId: f.auth.orgId },
        {
          [FeatureSwitchKey.PersonalSubscriptionPriority]:
            personalSubscriptionPriority,
        },
      );
      const token = f.auth.token({ scope: defaultScopes });
      expect((await listModels(token)).models).toContainEqual(
        expect.objectContaining({
          id: "gpt-5.6-luna",
          selectable: true,
          availability: "connection_required",
        }),
      );
      await createWebhookCallbackApi(context).postStripeEvent(
        {
          id: `evt_${randomUUID()}`,
          type: "customer.subscription.deleted",
          data: { object: { id: subscriptionId, metadata: {} } },
        },
        [200],
      );

      const pending = await callTool(token, "list_models");
      expect(pending.isError).toBeTruthy();
      expect(pending.structuredContent).toBeUndefined();
      expect(pending.content).toContainEqual({
        type: "text",
        text: "Model policies need to be synchronized with the current organization plan. Open model settings, then retry discovery.",
      });
      await expect(callTool(token, "list_models")).resolves.toStrictEqual(
        pending,
      );

      createRouteMocks(context).clerk.session(f.auth.userId, f.auth.orgId);
      const settings = await accept(
        setupApp({ context, routes: modelPoliciesRoutes })(
          modelPoliciesMainContract,
        ).list({ headers: { authorization: "Bearer clerk-session" } }),
        [200],
      );
      expect(settings.body.workspaceDefaultModel).toBe("gpt-5.6-luna");
      const models = await listModels(token);
      expect(models.defaultModel).toStrictEqual({
        model: "gpt-5.6-luna",
        source: "org_default",
      });
      expect(models.models).toContainEqual(
        expect.objectContaining({ id: "gpt-5.6-luna", selectable: true }),
      );
      const created = await createThread(token, {
        requestId: randomUUID(),
        agentId: f.agent.agentId,
        title: "After plan synchronization",
        model: "gpt-5.6-luna",
      });
      expect(created.model.selectedModel).toBe("gpt-5.6-luna");
      expect(
        (await getMessages(token, { threadId: created.threadId })).messages,
      ).toStrictEqual([]);
    },
  );

  it("distinguishes configured models, missing member credentials and the member default", async () => {
    const f = await creationFixture();
    expect((await listModels(f.auth.token())).models).toContainEqual(
      expect.objectContaining({
        id: "claude-sonnet-5",
        selectable: true,
        availability: "plan_restricted",
        reason: expect.any(String),
      }),
    );
    await f.runs.grantProEntitlement(f.actor);
    await f.runs.updateOrgModelPolicies(f.actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: f.providerId,
      },
      {
        model: "gpt-5.6-sol",
        isDefault: false,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    const token = f.auth.token();
    const models = await listModels(token);
    expect(models).toMatchObject({
      defaultModel: { model: "claude-sonnet-5", source: "org_default" },
      admission: "checked_on_send",
    });
    expect(models.models).toContainEqual(
      expect.objectContaining({
        id: "claude-sonnet-5",
        selectable: true,
        availability: "available",
      }),
    );
    for (const personalSubscriptionPriority of [false, true]) {
      await updateFeatureSwitchesForUser(
        context,
        { userId: f.auth.userId, orgId: f.auth.orgId },
        {
          [FeatureSwitchKey.PersonalSubscriptionPriority]:
            personalSubscriptionPriority,
        },
      );
      expect((await listModels(token)).models).toContainEqual(
        expect.objectContaining({
          id: "gpt-5.6-sol",
          selectable: true,
          availability: "connection_required",
        }),
      );
    }
    const visible = JSON.stringify(models);
    expect(visible).not.toContain(f.providerId);
    expect(visible).not.toContain("test-anthropic-key");
    createRouteMocks(context).clerk.session(f.auth.userId, f.auth.orgId);
    await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers: { authorization: "Bearer clerk-session" },
        body: { selectedModel: "gpt-5.6-sol", serviceTier: "priority" },
      }),
      [200],
    );
    await expect(listModels(token)).resolves.toMatchObject({
      defaultModel: { model: "gpt-5.6-sol", source: "member_default" },
    });
    expect((await listAgents(token)).agents).toContainEqual(
      expect.objectContaining({ isDefault: true }),
    );
  });

  it("creates an empty conversation using an explicit model and returns a send handoff", async () => {
    const f = await creationFixture();
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const created = await createThread(
      f.auth.token({ scope: `${requiredScopes} okou:chat:manage` }),
      {
        requestId: requestId.toUpperCase(),
        agentId: f.agent.agentId.toUpperCase(),
        title: "Review the quarterly plan",
        model: "claude-sonnet-4-6",
      },
    );
    expect(created).toMatchObject({
      threadId: requestId,
      agentId: f.agent.agentId,
      title: "Review the quarterly plan",
      titleTruncated: false,
      model: {
        selectedModel: "claude-sonnet-4-6",
        effectiveModel: "claude-sonnet-4-6",
        source: "thread",
        admission: "checked_on_send",
      },
      replayed: false,
      nextAction: {
        tool: "send_chat_message",
        arguments: { threadId: requestId },
      },
    });
    expect(Date.parse(created.retryUntil) - Date.parse(created.createdAt)).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(new URL(created.url).pathname).toBe(`/chats/${requestId}`);
    await expect(
      getStatus(token, { threadId: requestId }),
    ).resolves.toMatchObject({
      input: null,
      run: null,
      output: { state: "unavailable" },
    });
    expect(
      (await getMessages(token, { threadId: requestId })).messages,
    ).toStrictEqual([]);
    const sent = await sendMessage(token, {
      ...created.nextAction.arguments,
      requestId: randomUUID(),
      text: "This first message contains its own context.",
    });
    expect(sent.inputRef.threadId).toBe(requestId);
  });

  it("deduplicates simultaneous creation and replays current mutable settings without overwriting them", async () => {
    const f = await creationFixture();
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Original title",
      model: "claude-sonnet-5",
    };
    const token = f.auth.token({ scope: defaultScopes });
    const results = await Promise.all([
      createThread(token, args),
      createThread(token, args),
    ]);
    expect(
      results
        .map((result) => {
          return result.replayed;
        })
        .sort(),
    ).toStrictEqual([false, true]);
    expect(results[0]?.threadId).toBe(args.requestId);
    expect(results[1]?.threadId).toBe(args.requestId);
    expect((await listThreads(token)).threads).toHaveLength(1);
    await f.chat.renameThread(
      f.actor,
      args.requestId,
      "Renamed after creation",
    );
    await f.chat.updateThreadModelSelection(
      f.actor,
      args.requestId,
      "claude-sonnet-4-6",
    );
    const before = await f.chat.readThreadMetadata(f.actor, args.requestId);
    await expect(createThread(token, args)).resolves.toMatchObject({
      threadId: args.requestId,
      replayed: true,
      title: "Renamed after creation",
      model: {
        selectedModel: "claude-sonnet-4-6",
        effectiveModel: "claude-sonnet-4-6",
      },
    });
    await expect(
      f.chat.readThreadMetadata(f.actor, args.requestId),
    ).resolves.toStrictEqual(before);
    for (const conflicting of [
      { ...args, title: "Different intent" },
      { ...args, model: "claude-sonnet-4-6" },
    ]) {
      expect(
        (await callTool(token, "create_chat_thread", conflicting)).isError,
      ).toBeTruthy();
    }
    await expect(
      f.chat.readThreadMetadata(f.actor, args.requestId),
    ).resolves.toStrictEqual(before);
    expect((await listThreads(token)).threads).toHaveLength(1);
  });

  it("atomically updates sparse metadata and replays without reverting newer state", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const created = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Original metadata",
      model: "claude-sonnet-5",
    });
    const firstId = randomUUID();
    const first = await updateThread(token, {
      requestId: firstId,
      threadId: created.threadId,
      patch: { title: "Manual MCP title" },
    });
    expect(first).toMatchObject({
      requestId: firstId,
      threadId: created.threadId,
      title: "Manual MCP title",
      titleTruncated: false,
      model: {
        selectedModel: "claude-sonnet-5",
        effectiveModel: "claude-sonnet-5",
        source: "thread",
      },
      replayed: false,
    });
    expect(Date.parse(first.retryUntil) - Date.parse(first.acceptedAt)).toBe(
      24 * 60 * 60 * 1000,
    );

    const second = await updateThread(token, {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: {
        title: "Newer combined state",
        model: "claude-sonnet-4-6",
      },
    });
    expect(second).toMatchObject({
      title: "Newer combined state",
      model: {
        selectedModel: "claude-sonnet-4-6",
        effectiveModel: "claude-sonnet-4-6",
      },
      replayed: false,
    });

    await expect(
      updateThread(token, {
        requestId: firstId,
        threadId: created.threadId,
        patch: { title: "Manual MCP title" },
      }),
    ).resolves.toMatchObject({
      acceptedAt: first.acceptedAt,
      title: "Newer combined state",
      model: { selectedModel: "claude-sonnet-4-6" },
      replayed: true,
    });
    expect(
      (
        await callTool(token, "update_chat_thread", {
          requestId: firstId,
          threadId: created.threadId,
          patch: { title: "Conflicting reuse" },
        })
      ).isError,
    ).toBeTruthy();

    const cleared = await updateThread(token, {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: { model: null },
    });
    expect(cleared).toMatchObject({
      title: "Newer combined state",
      model: {
        selectedModel: null,
        effectiveModel: "claude-sonnet-5",
        source: "org_default",
      },
    });
    await expect(getThread(token, created.threadId)).resolves.toMatchObject({
      thread: {
        title: "Newer combined state",
        model: { selectedModel: null, effectiveModel: "claude-sonnet-5" },
      },
    });
  });

  it("preserves Fast, reasoning, media and browser settings", async () => {
    const f = await threadFixture();
    const model = await f.chat.getDefaultCreateThreadModel(f.actor);
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Preserve settings",
      model,
    });
    await f.chat.updateThreadModelSelection(f.actor, created.id, model, {
      reasoningEffort: "high",
      codexServiceTier: "fast",
    });
    await f.chat.updateThreadImageModel(f.actor, created.id, "gpt-image-2");
    await f.chat.updateThreadVideoModel(f.actor, created.id, "MiniMax-H3");
    const before = await f.chat.readThreadMetadata(f.actor, created.id);
    expect(before).toMatchObject({
      modelSettings: { [model]: { effort: "high" } },
      serviceTier: "priority",
      selectedVideoModel: "MiniMax-H3",
      selectedImageModel: "gpt-image-2",
    });

    await updateThread(f.auth.token({ scope: defaultScopes }), {
      requestId: randomUUID(),
      threadId: created.id,
      patch: { title: "Still preserved", model },
    });

    await expect(
      f.chat.readThreadMetadata(f.actor, created.id),
    ).resolves.toMatchObject({
      modelSettings: before.modelSettings,
      serviceTier: before.serviceTier,
      computerUseHostId: before.computerUseHostId,
      cloudBrowserEnabled: before.cloudBrowserEnabled,
      selectedVideoModel: before.selectedVideoModel,
      selectedImageModel: before.selectedImageModel,
    });
  });

  it("rejects update replay after its 24-hour window without reapplying intent", async () => {
    const f = await creationFixture();
    const currentToken = f.auth.token({ scope: defaultScopes });
    const created = await createThread(currentToken, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Before expiry",
      model: "claude-sonnet-5",
    });
    const requestId = randomUUID();
    const first = await updateThread(currentToken, {
      requestId,
      threadId: created.threadId,
      patch: { title: "Accepted title" },
    });
    await updateThread(currentToken, {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: { title: "Later title" },
    });
    const futureToken = f.auth.token({
      scope: defaultScopes,
      exp: Math.floor((Date.parse(first.retryUntil) + 60_000) / 1000),
    });

    await withMockNowForTest(Date.parse(first.retryUntil) + 1, async () => {
      const replay = await callTool(futureToken, "update_chat_thread", {
        requestId,
        threadId: created.threadId,
        patch: { title: "Accepted title" },
      });
      expect(replay.isError).toBeTruthy();
      expect(replay.structuredContent).toBeUndefined();
    });
    await expect(
      getThread(currentToken, created.threadId),
    ).resolves.toMatchObject({ thread: { title: "Later title" } });
  });

  it("validates thread update patches before changing metadata", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const created = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Unchanged metadata",
      model: "claude-sonnet-5",
    });
    const eventsBefore = (await f.chat.requestThreadEvents(f.actor, {}, [200]))
      .body;
    for (const patch of [
      {},
      { title: " " },
      { title: "x".repeat(201) },
      { model: "not-a-supported-model" },
      { title: "Must roll back", model: "not-a-supported-model" },
      { title: "Must roll back denied model", model: "claude-opus-4-8" },
      { title: "Unknown field", extra: true },
    ]) {
      expect(
        (
          await callTool(token, "update_chat_thread", {
            requestId: randomUUID(),
            threadId: created.threadId,
            patch,
          })
        ).isError,
      ).toBeTruthy();
    }
    expect(
      (
        await callTool(token, "update_chat_thread", {
          requestId: created.threadId,
          threadId: created.threadId,
          patch: { title: "Event collision must roll back" },
        })
      ).isError,
    ).toBeTruthy();
    await expect(getThread(token, created.threadId)).resolves.toMatchObject({
      thread: {
        title: "Unchanged metadata",
        model: { selectedModel: "claude-sonnet-5" },
      },
    });
    await expect(
      f.chat.requestThreadEvents(f.actor, {}, [200]),
    ).resolves.toMatchObject({ body: eventsBefore });
  });

  it("deduplicates simultaneous identical thread updates", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const created = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Concurrent metadata",
      model: "claude-sonnet-5",
    });
    const args = {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: { title: "One accepted update", model: "claude-sonnet-4-6" },
    };
    const results = await Promise.all([
      updateThread(token, args),
      updateThread(token, args),
    ]);
    expect(
      results
        .map((result) => {
          return result.replayed;
        })
        .sort(),
    ).toStrictEqual([false, true]);
    await expect(getThread(token, created.threadId)).resolves.toMatchObject({
      thread: {
        title: "One accepted update",
        model: { selectedModel: "claude-sonnet-4-6" },
      },
    });
  });

  it("expires creation retries after 24 hours and does not recreate deleted conversations", async () => {
    const f = await creationFixture();
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Retry window",
      model: "claude-sonnet-5",
    };
    const created = await createThread(
      f.auth.token({ scope: defaultScopes }),
      args,
    );
    const token = f.auth.token({
      scope: defaultScopes,
      exp: Math.floor((Date.parse(created.retryUntil) + 60_000) / 1000),
    });
    await withMockNowForTest(Date.parse(created.retryUntil) - 1, async () => {
      await expect(createThread(token, args)).resolves.toMatchObject({
        replayed: true,
      });
    });
    await withMockNowForTest(Date.parse(created.retryUntil) + 1, async () => {
      const expired = await callTool(token, "create_chat_thread", args);
      expect(expired.isError).toBeTruthy();
      expect(expired.structuredContent).toBeUndefined();
    });
    await f.chat.deleteThread(f.actor, created.threadId);
    expect(
      (await callTool(token, "create_chat_thread", args)).isError,
    ).toBeTruthy();
    expect((await listThreads(token)).threads).toStrictEqual([]);
  });

  it("rejects an unrelated created-event collision and an existing thread without matching creation evidence", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const collidingEventId = randomUUID();
    const first = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Other event owner",
      model: "claude-sonnet-5",
      eventId: collidingEventId,
    });
    const args = {
      requestId: collidingEventId,
      agentId: f.agent.agentId,
      title: "MCP creation intent",
      model: "claude-sonnet-5",
    };
    expect(
      (await callTool(token, "create_chat_thread", args)).isError,
    ).toBeTruthy();
    expect(
      (await callTool(token, "get_chat_thread", { threadId: collidingEventId }))
        .isError,
    ).toBeTruthy();
    const existingId = randomUUID();
    const existing = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: args.title,
      model: "claude-sonnet-5",
      clientThreadId: existingId,
      eventId: randomUUID(),
    });
    expect(
      (
        await callTool(token, "create_chat_thread", {
          ...args,
          requestId: existingId,
        })
      ).isError,
    ).toBeTruthy();
    const ids = (await listThreads(token)).threads.map((thread) => {
      return thread.threadId;
    });
    expect(new Set(ids)).toStrictEqual(new Set([first.id, existing.id]));
    expect(
      (await getMessages(token, { threadId: existing.id })).messages,
    ).toStrictEqual([]);
  });

  it("does not disclose private Agents or let another principal reuse a creation identity", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Owner's conversation",
      model: "claude-sonnet-5",
    };
    await createThread(token, args);
    const second = await f.bdd.createAgent(f.actor, {
      displayName: "Another owned Agent",
      visibility: "private",
    });
    expect(
      (
        await callTool(token, "create_chat_thread", {
          ...args,
          agentId: second.agentId,
        })
      ).isError,
    ).toBeTruthy();
    const missing = await callTool(token, "create_chat_thread", {
      ...args,
      requestId: randomUUID(),
      agentId: randomUUID(),
    });
    for (const actor of [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ]) {
      if (!actor.orgId) {
        throw new Error("Expected the peer's organization");
      }
      const hidden = await f.bdd.createAgent(actor, {
        displayName: "Private selection",
        visibility: "private",
      });
      await expect(
        callTool(token, "create_chat_thread", {
          ...args,
          requestId: randomUUID(),
          agentId: hidden.agentId,
        }),
      ).resolves.toStrictEqual(missing);
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        { [FeatureSwitchKey.McpServer]: true },
      );
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const foreignToken = f.auth.token({
        sub: actor.userId,
        org_id: actor.orgId,
        scope: defaultScopes,
      });
      const failed = await callTool(foreignToken, "create_chat_thread", {
        ...args,
        agentId: hidden.agentId,
      });
      expect(failed.isError).toBeTruthy();
      expect(JSON.stringify(failed)).not.toContain("Owner's conversation");
    }
    expect((await listThreads(token)).threads).toHaveLength(1);
  });

  it.each([false, true])(
    "rejects closed-account creation with cached membership %s",
    async (cachedMembership) => {
      const f = await creationFixture();
      const token = f.auth.token({ scope: defaultScopes });
      if (cachedMembership) {
        expect((await listAgents(token)).agents).toContainEqual(
          expect.objectContaining({ agentId: f.agent.agentId }),
        );
      }
      // Infrastructure exception: account-erasure closure has no production
      // ingress. Install only this test-owned dormant decision, without a worker.
      const closed = await closeErasureSubjectFixture({
        subjectKind: "user",
        subjectId: f.auth.userId,
      });
      onTestFinished(async () => {
        await removeErasureSubjectsFixture([closed.jobId]);
      });
      const args = {
        requestId: randomUUID(),
        agentId: f.agent.agentId,
        title: "Must not be created",
        model: "claude-sonnet-5",
      };
      if (!cachedMembership) {
        const response = await accept(
          client().request({
            extraHeaders: protocolHeaders(
              token,
              "tools/call",
              true,
              "create_chat_thread",
            ),
            body: requestBody("tools/call", true, {
              name: "create_chat_thread",
              arguments: args,
            }),
          }),
          [401],
        );
        expect(response.body).toStrictEqual({ error: "invalid_token" });
        return;
      }
      const result = await callTool(token, "create_chat_thread", args);
      expect(result.isError).toBeTruthy();
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toContainEqual({
        type: "text",
        text: "Account content is closed.",
      });
    },
  );

  it("requires explicit creation choices and rejects unrelated execution controls", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "A new conversation",
      model: "claude-sonnet-5",
    };
    for (const invalid of [
      { ...args, title: "  " },
      { ...args, title: "x".repeat(201) },
      { ...args, model: undefined },
      { ...args, requestId: undefined },
      { ...args, prompt: "Must not execute" },
      { ...args, orgId: f.auth.orgId },
      { ...args, model: "not-a-supported-model" },
    ]) {
      expect(
        (await callTool(token, "create_chat_thread", invalid)).isError,
      ).toBeTruthy();
    }
    expect((await listThreads(token)).threads).toStrictEqual([]);
    expect(
      (await callTool(token, "list_agents", { limit: 51 })).isError,
    ).toBeTruthy();
    expect(
      (await callTool(token, "list_models", { orgId: f.auth.orgId })).isError,
    ).toBeTruthy();
  });
});

describe("MCP chat status", () => {
  it("reports an empty thread without changing its unread or message state", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const before = await f.chat.readThread(f.actor, thread.id);
    const status = await getStatus(f.auth.token(), { threadId: thread.id });
    expect(status).toMatchObject({
      threadId: thread.id,
      input: null,
      run: null,
      runSelection: "latest",
      output: {
        state: "unavailable",
        messageRefs: [],
        hasMore: false,
        reason: "no_associated_run",
      },
      messages: null,
      retryAfterMs: null,
    });
    expect(Number.isNaN(Date.parse(status.observedAt))).toBeFalsy();
    await expect(f.chat.readThread(f.actor, thread.id)).resolves.toStrictEqual(
      before,
    );
  });

  it("tracks an original launch through running, partial output and materialized completion", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "PRIVATE_STATUS_PROMPT: summarize the findings",
    });
    if (!sent.runId) {
      throw new Error("Expected the submitted input to launch a run");
    }
    const runId = sent.runId;
    onTestFinished(async () => {
      await f.api.requestCancelRun(actor.actor, runId, [200, 400, 404]);
    });
    const args = { threadId: thread.id, inputRef: sent.inputRef };
    const pending = await getStatus(token, args);
    expect(pending).toMatchObject({
      input: {
        ref: sent.inputRef,
        state: "associated",
        // Immediate admission does not retain a launch receipt. Association
        // proves the run identity, not how the runtime consumed the input.
        deliveryMode: "unknown",
        runId,
      },
      run: { id: runId, status: "pending", completedAt: null },
      runSelection: "input",
      output: { state: "pending", messageRefs: [], reason: null },
      messages: {
        tool: "get_chat_messages",
        arguments: { threadId: thread.id, runId, limit: 20 },
      },
    });
    expect(pending.retryAfterMs).toBeGreaterThan(0);
    expect(pending.input?.visibleMessageRef).not.toStrictEqual(sent.inputRef);
    expect(JSON.stringify(pending)).not.toContain("PRIVATE_STATUS_PROMPT");
    const claimed = await f.claimChatRun(actor.runnerGroup, runId);
    await expect(getStatus(token, args)).resolves.toMatchObject({
      run: { id: runId, status: "running", completedAt: null },
      output: { state: "pending" },
    });
    await f.webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [
                { type: "text", text: "A readable intermediate result." },
              ],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    const partial = await getStatus(token, args);
    expect(partial).toMatchObject({
      run: { status: "running" },
      output: { state: "partial", hasMore: false, reason: null },
    });
    expect(partial.output.messageRefs).toHaveLength(1);
    await f.completeChatRunOk(runId, claimed.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    const ready = await getStatus(token, args);
    expect(ready).toMatchObject({
      run: { id: runId, status: "completed", completedAt: expect.any(String) },
      output: { state: "ready", messageRefs: partial.output.messageRefs },
      retryAfterMs: null,
    });
    if (!ready.messages) {
      throw new Error("Expected a message retrieval handoff");
    }
    const messages = await getMessages(token, ready.messages.arguments);
    expect(
      messages.messages
        .filter((message) => {
          return message.role === "assistant";
        })
        .map((message) => {
          return message.ref;
        }),
    ).toStrictEqual(ready.output.messageRefs);
    await expect(
      getStatus(token, { threadId: thread.id }),
    ).resolves.toMatchObject({
      input: null,
      runSelection: "latest",
      run: { id: runId, status: "completed" },
      output: { state: "ready" },
    });
    const invalidRefs = [
      { ...sent.inputRef, eventId: randomUUID() },
      { ...sent.inputRef, seqId: sent.inputRef.seqId + 1 },
      pending.input?.visibleMessageRef,
    ];
    for (const inputRef of invalidRefs) {
      if (!inputRef) {
        throw new Error("Expected a visible replacement reference");
      }
      await expect(
        getStatus(token, { threadId: thread.id, inputRef }),
      ).resolves.toMatchObject({
        input: { state: "unavailable", runId: null },
        run: null,
        runSelection: "input",
        messages: null,
      });
    }
    await expect(
      getStatus(token, {
        threadId: thread.id.toUpperCase(),
        inputRef: {
          ...sent.inputRef,
          threadId: thread.id.toUpperCase(),
          eventId: sent.inputRef.eventId.toUpperCase(),
        },
      }),
    ).resolves.toMatchObject({
      threadId: thread.id,
      input: { ref: sent.inputRef, runId },
      run: { id: runId, status: "completed" },
    });
  });

  it("keeps cancellation recovery separate from readable partial and late output", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Cancel after partial progress",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: { content: [{ type: "text", text: "Partial progress" }] },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    const token = auth.token({ scope: defaultScopes });
    await cancelRun(token, sent.runId);
    await flushWaitUntilForTest();
    const recovering = await getStatus(token, { threadId: sent.threadId });
    expect(recovering).toMatchObject({
      run: {
        id: sent.runId,
        status: "cancelled",
        cancellationRecovery: "pending",
      },
      output: { state: "partial" },
    });
    expect(recovering.retryAfterMs).toBeGreaterThan(0);
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [{ type: "text", text: "Recovered final progress" }],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await f.completeChatRunOk(sent.runId, claimed.sandboxHeaders, {
      lastEventSequence: 1,
    });
    await flushWaitUntilForTest();
    const recovered = await getStatus(token, { threadId: sent.threadId });
    expect(recovered).toMatchObject({
      run: {
        id: sent.runId,
        status: "cancelled",
        cancellationRecovery: "complete",
      },
      output: { state: "ready" },
      retryAfterMs: null,
    });
    expect(recovered.output.messageRefs).toHaveLength(2);
  });

  it("reports failed runs without inventing assistant messages from terminal errors", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Fail before producing output",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    await f.failChatRun(
      sent.runId,
      claimed.sandboxHeaders,
      "PRIVATE_RAW_ERROR",
    );
    await flushWaitUntilForTest();
    const status = await getStatus(auth.token(), { threadId: sent.threadId });
    expect(status).toMatchObject({
      run: { id: sent.runId, status: "failed" },
      output: { state: "unavailable", reason: "no_output", messageRefs: [] },
      retryAfterMs: null,
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE_RAW_ERROR");
  });

  it("identifies a queued launch and preserves its association after original-input retention", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const active = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Finish before the queued launch",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
    const token = auth.token({ scope: defaultScopes });
    const submitted = await sendMessage(token, {
      threadId: active.threadId,
      requestId: randomUUID(),
      text: "Start a new run when the previous one completes",
    });
    const args = { threadId: active.threadId, inputRef: submitted.inputRef };
    await expect(getStatus(token, args)).resolves.toMatchObject({
      input: { state: "queued", runId: null, deliveryMode: "unknown" },
      run: null,
    });
    await f.completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    const launched = await getStatus(token, args);
    const nextRunId = launched.run?.id;
    if (!nextRunId) {
      throw new Error("Expected the queued input to start its own run");
    }
    onTestFinished(async () => {
      await f.api.requestCancelRun(actor.actor, nextRunId, [200, 400, 404]);
    });
    expect(nextRunId).not.toBe(active.runId);
    expect(launched).toMatchObject({
      input: {
        ref: submitted.inputRef,
        state: "associated",
        deliveryMode: "launch",
        runId: nextRunId,
      },
      run: { id: nextRunId, status: "pending" },
      output: { state: "pending" },
    });
    // Infrastructure exception: the retention cutoff uses the database clock;
    // public requests cannot backdate this original submission by 31 days.
    await setQueuedUserMessageCreatedAtFixture({
      eventId: submitted.inputRef.eventId,
      createdAt: new Date(now() - 31 * 24 * 60 * 60 * 1000),
    });
    await snapshotMessages(active.threadId);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [active.threadId] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const archived = await getStatus(token, args);
    expect(archived.input).toStrictEqual(launched.input);
    expect(archived.run).toStrictEqual(launched.run);
    expect(archived.output).toStrictEqual(launched.output);
  });

  it.each(["completed", "timeout"] as const)(
    "keeps %s output pending or partial until its canonical terminal marker exists",
    async (status) => {
      const auth = await fixture();
      const f = createChatEventsFixture(context);
      const actor = await f.entitledChatActor({
        userId: auth.userId,
        orgId: auth.orgId,
      });
      const sent = await f.sendChatRun(actor.actor, {
        agentId: actor.agentId,
        prompt: "Observe a delayed terminal callback",
      });
      const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
      // Infrastructure exception: a successful public completion schedules its
      // callback. Only a process crash can leave the committed terminal run
      // without that dispatch; the existing scoped fixture recreates this gap.
      if (status === "completed") {
        await completeRunWithoutCallbacksFixture({ runId: sent.runId });
      } else {
        await timeoutRunWithoutCallbacksFixture({ runId: sent.runId });
      }
      const token = auth.token();
      await expect(
        getStatus(token, { threadId: sent.threadId }),
      ).resolves.toMatchObject({
        run: { id: sent.runId, status },
        output: { state: "pending", messageRefs: [] },
        retryAfterMs: expect.any(Number),
      });
      await f.webhooks.requestAgentEvents(
        {
          runId: sent.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 0,
              message: {
                content: [{ type: "text", text: "Late canonical output" }],
              },
            },
          ],
        },
        claimed.sandboxHeaders,
        [200],
      );
      const observed = await getStatus(token, { threadId: sent.threadId });
      expect(observed.run?.status).toBe(status);
      // Timeout fencing discards late output; an ordinary completed run can
      // materialize it, but neither case invents the missing terminal marker.
      expect(observed.output.state).toBe(
        status === "completed" ? "partial" : "pending",
      );
      expect(observed.output.messageRefs).toHaveLength(
        status === "completed" ? 1 : 0,
      );
      expect(observed.retryAfterMs).toBeGreaterThan(0);
    },
  );

  it("resolves archived original inputs and rejects an incomplete archive", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Retain my original input reference",
    });
    const args = { threadId: thread.id, inputRef: sent.inputRef };
    const before = await getStatus(token, args);
    // Infrastructure exception: public sends cannot backdate acceptance past
    // the database-clock retention cutoff. Archive, retention and all status
    // assertions still execute their real HTTP endpoints.
    await setQueuedUserMessageCreatedAtFixture({
      eventId: sent.inputRef.eventId,
      createdAt: new Date(now() - 31 * 24 * 60 * 60 * 1000),
    });
    await snapshotMessages(thread.id);
    const archive = puts.at(-1);
    if (!archive) {
      throw new Error("Expected the canonical archive");
    }
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [thread.id] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const after = await getStatus(token, args);
    expect(after.input).toStrictEqual(before.input);
    expect(after.output).toStrictEqual(before.output);
    await deleteFakeChatEventObject(archive.key);
    const failure = await callTool(token, "get_chat_status", args);
    expect(failure.isError).toBeTruthy();
    expect(failure.content[0]?.text).toContain("could not be read completely");
  });

  it("rejects cross-thread references and unsupported status controls", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token();
    const before = await f.chat.readThread(f.actor, thread.id);
    for (const args of [
      { threadId: thread.id, waitMs: 30_000 },
      { threadId: thread.id, runId: randomUUID() },
      {
        threadId: thread.id,
        inputRef: { threadId: randomUUID(), eventId: randomUUID(), seqId: 1 },
      },
      {
        threadId: thread.id,
        inputRef: { threadId: thread.id, eventId: randomUUID(), seqId: 0 },
      },
    ]) {
      expect(
        (await callTool(token, "get_chat_status", args)).isError,
      ).toBeTruthy();
    }
    await expect(f.chat.readThread(f.actor, thread.id)).resolves.toStrictEqual(
      before,
    );
  });
});

describe("MCP chat mutations", () => {
  it("treats UUID letter case as the same submission identity", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const text = "Preserve the message while normalizing its identifiers";
    const accepted = await sendMessage(token, {
      threadId: thread.id.toUpperCase(),
      requestId: requestId.toUpperCase(),
      text,
    });
    expect(accepted).toMatchObject({
      inputRef: { threadId: thread.id, eventId: requestId },
      replayed: false,
    });
    const replay = await sendMessage(token, {
      threadId: thread.id,
      requestId,
      text,
    });
    expect(replay).toStrictEqual({ ...accepted, replayed: true });
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toMatchObject([{ text }]);
  });

  it("preserves exact text and the original input reference when run admission rejects it", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const text = "  Keep my whitespace\n中文 😀  ";
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const result = await sendMessage(token, {
      threadId: thread.id,
      text,
      requestId,
    });
    expect(result).toMatchObject({
      inputRef: { threadId: thread.id, eventId: requestId },
      replayed: false,
      disposition: "rejected",
      runId: null,
    });
    expect(Date.parse(result.retryUntil) - Date.parse(result.acceptedAt)).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(new URL(result.url).pathname).toBe(`/chats/${thread.id}`);
    const events = (await f.chat.listThreadEvents(f.actor, thread.id)).events;
    const original = events.find((event) => {
      return event.id === requestId;
    });
    expect(original).toMatchObject({
      seqId: result.inputRef.seqId,
      eventType: "input.prompt",
      userMessage: { version: 1, parts: [{ type: "text", text }] },
    });
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toMatchObject([{ text, eventType: "input.rejected", runId: null }]);
    const status = await getStatus(token, {
      threadId: thread.id,
      inputRef: result.inputRef,
    });
    expect(status).toMatchObject({
      input: {
        ref: result.inputRef,
        state: "rejected",
        deliveryMode: "unknown",
        runId: null,
      },
      run: null,
      runSelection: "input",
      output: { state: "unavailable", reason: "no_associated_run" },
      messages: null,
      retryAfterMs: null,
    });
    expect(status.input?.visibleMessageRef).toStrictEqual(
      (await getMessages(token, { threadId: thread.id })).messages[0]?.ref,
    );
    const replay = await sendMessage(token, {
      threadId: thread.id,
      text,
      requestId,
    });
    expect(replay).toStrictEqual({ ...result, replayed: true });
    expect(
      (await f.chat.listThreadEvents(f.actor, thread.id)).events,
    ).toStrictEqual(events);
  });

  it("settles concurrent identical sends once and accepts refreshed authorization for the original receipt", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: thread.id,
      text: "One accepted message despite concurrent requests",
      requestId: randomUUID(),
    };
    const token = f.auth.token({ scope: defaultScopes });
    const replies = await Promise.all([
      sendMessage(token, args),
      sendMessage(token, args),
    ]);
    expect(replies[0]?.inputRef).toStrictEqual(replies[1]?.inputRef);
    expect(
      replies.filter((reply) => {
        return !reply.replayed;
      }),
    ).toHaveLength(1);
    const refreshed = f.auth.token({
      scope: `${requiredScopes} okou:chat:send`,
      exp: Math.floor(now() / 1000) + 7200,
      jti: randomUUID(),
    });
    const replay = await sendMessage(refreshed, args);
    expect(replay.inputRef).toStrictEqual(replies[0]?.inputRef);
    expect(replay.acceptedAt).toBe(replies[0]?.acceptedAt);
    expect(replay.retryUntil).toBe(replies[0]?.retryUntil);
    expect(replay.replayed).toBeTruthy();
    const messages = await getMessages(token, { threadId: thread.id });
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]?.text).toBe(args.text);
    expect(
      (await f.chat.listThreadEvents(f.actor, thread.id)).events.filter(
        (event) => {
          return event.id === args.requestId;
        },
      ),
    ).toHaveLength(1);
  });

  it("rejects same-identity changes of exact text or thread without changing either conversation", async () => {
    const f = await messageFixture();
    const first = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const second = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: first.id,
      text: "Exact input",
      requestId: randomUUID(),
    };
    const token = f.auth.token({ scope: defaultScopes });
    const receipt = await sendMessage(token, args);
    for (const threadId of [first.id, second.id]) {
      await f.chat.patchThread(f.actor, threadId, {
        draftUserMessage: {
          version: 1,
          parts: [{ type: "text", text: "Keep this unsent draft" }],
        },
      });
    }
    const firstBefore = await f.chat.readThread(f.actor, first.id);
    const secondBefore = await f.chat.readThread(f.actor, second.id);
    const before = await f.chat.listThreadEvents(f.actor, first.id);
    for (const changed of [
      { ...args, text: "Exact input " },
      { ...args, threadId: second.id },
    ]) {
      const failed = await callTool(token, "send_chat_message", changed);
      expect(failed.isError).toBeTruthy();
      expect(failed.structuredContent).toBeUndefined();
    }
    await expect(
      f.chat.listThreadEvents(f.actor, first.id),
    ).resolves.toStrictEqual(before);
    expect(
      (await getMessages(token, { threadId: second.id })).messages,
    ).toStrictEqual([]);
    expect((await sendMessage(token, args)).inputRef).toStrictEqual(
      receipt.inputRef,
    );
    await expect(f.chat.readThread(f.actor, first.id)).resolves.toStrictEqual(
      firstBefore,
    );
    await expect(f.chat.readThread(f.actor, second.id)).resolves.toStrictEqual(
      secondBefore,
    );
  });

  it("replays an equivalent owned first-party text input without creating another message", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const requestId = randomUUID();
    const text = "An existing first-party input";
    await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId: thread.id,
        clientEventId: requestId,
        prompt: text,
      },
      [201],
    );
    const before = await f.chat.listThreadEvents(f.actor, thread.id);
    const original = before.events.find((event) => {
      return event.id === requestId;
    });
    if (!original) {
      throw new Error("Expected the original first-party input");
    }
    const token = f.auth.token({ scope: defaultScopes });
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await sendMessage(token, {
        threadId: thread.id,
        text,
        requestId,
      });
      expect(replay).toMatchObject({
        inputRef: {
          threadId: thread.id,
          eventId: requestId,
          seqId: original.seqId,
        },
        acceptedAt: original.createdAt,
        replayed: true,
        disposition: "rejected",
        runId: null,
      });
    }
    await expect(
      f.chat.listThreadEvents(f.actor, thread.id),
    ).resolves.toStrictEqual(before);
  });

  it.each(["different text", "additional user context"] as const)(
    "rejects a first-party input with the same identity but %s",
    async (difference) => {
      const f = await messageFixture();
      const thread = await f.chat.createThread(f.actor, {
        agentId: f.agent.agentId,
      });
      const requestId = randomUUID();
      const text = "An existing first-party input";
      await f.chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agent.agentId,
          threadId: thread.id,
          clientEventId: requestId,
          prompt: text,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text },
              ...(difference === "additional user context"
                ? [
                    {
                      type: "additional_info" as const,
                      text: "Original context",
                    },
                  ]
                : []),
            ],
          },
        },
        [201],
      );
      const before = await f.chat.listThreadEvents(f.actor, thread.id);
      const failed = await callTool(
        f.auth.token({ scope: defaultScopes }),
        "send_chat_message",
        {
          threadId: thread.id,
          text: difference === "different text" ? `${text} changed` : text,
          requestId,
        },
      );
      expect(failed.isError).toBeTruthy();
      expect(failed.structuredContent).toBeUndefined();
      await expect(
        f.chat.listThreadEvents(f.actor, thread.id),
      ).resolves.toStrictEqual(before);
    },
  );

  it("admits only one payload when concurrent requests reuse an identity with conflicting text", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const results = await Promise.all(
      ["First conflicting payload", "Second conflicting payload"].map(
        (text) => {
          return callTool(token, "send_chat_message", {
            threadId: thread.id,
            requestId,
            text,
          });
        },
      ),
    );
    expect(
      results.filter((result) => {
        return result.isError;
      }),
    ).toHaveLength(1);
    const successful = results.find((result) => {
      return !result.isError;
    });
    const receipt = mcpSendChatMessageOutputSchema.parse(
      successful?.structuredContent,
    );
    expect(receipt).toMatchObject({
      inputRef: { eventId: requestId },
      replayed: false,
    });
    const messages = (await getMessages(token, { threadId: thread.id }))
      .messages;
    expect(messages).toHaveLength(1);
    expect([
      "First conflicting payload",
      "Second conflicting payload",
    ]).toContain(messages[0]?.text);
    expect(
      (await f.chat.listThreadEvents(f.actor, thread.id)).events.filter(
        (event) => {
          return event.id === requestId;
        },
      ),
    ).toHaveLength(1);
  });

  it("finishes an admitted send after its HTTP caller disconnects and recovers the original receipt", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: thread.id,
      text: "Recover this interrupted response",
      requestId: randomUUID(),
    };
    const token = f.auth.token({ scope: defaultScopes });
    // Infrastructure exception: an HTTP caller cannot pause a database lock.
    // Hold only this owned thread to disconnect after admission but before its
    // write commits, then verify the resulting conversation through real APIs.
    const lock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    const controller = new AbortController();
    const app = createAppWithRoutes({
      routes: mcpServerRoutes,
      signal: context.signal,
    });
    const pending = settleIncludingAbort(
      (async () => {
        const response = await app.request(
          new Request(resource, {
            method: "POST",
            headers: {
              ...protocolHeaders(
                token,
                "tools/call",
                true,
                "send_chat_message",
              ),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(
              requestBody("tools/call", true, {
                name: "send_chat_message",
                arguments: args,
              }),
            ),
            signal: controller.signal,
          }),
        );
        return { status: response.status, body: await response.text() };
      })(),
    );
    onTestFinished(async () => {
      controller.abort();
      lock.release();
      await lock.done;
      await pending;
    });
    await expect.poll(lock.blockedWaiterCount).toBeGreaterThan(0);
    controller.abort();
    lock.release();
    await lock.done;
    await pending;
    await flushWaitUntilForTest();
    const recovered = await sendMessage(token, args);
    expect(recovered).toMatchObject({
      inputRef: { threadId: thread.id, eventId: args.requestId },
      replayed: true,
      disposition: "rejected",
      runId: null,
    });
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toMatchObject([{ text: args.text }]);
    expect(
      (await f.chat.listThreadEvents(f.actor, thread.id)).events.filter(
        (event) => {
          return event.id === args.requestId;
        },
      ),
    ).toHaveLength(1);
  });

  it("rolls back the losing thread when two conversations concurrently reuse one request identity", async () => {
    const f = await messageFixture();
    const threads = await Promise.all([
      f.chat.createThread(f.actor, { agentId: f.agent.agentId }),
      f.chat.createThread(f.actor, { agentId: f.agent.agentId }),
    ]);
    for (const thread of threads) {
      await f.chat.patchThread(f.actor, thread.id, {
        draftUserMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Preserve the losing conversation draft" },
          ],
        },
      });
    }
    const before = await Promise.all(
      threads.map((thread) => {
        return f.chat.readThread(f.actor, thread.id);
      }),
    );
    // Infrastructure exception: separate requests cannot choose where their
    // transactions pause. Owned row locks make both senders reach the write
    // boundary before either identity can commit, without changing any rows.
    const locks = await Promise.all(
      threads.map((thread) => {
        return holdChatThreadRowLockFixture({
          threadId: thread.id,
          signal: context.signal,
        });
      }),
    );
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const pending = threads.map((thread) => {
      return settleIncludingAbort(
        callTool(token, "send_chat_message", {
          threadId: thread.id,
          text: "Exactly one conversation may accept this identity",
          requestId,
        }),
      );
    });
    onTestFinished(async () => {
      for (const lock of locks) {
        lock.release();
      }
      await Promise.all(
        locks.map((lock) => {
          return lock.done;
        }),
      );
      await Promise.allSettled(pending);
    });
    for (const lock of locks) {
      await expect.poll(lock.blockedWaiterCount).toBeGreaterThan(0);
    }
    for (const lock of locks) {
      lock.release();
    }
    await Promise.all(
      locks.map((lock) => {
        return lock.done;
      }),
    );
    const results = (await Promise.all(pending)).map((result) => {
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    });
    expect(
      results.filter((result) => {
        return result.isError;
      }),
    ).toHaveLength(1);
    for (const [index, result] of results.entries()) {
      const thread = threads[index];
      if (!thread) {
        throw new Error("Expected one request per conversation");
      }
      if (result.isError) {
        await expect(
          f.chat.readThread(f.actor, thread.id),
        ).resolves.toStrictEqual(before[index]);
        expect(
          (await getMessages(token, { threadId: thread.id })).messages,
        ).toStrictEqual([]);
      } else {
        const receipt = mcpSendChatMessageOutputSchema.parse(
          result.structuredContent,
        );
        expect(receipt).toMatchObject({
          inputRef: { threadId: thread.id, eventId: requestId },
          replayed: false,
        });
        expect(
          (await getMessages(token, { threadId: thread.id })).messages,
        ).toHaveLength(1);
      }
    }
  });

  it("expires an accepted identity after its absolute retry window without admitting another input", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: thread.id,
      text: "Absolute retry window",
      requestId: randomUUID(),
    };
    const receipt = await sendMessage(
      f.auth.token({ scope: defaultScopes }),
      args,
    );
    // Clerk validates real wall time while the receipt uses scoped app time.
    // Keep this credential valid across both clocks to isolate receipt expiry.
    const expiryToken = f.auth.token({
      scope: defaultScopes,
      exp: Math.floor((Date.parse(receipt.retryUntil) + 60_000) / 1000),
    });
    const before = await f.chat.listThreadEvents(f.actor, thread.id);
    await withMockNowForTest(Date.parse(receipt.retryUntil) - 1, async () => {
      const replay = await sendMessage(expiryToken, args);
      expect(replay).toStrictEqual({ ...receipt, replayed: true });
    });
    await withMockNowForTest(Date.parse(receipt.retryUntil) + 1, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const expired = await callTool(expiryToken, "send_chat_message", args);
        expect(expired.isError).toBeTruthy();
        expect(expired.structuredContent).toBeUndefined();
        expect(expired.content[0]?.text).toContain("expired");
      }
    });
    await expect(
      f.chat.listThreadEvents(f.actor, thread.id),
    ).resolves.toStrictEqual(before);
  });

  it("rechecks current thread authorization before disclosing an accepted receipt", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: thread.id,
      text: "PRIVATE_MCP_RECEIPT",
      requestId: randomUUID(),
    };
    const token = f.auth.token({ scope: defaultScopes });
    const submitted = await sendMessage(token, args);
    const strangers = [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ];
    for (const actor of strangers) {
      if (!actor.orgId) {
        throw new Error("Expected an organization for an OAuth peer");
      }
      await updateFeatureSwitchesForUser(
        context,
        {
          userId: actor.userId,
          orgId: actor.orgId,
        },
        { [FeatureSwitchKey.McpServer]: true },
      );
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const foreignToken = f.auth.token({
        sub: actor.userId,
        org_id: actor.orgId,
        scope: defaultScopes,
      });
      const failure = await callTool(foreignToken, "send_chat_message", args);
      const missing = await callTool(foreignToken, "send_chat_message", {
        ...args,
        threadId: randomUUID(),
      });
      expect(failure).toStrictEqual(missing);
      expect(failure.isError).toBeTruthy();
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_MCP_RECEIPT");
      const hiddenStatus = await callTool(foreignToken, "get_chat_status", {
        threadId: thread.id,
        inputRef: submitted.inputRef,
      });
      const missingThreadId = randomUUID();
      await expect(
        callTool(foreignToken, "get_chat_status", {
          threadId: missingThreadId,
          inputRef: { ...submitted.inputRef, threadId: missingThreadId },
        }),
      ).resolves.toStrictEqual(hiddenStatus);
      expect(hiddenStatus.isError).toBeTruthy();
      expect(hiddenStatus.structuredContent).toBeUndefined();
      await expect(
        revokeMessage(foreignToken, thread.id, args.requestId),
      ).resolves.toMatchObject({ outcome: "unavailable", runId: null });
    }
    await f.chat.deleteThread(f.actor, thread.id);
    expect(
      (await callTool(token, "send_chat_message", args)).isError,
    ).toBeTruthy();
    expect(
      (
        await callTool(token, "get_chat_status", {
          threadId: thread.id,
          inputRef: submitted.inputRef,
        })
      ).isError,
    ).toBeTruthy();
  });

  it.each([
    {
      name: "create_chat_thread",
      scope: "okou:chat:manage",
      args: {
        requestId: randomUUID(),
        agentId: randomUUID(),
        title: "Scope check",
        model: "claude-sonnet-5",
      },
    },
    {
      name: "update_chat_thread",
      scope: "okou:chat:manage",
      args: {
        requestId: randomUUID(),
        threadId: randomUUID(),
        patch: { title: "Scope check" },
      },
    },
    {
      name: "send_chat_message",
      scope: "okou:chat:send",
      args: {
        threadId: randomUUID(),
        text: "No grant",
        requestId: randomUUID(),
      },
    },
    {
      name: "revoke_queued_message",
      scope: "okou:run:cancel",
      args: { threadId: randomUUID(), inputId: randomUUID() },
    },
    {
      name: "cancel_run",
      scope: "okou:run:cancel",
      args: { runId: randomUUID() },
    },
  ])(
    "requires $scope for manual $name invocation",
    async ({ name, scope, args }) => {
      const auth = await fixture();
      const token = auth.token({
        scope: defaultScopes
          .split(" ")
          .filter((value) => {
            return value !== scope;
          })
          .join(" "),
      });
      const listed = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/list"),
          body: requestBody("tools/list"),
        }),
        [200],
      );
      const tools = z
        .object({
          result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
        })
        .parse(rpc(listed.body)).result.tools;
      expect(
        tools.some((tool) => {
          return tool.name === name;
        }),
      ).toBeFalsy();
      expect(
        tools.some((tool) => {
          return tool.name === "get_chat_messages";
        }),
      ).toBeTruthy();
      const response = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/call", true, name),
          body: requestBody("tools/call", true, { name, arguments: args }),
        }),
        [200],
      );
      expect(rpc(response.body)).toMatchObject({
        error: { message: expect.any(String) },
      });
    },
  );

  it("rejects unsupported send controls and invalid text before enqueueing", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token({ scope: defaultScopes });
    const base = {
      threadId: thread.id,
      text: "Only ordinary user input",
      requestId: randomUUID(),
    };
    for (const args of [
      { ...base, text: " \n\t " },
      { ...base, text: "x".repeat(32_001) },
      { ...base, requestId: "not-a-uuid" },
      { ...base, model: "claude-sonnet-5" },
      { ...base, agentId: f.agent.agentId },
    ]) {
      const failed = await callTool(token, "send_chat_message", args);
      expect(failed.isError).toBeTruthy();
      expect(failed.structuredContent).toBeUndefined();
    }
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toStrictEqual([]);
  });

  it.each(["lowercase", "uppercase"] as const)(
    "withdraws pending input exactly once without cancelling its active run (%s UUIDs)",
    async (letterCase) => {
      const f = await chatRunFixture();
      const active = await f.chat.requestSendEvent(
        f.actor,
        { agentId: f.agent.agentId, prompt: "Keep this run active" },
        [201],
      );
      if (active.status !== 201 || !active.body.runId) {
        throw new Error("Expected an active run");
      }
      const runId = active.body.runId;
      onTestFinished(async () => {
        await f.runs.requestCancelRun(f.actor, runId, [200]);
      });
      const token = f.auth.token({ scope: defaultScopes });
      const args = {
        threadId: active.body.threadId,
        text: "Withdraw only this pending input",
        requestId: randomUUID(),
      };
      const sent = await sendMessage(token, args);
      expect(sent).toMatchObject({ disposition: "queued", runId: null });
      await expect(
        getStatus(token, { threadId: args.threadId, inputRef: sent.inputRef }),
      ).resolves.toMatchObject({
        input: { state: "queued", runId: null },
        run: null,
        runSelection: "input",
        output: { state: "unavailable", reason: "no_associated_run" },
      });
      const revoked = await revokeMessage(
        token,
        letterCase === "uppercase"
          ? args.threadId.toUpperCase()
          : args.threadId,
        letterCase === "uppercase"
          ? args.requestId.toUpperCase()
          : args.requestId,
      );
      expect(revoked).toMatchObject({
        threadId: args.threadId,
        inputId: args.requestId,
        outcome: "revoked",
      });
      await expect(
        revokeMessage(token, args.threadId, args.requestId),
      ).resolves.toMatchObject({ outcome: "already_revoked" });
      await expect(sendMessage(token, args)).resolves.toMatchObject({
        inputRef: sent.inputRef,
        replayed: true,
        disposition: "revoked",
        runId: null,
      });
      await expect(
        getStatus(token, { threadId: args.threadId, inputRef: sent.inputRef }),
      ).resolves.toMatchObject({
        input: {
          ref: sent.inputRef,
          state: "revoked",
          runId: null,
          visibleMessageRef: null,
        },
        run: null,
        output: { state: "unavailable", reason: "no_associated_run" },
        retryAfterMs: null,
      });
      expect(
        (await getMessages(token, { threadId: args.threadId })).messages.map(
          (message) => {
            return message.text;
          },
        ),
      ).toStrictEqual(["Keep this run active"]);
      await expect(f.runs.readRun(f.actor, runId)).resolves.toMatchObject({
        status: "pending",
      });
      expect(
        (await f.chat.listThreadEvents(f.actor, args.threadId)).events.filter(
          (event) => {
            return (
              event.eventType === "control.revoke" &&
              event.revokesEventId === args.requestId
            );
          },
        ),
      ).toHaveLength(1);
      const before = await f.chat.listThreadEvents(f.actor, args.threadId);
      await expect(
        revokeMessage(token, args.threadId, randomUUID()),
      ).resolves.toMatchObject({ outcome: "unavailable" });
      await expect(
        f.chat.listThreadEvents(f.actor, args.threadId),
      ).resolves.toStrictEqual(before);
    },
  );

  it("starts an ordinary run and denies cancellation by another user or organization", async () => {
    const f = await chatRunFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token({ scope: defaultScopes });
    const sent = await sendMessage(token, {
      threadId: thread.id,
      text: "Start through the normal run scheduler",
      requestId: randomUUID(),
    });
    if (!sent.runId) {
      throw new Error(
        "Expected the MCP submission to be associated with a run",
      );
    }
    const runId = sent.runId;
    onTestFinished(async () => {
      await f.runs.requestCancelRun(f.actor, runId, [200]);
    });
    expect(sent.disposition).toBe("associated");
    await expect(f.runs.readRun(f.actor, runId)).resolves.toMatchObject({
      status: "pending",
    });
    const bdd = createBddApi(context);
    for (const actor of [
      bdd.user({ orgId: f.auth.orgId }),
      bdd.user({ userId: f.auth.userId }),
    ]) {
      if (!actor.orgId) {
        throw new Error("Expected organization for cancellation authorization");
      }
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        { [FeatureSwitchKey.McpServer]: true },
      );
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const failure = await callTool(
        f.auth.token({
          scope: defaultScopes,
          sub: actor.userId,
          org_id: actor.orgId,
        }),
        "cancel_run",
        { runId },
      );
      expect(failure.isError).toBeTruthy();
      expect(failure.structuredContent).toBeUndefined();
      expect(failure.content[0]?.text).toContain("No such run");
    }
    await expect(f.runs.readRun(f.actor, runId)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("does not withdraw reserved input and reports its later association with the same active run", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const initial = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Active steer target",
    });
    if (!initial.runId) {
      throw new Error("Expected MCP input to start the steer target");
    }
    const active = { threadId: thread.id, runId: initial.runId };
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, active.runId);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
    const args = {
      threadId: active.threadId,
      text: "Steer the current run",
      requestId: randomUUID(),
    };
    const sent = await sendMessage(token, args);
    expect(sent).toMatchObject({ disposition: "queued", runId: null });
    const reserved = await f.api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the runner to reserve MCP input");
    }
    expect(reserved.eventIds).toStrictEqual([args.requestId]);
    const recall = await revokeMessage(token, args.threadId, args.requestId);
    expect(recall).toMatchObject({
      outcome: "not_revocable",
      reason: "reserved_or_associated",
    });
    await expect(sendMessage(token, args)).resolves.toMatchObject({
      inputRef: sent.inputRef,
      replayed: true,
      disposition: "reserved",
      runId: active.runId,
    });
    await expect(
      getStatus(token, { threadId: args.threadId, inputRef: sent.inputRef }),
    ).resolves.toMatchObject({
      input: {
        ref: sent.inputRef,
        state: "reserved",
        deliveryMode: "unknown",
        runId: active.runId,
      },
      run: { id: active.runId, status: "running" },
      output: { state: "pending", messageRefs: [] },
    });
    await expect(
      f.api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    await expect(sendMessage(token, args)).resolves.toMatchObject({
      inputRef: sent.inputRef,
      replayed: true,
      disposition: "associated",
      runId: active.runId,
    });
    const delivered = await getStatus(token, {
      threadId: args.threadId,
      inputRef: sent.inputRef,
    });
    expect(delivered).toMatchObject({
      input: {
        ref: sent.inputRef,
        state: "delivered",
        deliveryMode: "steer",
        runId: active.runId,
      },
      run: { id: active.runId, status: "running" },
      runSelection: "input",
      output: { state: "pending", messageRefs: [] },
    });
    expect(delivered.input?.visibleMessageRef).not.toStrictEqual(sent.inputRef);
    await expect(
      revokeMessage(token, args.threadId, args.requestId),
    ).resolves.toMatchObject({
      outcome: "not_revocable",
      reason: "reserved_or_associated",
      runId: active.runId,
    });
    expect(
      (await getMessages(token, { threadId: args.threadId })).messages,
    ).toMatchObject([
      { text: "Active steer target", runId: active.runId },
      { text: args.text, runId: active.runId },
    ]);
    await expect(
      f.api.readRun(actor.actor, active.runId),
    ).resolves.toMatchObject({
      status: "running",
    });
    await f.webhooks.requestAgentEvents(
      {
        runId: active.runId,
        events: Array.from({ length: 21 }, (_, sequenceNumber) => {
          return {
            type: "assistant",
            sequenceNumber,
            message: {
              content: [
                { type: "text", text: `Shared output ${sequenceNumber}` },
              ],
            },
          };
        }),
      },
      claimed.sandboxHeaders,
      [200],
    );
    const steered = await getStatus(token, {
      threadId: args.threadId,
      inputRef: sent.inputRef,
    });
    const launched = await getStatus(token, {
      threadId: args.threadId,
      inputRef: initial.inputRef,
    });
    expect(launched.run).toStrictEqual(steered.run);
    expect(launched.output).toStrictEqual(steered.output);
    expect(steered.output).toMatchObject({ state: "partial", hasMore: true });
    expect(steered.output.messageRefs).toHaveLength(20);
    if (!steered.messages) {
      throw new Error("Expected shared output retrieval instructions");
    }
    const page = await getMessages(token, steered.messages.arguments);
    expect(
      page.messages.map((message) => {
        return message.ref;
      }),
    ).toStrictEqual(steered.output.messageRefs);
    expect(page.olderCursor).not.toBeNull();
    installFakeChatEventR2(context, []);
    // Infrastructure exception: public sends cannot backdate acceptance past
    // the database retention cutoff. Retaining this settled source also removes
    // its delivery receipt, while canonical archived replacement links survive.
    await setQueuedUserMessageCreatedAtFixture({
      eventId: sent.inputRef.eventId,
      createdAt: new Date(now() - 31 * 24 * 60 * 60 * 1000),
    });
    await snapshotMessages(args.threadId);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [args.threadId] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const archived = await getStatus(token, {
      threadId: args.threadId,
      inputRef: sent.inputRef,
    });
    expect(archived.input).toStrictEqual({
      ...steered.input,
      state: "associated",
      deliveryMode: "unknown",
    });
    expect(archived.run).toStrictEqual(steered.run);
    expect(archived.output).toStrictEqual(steered.output);
  });

  it.each(["lowercase", "uppercase"] as const)(
    "cancels an owned run cooperatively and keeps repeated cancellation idempotent (%s UUIDs)",
    async (letterCase) => {
      const auth = await fixture();
      const f = createChatEventsFixture(context);
      const actor = await f.entitledChatActor({
        userId: auth.userId,
        orgId: auth.orgId,
      });
      const active = await f.sendChatRun(actor.actor, {
        agentId: actor.agentId,
        prompt: "Cancel this whole run",
      });
      const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
      const token = auth.token({ scope: defaultScopes });
      const result = await cancelRun(
        token,
        letterCase === "uppercase" ? active.runId.toUpperCase() : active.runId,
      );
      expect(result).toMatchObject({
        runId: active.runId,
        status: "cancelled",
        alreadyCancelled: false,
      });
      await flushWaitUntilForTest();
      await expect(
        f.api.readRun(actor.actor, active.runId),
      ).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(
        f.api.readRunnerCancellation(
          claimed.claim.sandboxToken,
          active.runId,
          actor.runnerGroup,
        ),
      ).resolves.toMatchObject({ state: "present", mode: "cooperative" });
      await expect(cancelRun(token, active.runId)).resolves.toMatchObject({
        runId: active.runId,
        status: "cancelled",
        alreadyCancelled: true,
      });
      await flushWaitUntilForTest();
      expect(
        (
          await f.chat.listThreadEvents(actor.actor, active.threadId)
        ).events.filter((event) => {
          return (
            event.eventType === "run.cancelled" && event.runId === active.runId
          );
        }),
      ).toHaveLength(1);
    },
  );

  it("rejects cancellation of a completed run without rewriting its terminal state", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const active = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Complete normally",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
    await f.completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    const result = await callTool(
      auth.token({ scope: defaultScopes }),
      "cancel_run",
      { runId: active.runId },
    );
    expect(result.isError).toBeTruthy();
    expect(result.structuredContent).toBeUndefined();
    await expect(
      f.api.readRun(actor.actor, active.runId),
    ).resolves.toMatchObject({
      status: "completed",
    });
  });
});

describe("MCP canonical message reads", () => {
  it("pages latest and earlier messages with genuine references and the original input time after rejection", async () => {
    const f = await messageFixture();
    const sent = await f.send("Message 0");
    for (let index = 1; index < 23; index++) {
      await f.send(`Message ${index}`, sent.threadId);
    }
    const token = f.auth.token();
    const canonical = await f.chat.listThreadEvents(f.actor, sent.threadId);
    const latest = await getMessages(token, { threadId: sent.threadId });
    expect(latest.messages).toHaveLength(20);
    expect(
      latest.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(
      Array.from({ length: 20 }, (_, index) => {
        return `Message ${index + 3}`;
      }),
    );
    expect(latest.newerCursor).toBeNull();
    expect(latest.olderCursor).not.toBeNull();
    const older = await getMessages(token, {
      threadId: sent.threadId,
      cursor: latest.olderCursor,
    });
    expect(
      older.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(["Message 0", "Message 1", "Message 2"]);
    expect(older.olderCursor).toBeNull();
    const all = [...older.messages, ...latest.messages];
    expect(
      new Set(
        all.map((message) => {
          return message.ref.eventId;
        }),
      ).size,
    ).toBe(23);
    for (const message of all) {
      const original = canonical.events.find((event) => {
        return event.id === message.ref.eventId;
      });
      const initialInput = canonical.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.userMessage.parts.some((part) => {
            return part.type === "text" && part.text === message.text;
          })
        );
      });
      expect(original).toBeDefined();
      expect(initialInput).toBeDefined();
      expect(message).toMatchObject({
        ref: {
          threadId: sent.threadId,
          eventId: original?.id,
          seqId: original?.seqId,
        },
        createdAt: initialInput?.createdAt,
        eventType: "input.rejected",
        role: "user",
        runId: null,
        textOffset: 0,
        textComplete: true,
        fileOffset: 0,
        filesComplete: true,
        nextContentCursor: null,
      });
      expect(new URL(message.url).pathname).toBe(`/chats/${sent.threadId}`);
    }
  });

  it("reads around either coordinate and traverses both directions without repeating the anchor", async () => {
    const f = await messageFixture();
    const sent = await f.send("Around 0");
    for (let index = 1; index < 9; index++) {
      await f.send(`Around ${index}`, sent.threadId);
    }
    const token = f.auth.token();
    const all = await getMessages(token, { threadId: sent.threadId });
    const anchor = all.messages[4];
    if (!anchor) {
      throw new Error("Expected middle message");
    }
    const filters = { threadId: sent.threadId, limit: 3 };
    const centered = await getMessages(token, {
      ...filters,
      around: { eventId: anchor.ref.eventId },
    });
    expect(
      centered.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(["Around 3", "Around 4", "Around 5"]);
    expect(
      (
        await getMessages(token, {
          ...filters,
          around: { seqId: anchor.ref.seqId },
        })
      ).messages,
    ).toStrictEqual(centered.messages);
    const older = await getMessages(token, {
      ...filters,
      cursor: centered.olderCursor,
    });
    const newer = await getMessages(token, {
      ...filters,
      cursor: centered.newerCursor,
    });
    expect([
      ...older.messages,
      ...centered.messages,
      ...newer.messages,
    ]).toStrictEqual(all.messages);
    for (const around of [
      { eventId: randomUUID() },
      { eventId: anchor.ref.eventId, seqId: anchor.ref.seqId + 1 },
    ]) {
      const failure = await callTool(token, "get_chat_messages", {
        ...filters,
        around,
      });
      expect(failure.isError).toBeTruthy();
      expect(failure.structuredContent).toBeUndefined();
    }
  });

  it("returns an empty owned thread without changing any read or lifecycle state", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const before = await f.chat.readThread(f.actor, thread.id);
    await expect(
      getMessages(f.auth.token(), { threadId: thread.id }),
    ).resolves.toMatchObject({
      messages: [],
      olderCursor: null,
      newerCursor: null,
    });
    await expect(f.chat.readThread(f.actor, thread.id)).resolves.toStrictEqual(
      before,
    );
  });

  it("excludes private user context and private citation markup while retaining assistant work and artifact links", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Visible request",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Visible request" },
          { type: "additional_info", text: "PRIVATE_USER_CONTEXT_CANARY" },
        ],
      },
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    const artifact = `/artifacts/${randomUUID()}?view=original`;
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [
                { type: "text", text: "I have checked the source material." },
                { type: "thinking", thinking: "PRIVATE_THINKING_CANARY" },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [
                {
                  type: "text",
                  text: `Download [the report](${artifact}).<oai-mem-citation><citation_entries>PRIVATE_CITATION_CANARY</citation_entries></oai-mem-citation>`,
                },
              ],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    const page = await getMessages(auth.token(), {
      threadId: sent.threadId,
      runId: sent.runId,
    });
    expect(
      page.messages.map((message) => {
        return message.role;
      }),
    ).toStrictEqual(["user", "assistant", "assistant"]);
    expect(page.messages[1]?.text).toBe("I have checked the source material.");
    expect(page.messages[2]?.text).toContain(`[the report](${artifact})`);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_");
    expect(JSON.stringify(page)).not.toContain("oai-mem-citation");
    const filters = { threadId: sent.threadId, runId: sent.runId, limit: 1 };
    const partial = await getMessages(auth.token(), filters);
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "item.completed",
            sequenceNumber: 2,
            item: {
              id: "private-reasoning",
              type: "reasoning",
              text: "PRIVATE_REASONING_EVENT",
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    const before = await f.chat.readThread(actor.actor, sent.threadId);
    expect(
      (
        await getMessages(auth.token(), {
          ...filters,
          cursor: partial.olderCursor,
        })
      ).messages[0]?.text,
    ).toBe("I have checked the source material.");
    expect(
      page.messages.every((message) => {
        return message.runId === sent.runId;
      }),
    ).toBeTruthy();
    expect(
      (
        await getMessages(auth.token(), {
          threadId: sent.threadId,
          runId: randomUUID(),
        })
      ).messages,
    ).toStrictEqual([]);
    await expect(
      f.chat.readThread(actor.actor, sent.threadId),
    ).resolves.toStrictEqual(before);
    await f.cancelChatRun(actor.actor, sent.runId);
  });

  it("recalls queued input from the visible stream and invalidates its previous reference", async () => {
    const f = await chatRunFixture();
    const sent = await f.chat.requestSendEvent(
      f.actor,
      { agentId: f.agent.agentId, prompt: "Active request" },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected active run");
    }
    await flushWaitUntilForTest();
    const queued = await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId: sent.body.threadId,
        prompt: `Recall this queued request\n${"😀".repeat(6000)}`,
      },
      [201],
    );
    expect(queued.status).toBe(201);
    const token = f.auth.token();
    const before = await getMessages(token, { threadId: sent.body.threadId });
    const target = before.messages.find((message) => {
      return message.text.startsWith("Recall this queued request\n");
    });
    if (!target) {
      throw new Error("Expected queued visible input");
    }
    expect(target.nextContentCursor).not.toBeNull();
    await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId: sent.body.threadId,
        revokesEventId: target.ref.eventId,
      },
      [201],
    );
    const after = await getMessages(token, { threadId: sent.body.threadId });
    expect(
      after.messages.some((message) => {
        return message.ref.eventId === target.ref.eventId;
      }),
    ).toBeFalsy();
    const staleContent = await callTool(token, "get_chat_messages", {
      threadId: sent.body.threadId,
      cursor: target.nextContentCursor,
    });
    expect(staleContent.isError).toBeTruthy();
    expect(staleContent.structuredContent).toBeUndefined();
    expect(
      (
        await callTool(token, "get_chat_messages", {
          threadId: sent.body.threadId,
          around: { eventId: target.ref.eventId },
        })
      ).isError,
    ).toBeTruthy();
    await f.runs.requestCancelRun(f.actor, sent.body.runId, [200]);
    await flushWaitUntilForTest();
  });

  it("binds cursors to the owner, organization, thread, page size and filters, with absolute expiry", async () => {
    const f = await messageFixture();
    const sent = await f.send("Cursor first");
    await f.send("Cursor second", sent.threadId);
    const args = { threadId: sent.threadId, limit: 1 };
    const page = await getMessages(f.auth.token(), args);
    const cursor = page.olderCursor;
    if (!cursor) {
      throw new Error("Expected older cursor");
    }
    const other = await f.send("Other thread");
    for (const invalid of [
      { ...args, cursor: `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}` },
      { ...args, cursor, limit: 2 },
      { ...args, cursor, runId: randomUUID() },
      { ...args, cursor, threadId: other.threadId },
      { ...args, cursor, around: { seqId: 1 } },
    ]) {
      const failed = await callTool(
        f.auth.token(),
        "get_chat_messages",
        invalid,
      );
      expect(failed.isError).toBeTruthy();
      expect(failed.structuredContent).toBeUndefined();
    }
    await expect(
      getMessages(f.auth.token(), { ...args, cursor }),
    ).resolves.toMatchObject({ messages: [{ text: "Cursor first" }] });
    const longToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      expect(
        (await callTool(longToken, "get_chat_messages", { ...args, cursor }))
          .isError,
      ).toBeTruthy();
      expect((await getMessages(longToken, args)).messages).toHaveLength(1);
    });
  });

  it("does not reveal foreign messages through either references or a signed cursor", async () => {
    const f = await messageFixture();
    const sent = await f.send("Owned message");
    await f.send("Another owned message", sent.threadId);
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 1 };
    const cursor = (await getMessages(token, args)).olderCursor;
    const missing = await callTool(token, "get_chat_messages", {
      threadId: randomUUID(),
    });
    for (const actor of [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ]) {
      const agent = await f.bdd.createAgent(actor, {
        displayName: "Foreign messages",
        visibility: "private",
      });
      const thread = await f.chat.createThread(actor, {
        agentId: agent.agentId,
      });
      await expect(
        callTool(token, "get_chat_messages", { threadId: thread.id }),
      ).resolves.toStrictEqual(missing);
      if (!actor.orgId) {
        throw new Error("Expected organization");
      }
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        { [FeatureSwitchKey.McpServer]: true },
      );
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const denied = await callTool(
        f.auth.token({ sub: actor.userId, org_id: actor.orgId }),
        "get_chat_messages",
        { ...args, cursor },
      );
      expect(denied.isError).toBeTruthy();
      expect(JSON.stringify(denied)).not.toContain("Owned message");
    }
  });

  it("invalidates pagination on visible appends while preserving cursors through metadata-only changes", async () => {
    const f = await messageFixture();
    const sent = await f.send("View first");
    await f.send("View second", sent.threadId);
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 1 };
    const page = await getMessages(token, args);
    await f.chat.renameThread(f.actor, sent.threadId, "Metadata only");
    expect(
      (await getMessages(token, { ...args, cursor: page.olderCursor }))
        .messages[0]?.text,
    ).toBe("View first");
    await f.send("Visible append", sent.threadId);
    const changed = await callTool(token, "get_chat_messages", {
      ...args,
      cursor: page.olderCursor,
    });
    expect(changed.isError).toBeTruthy();
    expect(changed.structuredContent).toBeUndefined();
    expect((await getMessages(token, args)).messages[0]?.text).toBe(
      "Visible append",
    );
  });

  it("delivers long Unicode text without loss through content cursors, even after unrelated appends", async () => {
    const f = await messageFixture();
    const text = "𠮷😀中文é\n".repeat(12_000);
    const sent = await f.send(text);
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 1 };
    const first = await getMessages(token, args);
    const initial = first.messages[0];
    if (!initial?.nextContentCursor) {
      throw new Error("Expected content continuation");
    }
    expect(initial.textComplete).toBeFalsy();
    expect(initial.textOffset).toBe(0);
    await f.send("Unrelated appended message", sent.threadId);
    let combined = initial.text;
    let cursor: string | null = initial.nextContentCursor;
    let segments = 1;
    while (cursor !== null) {
      expect(segments++).toBeLessThan(100);
      const page = await getMessages(token, { ...args, cursor });
      expect(page.messages).toHaveLength(1);
      const segment = page.messages[0];
      if (!segment) {
        throw new Error("Expected continuation segment");
      }
      expect(segment.ref).toStrictEqual(initial.ref);
      expect(segment.text).not.toContain("\uFFFD");
      expect(segment.textOffset).toBeGreaterThan(0);
      combined += segment.text;
      cursor = segment.nextContentCursor;
      if (cursor === null) {
        expect(segment.textComplete).toBeTruthy();
      }
    }
    expect(combined).toBe(text);
  });

  it("keeps byte-bounded pages complete through continuation and retains the requested middle anchor", async () => {
    const f = await messageFixture();
    const sent = await f.send(`Message 0\n${"😀".repeat(6000)}`);
    for (let index = 1; index < 12; index++) {
      await f.send(`Message ${index}\n${"😀".repeat(6000)}`, sent.threadId);
    }
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 50 };
    let page = await getMessages(token, args);
    expect(page.messages.length).toBeLessThan(12);
    const messages = [...page.messages];
    while (page.olderCursor !== null) {
      expect(messages.length).toBeLessThan(12);
      const result = await callTool(token, "get_chat_messages", {
        ...args,
        cursor: page.olderCursor,
      });
      expect(result.isError).not.toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        512 * 1024,
      );
      page = mcpGetChatMessagesOutputSchema.parse(result.structuredContent);
      messages.unshift(...page.messages);
    }
    expect(
      messages.map((message) => {
        return message.text.split("\n")[0];
      }),
    ).toStrictEqual(
      Array.from({ length: 12 }, (_, index) => {
        return `Message ${index}`;
      }),
    );
    expect(
      new Set(
        messages.map((message) => {
          return message.ref.eventId;
        }),
      ).size,
    ).toBe(12);
    for (const message of messages) {
      expect(message.textComplete).toBeFalsy();
      expect(message.nextContentCursor).not.toBeNull();
    }
    const anchor = messages[5];
    if (!anchor) {
      throw new Error("Expected middle large message");
    }
    const centeredResult = await callTool(token, "get_chat_messages", {
      ...args,
      around: { eventId: anchor.ref.eventId },
    });
    expect(centeredResult.isError).not.toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(centeredResult))).toBeLessThan(
      512 * 1024,
    );
    const centered = mcpGetChatMessagesOutputSchema.parse(
      centeredResult.structuredContent,
    );
    expect(centered.messages.length).toBeLessThan(12);
    expect(
      centered.messages.map((message) => {
        return message.ref.eventId;
      }),
    ).toContain(anchor.ref.eventId);
    expect(
      centered.olderCursor !== null || centered.newerCursor !== null,
    ).toBeTruthy();
  });

  it("continues file metadata without dropping original or annotated identities", async () => {
    const f = await messageFixture();
    const files = Array.from({ length: 75 }, (_, index) => {
      return {
        id: randomUUID(),
        filename: `source-${index}.png`,
        size: 42,
      };
    });
    const annotatedFileId = randomUUID();
    f.chat.mockCompletedUploadObjects(f.actor, [
      ...files,
      { id: annotatedFileId, filename: "annotated.png", size: 42 },
    ]);
    const parts: UserMessageDocument["parts"] = files.map((file, index) => {
      return {
        type: "file",
        fileId: file.id,
        filenameSnapshot: file.filename,
        contentType: "image/png",
        ...(index === 0 ? { annotatedFileId, annotations: { marks: [] } } : {}),
      };
    });
    const sent = await f.send("Review these images", undefined, {
      version: 1,
      parts: [{ type: "text", text: "Review these images" }, ...parts],
    });
    const args = { threadId: sent.threadId, limit: 1 };
    const token = f.auth.token();
    let page = await getMessages(token, args);
    const collected: {
      fileId: string;
      filename: string;
      contentType: string;
      annotatedFileId?: string;
    }[] = [];
    let segments = 0;
    for (;;) {
      expect(segments++).toBeLessThan(100);
      const message = page.messages[0];
      if (!message) {
        throw new Error("Expected file segment");
      }
      expect(message.fileOffset).toBe(collected.length);
      collected.push(...message.files);
      if (message.nextContentCursor === null) {
        expect(message.filesComplete).toBeTruthy();
        break;
      }
      page = await getMessages(token, {
        ...args,
        cursor: message.nextContentCursor,
      });
    }
    expect(segments).toBeGreaterThan(1);
    expect(collected).toStrictEqual(
      files.map((file, index) => {
        return {
          fileId: file.id,
          filename: file.filename,
          contentType: "image/png",
          ...(index === 0 ? { annotatedFileId } : {}),
        };
      }),
    );
  });

  it("preserves pages when canonical history moves into a snapshot and merges its PostgreSQL tail", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const sent = await f.send("Archived first");
    await f.send("Archived second", sent.threadId);
    const args = { threadId: sent.threadId, limit: 1 };
    const token = f.auth.token();
    const page = await getMessages(token, args);
    await snapshotMessages(sent.threadId);
    expect(puts.length).toBeGreaterThan(0);
    expect(
      (await getMessages(token, { ...args, cursor: page.olderCursor }))
        .messages[0]?.text,
    ).toBe("Archived first");
    await f.send("PostgreSQL tail", sent.threadId);
    const all = await getMessages(token, { threadId: sent.threadId });
    expect(
      all.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(["Archived first", "Archived second", "PostgreSQL tail"]);
    expect(
      new Set(
        all.messages.map((message) => {
          return message.ref.eventId;
        }),
      ).size,
    ).toBe(3);
  });

  it("continues text and individually bounded file metadata when their combined segment is oversized", async () => {
    const f = await messageFixture();
    const fileId = randomUUID();
    const filename = "f".repeat(60_000);
    const text = "Read this file. ".repeat(600);
    f.chat.mockCompletedUploadObject(f.actor, fileId, "source.png", 42);
    const sent = await f.send(text, undefined, {
      version: 1,
      parts: [
        { type: "text", text },
        {
          type: "file",
          fileId,
          filenameSnapshot: filename,
          contentType: "image/png",
        },
      ],
    });
    const args = { threadId: sent.threadId, limit: 1 };
    const token = f.auth.token();
    let page = await getMessages(token, args);
    let collectedText = "";
    const collectedFiles: { fileId: string; filename: string }[] = [];
    let segments = 0;
    for (;;) {
      expect(segments++).toBeLessThan(20);
      const message = page.messages[0];
      if (!message) {
        throw new Error("Expected a recoverable text/file segment");
      }
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(
        64 * 1024,
      );
      expect(message.textOffset).toBe(collectedText.length);
      expect(message.fileOffset).toBe(collectedFiles.length);
      expect(message.text.length + message.files.length).toBeGreaterThan(0);
      collectedText += message.text;
      collectedFiles.push(...message.files);
      if (message.nextContentCursor === null) {
        expect(message.textComplete).toBeTruthy();
        expect(message.filesComplete).toBeTruthy();
        break;
      }
      page = await getMessages(token, {
        ...args,
        cursor: message.nextContentCursor,
      });
    }
    expect(segments).toBeGreaterThan(1);
    expect(collectedText).toBe(`${text}\n\n[File: ${filename}]`);
    expect(collectedFiles).toStrictEqual([
      { fileId, filename, contentType: "image/png" },
    ]);
  });

  it("reports oversized file metadata explicitly without losing content behind a missing continuation", async () => {
    const f = await messageFixture();
    const fileId = randomUUID();
    f.chat.mockCompletedUploadObject(f.actor, fileId, "source.png", 42);
    const sent = await f.send("Large file metadata", undefined, {
      version: 1,
      parts: [
        { type: "text", text: "Large file metadata" },
        {
          type: "file",
          fileId,
          filenameSnapshot: "📎".repeat(20_000),
          contentType: "image/png",
        },
      ],
    });
    const result = await callTool(f.auth.token(), "get_chat_messages", {
      threadId: sent.threadId,
    });
    expect(result.isError).toBeTruthy();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toContain("metadata");
  });

  it("reads retained snapshot records after their source rows have been deleted", async () => {
    const f = await threadFixture();
    installFakeChatEventR2(context);
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    // Infrastructure exception: public writes cannot backdate an event beyond
    // the retention worker's database-clock cutoff. Reuse its centralized old
    // event fixture; projection, snapshot, retention and MCP reads stay real.
    const eventId = await createStore().set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: thread.id,
        content: "Retained assistant content",
        offsetMs: -60_000,
      },
      context.signal,
    );
    await snapshotMessages(thread.id);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [thread.id] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const messages = await getMessages(f.auth.token(), { threadId: thread.id });
    expect(messages.messages).toMatchObject([
      {
        ref: { eventId },
        text: "Retained assistant content",
        role: "assistant",
      },
    ]);
  });

  it.each(["archive", "archive and tail"] as const)(
    "rejects ambiguous duplicate message identities across %s until the canonical snapshot is repaired",
    async (source) => {
      const f = await messageFixture();
      const puts: RecordedChatEventPut[] = [];
      installFakeChatEventR2(context, puts);
      const sent = await f.send("First archived message");
      onTestFinished(async () => {
        await f.chat.deleteThread(f.actor, sent.threadId);
      });
      await f.send("Second archived message", sent.threadId);
      await snapshotMessages(sent.threadId);
      const archive = puts.at(-1);
      if (!archive) {
        throw new Error("Expected an archive for duplicate identity coverage");
      }
      if (source === "archive and tail") {
        await f.send("Current database tail", sent.threadId);
      }
      const token = f.auth.token();
      const args = { threadId: sent.threadId };
      const before = await getMessages(token, args);
      const firstId = before.messages[0]?.ref.eventId;
      const duplicateId = before.messages.at(-1)?.ref.eventId;
      if (!firstId || !duplicateId || firstId === duplicateId) {
        throw new Error("Expected distinct canonical visible message IDs");
      }
      // Infrastructure exception: legacy persisted archives can contain IDs
      // that the canonical snapshot writer must normalize. Public writes do
      // not produce duplicate live primary keys, so install that historical
      // storage state using the shared fake R2 and snapshot-head fixture.
      const rows = gunzipSync(archive.body)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      const body = gzipSync(
        Buffer.from(
          rows
            .map((row) => {
              return `${JSON.stringify({
                ...row,
                id: row.id === firstId ? duplicateId : row.id,
              })}\n`;
            })
            .join(""),
        ),
      );
      const last = rows.at(-1);
      if (!last) {
        throw new Error("Expected a nonempty historical archive");
      }
      const key = `chat-events/${sent.threadId}/${last.seqId.toString()}-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
      writeFakeChatEventObject(key, body);
      onTestFinished(async () => {
        await deleteFakeChatEventObject(key);
      });
      await updateChatEventSnapshotHead(context, sent.threadId, key);

      const failed = await callTool(token, "get_chat_messages", args);
      expect(failed.isError).toBeTruthy();
      expect(failed.structuredContent).toBeUndefined();
      expect(failed.content[0]?.text).toContain("could not be read completely");
      for (const message of before.messages) {
        expect(JSON.stringify(failed)).not.toContain(message.text);
      }

      await snapshotMessages(sent.threadId);
      const repaired = await getMessages(token, args);
      expect(
        repaired.messages.map((message) => {
          return message.text;
        }),
      ).toStrictEqual(
        before.messages.map((message) => {
          return message.text;
        }),
      );
      expect(
        new Set(
          repaired.messages.map((message) => {
            return message.ref.eventId;
          }),
        ).size,
      ).toBe(repaired.messages.length);
    },
  );

  it("reports missing, corrupt or oversized archives instead of returning an apparently complete tail", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const sent = await f.send("Required archived source");
    await snapshotMessages(sent.threadId);
    const archive = puts.at(-1);
    if (!archive) {
      throw new Error("Expected stored archive");
    }
    await f.send("Visible tail alone is incomplete", sent.threadId);
    for (const body of [
      Buffer.from("not a gzip archive"),
      Buffer.alloc(8 * 1024 * 1024 + 1),
      null,
    ]) {
      if (body === null) {
        await deleteFakeChatEventObject(archive.key);
      } else {
        writeFakeChatEventObject(archive.key, body);
      }
      const failed = await callTool(f.auth.token(), "get_chat_messages", {
        threadId: sent.threadId,
      });
      expect(failed.isError).toBeTruthy();
      expect(failed.structuredContent).toBeUndefined();
      expect(JSON.stringify(failed)).not.toContain(
        "Visible tail alone is incomplete",
      );
    }
    writeFakeChatEventObject(archive.key, archive.body);
    expect(
      (await getMessages(f.auth.token(), { threadId: sent.threadId })).messages,
    ).toHaveLength(2);
  });

  it.each(["decoded bytes", "event rows"] as const)(
    "rejects archives exceeding the %s budget with an explicit resource error",
    async (budget) => {
      const f = await messageFixture();
      installFakeChatEventR2(context);
      const sent = await f.send("Archive resource limits");
      onTestFinished(async () => {
        await f.chat.deleteThread(f.actor, sent.threadId);
      });
      await snapshotMessages(sent.threadId);
      // Infrastructure exception: imported historical archives may exceed the
      // MCP envelope. The normal archiver compacts control rows, so install a
      // checksum-valid old-object boundary through its centralized head fixture.
      const count = budget === "event rows" ? 50_001 : 1;
      const body =
        budget === "decoded bytes"
          ? Buffer.alloc(32 * 1024 * 1024 + 1, "a")
          : Buffer.from(
              Array.from({ length: count }, (_, index) => {
                return (
                  JSON.stringify({
                    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
                    chatThreadId: sent.threadId,
                    runId: null,
                    revokesEventId: null,
                    contextType: null,
                    contextId: null,
                    runEventSequenceNumber: null,
                    runEventId: null,
                    seqId: index + 1,
                    createdAt: "2026-09-01T00:00:00.000Z",
                    eventType: "browser.close",
                    payload: null,
                  }) + "\n"
                );
              }).join(""),
            );
      const compressed = gzipSync(body);
      expect(compressed.length).toBeLessThan(8 * 1024 * 1024);
      const key = `chat-events/${sent.threadId}/${count}-${createHash("sha256").update(compressed).digest("hex")}.ndjson.gz`;
      writeFakeChatEventObject(key, compressed);
      onTestFinished(async () => {
        await deleteFakeChatEventObject(key);
      });
      await updateChatEventSnapshotHead(
        context,
        sent.threadId,
        key,
        budget === "event rows" ? count : undefined,
      );
      const result = await callTool(f.auth.token(), "get_chat_messages", {
        threadId: sent.threadId,
        limit: 1,
      });
      expect(result.isError).toBeTruthy();
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]?.text).toMatch(/budget|limit/u);
    },
  );

  it("rejects a historical database payload exceeding the read budget even for a one-message page", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    onTestFinished(async () => {
      await f.chat.deleteThread(f.actor, thread.id);
    });
    // Infrastructure exception: old/imported persisted rows can exceed today's
    // HTTP body bound. Seed that storage state through the retention fixture,
    // then assert the real authenticated tool fails without leaking a prefix.
    await createStore().set(
      seedRetentionOutputEvent$,
      { chatThreadId: thread.id, content: "x".repeat(32 * 1024 * 1024) },
      context.signal,
    );
    const result = await callTool(f.auth.token(), "get_chat_messages", {
      threadId: thread.id,
      limit: 1,
    });
    expect(result.isError).toBeTruthy();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toContain("32 MiB");
  });

  it.each(["get_chat_messages", "search_chat_messages"] as const)(
    "propagates %s cancellation into a partially consumed archive and permits a later fresh read",
    async (toolName) => {
      const f = await messageFixture();
      const puts: RecordedChatEventPut[] = [];
      installFakeChatEventR2(context, puts);
      const sent = await f.send("Read after cancellation");
      await snapshotMessages(sent.threadId);
      const archive = puts.at(-1);
      if (!archive) {
        throw new Error("Expected archive for cancellation");
      }
      const args =
        toolName === "get_chat_messages"
          ? { threadId: sent.threadId }
          : { threadId: sent.threadId, query: "cancellation" };
      const firstChunkRead = createDeferredPromise<void>(context.signal);
      const storageAborted = createDeferredPromise<void>(context.signal);
      const controller = new AbortController();
      onTestFinished(() => {
        controller.abort();
      });
      context.mocks.s3.send.mockImplementation(
        (command: unknown, options: unknown) => {
          const input = z
            .object({ input: z.object({ Key: z.string() }) })
            .parse(command).input;
          expect(input.Key).toBe(archive.key);
          const providerSignal = z
            .object({ abortSignal: z.instanceof(AbortSignal) })
            .parse(options).abortSignal;
          return Promise.resolve({
            ContentLength: archive.body.length,
            Body: {
              async *[Symbol.asyncIterator]() {
                yield archive.body.subarray(0, 8);
                const held = createDeferredPromise<void>(providerSignal);
                providerSignal.addEventListener(
                  "abort",
                  () => {
                    storageAborted.resolve();
                  },
                  { once: true },
                );
                firstChunkRead.resolve();
                await held.promise;
              },
            },
          });
        },
      );
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const pending = settleIncludingAbort(
        (async () => {
          const response = await app.request(
            new Request(resource, {
              method: "POST",
              headers: {
                ...protocolHeaders(
                  f.auth.token(),
                  "tools/call",
                  true,
                  toolName,
                ),
                "Content-Type": "application/json",
              },
              body: JSON.stringify(
                requestBody("tools/call", true, {
                  name: toolName,
                  arguments: args,
                }),
              ),
              signal: controller.signal,
            }),
          );
          return { status: response.status, body: await response.text() };
        })(),
      );
      await Promise.race([
        firstChunkRead.promise,
        pending.then((result) => {
          throw new Error(
            `MCP request ended before reading its archive: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      controller.abort();
      await storageAborted.promise;
      const result = await pending;
      if (result.ok) {
        if (result.value.status === 200) {
          expect(rpc(result.value.body)).toMatchObject({
            result: { isError: true },
          });
        } else {
          expect(result.value.status).toBeGreaterThanOrEqual(400);
        }
      } else {
        expect(result.error).toMatchObject({ name: "AbortError" });
      }
      installFakeChatEventR2(context);
      const fresh =
        toolName === "get_chat_messages"
          ? (await getMessages(f.auth.token(), args)).messages[0]?.text
          : (await searchMessages(f.auth.token(), args)).matches[0]?.excerpt
              .text;
      expect(fresh).toBe("Read after cancellation");
    },
  );

  it.each([
    { limit: 0 },
    { limit: 51 },
    { around: {} },
    { around: { seqId: 0 } },
    { cursor: "x".repeat(4097) },
  ])("rejects malformed message arguments %j", async (invalid) => {
    const auth = await fixture();
    expect(
      (
        await callTool(auth.token(), "get_chat_messages", {
          threadId: randomUUID(),
          ...invalid,
        })
      ).isError,
    ).toBeTruthy();
  });
});

describe("MCP message search", () => {
  it("pages beyond 25 matches with real references and leaves thread state unchanged", async () => {
    const f = await messageFixture();
    const query = "mcpsearchpaging";
    const first = await withMockNowForTest(now(), async () => {
      const sent = await f.send(`${query} 0`);
      for (let index = 1; index < 28; index++) {
        await f.send(`${query} ${index}`, sent.threadId);
      }
      const second = await f.send(`${query} another thread`);
      return {
        threadId: sent.threadId,
        threadIds: [sent.threadId, second.threadId],
      };
    });
    await f.chat.renameThread(f.actor, first.threadId, "Current search title");
    const token = f.auth.token();
    expect((await searchMessages(token, { query })).matches).toStrictEqual([]);
    await projectSearchMessages(first.threadIds);
    const before = await Promise.all(
      first.threadIds.map(async (threadId) => {
        return await f.chat.readThread(f.actor, threadId);
      }),
    );
    const source = (
      await Promise.all(
        first.threadIds.map(async (threadId) => {
          const history = await f.chat.listThreadEvents(f.actor, threadId);
          return history.events
            .filter((event) => {
              return event.eventType === "input.rejected";
            })
            .map((event) => {
              return {
                ref: { threadId, eventId: event.id, seqId: event.seqId },
                createdAt: event.createdAt,
              };
            });
        }),
      )
    ).flat();
    source.sort((left, right) => {
      return (
        right.createdAt.localeCompare(left.createdAt) ||
        right.ref.threadId.localeCompare(left.ref.threadId) ||
        right.ref.seqId - left.ref.seqId
      );
    });
    const args = { query, limit: 7 };
    let page = await searchMessages(token, args);
    const matches = [...page.matches];
    while (page.nextCursor !== null) {
      expect(matches.length).toBeLessThan(29);
      const result = await callTool(token, "search_chat_messages", {
        ...args,
        cursor: page.nextCursor,
      });
      expect(result.isError).not.toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        512 * 1024,
      );
      page = mcpSearchChatMessagesOutputSchema.parse(result.structuredContent);
      expect(page.scanLimited).toBeFalsy();
      matches.push(...page.matches);
    }
    expect(
      matches.map(({ ref, createdAt }) => {
        return { ref, createdAt: new Date(createdAt).toISOString() };
      }),
    ).toStrictEqual(source);
    expect(matches).toHaveLength(29);
    expect(
      new Set(
        matches.map(({ ref }) => {
          return ref.eventId;
        }),
      ).size,
    ).toBe(29);
    for (const match of matches) {
      expect(match.agent.agentId).toBe(f.agent.agentId);
      expect(match.excerpt).toMatchObject({
        offset: 0,
        hasBefore: false,
        hasAfter: false,
      });
      expect(new URL(match.url).pathname).toBe(`/chats/${match.ref.threadId}`);
    }
    const hit = matches.find(({ ref }) => {
      return ref.threadId === first.threadIds[0];
    });
    if (!hit) {
      throw new Error("Expected a hit in the renamed thread");
    }
    expect(hit.threadTitle).toBe("Current search title");
    expect(hit.titleTruncated).toBeFalsy();
    const around = await getMessages(token, {
      threadId: hit.ref.threadId,
      around: { eventId: hit.ref.eventId, seqId: hit.ref.seqId },
      limit: 1,
    });
    expect(around.messages).toMatchObject([
      { ref: hit.ref, text: hit.excerpt.text },
    ]);
    await expect(
      Promise.all(
        first.threadIds.map(async (threadId) => {
          return await f.chat.readThread(f.actor, threadId);
        }),
      ),
    ).resolves.toStrictEqual(before);
  });

  it("preserves stored microseconds and sequence ties in cursors and date bounds", async () => {
    const f = await messageFixture();
    const sent = await f.send("precisionneedle oldest");
    for (const suffix of ["newest", "first tie", "second tie"]) {
      await f.send(`precisionneedle ${suffix}`, sent.threadId);
    }
    await projectSearchMessages([sent.threadId]);
    const token = f.auth.token();
    const source = await getMessages(token, { threadId: sent.threadId });
    const timestamps = [
      "2026-09-18T01:02:03.456001Z",
      "2026-09-18T01:02:03.456003Z",
      "2026-09-18T01:02:03.456002Z",
      "2026-09-18T01:02:03.456002Z",
    ];
    const expected: {
      ref: (typeof source.messages)[number]["ref"];
      createdAt: string;
    }[] = [];
    for (const [index, message] of source.messages.entries()) {
      const createdAt = timestamps[index];
      if (!createdAt) {
        throw new Error(
          "Expected one timestamp for each precision fixture event",
        );
      }
      // Infrastructure exception: product writes cannot choose exact stored
      // sub-millisecond times. Model already-indexed historical SQL timestamps
      // without relying on the current projector's Date normalization.
      await setChatSearchEventTimestampPrecisionFixture({
        eventId: message.ref.eventId,
        createdAt,
      });
      expected.push({ ref: message.ref, createdAt });
    }
    expected.sort((left, right) => {
      return (
        right.createdAt.localeCompare(left.createdAt) ||
        right.ref.seqId - left.ref.seqId
      );
    });
    const args = { query: "precisionneedle", limit: 1 };
    let page = await searchMessages(token, args);
    const actual = [...page.matches];
    while (page.nextCursor !== null) {
      expect(actual.length).toBeLessThan(4);
      page = await searchMessages(token, { ...args, cursor: page.nextCursor });
      actual.push(...page.matches);
    }
    expect(
      actual.map(({ ref, createdAt }) => {
        return { ref, createdAt };
      }),
    ).toStrictEqual(expected);
    const bounded = await searchMessages(token, {
      query: "precisionneedle",
      since: "2026-09-18T01:02:03.456002Z",
      before: "2026-09-18T01:02:03.456003Z",
    });
    expect(
      bounded.matches.map(({ excerpt }) => {
        return excerpt.text;
      }),
    ).toStrictEqual([
      "precisionneedle second tie",
      "precisionneedle first tie",
    ]);
  });

  it("applies role, source time, Agent and thread filters before limiting and excludes private context", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const query = "mcpfilterneedle";
    const baseTime = now();
    const sent = await withMockNowForTest(baseTime, async () => {
      return await f.sendChatRun(actor.actor, {
        agentId: actor.agentId,
        prompt: `${query} user before`,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: `${query} user before` },
            { type: "additional_info", text: "mcpprivateneedle context" },
          ],
        },
      });
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, sent.runId);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    await withMockNowForTest(baseTime + 1000, async () => {
      await f.webhooks.requestAgentEvents(
        {
          runId: sent.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 0,
              message: {
                content: [
                  { type: "text", text: `${query} assistant answer` },
                  { type: "thinking", thinking: "mcpprivateneedle reasoning" },
                ],
              },
            },
          ],
        },
        claimed.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
    });
    await withMockNowForTest(baseTime + 2000, async () => {
      await f.chat.requestSendEvent(
        actor.actor,
        {
          agentId: actor.agentId,
          threadId: sent.threadId,
          prompt: `${query} queued after`,
        },
        [201],
      );
    });
    const otherAgent = await f.chat.createAgentForChatThread(
      actor.actor,
      "Other search Agent",
    );
    const other = await withMockNowForTest(baseTime + 3000, async () => {
      return await f.sendChatRun(actor.actor, {
        agentId: otherAgent.agentId,
        prompt: `${query} other Agent`,
      });
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, other.runId);
    });
    await projectSearchMessages([sent.threadId, other.threadId]);
    // Infrastructure exception: event timestamps come from the PostgreSQL
    // clock, so the public API cannot select exact inclusive/exclusive bounds.
    // Only timestamp placement uses the centralized historical fixture.
    const sourceMessages = await getMessages(auth.token(), {
      threadId: sent.threadId,
    });
    for (const message of sourceMessages.messages) {
      const offset =
        message.role === "assistant"
          ? 1000
          : message.text.endsWith("queued after")
            ? 2000
            : 0;
      await setChatSearchEventTimestampPrecisionFixture({
        eventId: message.ref.eventId,
        createdAt: new Date(baseTime + offset).toISOString(),
      });
    }
    const otherMessages = await getMessages(auth.token(), {
      threadId: other.threadId,
    });
    for (const message of otherMessages.messages) {
      await setChatSearchEventTimestampPrecisionFixture({
        eventId: message.ref.eventId,
        createdAt: new Date(baseTime + 3000).toISOString(),
      });
    }
    const token = auth.token();
    const args = { query, limit: 1 };
    expect((await searchMessages(token, args)).matches[0]?.ref.threadId).toBe(
      other.threadId,
    );
    for (const filters of [
      { agentId: actor.agentId },
      { threadId: sent.threadId },
    ]) {
      expect(
        (await searchMessages(token, { ...args, ...filters })).matches[0]
          ?.excerpt.text,
      ).toBe(`${query} queued after`);
    }
    const since = new Date(baseTime + 1000).toISOString();
    const before = new Date(baseTime + 2000).toISOString();
    for (const filters of [
      { role: "assistant" },
      { before },
      { since, before },
    ]) {
      const page = await searchMessages(token, { ...args, ...filters });
      expect(page.matches).toMatchObject([
        {
          role: "assistant",
          runId: sent.runId,
          excerpt: { text: `${query} assistant answer` },
        },
      ]);
    }
    expect(
      (
        await searchMessages(token, {
          ...args,
          threadId: sent.threadId,
          since: before,
        })
      ).matches[0]?.excerpt.text,
    ).toBe(`${query} queued after`);
    expect(
      (await searchMessages(token, { query, role: "user" })).matches,
    ).toHaveLength(3);
    expect(
      (await searchMessages(token, { query: "mcpprivateneedle" })).matches,
    ).toStrictEqual([]);
    expect(
      (await searchMessages(token, { ...args, threadId: randomUUID() }))
        .matches,
    ).toStrictEqual([]);
  });

  it("centers late Unicode excerpts on real matches and rejects CJK phrases split across runs", async () => {
    const f = await messageFixture();
    const text = `${"😀文 ".repeat(3000)}LateNeedle 上海滩 ${"𠮷尾 ".repeat(500)}`;
    const sent = await f.send(text);
    await f.send("LateNeedle 上海 海滩", sent.threadId);
    await projectSearchMessages([sent.threadId]);
    const token = f.auth.token();
    const result = await searchMessages(token, { query: "lateneedle 上海滩" });
    expect(result.matches).toHaveLength(1);
    const match = result.matches[0];
    if (!match) {
      throw new Error("Expected the contiguous mixed-language match");
    }
    expect(match.excerpt.text).toContain("LateNeedle 上海滩");
    expect(match.excerpt.text.length).toBeLessThanOrEqual(1000);
    expect(match.excerpt.offset).toBeGreaterThan(8192);
    expect(match.excerpt.hasBefore).toBeTruthy();
    expect(match.excerpt.hasAfter).toBeTruthy();
    expect(Buffer.from(match.excerpt.text).toString("utf8")).toBe(
      match.excerpt.text,
    );
    expect(
      text.slice(
        match.excerpt.offset,
        match.excerpt.offset + match.excerpt.text.length,
      ),
    ).toBe(match.excerpt.text);
    expect(
      (await searchMessages(token, { query: "上海滩" })).matches.map(
        ({ ref }) => {
          return ref;
        },
      ),
    ).toStrictEqual([match.ref]);
    expect(
      (await searchMessages(token, { query: "LATENEEDLE" })).matches,
    ).toHaveLength(2);
    const around = await getMessages(token, {
      threadId: match.ref.threadId,
      around: { eventId: match.ref.eventId, seqId: match.ref.seqId },
      limit: 1,
    });
    expect(around.messages[0]?.ref).toStrictEqual(match.ref);
    expect(around.messages[0]?.nextContentCursor).not.toBeNull();
  });

  it("never returns stale revoked or replaced inputs before the index catches up", async () => {
    const f = await chatRunFixture();
    const active = await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        prompt: "Active unrelated task",
      },
      [201],
    );
    if (active.status !== 201 || active.body.runId === null) {
      throw new Error("Expected an active run for queued edits");
    }
    const runId = active.body.runId;
    onTestFinished(async () => {
      await f.runs.requestCancelRun(f.actor, runId, [200]);
      await flushWaitUntilForTest();
    });
    const threadId = active.body.threadId;
    for (const prompt of [
      "staleneedle recall",
      "staleneedle replace",
      "staleneedle unchanged",
    ]) {
      await f.chat.requestSendEvent(
        f.actor,
        { agentId: f.agent.agentId, threadId, prompt },
        [201],
      );
    }
    await projectSearchMessages([threadId]);
    const token = f.auth.token();
    const original = await searchMessages(token, { query: "staleneedle" });
    expect(original.matches).toHaveLength(3);
    const recalled = original.matches.find((match) => {
      return match.excerpt.text.endsWith("recall");
    });
    const replaced = original.matches.find((match) => {
      return match.excerpt.text.endsWith("replace");
    });
    if (!recalled || !replaced) {
      throw new Error("Expected both queued search targets");
    }
    await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId,
        revokesEventId: recalled.ref.eventId,
      },
      [201],
    );
    // Infrastructure exception: normal sends cannot author an arbitrary
    // internal replacement. Reuse the canonical writer fixture to reconstruct
    // the legacy replacement state that can outlive its indexed source row.
    await rejectSearchablePromptFixture({
      chatThreadId: threadId,
      eventId: replaced.ref.eventId,
      text: "replacementneedle current text",
    });
    const stale = await searchMessages(token, { query: "staleneedle" });
    expect(
      stale.matches.map(({ excerpt }) => {
        return excerpt.text;
      }),
    ).toStrictEqual(["staleneedle unchanged"]);
    expect(stale.nextCursor).toBeNull();
    expect(
      (await searchMessages(token, { query: "replacementneedle" })).matches,
    ).toStrictEqual([]);
    await projectSearchMessages([threadId]);
    const current = await searchMessages(token, { query: "replacementneedle" });
    expect(current.matches).toHaveLength(1);
    expect(current.matches[0]?.ref.eventId).not.toBe(replaced.ref.eventId);
  });

  it("finds retained source messages with valid context references and fails explicitly on a missing archive", async () => {
    const f = await threadFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    // Infrastructure exception: public writes cannot backdate the event beyond
    // the retention worker's database-clock cutoff. All projection, archival,
    // retention, search and context reads below use their real HTTP routes.
    const eventId = await createStore().set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: thread.id,
        content: "retainedsearchneedle canonical answer",
        offsetMs: -60_000,
      },
      context.signal,
    );
    await snapshotMessages(thread.id);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({
        body: { chat_thread_ids: [thread.id] },
      }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const token = f.auth.token();
    const args = { query: "retainedsearchneedle" };
    const page = await searchMessages(token, args);
    expect(page.matches).toMatchObject([
      {
        ref: { eventId, threadId: thread.id },
        role: "assistant",
        excerpt: { text: "retainedsearchneedle canonical answer" },
      },
    ]);
    const match = page.matches[0];
    const archive = puts.at(-1);
    if (!match || !archive) {
      throw new Error("Expected a retained match and its canonical archive");
    }
    expect(
      (
        await getMessages(token, {
          threadId: thread.id,
          around: { eventId, seqId: match.ref.seqId },
          limit: 1,
        })
      ).messages[0]?.ref,
    ).toStrictEqual(match.ref);
    await deleteFakeChatEventObject(archive.key);
    const missing = await callTool(token, "search_chat_messages", args);
    expect(missing.isError).toBeTruthy();
    expect(missing.structuredContent).toBeUndefined();
    expect(JSON.stringify(missing)).not.toContain("canonical answer");
  });

  it("enforces one aggregate history budget across individually readable search matches", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const threadIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const text = `aggregatebudgetneedle VISIBLE_EXCERPT_CANARY_${index}`;
      const sent = await f.send(text);
      threadIds.push(sent.threadId);
      onTestFinished(async () => {
        await f.chat.deleteThread(f.actor, sent.threadId);
      });
      await snapshotMessages(sent.threadId);
      const archive = puts.at(-1);
      if (!archive) {
        throw new Error("Expected a genuine indexed message archive");
      }
      // Infrastructure exception: historical imported archives can exceed the
      // current HTTP envelope. Preserve the actual indexed event coordinates
      // and visible text, adding only private context that is never searchable.
      const rows = gunzipSync(archive.body)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      const expanded = Buffer.from(
        rows
          .map((row) => {
            return `${JSON.stringify(
              row.eventType === "input.rejected"
                ? {
                    ...row,
                    payload: {
                      ...row.payload,
                      userMessage: {
                        version: 1,
                        parts: [
                          { type: "text", text },
                          {
                            type: "additional_info",
                            text: "x".repeat(17 * 1024 * 1024),
                          },
                        ],
                      },
                    },
                  }
                : row,
            )}\n`;
          })
          .join(""),
      );
      expect(expanded.length).toBeGreaterThan(17 * 1024 * 1024);
      expect(expanded.length).toBeLessThan(18 * 1024 * 1024);
      const body = gzipSync(expanded);
      expect(body.length).toBeLessThan(8 * 1024 * 1024);
      const last = rows.at(-1);
      if (!last) {
        throw new Error("Expected the original archive's terminal coordinate");
      }
      const key = `chat-events/${sent.threadId}/${last.seqId.toString()}-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
      writeFakeChatEventObject(key, body);
      onTestFinished(async () => {
        await deleteFakeChatEventObject(key);
      });
      await updateChatEventSnapshotHead(context, sent.threadId, key);
    }
    const token = f.auth.token();
    const query = "aggregatebudgetneedle";
    for (const threadId of threadIds) {
      const narrow = await searchMessages(token, { query, threadId });
      expect(narrow.matches).toHaveLength(1);
      expect(narrow.matches[0]?.ref.threadId).toBe(threadId);
      expect(narrow.matches[0]?.excerpt.text).toContain(
        "VISIBLE_EXCERPT_CANARY_",
      );
    }
    const combined = await callTool(token, "search_chat_messages", { query });
    expect(combined.isError).toBeTruthy();
    expect(combined.structuredContent).toBeUndefined();
    expect(combined.content[0]?.text).toMatch(/budget|limit/u);
    expect(JSON.stringify(combined)).not.toContain("VISIBLE_EXCERPT_CANARY_");
  });

  it("continues after a full scan of lexical false positives without hiding an older exact match", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    const query = "scanbudgetneedle 上海滩";
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: `${query} visible older input`,
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, sent.runId);
    });
    const token = auth.token();
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    const before = await getMessages(token, { threadId: sent.threadId });
    expect(before.messages).toHaveLength(1);
    const visible = before.messages[0];
    if (!visible) {
      throw new Error("Expected the canonical older input reference");
    }
    // One runner batch creates 100 indexed candidates with the same CJK
    // bigrams; canonical phrase verification rejects their disconnected text.
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: Array.from({ length: 100 }, (_, sequenceNumber) => {
          return {
            type: "assistant" as const,
            sequenceNumber,
            message: {
              content: [
                {
                  type: "text" as const,
                  text: `scanbudgetneedle 上海 海滩 candidate ${sequenceNumber}`,
                },
              ],
            },
          };
        }),
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    await projectSearchMessages([sent.threadId]);
    const args = { query, limit: 1 };
    const first = await searchMessages(token, args);
    expect(first.matches).toStrictEqual([]);
    expect(first.scanLimited).toBeTruthy();
    expect(first.nextCursor).not.toBeNull();
    const next = await searchMessages(token, {
      ...args,
      cursor: first.nextCursor,
    });
    expect(next).toMatchObject({
      matches: [
        {
          ref: visible.ref,
          excerpt: { text: `${query} visible older input` },
        },
      ],
      scanLimited: false,
      nextCursor: null,
    });
  });

  it("rechecks current ownership and Agent organization when indexed labels are stale", async () => {
    const f = await messageFixture();
    const ownerChanged = await f.send("transfersearchneedle owner moved");
    const agentChanged = await f.send("transfersearchneedle Agent moved");
    await projectSearchMessages([ownerChanged.threadId, agentChanged.threadId]);
    const token = f.auth.token();
    expect(
      (await searchMessages(token, { query: "transfersearchneedle" })).matches,
    ).toHaveLength(2);
    const peer = f.bdd.user({ orgId: f.auth.orgId });
    const otherOrganization = f.bdd.user({ userId: f.auth.userId });
    const otherAgent = await f.bdd.createAgent(otherOrganization, {
      displayName: "Agent from another organization",
      visibility: "private",
    });
    // Infrastructure exception: no product writer currently transfers thread
    // ownership or Agent identity. This existing fixture models historical or
    // future transfers without letting stale projected labels grant access.
    await updateChatSearchSourceThreadFixture({
      chatThreadId: ownerChanged.threadId,
      userId: peer.userId,
      agentId: f.agent.agentId,
    });
    await updateChatSearchSourceThreadFixture({
      chatThreadId: agentChanged.threadId,
      userId: f.auth.userId,
      agentId: otherAgent.agentId,
    });
    for (const args of [
      { query: "transfersearchneedle" },
      { query: "transfersearchneedle", threadId: ownerChanged.threadId },
      { query: "transfersearchneedle", threadId: agentChanged.threadId },
      { query: "transfersearchneedle", agentId: f.agent.agentId },
    ]) {
      expect((await searchMessages(token, args)).matches).toStrictEqual([]);
    }
  });

  it("keeps escaped excerpts within page and wire byte limits without skipping a match", async () => {
    const f = await messageFixture();
    const text = `escapedsearchneedle ${"\u0001".repeat(1200)}`;
    const first = await f.send(`${text} 0`);
    for (let index = 1; index < 30; index++) {
      await f.send(`${text} ${index}`, first.threadId);
    }
    await projectSearchMessages([first.threadId]);
    const token = f.auth.token();
    const args = { query: "escapedsearchneedle", limit: 50 };
    let response = await callTool(token, "search_chat_messages", args);
    expect(response.isError).not.toBeTruthy();
    let page = mcpSearchChatMessagesOutputSchema.parse(
      response.structuredContent,
    );
    expect(page.matches.length).toBeGreaterThan(0);
    expect(page.matches.length).toBeLessThan(30);
    const eventIds: string[] = [];
    do {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        160 * 1024,
      );
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(
        512 * 1024,
      );
      expect(page.scanLimited).toBeFalsy();
      eventIds.push(
        ...page.matches.map(({ ref }) => {
          return ref.eventId;
        }),
      );
      expect(eventIds.length).toBeLessThanOrEqual(30);
      if (page.nextCursor === null) {
        break;
      }
      response = await callTool(token, "search_chat_messages", {
        ...args,
        cursor: page.nextCursor,
      });
      expect(response.isError).not.toBeTruthy();
      page = mcpSearchChatMessagesOutputSchema.parse(
        response.structuredContent,
      );
    } while (page.matches.length > 0);
    expect(page.nextCursor).toBeNull();
    expect(eventIds).toHaveLength(30);
    expect(new Set(eventIds).size).toBe(30);
  });

  it("binds search cursors to all filters and expires them without extending their lifetime", async () => {
    const f = await messageFixture();
    const first = await f.send("searchcursor first");
    await f.send("searchcursor second", first.threadId);
    await projectSearchMessages([first.threadId]);
    const token = f.auth.token();
    const args = { query: "searchcursor", limit: 1 };
    const page = await searchMessages(token, args);
    const cursor = page.nextCursor;
    if (!cursor) {
      throw new Error("Expected a signed search continuation");
    }
    for (const invalid of [
      { cursor: `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}` },
      { cursor, query: "differentquery" },
      { cursor, limit: 2 },
      { cursor, threadId: first.threadId },
      { cursor, agentId: f.agent.agentId },
      { cursor, role: "user" },
      { cursor, since: new Date(0).toISOString() },
      { cursor, before: new Date(now() + 60_000).toISOString() },
    ]) {
      const result = await callTool(token, "search_chat_messages", {
        ...args,
        ...invalid,
      });
      expect(result.isError).toBeTruthy();
      expect(result.structuredContent).toBeUndefined();
    }
    expect(
      (await searchMessages(token, { ...args, cursor })).matches[0]?.excerpt
        .text,
    ).toBe("searchcursor first");
    const longToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      expect(
        (await callTool(longToken, "search_chat_messages", { ...args, cursor }))
          .isError,
      ).toBeTruthy();
      expect((await searchMessages(longToken, args)).matches).toHaveLength(1);
    });
  });

  it("does not disclose foreign or deleted threads or accept a cursor from another principal", async () => {
    const f = await messageFixture();
    const sent = await f.send("ownersearchneedle first");
    await f.send("ownersearchneedle second", sent.threadId);
    await projectSearchMessages([sent.threadId]);
    const args = { query: "ownersearchneedle", limit: 1 };
    const cursor = (await searchMessages(f.auth.token(), args)).nextCursor;
    expect(cursor).not.toBeNull();
    for (const actor of [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ]) {
      if (!actor.orgId) {
        throw new Error("Expected the other principal's organization");
      }
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        { [FeatureSwitchKey.McpServer]: true },
      );
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const token = f.auth.token({ sub: actor.userId, org_id: actor.orgId });
      expect((await searchMessages(token, args)).matches).toStrictEqual([]);
      expect(
        (await searchMessages(token, { ...args, threadId: sent.threadId }))
          .matches,
      ).toStrictEqual([]);
      const result = await callTool(token, "search_chat_messages", {
        ...args,
        cursor,
      });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain("ownersearchneedle first");
    }
    await f.chat.deleteThread(f.actor, sent.threadId);
    expect((await searchMessages(f.auth.token(), args)).matches).toStrictEqual(
      [],
    );
  });

  it.each([
    { query: "" },
    { query: "   " },
    { query: "x".repeat(201) },
    { query: "中文", limit: 0 },
    { query: "中文", limit: 51 },
    { query: "中文", cursor: "x".repeat(4097) },
    { query: "中文", role: "system" },
    { query: "中文", since: "not-a-date" },
    {
      query: "中文",
      since: "2026-01-02T00:00:00.000Z",
      before: "2026-01-01T00:00:00.000Z",
    },
    { query: "!!!" },
    { query: "中" },
  ])(
    "rejects malformed or unsupported lexical search arguments %j",
    async (args) => {
      const auth = await fixture();
      const result = await callTool(auth.token(), "search_chat_messages", args);
      expect(result.isError).toBeTruthy();
      expect(result.structuredContent).toBeUndefined();
    },
  );
});

describe("external MCP entry", () => {
  it("publishes public cross-origin metadata without authentication", async () => {
    mockEnv("MCP_RESOURCE_URL", resource);
    mockEnv("MCP_OAUTH_ISSUER", issuer);
    const response = await accept(
      client().metadata({
        extraHeaders: { Origin: "https://client.example.test" },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      resource,
      authorization_servers: [issuer],
      scopes_supported: defaultScopes.split(" "),
      bearer_methods_supported: ["header"],
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("isolates absent MCP configuration from first-party feature access", async () => {
    mockEnv("MCP_RESOURCE_URL", undefined);
    mockEnv("MCP_OAUTH_ISSUER", undefined);
    await expect(client().metadata()).resolves.toMatchObject({ status: 503 });
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("challenges unauthenticated calls and ignores a session cookie", async () => {
    await fixture();
    const response = await accept(
      client().request({
        body: requestBody("tools/list"),
        extraHeaders: { cookie: "__session=clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({ error: "unauthorized" });
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="https://api.mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="${defaultScopes}"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    { modern: true, scopes: requiredScopes },
    { modern: false, scopes: requiredScopes },
    { modern: true, scopes: defaultScopes },
    { modern: false, scopes: defaultScopes },
  ])(
    "discovers and calls chat discovery with modern=$modern and scopes=$scopes",
    async ({ modern, scopes }) => {
      const auth = await fixture();
      const token = auth.token({ scope: scopes });
      if (!modern) {
        const initialized = await accept(
          client().request({
            extraHeaders: protocolHeaders(token, "initialize", false),
            body: {
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "okou-test", version: "1" },
              },
            },
          }),
          [200],
        );
        expect(rpc(initialized.body)).toMatchObject({
          result: { protocolVersion: "2025-11-25" },
        });
      }
      const listed = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/list", modern),
          body: requestBody("tools/list", modern),
        }),
        [200],
      );
      expect(rpc(listed.body)).toMatchObject({
        result: {
          tools: [
            { name: "get_chat_messages", annotations: { readOnlyHint: true } },
            {
              name: "search_chat_messages",
              annotations: { readOnlyHint: true },
            },
            { name: "get_chat_status", annotations: { readOnlyHint: true } },
            { name: "list_agents", annotations: { readOnlyHint: true } },
            { name: "list_models", annotations: { readOnlyHint: true } },
            { name: "list_chat_threads", annotations: { readOnlyHint: true } },
            { name: "get_chat_thread", annotations: { readOnlyHint: true } },
            ...(scopes === defaultScopes
              ? [
                  {
                    name: "create_chat_thread",
                    annotations: { readOnlyHint: false, idempotentHint: true },
                  },
                  {
                    name: "update_chat_thread",
                    annotations: { readOnlyHint: false, idempotentHint: true },
                  },
                  {
                    name: "send_chat_message",
                    annotations: { readOnlyHint: false, idempotentHint: true },
                  },
                  {
                    name: "revoke_queued_message",
                    annotations: {
                      readOnlyHint: false,
                      destructiveHint: true,
                      idempotentHint: true,
                    },
                  },
                  {
                    name: "cancel_run",
                    annotations: {
                      readOnlyHint: false,
                      destructiveHint: true,
                      idempotentHint: true,
                    },
                  },
                ]
              : []),
          ],
        },
      });
      const result = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/call", modern),
          body: requestBody("tools/call", modern, {
            name: "list_chat_threads",
            arguments: {},
          }),
        }),
        [200],
      );
      expect(rpc(result.body)).toMatchObject({
        result: {
          structuredContent: {
            threads: [],
            nextCursor: null,
            unreadCoverage: "retained_terminal_events_and_native_deliveries",
          },
          content: [{ type: "text" }],
        },
      });
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.headers.get("content-type")).toContain(
        modern ? "application/json" : "text/event-stream",
      );
      if (!modern) {
        expect(typeof result.body).toBe("string");
      }
    },
  );

  it.each([true, false])(
    "works with the generic MCP SDK client with modern=%s",
    async (modern) => {
      const f = await messageFixture();
      const auth = f.auth;
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const transport = new StreamableHTTPClientTransport(new URL(resource), {
        authProvider: {
          token: () => {
            return Promise.resolve(auth.token({ scope: defaultScopes }));
          },
        },
        fetch: async (input, init) => {
          return await app.request(new Request(input, init));
        },
      });
      const sdk = new Client(
        { name: "okou-interoperability-test", version: "1" },
        {
          versionNegotiation: {
            mode: modern ? { pin: modernVersion } : "legacy",
          },
        },
      );
      onTestFinished(() => {
        return sdk.close();
      });
      await sdk.connect(transport);
      expect(sdk.getDiscoverResult() !== undefined).toBe(modern);
      const tools = await sdk.listTools();
      expect(
        tools.tools.map((tool) => {
          return tool.name;
        }),
      ).toStrictEqual([
        "get_chat_messages",
        "search_chat_messages",
        "get_chat_status",
        "list_agents",
        "list_models",
        "list_chat_threads",
        "get_chat_thread",
        "create_chat_thread",
        "update_chat_thread",
        "send_chat_message",
        "revoke_queued_message",
        "cancel_run",
      ]);
      const result = await sdk.callTool({
        name: "list_chat_threads",
        arguments: {},
      });
      expect(result).toMatchObject({
        structuredContent: { threads: [], nextCursor: null },
      });
      const sent = await f.send("sdksearchneedle context handoff");
      await projectSearchMessages([sent.threadId]);
      const searched = await sdk.callTool({
        name: "search_chat_messages",
        arguments: { query: "sdksearchneedle" },
      });
      expect(searched.isError).not.toBeTruthy();
      const match = mcpSearchChatMessagesOutputSchema.parse(
        searched.structuredContent,
      ).matches[0];
      if (!match) {
        throw new Error(
          "Expected the generic SDK search to return a real reference",
        );
      }
      const around = await sdk.callTool({
        name: "get_chat_messages",
        arguments: {
          threadId: match.ref.threadId,
          around: { eventId: match.ref.eventId, seqId: match.ref.seqId },
          limit: 1,
        },
      });
      expect(around).toMatchObject({
        structuredContent: {
          messages: [
            { ref: match.ref, text: "sdksearchneedle context handoff" },
          ],
        },
      });
      const requestId = randomUUID();
      const submitted = await sdk.callTool({
        name: "send_chat_message",
        arguments: {
          threadId: sent.threadId,
          text: "Submitted by a generic MCP client",
          requestId,
        },
      });
      expect(submitted.isError).not.toBeTruthy();
      const receipt = mcpSendChatMessageOutputSchema.parse(
        submitted.structuredContent,
      );
      expect(receipt).toMatchObject({
        inputRef: { threadId: sent.threadId, eventId: requestId },
        replayed: false,
        disposition: "rejected",
        runId: null,
      });
      const missing = await sdk.callTool({
        name: "get_chat_thread",
        arguments: { threadId: randomUUID() },
      });
      expect(missing.isError).toBeTruthy();
    },
  );

  it.each([
    { iss: "https://other-clerk.example.test" },
    { aud: "https://different-resource.example.test/mcp" },
    { aud: undefined },
    { org_id: undefined },
    { client_id: undefined },
    { sub: "machine_client" },
    { exp: 1 },
    { nbf: 9_000_000_000 },
  ])("rejects invalid access claims %j", async (claims) => {
    const auth = await fixture();
    const result = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(claims), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [401],
    );
    expect(result.body).toStrictEqual({ error: "invalid_token" });
  });

  it.each(["JWT", "id+jwt"])(
    "rejects the signed %s token type",
    async (type) => {
      const auth = await fixture();
      const response = await accept(
        client().request({
          extraHeaders: protocolHeaders(auth.token({}, type), "tools/list"),
          body: requestBody("tools/list"),
        }),
        [401],
      );
      expect(response.body).toStrictEqual({ error: "invalid_token" });
    },
  );

  it("rejects a tampered signature", async () => {
    const auth = await fixture();
    const pieces = auth.token().split(".");
    const token = `${pieces[0]}.${pieces[1]}.${Buffer.alloc(256).toString("base64url")}`;
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(token, "tools/list"),
        body: requestBody("tools/list"),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({ error: "invalid_token" });
    expect(response.headers.get("www-authenticate")).toContain(
      `scope="${defaultScopes}"`,
    );
  });

  it("denies discovery and manual invocation without the read grant", async () => {
    const auth = await fixture();
    const token = auth.token({ scope: `${orgScope} okou:chat:manage` });
    for (const { method, name, args } of [
      { method: "tools/list", name: "list_chat_threads", args: {} },
      { method: "tools/call", name: "list_chat_threads", args: {} },
      {
        method: "tools/call",
        name: "get_chat_thread",
        args: { threadId: randomUUID() },
      },
      {
        method: "tools/call",
        name: "get_chat_status",
        args: { threadId: randomUUID() },
      },
      { method: "tools/call", name: "list_agents", args: {} },
      { method: "tools/call", name: "list_models", args: {} },
      {
        method: "tools/call",
        name: "create_chat_thread",
        args: {
          requestId: randomUUID(),
          agentId: randomUUID(),
          title: "Missing read grant",
          model: "claude-sonnet-5",
        },
      },
    ]) {
      const result = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, method, true, name),
          body: requestBody(method, true, {
            name,
            arguments: args,
          }),
        }),
        [403],
      );
      expect(result.body).toStrictEqual({ error: "insufficient_scope" });
    }
  });

  it("requests organization consent when only the application read scope is granted", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(
          auth.token({ scope: readScope }),
          "tools/list",
        ),
        body: requestBody("tools/list"),
      }),
      [403],
    );
    expect(response.body).toStrictEqual({ error: "insufficient_scope" });
    expect(response.headers.get("www-authenticate")).toContain(
      `scope="${requiredScopes}"`,
    );
  });

  it("requires the feature override in the selected organization", async () => {
    const auth = await fixture(false);
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [403],
    );
    expect(response.body).toMatchObject({ error: "access_denied" });
  });

  it("does not share feature authority across concurrent principals", async () => {
    const auth = await fixture();
    const otherUser = `user_${randomUUID()}`;
    const responses = await Promise.all([
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      client().request({
        extraHeaders: protocolHeaders(
          auth.token({ sub: otherUser }),
          "tools/list",
        ),
        body: requestBody("tools/list"),
      }),
    ]);
    expect(
      responses.map((item) => {
        return item.status;
      }),
    ).toStrictEqual([200, 403]);
  });

  it("rejects an organization outside current membership", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(
          auth.token({ org_id: `org_${randomUUID()}` }),
          "tools/list",
        ),
        body: requestBody("tools/list"),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({ error: "invalid_token" });
  });

  it("keeps membership outages distinct from invalid credentials", async () => {
    const auth = await fixture();
    context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValue(
      new Error("Provider unavailable"),
    );
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [503],
    );
    expect(response.body).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("rejects a removed member after the bounded membership cache expires", async () => {
    const auth = await fixture();
    const token = auth.token();
    const read = () => {
      return client().request({
        extraHeaders: protocolHeaders(token, "tools/list"),
        body: requestBody("tools/list"),
      });
    };
    await expect(read()).resolves.toMatchObject({ status: 200 });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
      totalCount: 0,
    });
    const response = await withMockNowForTest(now() + 61_000, read);
    expect(response).toMatchObject({
      status: 401,
      body: { error: "invalid_token" },
    });
  });

  it.each([
    { scope: undefined, scp: [orgScope, readScope] },
    { scope: requiredScopes, scp: [orgScope, readScope] },
    { aud: ["https://another.example.test", resource] },
  ])("accepts the supported signed claim representation %j", async (claims) => {
    const auth = await fixture();
    await expect(
      client().request({
        extraHeaders: protocolHeaders(auth.token(claims), "tools/list"),
        body: requestBody("tools/list"),
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.each([
    { scope: requiredScopes, scp: ["okou:chat:manage"] },
    {
      scope: `${requiredScopes} ${readScope}`,
      scp: [orgScope, readScope, "okou:chat:manage"],
    },
  ])("rejects disagreeing signed scope claims %j", async (claims) => {
    const auth = await fixture();
    await expect(
      client().request({
        extraHeaders: protocolHeaders(auth.token(claims), "tools/list"),
        body: requestBody("tools/list"),
      }),
    ).resolves.toMatchObject({ status: 401, body: { error: "invalid_token" } });
  });

  it("acknowledges legacy initialization notifications without caching them", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(
          auth.token(),
          "notifications/initialized",
          false,
        ),
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      }),
      [202],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps signing-key outages distinct from invalid credentials", async () => {
    const auth = await fixture();
    server.use(
      http.get("https://api.clerk.com/v1/jwks", () => {
        return HttpResponse.json({ error: "unavailable" }, { status: 503 });
      }),
    );
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
      [503],
    );
    expect(response.body).toMatchObject({ error: "temporarily_unavailable" });
  });

  it("rejects organization overrides in tool arguments", async () => {
    const auth = await fixture();
    const response = await client().request({
      extraHeaders: protocolHeaders(auth.token(), "tools/call"),
      body: requestBody("tools/call", true, {
        name: "list_chat_threads",
        arguments: { orgId: "org_foreign" },
      }),
    });
    expect(rpc(response.body)).toMatchObject({
      result: {
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining("Unrecognized key") },
        ],
      },
    });
  });

  it("rejects an unknown tool through the SDK", async () => {
    const name = "unknown_tool";
    const auth = await fixture();
    const response = await client().request({
      extraHeaders: {
        ...protocolHeaders(auth.token(), "tools/call"),
        "MCP-Name": name,
      },
      body: requestBody("tools/call", true, {
        name,
        arguments: {},
      }),
    });
    expect(
      z
        .object({ error: z.object({ code: z.number() }) })
        .parse(rpc(response.body)).error.code,
    ).toBeLessThan(0);
  });

  it("rejects standalone stateless sessions", async () => {
    const auth = await fixture();
    const extraHeaders = protocolHeaders(auth.token(), "tools/list", false);
    await expect(client().get({ extraHeaders })).resolves.toMatchObject({
      status: 405,
    });
    await expect(client().delete({ extraHeaders })).resolves.toMatchObject({
      status: 405,
    });
  });

  it.each(["https://untrusted.example.test", "null", ""])(
    "rejects Origin %s before authorization",
    async (origin) => {
      await fixture();
      const response = await accept(
        client().request({
          extraHeaders: { Origin: origin },
          body: requestBody("tools/list"),
        }),
        [403],
      );
      expect(response.body).toStrictEqual({ error: "Forbidden Origin" });
    },
  );

  it("rejects an unlisted browser origin's preflight and authorized request", async () => {
    const auth = await fixture();
    const origin = "https://client.example.test";
    const raw = setupRawAppRequest({ context, routes: mcpServerRoutes });
    const preflight = await raw("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,mcp-protocol-version,mcp-method",
      },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.body).toStrictEqual({ error: "Forbidden Origin" });
    const result = await accept(
      client().request({
        extraHeaders: {
          ...protocolHeaders(auth.token(), "tools/list"),
          Origin: origin,
        },
        body: requestBody("tools/list"),
      }),
      [403],
    );
    expect(result.body).toStrictEqual({ error: "Forbidden Origin" });
    expect(result.headers.get("access-control-allow-origin")).toBeNull();
    expect(result.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("bounds the request body before SDK dispatch", async () => {
    const auth = await fixture();
    const response = await accept(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list", true, {
          padding: "x".repeat(64 * 1024),
        }),
      }),
      [413],
    );
    expect(response.status).toBe(413);
  });

  it("allows an SSE consumer to cancel without affecting the next request", async () => {
    const auth = await fixture();
    const app = createAppWithRoutes({
      routes: mcpServerRoutes,
      signal: context.signal,
    });
    const response = await app.request(resource, {
      method: "POST",
      headers: {
        ...protocolHeaders(auth.token(), "tools/call", false),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        requestBody("tools/call", false, {
          name: "list_chat_threads",
          arguments: {},
        }),
      ),
    });
    expect(response.status).toBe(200);
    if (!response.body) {
      throw new Error("Expected an SSE body");
    }
    await response.body.cancel();
    await expect(
      client().request({
        extraHeaders: protocolHeaders(auth.token(), "tools/list"),
        body: requestBody("tools/list"),
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("filters before pagination and treats title wildcards literally", async () => {
    const f = await threadFixture();
    const first = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100%_DONE first",
    });
    const second = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100%_DONE second",
    });
    await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100XX_DONE wildcard decoy",
    });
    await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Most recent unrelated thread",
    });
    const otherAgent = await f.bdd.createAgent(f.actor, {
      displayName: "Other discovery agent",
      visibility: "private",
    });
    await f.chat.createThread(f.actor, {
      agentId: otherAgent.agentId,
      title: "Launch 100%_DONE different Agent",
    });
    const token = f.auth.token();
    const filters = {
      agentId: f.agent.agentId,
      title: "100%_done",
      activity: "idle",
      unread: false,
      limit: 1,
    };
    const page = await listThreads(token, filters);
    expect(
      page.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([second.id]);
    expect(page.nextCursor).not.toBeNull();
    const next = await listThreads(token, {
      ...filters,
      cursor: page.nextCursor,
    });
    expect(
      next.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([first.id]);
    expect(next.nextCursor).toBeNull();
    expect(next.unreadCoverage).toBe(
      "retained_terminal_events_and_native_deliveries",
    );

    const current = await getThread(token, second.id);
    const instant = Date.parse(current.thread.lastMessageAt);
    const windowed = await listThreads(token, {
      ...filters,
      title: "second",
      since: new Date(instant - 1).toISOString(),
      before: new Date(instant + 1).toISOString(),
    });
    expect(
      windowed.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([second.id]);
    const outside = await listThreads(token, {
      ...filters,
      since: new Date(instant + 1).toISOString(),
    });
    expect(outside.threads).toStrictEqual([]);
  });

  it("reads empty threads and current metadata without changing read, pin or lifecycle state", async () => {
    const f = await threadFixture();
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Original discovery title",
    });
    await f.chat.pinThread(f.actor, created.id);
    const before = {
      metadata: await f.chat.readThreadMetadata(f.actor, created.id),
      detail: await f.chat.readThread(f.actor, created.id),
      events: (await f.chat.requestThreadEvents(f.actor, {}, [200])).body,
      draft: await f.chat.readThreadDraft(f.actor, created.id),
    };
    const token = f.auth.token();
    const detail = await getThread(token, created.id);
    expect(detail.thread).toMatchObject({
      threadId: created.id,
      title: "Original discovery title",
      titleTruncated: false,
      agent: { agentId: f.agent.agentId, name: "MCP discovery agent" },
      activity: { queued: false, pending: false, running: false },
      unread: false,
      model: {
        selectedModel: before.metadata.selectedModel,
        effectiveModel: before.metadata.selectedModel,
        source: "thread",
        admission: "checked_on_send",
      },
    });
    expect(new URL(detail.thread.url).pathname).toBe(`/chats/${created.id}`);
    expect((await listThreads(token)).threads).toStrictEqual([detail.thread]);
    await expect(getThread(token, created.id)).resolves.toStrictEqual(detail);
    expect({
      metadata: await f.chat.readThreadMetadata(f.actor, created.id),
      detail: await f.chat.readThread(f.actor, created.id),
      events: (await f.chat.requestThreadEvents(f.actor, {}, [200])).body,
      draft: await f.chat.readThreadDraft(f.actor, created.id),
    }).toStrictEqual(before);

    await f.chat.renameThread(f.actor, created.id, "Renamed discovery title");
    expect(
      (await listThreads(token, { title: "Original discovery title" })).threads,
    ).toStrictEqual([]);
    expect((await getThread(token, created.id)).thread.title).toBe(
      "Renamed discovery title",
    );
    await f.chat.deleteThread(f.actor, created.id);
    expect((await listThreads(token)).threads).toStrictEqual([]);
    const deleted = await callTool(token, "get_chat_thread", {
      threadId: created.id,
    });
    const missing = await callTool(token, "get_chat_thread", {
      threadId: randomUUID(),
    });
    expect(deleted.isError).toBeTruthy();
    expect(deleted).toStrictEqual(missing);
  });

  it("reflects a changed model pin and resolves a cleared pin without rewriting it", async () => {
    const f = await threadFixture();
    const runs = createRunsApi(context);
    const { providerId } = await runs.ensureOrgModelProvider(f.actor);
    await runs.updateOrgModelPolicies(
      f.actor,
      (["claude-sonnet-5", "claude-sonnet-4-6"] as const).map((model) => {
        return {
          model,
          isDefault: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      }),
    );
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Current model",
      model: "claude-sonnet-5",
    });
    const token = f.auth.token();
    await f.chat.updateThreadModelSelection(
      f.actor,
      created.id,
      "claude-sonnet-4-6",
    );
    expect((await getThread(token, created.id)).thread.model).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      effectiveModel: "claude-sonnet-4-6",
      source: "thread",
      admission: "checked_on_send",
    });
    await f.chat.updateThreadModelSelection(f.actor, created.id, null);
    const before = await f.chat.readThreadMetadata(f.actor, created.id);
    const model = (await getThread(token, created.id)).thread.model;
    expect(model).toMatchObject({
      selectedModel: null,
      effectiveModel: "claude-sonnet-5",
      admission: "checked_on_send",
    });
    expect(["member_default", "org_default"]).toContain(model.source);
    await expect(
      f.chat.readThreadMetadata(f.actor, created.id),
    ).resolves.toStrictEqual(before);
  });

  it("rejects tampered, changed-filter and expired cursors with a fresh-traversal path", async () => {
    const f = await threadFixture();
    for (const title of ["Cursor first", "Cursor second", "Cursor third"]) {
      await f.chat.createThread(f.actor, { agentId: f.agent.agentId, title });
    }
    const filters = { title: "Cursor", limit: 1 };
    const first = await listThreads(f.auth.token(), filters);
    if (!first.nextCursor) {
      throw new Error("Expected a continuation cursor");
    }
    const cursor = first.nextCursor;
    const tampered = `${cursor.startsWith("A") ? "B" : "A"}${cursor.slice(1)}`;
    for (const args of [
      { ...filters, cursor: tampered },
      { ...filters, cursor, title: "different" },
      { ...filters, cursor, activity: "idle" },
    ]) {
      const result = await callTool(f.auth.token(), "list_chat_threads", args);
      expect(result.isError).toBeTruthy();
      expect(result.structuredContent).toBeUndefined();
    }
    const second = await listThreads(f.auth.token(), { ...filters, cursor });
    const ids = [...first.threads, ...second.threads].map((thread) => {
      return thread.threadId;
    });
    expect(new Set(ids).size).toBe(2);
    const expiryToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      const expired = await callTool(expiryToken, "list_chat_threads", {
        ...filters,
        cursor,
      });
      expect(expired.isError).toBeTruthy();
      expect((await listThreads(expiryToken, filters)).threads).toHaveLength(1);
    });
  });

  it("never discloses a peer's or another organization's thread through list or detail", async () => {
    const f = await threadFixture();
    const own = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Owned thread",
    });
    const ownSecond = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Owned second thread",
    });
    const strangers = [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ];
    const token = f.auth.token();
    const first = await listThreads(token, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const missing = await callTool(token, "get_chat_thread", {
      threadId: randomUUID(),
    });
    for (const actor of strangers) {
      const agent = await f.bdd.createAgent(actor, {
        displayName: "Hidden Agent",
        visibility: "private",
      });
      const thread = await f.chat.createThread(actor, {
        agentId: agent.agentId,
        title: "Hidden thread",
      });
      await expect(
        callTool(token, "get_chat_thread", { threadId: thread.id }),
      ).resolves.toStrictEqual(missing);
      expect(
        (await listThreads(token, { agentId: agent.agentId })).threads,
      ).toStrictEqual([]);
      if (!actor.orgId) {
        throw new Error("Expected an organization for a peer fixture");
      }
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        {
          [FeatureSwitchKey.McpServer]: true,
        },
      );
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const foreignCursor = await callTool(
        f.auth.token({ sub: actor.userId, org_id: actor.orgId }),
        "list_chat_threads",
        { limit: 1, cursor: first.nextCursor },
      );
      expect(foreignCursor.isError).toBeTruthy();
    }
    expect(missing.isError).toBeTruthy();
    expect(
      (await listThreads(token)).threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([ownSecond.id, own.id]);
  });

  it("bounds Unicode titles and preserves an allowed Unicode Agent name", async () => {
    const f = await threadFixture();
    const longName = "😀".repeat(256);
    const longTitle = "🚀".repeat(700);
    const agent = await f.bdd.createAgent(f.actor, {
      displayName: longName,
      visibility: "private",
    });
    const created = await f.chat.createThread(f.actor, {
      agentId: agent.agentId,
      title: longTitle,
    });
    const detail = await getThread(f.auth.token(), created.id);
    expect(detail.thread.titleTruncated).toBeTruthy();
    expect(detail.thread.agent.name).toBe(longName);
    expect(detail.thread.title?.length).toBeLessThanOrEqual(1000);
    expect(detail.thread.agent.name).toHaveLength(512);
    expect(detail.thread.title?.endsWith("🚀")).toBeTruthy();
    expect(detail.thread.agent.name.endsWith("😀")).toBeTruthy();
  });

  it("projects canonical run activity and unread without the sparse seven-day cap", async () => {
    const f = await chatRunFixture();
    const sent = await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        prompt: "Track canonical activity",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a started run");
    }
    const threadId = sent.body.threadId;
    await flushWaitUntilForTest();
    const active = await listThreads(f.auth.token(), { activity: "active" });
    expect(
      active.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([threadId]);
    expect(active.threads[0]?.activity).toStrictEqual({
      queued: false,
      pending: true,
      running: false,
    });
    expect(
      (await listThreads(f.auth.token(), { unread: true })).threads,
    ).toStrictEqual([]);

    await f.runs.requestCancelRun(f.actor, sent.body.runId, [200]);
    await flushWaitUntilForTest();
    await expect
      .poll(async () => {
        return (await f.chat.listThreadEvents(f.actor, threadId)).events.some(
          (event) => {
            return (
              event.eventType === "run.cancelled" &&
              event.runId === sent.body.runId
            );
          },
        );
      })
      .toBe(true);
    await f.chat.markThreadUnread(f.actor, threadId);
    const before = await f.chat.readThread(f.actor, threadId);
    const unread = await listThreads(f.auth.token(), {
      unread: true,
      activity: "idle",
    });
    expect(
      unread.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([threadId]);
    expect(
      (await getThread(f.auth.token(), threadId)).thread.unread,
    ).toBeTruthy();
    await expect(f.chat.readThread(f.actor, threadId)).resolves.toStrictEqual(
      before,
    );
    const retainedToken = f.auth.token({
      exp: Math.floor((now() + 9 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 8 * 24 * 60 * 60 * 1000, async () => {
      expect((await f.chat.listIndicators(f.actor)).threads).toStrictEqual({});
      expect(
        (await listThreads(retainedToken, { unread: true })).threads.map(
          (thread) => {
            return thread.threadId;
          },
        ),
      ).toStrictEqual([threadId]);
    });
    await f.chat.markThreadRead(f.actor, threadId);
    expect(
      (await listThreads(f.auth.token(), { unread: true })).threads,
    ).toStrictEqual([]);
    expect(
      (await getThread(f.auth.token(), threadId)).thread.unread,
    ).toBeFalsy();
  });

  it("continues pagination through intervening rename and deletion", async () => {
    const f = await threadFixture();
    const threads: { id: string }[] = [];
    for (const title of ["Page first", "Page second", "Page third"]) {
      const thread = await f.chat.createThread(f.actor, {
        agentId: f.agent.agentId,
        title,
      });
      threads.push(thread);
    }
    const token = f.auth.token();
    const expected = threads
      .map((thread) => {
        return thread.id;
      })
      .reverse();
    const first = await listThreads(token, {
      agentId: f.agent.agentId,
      limit: 1,
    });
    expect(
      first.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual(expected.slice(0, 1));
    const renamedId = expected[1];
    const deletedId = expected[2];
    if (!first.nextCursor || !renamedId || !deletedId) {
      throw new Error("Expected three threads and a continuation cursor");
    }
    await f.chat.renameThread(f.actor, renamedId, "Renamed between pages");
    await f.chat.deleteThread(f.actor, deletedId);
    const next = await listThreads(token, {
      agentId: f.agent.agentId,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(
      next.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([renamedId]);
    expect(next.threads[0]?.title).toBe("Renamed between pages");
    expect(next.nextCursor).toBeNull();
    const fresh = await listThreads(token, { agentId: f.agent.agentId });
    expect(
      fresh.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual(expected.slice(0, 2));
  });

  it("accepts a nonempty timestamp range smaller than one millisecond", async () => {
    const auth = await fixture();
    const page = await listThreads(auth.token(), {
      since: "2026-09-18T00:00:00.000001Z",
      before: "2026-09-18T00:00:00.000002Z",
    });
    expect(page.threads).toStrictEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { since: "2026-09-18T00:00:00Z", before: "2026-09-17T00:00:00Z" },
    { activity: "completed" },
    { cursor: "x".repeat(4097) },
  ])("rejects invalid list arguments %j", async (args) => {
    const auth = await fixture();
    expect(
      (await callTool(auth.token(), "list_chat_threads", args)).isError,
    ).toBeTruthy();
  });

  it("returns canonical activity isolated to each signed organization", async () => {
    const auth = await fixture();
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const callbacks = createChatCallbacksApi(context);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const actors = [
      bdd.user({ userId: auth.userId, orgId: auth.orgId }),
      bdd.user({ userId: auth.userId, orgId: `org_${randomUUID()}` }),
    ];
    const expected: { threadId: string; agentId: string }[] = [];
    for (const actor of actors) {
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "MCP indicators",
        visibility: "private",
      });
      const sent = await chat.requestSendEvent(
        actor,
        { agentId: agent.agentId, prompt: "Read my indicators" },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected an active chat thread");
      }
      createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
      await accept(
        setupApp({ context, routes: featureSwitchesRoutes })(
          featureSwitchesContract,
        ).update({
          headers: { authorization: "Bearer clerk-session" },
          body: { switches: { [FeatureSwitchKey.McpServer]: true } },
        }),
        [200],
      );
      const projection = await chat.listIndicators(actor);
      expect(projection).toStrictEqual({
        agents: { [agent.agentId]: "active" },
        threads: { [sent.body.threadId]: "active" },
      });
      expected.push({ threadId: sent.body.threadId, agentId: agent.agentId });
    }
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: actors.map((actor) => {
        return {
          id: randomUUID(),
          role: "org:member",
          organization: { id: actor.orgId },
        };
      }),
      totalCount: 2,
    });
    const results = await Promise.all(
      actors.map((actor) => {
        return accept(
          client().request({
            extraHeaders: protocolHeaders(
              auth.token({ org_id: actor.orgId }),
              "tools/call",
            ),
            body: requestBody("tools/call", true, {
              name: "list_chat_threads",
              arguments: {},
            }),
          }),
          [200],
        );
      }),
    );
    expect(
      results.map((result) => {
        const output = z
          .object({ result: z.object({ structuredContent: z.unknown() }) })
          .parse(rpc(result.body)).result.structuredContent;
        const page = mcpListChatThreadsOutputSchema.parse(output);
        expect(page.threads).toHaveLength(1);
        const thread = page.threads[0];
        if (!thread) {
          throw new Error("Expected one owned active thread");
        }
        expect(Object.values(thread.activity).some(Boolean)).toBeTruthy();
        expect(thread.unread).toBeFalsy();
        return { threadId: thread.threadId, agentId: thread.agent.agentId };
      }),
    ).toStrictEqual(expected);
  });
});
