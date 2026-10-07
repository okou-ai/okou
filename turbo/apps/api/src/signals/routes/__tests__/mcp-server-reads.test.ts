import {
  mcpListAgentsOutputSchema,
  mcpListModelsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";
import { mcpGetChatInputOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-input";
import { mcpSendChatMessageOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mcpGetRunStatusOutputSchema } from "@okouai/api-contracts/contracts/mcp-run-status";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";

import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-messages";

import { mcpToolErrorContentSchema } from "@okouai/api-contracts/contracts/mcp-tool-errors";
import {
  resolveChatEventRecommendedFollowups,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { http, HttpResponse } from "msw";

import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";

import { mcpServerRoutes } from "../mcp-server";

import { createBddApi } from "./helpers/api-bdd";

import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";

import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { chatEventDisplayText } from "./helpers/chat-event";

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

async function messageFixture() {
  const f = await threadFixture();
  // Canonical message reads use the no-credit Auto rejection path, not a
  // personal subscription route that would launch a Run.
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
  await f.api.updateUserModelPreference(actor.actor, NATIVE_RUNNER_MODEL);
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
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: NATIVE_RUNNER_MODEL,
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "MCP activity agent",
    visibility: "private",
  });
  return { auth, actor, chat, agent, runs };
}

describe("MCP shared read budgets", () => {
  it.each([
    {
      name: "multibyte text within budget",
      prompt: "界".repeat(40_000),
      oversized: false,
    },
    {
      name: "oversized multibyte text",
      prompt: "界".repeat(60_000),
      oversized: true,
    },
    {
      name: "oversized JSON escaping",
      prompt: `Large prompt\n${"\n".repeat(85_000)}`,
      oversized: true,
    },
  ])(
    "bounds Run structured output by serialized bytes: $name",
    async ({ prompt, oversized }) => {
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
      const web = await f.api.readRun(actor.actor, sent.runId);
      expect(web.prompt).toBe(prompt);
      const bytes = Buffer.byteLength(JSON.stringify(web));
      const result = await callTool(auth.token(), "get_run_status", {
        runId: sent.runId,
      });
      if (oversized) {
        expect(bytes).toBeGreaterThan(160 * 1024);
        expect(structuredToolError(result)).toMatchObject({
          code: "response_limit",
          retryable: false,
        });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
        expect(result.structuredContent).not.toHaveProperty("prompt");
      } else {
        expect(bytes).toBeLessThanOrEqual(160 * 1024);
        expect(result.isError).not.toBeTruthy();
        expect(
          mcpGetRunStatusOutputSchema.parse(result.structuredContent),
        ).toStrictEqual(web);
      }
      const foreign = await callTool(
        auth.token({ sub: `user_${randomUUID()}` }),
        "get_run_status",
        { runId: sent.runId },
      );
      expect(structuredToolError(foreign).code).toBe("not_found");
    },
  );

  it("keeps consumed input readable with an unrelated oversized native Run prompt", async () => {
    const auth = fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const eventId = randomUUID();
    const prompt = `Oversized native prompt ${"界".repeat(60_000)}`;
    // The ordinary Web send accepts this prompt; MCP send has its own smaller
    // input bound. No historical result or private business row is fabricated.
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      model: NATIVE_RUNNER_MODEL,
      prompt,
      clientEventId: eventId,
    });
    const runId = sent.runId;
    onTestFinished(async () => {
      const run = await f.api.readRun(actor.actor, runId);
      if (["pending", "queued", "running"].includes(run.status)) {
        await f.cancelChatRun(actor.actor, runId);
      }
    });
    const token = auth.token();
    const args = { threadId: sent.threadId, eventId };
    const initial = mcpGetChatInputOutputSchema.parse(
      (await callTool(token, "get_chat_input", args)).structuredContent,
    );
    expect(initial).toMatchObject({
      ...args,
      inputStatus: "consumed",
      run: { runId, status: "pending" },
      error: null,
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, runId);
    f.chatCallbacks.mockChatOutputEvents([]);
    await f.completeChatRunOk(runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    const web = await f.api.readRun(actor.actor, runId);
    expect(web.prompt).toBe(prompt);
    expect(Buffer.byteLength(JSON.stringify(web))).toBeGreaterThan(160 * 1024);
    expect(
      structuredToolError(await callTool(token, "get_run_status", { runId })),
    ).toMatchObject({ code: "response_limit", retryable: false });
    const observed = await callTool(token, "get_chat_input", args);
    expect(observed.isError).not.toBeTruthy();
    expect(
      mcpGetChatInputOutputSchema.parse(observed.structuredContent),
    ).toMatchObject({
      ...args,
      inputStatus: "consumed",
      run: { runId, status: "completed" },
      error: null,
    });
    expect(JSON.stringify(observed)).not.toContain("Oversized native prompt");
    expect(
      structuredToolError(
        await callTool(
          auth.token({ sub: `user_${randomUUID()}` }),
          "get_chat_input",
          args,
        ),
      ).code,
    ).toBe("not_found");
  });
});

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
        eventId:
          message.role === "user"
            ? (original?.revokesEventId ?? original?.id)
            : original?.id,
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
          eventId: initialInput?.id,
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
        eventId: target.ref.eventId,
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
describe("MCP original input observations", () => {
  it("observes a small live input despite unrelated output exceeding the full-history budget", async () => {
    const auth = fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const token = auth.token({
      scope: `${requiredScopes} okou:chat:send okou:run:cancel`,
    });
    const sent = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(token, "send_chat_message", {
          agentId: actor.agentId,
          model: NATIVE_RUNNER_MODEL,
          prompt: "Small observed origin",
        })
      ).structuredContent,
    );
    await flushWaitUntilForTest();
    const selector = { threadId: sent.threadId, eventId: sent.eventId };
    const first = mcpGetChatInputOutputSchema.parse(
      (await callTool(token, "get_chat_input", selector)).structuredContent,
    );
    if (first.inputStatus !== "consumed") {
      throw new Error("Expected an admitted native Run");
    }
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, first.run.runId);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, first.run.runId);
    await f.webhooks.requestAgentEvents(
      {
        runId: first.run.runId,
        events: Array.from({ length: 33 }, (_, sequenceNumber) => {
          return {
            type: "assistant",
            sequenceNumber,
            message: {
              content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
            },
          };
        }),
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(
      structuredToolError(
        await callTool(token, "get_chat_messages", { threadId: sent.threadId }),
      ).code,
    ).toBe("history_limit");
    const observed = mcpGetChatInputOutputSchema.parse(
      (await callTool(token, "get_chat_input", selector)).structuredContent,
    );
    expect(observed).toStrictEqual({
      ...selector,
      createdAt: first.createdAt,
      inputStatus: "consumed",
      run: { runId: first.run.runId, status: "running" },
      error: null,
    });
  }, 30_000);

  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps input consumption separate from native %s state and owner/org authority",
    async (status) => {
      const auth = fixture();
      const f = createChatEventsFixture(context);
      const actor = await nativeRunnerChatActor(f, auth);
      const token = auth.token({
        scope: `${requiredScopes} okou:chat:send okou:run:cancel`,
      });
      const sent = mcpSendChatMessageOutputSchema.parse(
        (
          await callTool(token, "send_chat_message", {
            agentId: actor.agentId,
            model: NATIVE_RUNNER_MODEL,
            prompt: "PRIVATE_INPUT_STATE_CANARY",
          })
        ).structuredContent,
      );
      await flushWaitUntilForTest();
      const selector = { threadId: sent.threadId, eventId: sent.eventId };
      const initial = mcpGetChatInputOutputSchema.parse(
        (await callTool(token, "get_chat_input", selector)).structuredContent,
      );
      if (initial.inputStatus !== "consumed") {
        throw new Error("Expected the accepted input to be consumed");
      }
      const runId = initial.run.runId;
      onTestFinished(async () => {
        const run = await f.api.readRun(actor.actor, runId);
        if (["pending", "queued", "running"].includes(run.status)) {
          await f.cancelChatRun(actor.actor, runId);
        }
      });
      const claimed = await f.claimChatRun(actor.runnerGroup, runId);
      if (status === "completed") {
        await f.completeChatRunOk(runId, claimed.sandboxHeaders);
      } else if (status === "failed") {
        await f.failChatRun(
          runId,
          claimed.sandboxHeaders,
          "PRIVATE_RUN_ERROR_CANARY",
        );
      } else {
        expect(
          (await callTool(token, "cancel_run", { runId })).isError,
        ).not.toBeTruthy();
      }
      await flushWaitUntilForTest();
      const observed = mcpGetChatInputOutputSchema.parse(
        (await callTool(token, "get_chat_input", selector)).structuredContent,
      );
      expect(observed).toStrictEqual({
        ...selector,
        createdAt: initial.createdAt,
        inputStatus: "consumed",
        run: { runId, status },
        error: null,
      });
      expect(JSON.stringify(observed)).not.toContain("PRIVATE_");
      expect(
        structuredToolError(
          await callTool(
            auth.token({ sub: `user_${randomUUID()}` }),
            "get_chat_input",
            selector,
          ),
        ).code,
      ).toBe("not_found");
      const foreignOrg = `org_${randomUUID()}`;
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              id: randomUUID(),
              role: "org:member",
              organization: { id: auth.orgId },
            },
            {
              id: randomUUID(),
              role: "org:member",
              organization: { id: foreignOrg },
            },
          ],
          totalCount: 2,
        },
      );
      expect(
        structuredToolError(
          await callTool(
            auth.token({ org_id: foreignOrg }),
            "get_chat_input",
            selector,
          ),
        ).code,
      ).toBe("not_found");
    },
  );

  it("arbitrates live recall against consumption without resurrecting the origin", async () => {
    const auth = fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const active = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      model: NATIVE_RUNNER_MODEL,
      prompt: "Hold the active native Run",
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, active.runId);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
    const token = auth.token({
      scope: `${requiredScopes} okou:chat:send okou:run:cancel`,
    });
    const sent = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(token, "send_chat_message", {
          agentId: actor.agentId,
          threadId: active.threadId,
          model: NATIVE_RUNNER_MODEL,
          prompt: "Race recall and steering",
        })
      ).structuredContent,
    );
    await flushWaitUntilForTest();
    const selector = { threadId: active.threadId, eventId: sent.eventId };
    expect(
      (await callTool(token, "get_chat_input", selector)).structuredContent,
    ).toMatchObject({ inputStatus: "queued" });
    const [recall, steer] = await Promise.all([
      callTool(token, "revoke_queued_message", {
        ...selector,
        agentId: actor.agentId,
      }),
      f.api.requestDeclareSteeredInputAs(
        `Bearer ${claimed.claim.sandboxToken}`,
        active.runId,
        sent.eventId,
        [200, 404, 409],
      ),
    ]);
    await flushWaitUntilForTest();
    const observed = mcpGetChatInputOutputSchema.parse(
      (await callTool(token, "get_chat_input", selector)).structuredContent,
    );
    expect(observed.eventId).toBe(sent.eventId);
    if (observed.inputStatus === "recalled") {
      expect(recall.isError).not.toBeTruthy();
      expect(steer.status).not.toBe(200);
      expect(
        (await getMessages(token, { threadId: active.threadId })).messages.some(
          (message) => {
            return message.ref.eventId === sent.eventId;
          },
        ),
      ).toBeFalsy();
    } else {
      expect(observed).toMatchObject({
        inputStatus: "consumed",
        run: { runId: active.runId, status: "running" },
      });
      expect(steer.status).toBe(200);
      expect(recall.isError).toBeTruthy();
    }
  });

  it("recognizes a recommended-followup prompt as an origin rather than its replacement", async () => {
    const auth = fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    mockGoogleText();
    server.use(
      http.post(VERTEX_TEXT_URL, async ({ request }) => {
        const payload = vertexTextRequest(await request.json(), request.url);
        return vertexTextResponse(
          payload.messages[0]?.content.includes(
            "recommended follow-up messages",
          )
            ? JSON.stringify([
                { prompt: "Use the recommendation", kind: "talk" },
              ])
            : "Recommended origin",
        );
      }),
    );
    const completed = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      model: NATIVE_RUNNER_MODEL,
      prompt: "Generate a recommended follow-up",
    });
    const claim = await f.claimChatRun(actor.runnerGroup, completed.runId);
    await f.webhooks.requestAgentEvents(
      {
        runId: completed.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [{ type: "text", text: "An answer with a follow-up" }],
            },
          },
        ],
      },
      claim.sandboxHeaders,
      [200],
    );
    await f.completeChatRunOk(completed.runId, claim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    const page = await f.chat.listThreadEvents(actor.actor, completed.threadId);
    const recommendation = page.events.find((event) => {
      return (
        event.eventType === "output.followups" &&
        resolveChatEventRecommendedFollowups(event).length > 0
      );
    });
    if (!recommendation) {
      throw new Error("Expected a real generated recommendation");
    }
    const eventId = randomUUID();
    await f.chat.requestSendEvent(
      actor.actor,
      {
        agentId: actor.agentId,
        threadId: completed.threadId,
        model: NATIVE_RUNNER_MODEL,
        prompt: "Use the recommendation",
        revokesEventId: recommendation.id,
        clientEventId: eventId,
      },
      [201],
    );
    await flushWaitUntilForTest();
    const token = auth.token();
    const observed = mcpGetChatInputOutputSchema.parse(
      (
        await callTool(token, "get_chat_input", {
          threadId: completed.threadId,
          eventId,
        })
      ).structuredContent,
    );
    expect(observed).toMatchObject({ eventId, inputStatus: "consumed" });
    if (observed.inputStatus !== "consumed") {
      throw new Error("Expected the recommendation to launch a native Run");
    }
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, observed.run.runId);
    });
    const after = await f.chat.listThreadEvents(
      actor.actor,
      completed.threadId,
    );
    const replacement = after.events.find((event) => {
      return event.revokesEventId === eventId;
    });
    if (!replacement) {
      throw new Error("Expected the consuming replacement");
    }
    for (const invalidId of [recommendation.id, replacement.id]) {
      expect(
        structuredToolError(
          await callTool(token, "get_chat_input", {
            threadId: completed.threadId,
            eventId: invalidId,
          }),
        ).code,
      ).toBe("not_found");
    }
  });

  it("excludes live automation origins and their consuming replacements", async () => {
    const auth = fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const workflowId = await createWorkflowsBddApi(context).createWorkflow(
      actor.actor,
      {
        agentId: actor.agentId,
        name: "hidden-mcp-input",
      },
    );
    const created = await accept(
      f.threadPiAutomationsClient().create({
        headers: f.sessionHeaders(actor.actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const started = await accept(
      f.threadPiAutomationsClient().run({
        headers: f.sessionHeaders(actor.actor),
        params: { id: created.body.id },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const threadId = started.body.chatThreadId;
    const page = await f.chat.listThreadEvents(actor.actor, threadId);
    const origin = page.events.find((event) => {
      return event.eventType === "input.automation";
    });
    if (!origin) {
      throw new Error("Expected the real hidden automation origin");
    }
    const replacement = page.events.find((event) => {
      return event.revokesEventId === origin.id;
    });
    if (!replacement?.runId) {
      throw new Error("Expected the automation's consuming native Run");
    }
    const runId = replacement.runId;
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, runId);
    });
    for (const eventId of [origin.id, replacement.id]) {
      expect(
        structuredToolError(
          await callTool(auth.token(), "get_chat_input", { threadId, eventId }),
        ).code,
      ).toBe("not_found");
    }
  });

  it("tracks concurrent identical inputs through queue, steering and a shared Run's completion", async () => {
    const auth = fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const token = auth.token({
      scope: `${requiredScopes} okou:chat:send okou:run:cancel`,
    });
    const initial = mcpSendChatMessageOutputSchema.parse(
      (
        await callTool(token, "send_chat_message", {
          agentId: actor.agentId,
          model: NATIVE_RUNNER_MODEL,
          prompt: "MCP origin anchor",
        })
      ).structuredContent,
    );
    await flushWaitUntilForTest();
    const observe = async (eventId: string) => {
      return mcpGetChatInputOutputSchema.parse(
        (
          await callTool(token, "get_chat_input", {
            threadId: initial.threadId,
            eventId,
          })
        ).structuredContent,
      );
    };
    const first = await observe(initial.eventId);
    if (first.inputStatus !== "consumed") {
      throw new Error(
        "Expected the accepted origin to be picked into a real Run",
      );
    }
    const runId = first.run.runId;
    onTestFinished(async () => {
      const run = await f.api.readRun(actor.actor, runId);
      if (
        run.status === "pending" ||
        run.status === "running" ||
        run.status === "queued"
      ) {
        await f.cancelChatRun(actor.actor, runId);
      }
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, runId);
    const sends = await Promise.all(
      [0, 1].map(async () => {
        return mcpSendChatMessageOutputSchema.parse(
          (
            await callTool(token, "send_chat_message", {
              agentId: actor.agentId,
              threadId: initial.threadId,
              model: NATIVE_RUNNER_MODEL,
              prompt: "Identical MCP steering input",
            })
          ).structuredContent,
        );
      }),
    );
    await flushWaitUntilForTest();
    expect(
      new Set(
        sends.map((sent) => {
          return sent.eventId;
        }),
      ).size,
    ).toBe(2);
    for (const sent of sends) {
      await expect(observe(sent.eventId)).resolves.toMatchObject({
        eventId: sent.eventId,
        inputStatus: "queued",
        run: null,
        error: null,
      });
    }
    const queuedHistory = await getMessages(token, {
      threadId: initial.threadId,
    });
    for (const message of queuedHistory.messages.filter((message) => {
      return message.text === "Identical MCP steering input";
    })) {
      await f.api.declareSteeredInput(
        claimed.claim.sandboxToken,
        runId,
        message.ref.eventId,
      );
    }
    const after = await getMessages(token, { threadId: initial.threadId });
    for (const sent of sends) {
      await expect(observe(sent.eventId)).resolves.toMatchObject({
        eventId: sent.eventId,
        inputStatus: "consumed",
        run: { runId, status: "running" },
        error: null,
      });
      const message = after.messages.find((item) => {
        return item.ref.eventId === sent.eventId;
      });
      const queued = queuedHistory.messages.find((item) => {
        return item.ref.eventId === sent.eventId;
      });
      expect(message?.ref.seqId).not.toBe(queued?.ref.seqId);
      const around = await getMessages(token, {
        threadId: initial.threadId,
        around: { eventId: sent.eventId },
        limit: 1,
      });
      expect(around.messages[0]?.ref.eventId).toBe(sent.eventId);
      expect(
        structuredToolError(
          await callTool(token, "revoke_queued_message", {
            agentId: actor.agentId,
            threadId: initial.threadId,
            eventId: sent.eventId,
          }),
        ).code,
      ).toBe("bad_request");
    }
    await expect(f.api.readRun(actor.actor, runId)).resolves.toMatchObject({
      status: "running",
    });
    f.chatCallbacks.mockChatOutputEvents([]);
    await f.completeChatRunOk(runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    for (const sent of [initial, ...sends]) {
      await expect(observe(sent.eventId)).resolves.toMatchObject({
        eventId: sent.eventId,
        inputStatus: "consumed",
        run: { runId, status: "completed" },
        error: null,
      });
    }
  });
});

describe("MCP message search", () => {
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

  it("discovers Auto as the null default without a member preference", async () => {
    const auth = await fixture();
    const models = await listModels(auth.token());
    expect(models.models).toContainEqual(
      expect.objectContaining({ id: null, name: "Auto" }),
    );
    expect(models.defaultModel).toStrictEqual({
      model: null,
      source: "org_default",
    });
  });
});
