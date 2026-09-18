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
import { seedRetentionOutputEvent$ } from "../../../test-fixtures/chat-event-retention";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
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

  it("propagates client cancellation into a partially consumed archive and permits a later fresh read", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const sent = await f.send("Read after cancellation");
    await snapshotMessages(sent.threadId);
    const archive = puts.at(-1);
    if (!archive) {
      throw new Error("Expected archive for cancellation");
    }
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
                "get_chat_messages",
              ),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(
              requestBody("tools/call", true, {
                name: "get_chat_messages",
                arguments: { threadId: sent.threadId },
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
    expect(
      (await getMessages(f.auth.token(), { threadId: sent.threadId }))
        .messages[0]?.text,
    ).toBe("Read after cancellation");
  });

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
            { name: "list_chat_threads", annotations: { readOnlyHint: true } },
            { name: "get_chat_thread", annotations: { readOnlyHint: true } },
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
      const auth = await fixture();
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const transport = new StreamableHTTPClientTransport(new URL(resource), {
        authProvider: {
          token: () => {
            return Promise.resolve(auth.token());
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
        "list_chat_threads",
        "get_chat_thread",
      ]);
      const result = await sdk.callTool({
        name: "list_chat_threads",
        arguments: {},
      });
      expect(result).toMatchObject({
        structuredContent: { threads: [], nextCursor: null },
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
    const token = auth.token({ scope: "okou:chat:manage" });
    for (const { method, name, args } of [
      { method: "tools/list", name: "list_chat_threads", args: {} },
      { method: "tools/call", name: "list_chat_threads", args: {} },
      {
        method: "tools/call",
        name: "get_chat_thread",
        args: { threadId: randomUUID() },
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
