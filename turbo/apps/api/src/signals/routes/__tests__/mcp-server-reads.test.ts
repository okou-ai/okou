import {
  mcpListAgentsOutputSchema,
  mcpListModelsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { seedRetentionOutputEvent$ } from "../../../test-fixtures/chat-event-retention";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";

import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-messages";
import { mcpSearchChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-search";

import { mcpToolErrorContentSchema } from "@okouai/api-contracts/contracts/mcp-tool-errors";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";

import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";

import { mcpServerRoutes } from "../mcp-server";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";

import {
  rejectSearchablePromptFixture,
  setChatSearchEventTimestampPrecisionFixture,
  updateChatSearchSourceThreadFixture,
} from "../../../test-fixtures/chat-event-search";

import { createBddApi } from "./helpers/api-bdd";

import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

import { createRunsApi } from "./helpers/api-bdd-runs";

import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { chatEventDisplayText } from "./helpers/chat-event";
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
  return result;
}

function structuredToolError(result: Awaited<ReturnType<typeof callTool>>) {
  expect(result.isError).toBeTruthy();
  return mcpToolErrorContentSchema.parse(result.structuredContent).error;
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
  // Canonical message reads use the no-credit Auto rejection path, not a
  // paid Custom route that would launch a Run.
  async function send(
    prompt: string,
    threadId?: string,
    userMessage?: UserMessageDocument,
  ) {
    const clientEventId = randomUUID();
    const response = await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        prompt,
        threadId,
        userMessage,
        clientEventId,
      },
      [201],
    );
    if (response.status !== 201) {
      throw new Error("Expected an accepted canonical message");
    }
    // A send only enqueues; the background pick rejects this no-credit input
    // without a run. Finish it so later reads, including reads after the
    // history moves into a snapshot, see the rejection.
    await flushWaitUntilForTest();
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

/**
 * Run-status, cancellation and search scenarios drive chat runs through the
 * native Runner claim protocol. Fable stays off Pi, while the fixture's
 * default Sonnet 5 route now executes API-first.
 */
const NATIVE_RUNNER_MODEL = "claude-fable-5-1";

async function nativeRunnerChatActor(
  f: ReturnType<typeof createChatEventsFixture>,
  auth: { readonly userId: string; readonly orgId: string },
) {
  const actor = await f.entitledChatActor({
    userId: auth.userId,
    orgId: auth.orgId,
  });
  await f.api.updateOrgModelPolicies(actor.actor, [
    {
      model: NATIVE_RUNNER_MODEL,
      preferred: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: actor.providerId,
    },
  ]);
  return actor;
}

async function assistantMessagesFixture(
  prompt: string,
  messages: readonly string[],
) {
  const auth = fixture();
  const f = createChatEventsFixture(context);
  const actor = await nativeRunnerChatActor(f, auth);
  const sent = await f.sendChatRun(actor.actor, {
    agentId: actor.agentId,
    model: NATIVE_RUNNER_MODEL,
    prompt,
  });
  onTestFinished(async () => {
    await f.cancelChatRun(actor.actor, sent.runId);
  });
  const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
  await f.webhooks.requestAgentEvents(
    {
      runId: sent.runId,
      events: messages.map((text, sequenceNumber) => {
        return {
          type: "assistant",
          sequenceNumber,
          message: { content: [{ type: "text", text }] },
        };
      }),
    },
    claimed.sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
  return {
    auth,
    actor: actor.actor,
    chat: f.chat,
    threadId: sent.threadId,
    runId: sent.runId,
  };
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
  await runs.ensureOrgModelProvider(actor, { model: NATIVE_RUNNER_MODEL });
  const agent = await bdd.createAgent(actor, {
    displayName: "MCP activity agent",
    visibility: "private",
  });
  return { auth, actor, chat, agent, runs };
}

describe("MCP canonical message reads", () => {
  it("pages latest and earlier messages with the default 20-message limit", async () => {
    const f = await assistantMessagesFixture(
      "Message 0",
      Array.from({ length: 22 }, (_, index) => {
        return `Message ${index + 1}`;
      }),
    );
    const token = f.auth.token();
    const canonical = await f.chat.listThreadEvents(f.actor, f.threadId);
    const latest = await getMessages(token, { threadId: f.threadId });
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
      threadId: f.threadId,
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
        return (
          (event.eventType === "input.prompt" ||
            event.eventType === "output.message") &&
          event.runId === f.runId &&
          chatEventDisplayText(event) === message.text
        );
      });
      expect(original).toBeDefined();
      expect(message.ref).toStrictEqual({
        threadId: f.threadId,
        eventId: original?.id,
        seqId: original?.seqId,
      });
      expect(new URL(message.url).pathname).toBe(`/chats/${f.threadId}`);
    }
  });

  it("preserves rejected input references and original timestamps across message pages", async () => {
    const f = await messageFixture();
    const sent = await f.send("Message 0");
    await f.send("Message 1", sent.threadId);
    const token = f.auth.token();
    const canonical = await f.chat.listThreadEvents(f.actor, sent.threadId);
    const args = { threadId: sent.threadId, limit: 1 };
    const latest = await getMessages(token, args);
    expect(latest.messages).toHaveLength(1);
    expect(latest.messages[0]?.text).toBe("Message 1");
    expect(latest.olderCursor).not.toBeNull();
    const older = await getMessages(token, {
      ...args,
      cursor: latest.olderCursor,
    });
    expect(older.messages).toHaveLength(1);
    expect(older.messages[0]?.text).toBe("Message 0");
    for (const message of [...older.messages, ...latest.messages]) {
      const original = canonical.events.find((event) => {
        return (
          event.eventType === "input.rejected" &&
          chatEventDisplayText(event) === message.text
        );
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
        messageAt: expect.any(String),
        eventType: "input.rejected",
        role: "user",
        runId: null,
        textOffset: 0,
        textComplete: true,
        fileOffset: 0,
        filesComplete: true,
        nextContentCursor: null,
      });
      expect(Date.parse(message.messageAt)).toBe(
        Date.parse(initialInput?.createdAt ?? ""),
      );
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
      structuredToolError(failure);
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
    const actor = await nativeRunnerChatActor(f, auth);
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
    const active = await createChatEventsFixture(context).sendChatRun(f.actor, {
      agentId: f.agent.agentId,
      prompt: "Active request",
    });
    await flushWaitUntilForTest();
    const queued = await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId: active.threadId,
        prompt: `Recall this queued request\n${"😀".repeat(6000)}`,
      },
      [201],
    );
    expect(queued.status).toBe(201);
    const token = f.auth.token();
    const before = await getMessages(token, { threadId: active.threadId });
    const target = before.messages.find((message) => {
      return message.text.startsWith("Recall this queued request\n");
    });
    if (!target) {
      throw new Error("Expected queued visible input");
    }
    expect(target.nextContentCursor).not.toBeNull();
    const recalled = await callTool(
      f.auth.token({ scope: `${requiredScopes} okou:run:cancel` }),
      "revoke_queued_message",
      {
        agentId: f.agent.agentId,
        threadId: active.threadId,
        revokesEventId: target.ref.eventId,
      },
    );
    expect(recalled.isError).not.toBeTruthy();
    expect(recalled.structuredContent).toMatchObject({
      threadId: active.threadId,
    });
    const after = await getMessages(token, { threadId: active.threadId });
    expect(
      after.messages.some((message) => {
        return message.ref.eventId === target.ref.eventId;
      }),
    ).toBeFalsy();
    const staleContent = await callTool(token, "get_chat_messages", {
      threadId: active.threadId,
      cursor: target.nextContentCursor,
    });
    expect(staleContent.isError).toBeTruthy();
    structuredToolError(staleContent);
    expect(
      (
        await callTool(token, "get_chat_messages", {
          threadId: active.threadId,
          around: { eventId: target.ref.eventId },
        })
      ).isError,
    ).toBeTruthy();
    await f.runs.requestCancelRun(f.actor, active.runId, [200]);
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
      structuredToolError(failed);
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
    structuredToolError(changed);
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
    structuredToolError(result);
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
      structuredToolError(failed);
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
      structuredToolError(failed);
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
                    eventType: "output.message",
                    payload: { content: "a" },
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
      structuredToolError(result);
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
    structuredToolError(result);
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
  it("pages beyond 25 matches without losing or repeating canonical references", async () => {
    const query = "mcpsearchpaging";
    const f = await assistantMessagesFixture(
      "Search the assistant output",
      Array.from({ length: 29 }, (_, index) => {
        return `${query} ${index}`;
      }),
    );
    const token = f.auth.token();
    await projectSearchMessages([f.threadId]);
    const canonical = await f.chat.listThreadEvents(f.actor, f.threadId);
    const source = canonical.events
      .filter((event) => {
        return event.eventType === "output.message";
      })
      .map((event) => {
        return {
          ref: { threadId: f.threadId, eventId: event.id, seqId: event.seqId },
          createdAt: event.createdAt,
        };
      });
    source.sort((left, right) => {
      return (
        right.createdAt.localeCompare(left.createdAt) ||
        right.ref.seqId - left.ref.seqId
      );
    });
    const args = { query, limit: 7 };
    let page = await searchMessages(token, args);
    expect(page.matches).toHaveLength(7);
    expect(page.scanLimited).toBeFalsy();
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
      matches.map(({ ref, sourceEventAt }) => {
        return { ref, createdAt: new Date(sourceEventAt).toISOString() };
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
  });

  it("resolves rejected search references across threads without changing their state", async () => {
    const f = await messageFixture();
    const query = "mcpsearchreferences";
    const first = await withMockNowForTest(now(), async () => {
      const sent = await f.send(`${query} 0`);
      for (let index = 1; index < 3; index++) {
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
    const args = { query, limit: 2 };
    let page = await searchMessages(token, args);
    expect(page.matches).toHaveLength(2);
    expect(page.scanLimited).toBeFalsy();
    const matches = [...page.matches];
    while (page.nextCursor !== null) {
      expect(matches.length).toBeLessThan(4);
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
      matches.map(({ ref, sourceEventAt }) => {
        return { ref, createdAt: new Date(sourceEventAt).toISOString() };
      }),
    ).toStrictEqual(source);
    expect(matches).toHaveLength(4);
    expect(
      new Set(
        matches.map(({ ref }) => {
          return ref.eventId;
        }),
      ).size,
    ).toBe(4);
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
      sourceEventAt: string;
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
      expected.push({ ref: message.ref, sourceEventAt: createdAt });
    }
    expected.sort((left, right) => {
      return (
        right.sourceEventAt.localeCompare(left.sourceEventAt) ||
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
      actual.map(({ ref, sourceEventAt }) => {
        return { ref, sourceEventAt };
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

  async function setupMessageSearchFilters() {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
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
    return { actor, args, baseTime, other, query, sent, token };
  }

  it("applies the result limit after ordering message search matches", async () => {
    const { args, other, token } = await setupMessageSearchFilters();
    expect((await searchMessages(token, args)).matches[0]?.ref.threadId).toBe(
      other.threadId,
    );
  });

  it.each(["agent", "thread"] as const)(
    "applies the $filter filter before limiting message search matches",
    async (filter) => {
      const { actor, args, query, sent, token } =
        await setupMessageSearchFilters();
      const filters =
        filter === "agent"
          ? { agentId: actor.agentId }
          : { threadId: sent.threadId };
      expect(
        (await searchMessages(token, { ...args, ...filters })).matches[0]
          ?.excerpt.text,
      ).toBe(`${query} queued after`);
    },
  );

  it.each(["role", "before", "bounded"] as const)(
    "applies the $filter source filter before limiting message search matches",
    async (filter) => {
      const { args, baseTime, query, sent, token } =
        await setupMessageSearchFilters();
      const since = new Date(baseTime + 1000).toISOString();
      const before = new Date(baseTime + 2000).toISOString();
      const filters =
        filter === "role"
          ? ({ role: "assistant" } as const)
          : filter === "before"
            ? { before }
            : { since, before };
      const page = await searchMessages(token, { ...args, ...filters });
      expect(page.matches).toMatchObject([
        {
          role: "assistant",
          runId: sent.runId,
          excerpt: { text: `${query} assistant answer` },
        },
      ]);
    },
  );

  it("applies an inclusive source-time lower bound before limiting", async () => {
    const { args, baseTime, query, sent, token } =
      await setupMessageSearchFilters();
    const before = new Date(baseTime + 2000).toISOString();
    expect(
      (
        await searchMessages(token, {
          ...args,
          threadId: sent.threadId,
          since: before,
        })
      ).matches[0]?.excerpt.text,
    ).toBe(`${query} queued after`);
  });

  it("filters message search by user role", async () => {
    const { query, token } = await setupMessageSearchFilters();
    expect(
      (await searchMessages(token, { query, role: "user" })).matches,
    ).toHaveLength(3);
  });

  it("excludes private message context from search", async () => {
    const { token } = await setupMessageSearchFilters();
    expect(
      (await searchMessages(token, { query: "mcpprivateneedle" })).matches,
    ).toStrictEqual([]);
  });

  it("returns no message-search matches for an unrelated thread", async () => {
    const { args, token } = await setupMessageSearchFilters();
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
    const { runId, threadId } = await createChatEventsFixture(
      context,
    ).sendChatRun(f.actor, {
      agentId: f.agent.agentId,
      prompt: "Active unrelated task",
    });
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

    // Releasing this run can pick the remaining input. Settle that work
    // before test teardown clears its Runner and storage configuration.
    await f.runs.requestCancelRun(f.actor, runId, [200]);
    await flushWaitUntilForTest();
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
    structuredToolError(missing);
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
    structuredToolError(combined);
    expect(combined.content[0]?.text).toMatch(/budget|limit/u);
    expect(JSON.stringify(combined)).not.toContain("VISIBLE_EXCERPT_CANARY_");
  });

  it("continues after a full scan of lexical false positives without hiding an older exact match", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
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
      structuredToolError(result);
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
      structuredToolError(result);
    },
  );
});

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

describe("MCP ordinary discovery", () => {
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

  it("discovers the projected system default without stored policies", async () => {
    const auth = await fixture();
    const models = await listModels(auth.token());
    expect(models.defaultModel).toStrictEqual({
      model: SEEDED_SYSTEM_DEFAULT_MODEL,
      source: "org_default",
    });
  });
});
