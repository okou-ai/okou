import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import { activitySummaryResponseSchema } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadsContract,
  indicatorsSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  mcpGetChatMessagesOutputSchema,
  mcpGetChatThreadOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-snapshots";
import {
  mcpCancelRunOutputSchema,
  mcpSendChatMessageOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-tools";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mcpServerRoutes } from "../mcp-server";
import { mcpChatSearchContract } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const mcp = createMcpWebApi(context);

async function fixture() {
  const actor = bdd.user({ orgId: `org_${randomUUID()}` });
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Web MCP adapter",
    visibility: "private",
  });
  const token = mcp.authorize(actor);
  return { actor, agentId: agent.agentId, token };
}
function body(result: Awaited<ReturnType<typeof mcp.call>>): unknown {
  return (
    result.structuredContent ?? JSON.parse(result.content[0]?.text ?? "null")
  );
}
function error(result: Awaited<ReturnType<typeof mcp.call>>) {
  expect(result.isError).toBeTruthy();
  return apiErrorSchema.parse(body(result)).error;
}
async function send(
  f: Awaited<ReturnType<typeof fixture>>,
  prompt: string,
  threadId?: string,
) {
  const result = await mcp.call(f.token(), "send_chat_message", {
    agentId: f.agentId,
    prompt,
    ...(threadId ? { threadId } : {}),
  });
  expect(result.isError).not.toBeTruthy();
  return mcpSendChatMessageOutputSchema.parse(body(result));
}

describe("thin MCP Web adapters", () => {
  it.each([true, false])(
    "discovers and calls the same tools through the SDK (modern=%s)",
    async (modern) => {
      const f = await fixture();
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const sdk = new Client(
        { name: "web-parity", version: "1" },
        {
          versionNegotiation: {
            mode: modern ? { pin: "2026-07-28" } : "legacy",
          },
        },
      );
      onTestFinished(() => {
        return sdk.close();
      });
      await sdk.connect(
        new StreamableHTTPClientTransport(
          new URL("https://api.mcp.example.test/mcp"),
          {
            authProvider: {
              token: () => {
                return Promise.resolve(f.token());
              },
            },
            fetch: async (input, init) => {
              return await app.request(new Request(input, init));
            },
          },
        ),
      );
      const { tools } = await sdk.listTools();
      expect(
        tools
          .map((tool) => {
            return tool.name;
          })
          .sort(),
      ).toStrictEqual(
        [
          "cancel_run",
          "get_chat_activity_summary",
          "get_chat_indicators",
          "get_chat_input_status",
          "get_chat_messages",
          "get_chat_thread_list",
          "list_agents",
          "list_models",
          "rename_chat_thread",
          "revoke_queued_message",
          "search_chat_messages",
          "send_chat_message",
          "update_chat_thread_model",
        ].sort(),
      );
      const validator = new AjvJsonSchemaValidator();
      for (const tool of tools) {
        expect(() => {
          return validator.getValidator(tool.inputSchema as JsonSchemaType);
        }).not.toThrow();
        if (tool.outputSchema) {
          expect(() => {
            return validator.getValidator(tool.outputSchema as JsonSchemaType);
          }).not.toThrow();
        }
      }
      const search = tools.find((tool) => {
        return tool.name === "search_chat_messages";
      });
      if (!search?.outputSchema) {
        throw new Error("Missing MCP search response schema");
      }
      expect(search.inputSchema.properties?.keyword).toMatchObject({
        description: expect.stringMatching(
          /CJK.*single-character CJK.*whole-word.*AND.*no indexable tokens.*No Unicode normalization/s,
        ),
      });
      expect(search.outputSchema).toMatchObject({
        properties: {
          results: {
            items: {
              properties: {
                matchedRanges: {
                  description: expect.stringMatching(
                    /\[start,end\).*matchedMessage\.content.*UTF-16.*code points.*UTF-8.*content\.slice.*ACK-QA-A1-🧪-中文.*\[13,15\)/s,
                  ),
                  items: {
                    properties: {
                      start: {
                        description: expect.stringMatching(/Inclusive.*UTF-16/),
                      },
                      end: {
                        description: expect.stringMatching(/Exclusive.*UTF-16/),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      expect(search.inputSchema.properties?.since).toMatchObject({
        type: "string",
        format: "date-time",
        description: expect.stringContaining("Inclusive lower bound"),
      });
      expect(search.description).toContain("2026-10-12T08:02:50Z");
      expect(search.description).toContain("index updates asynchronously");
      const validateSearchInput = validator.getValidator(
        search.inputSchema as JsonSchemaType,
      );
      for (const since of [
        "2026-10-12T08:02:50Z",
        "2026-10-12T16:02:50.123+08:00",
      ]) {
        expect(
          validateSearchInput({ keyword: "search", since }).valid,
        ).toBeTruthy();
      }
      const searched = await sdk.callTool({
        name: "search_chat_messages",
        arguments: {
          keyword: `sdk-time-${randomUUID()}`,
          since: "2026-10-12T08:02:50Z",
        },
      });
      expect(searched.isError).not.toBeTruthy();
      expect(
        mcpChatSearchContract.search.responses[200].parse(
          searched.structuredContent,
        ),
      ).toStrictEqual({ results: [] });
      const searchThreadId = randomUUID();
      const searchHit = {
        threadId: searchThreadId,
        agentId: f.agentId,
        displayName: null,
        matchedMessage: {
          threadId: searchThreadId,
          role: "user",
          content: "indexed message",
          createdAt: "2026-10-12T08:00:00.000Z",
          seqId: 1,
          runId: null,
        },
        matchedRanges: [],
      };
      const validateSearch = validator.getValidator(
        search.outputSchema as JsonSchemaType,
      );
      expect(validateSearch({ results: [searchHit] }).valid).toBeTruthy();
      const sendTool = tools.find((tool) => {
        return tool.name === "send_chat_message";
      });
      if (!sendTool?.outputSchema) {
        throw new Error("Missing MCP send response schema");
      }
      expect(
        Object.keys(sendTool.inputSchema.properties ?? {}).sort(),
      ).toStrictEqual(["agentId", "model", "prompt", "threadId"]);
      expect(sendTool.outputSchema).toMatchObject({
        properties: { eventId: { type: "string", format: "uuid" } },
      });
      for (const [name, args] of [
        ["send_chat_message", { agentId: f.agentId, prompt: "reference" }],
        [
          "revoke_queued_message",
          { agentId: f.agentId, eventId: randomUUID() },
        ],
        ["get_chat_messages", {}],
        ["rename_chat_thread", { title: "reference" }],
        ["update_chat_thread_model", { model: null }],
        ["get_chat_activity_summary", { runId: randomUUID() }],
      ] as const) {
        const tool = tools.find((item) => {
          return item.name === name;
        });
        if (!tool) {
          throw new Error(`Missing tool ${name}`);
        }
        const validateInput = validator.getValidator(
          tool.inputSchema as JsonSchemaType,
        );
        expect(
          validateInput({ ...args, threadId: searchThreadId }).valid,
        ).toBeTruthy();
      }
      for (const name of ["cancel_run", "get_chat_activity_summary"]) {
        const tool = tools.find((item) => {
          return item.name === name;
        });
        if (!tool) {
          throw new Error(`Missing tool ${name}`);
        }
        expect(tool.inputSchema.properties?.runId).toMatchObject({
          type: "string",
          format: "uuid",
        });
      }
      const messages = tools.find((tool) => {
        return tool.name === "get_chat_messages";
      });
      expect(messages).toBeDefined();
      if (!messages) {
        throw new Error("Missing message snapshot tool");
      }
      const validate = validator.getValidator(
        messages.inputSchema as JsonSchemaType,
      );
      expect(validate({ threadId: randomUUID() }).valid).toBeTruthy();
      expect(
        validate({
          threadId: randomUUID(),
          sinceSeqId: 3,
          sinceEventId: randomUUID(),
        }).valid,
      ).toBeTruthy();
      expect(
        validate({ threadId: randomUUID(), sinceSeqId: 3 }).valid,
      ).toBeFalsy();
      const listed = await sdk.callTool({
        name: "get_chat_thread_list",
        arguments: {},
      });
      expect(listed.isError).not.toBeTruthy();
      expect(
        mcpGetChatThreadOutputSchema.parse(listed.structuredContent),
      ).toMatchObject({
        snapshot: { chatThreads: [], latestEventId: null, latestSeqId: null },
        events: [],
        hasMore: false,
      });
      const sent = await sdk.callTool({
        name: "send_chat_message",
        arguments: { agentId: f.agentId, prompt: "SDK canonical reference" },
      });
      expect(sent.isError).not.toBeTruthy();
      const reference = mcpSendChatMessageOutputSchema.parse(
        sent.structuredContent,
      );
      expect(sent.structuredContent).toStrictEqual(reference);
      expect(sent.content).toContainEqual({
        type: "text",
        text: JSON.stringify(reference),
      });
      await flushWaitUntilForTest();
      const history = await sdk.callTool({
        name: "get_chat_messages",
        arguments: { threadId: reference.threadId },
      });
      expect(history.isError).not.toBeTruthy();
      const page = mcpGetChatMessagesOutputSchema.parse(
        history.structuredContent,
      );
      expect(page.rows).toContainEqual(
        expect.objectContaining({
          eventId: reference.eventId,
          threadId: reference.threadId,
          eventType: "input.prompt",
          runId: null,
        }),
      );
      const lifecycle = await sdk.callTool({
        name: "get_chat_thread_list",
        arguments: {},
      });
      expect(lifecycle.isError).not.toBeTruthy();
      expect(
        mcpGetChatThreadOutputSchema.parse(lifecycle.structuredContent).events,
      ).toContainEqual(
        expect.objectContaining({
          threadId: reference.threadId,
          kind: "created",
        }),
      );
    },
  );

  it("does not fall back from expired OAuth to a browser identity or enable unscoped Web routes", async () => {
    const f = await fixture();
    createRouteMocks(context).clerk.session(
      f.actor.userId,
      f.actor.orgId,
      f.actor.orgRole,
    );
    const expired = await mcp.web(f.token({ exp: 1 }), "/api/agents");
    expect(expired.status).toBe(401);
    const unsupported = await mcp.web(f.token(), `/api/agents/${f.agentId}`);
    expect(unsupported.status).toBe(401);
  });

  it("keeps OAuth signing-key outages distinct from invalid credentials on the Web entry", async () => {
    const f = await fixture();
    // Keep all real Clerk retries; make only their external SDK jitter deterministic.
    onTestFinished(context.mocks.clerkRetryJitter(0));
    server.use(
      http.get("https://api.clerk.com/v1/jwks", () => {
        return HttpResponse.json(
          { error: "provider unavailable" },
          { status: 503 },
        );
      }),
    );
    const unavailable = await mcp.web(f.token(), "/api/agents");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({
      error: { code: "PROVIDER_UNAVAILABLE" },
    });
  });

  it("preserves send/manage/cancel grants and checks each Web event operation's scope", async () => {
    const f = await fixture();
    for (const [scope, present, absent] of [
      ["okou:chat:send", "send_chat_message", "revoke_queued_message"],
      ["okou:run:cancel", "revoke_queued_message", "send_chat_message"],
      ["okou:chat:manage", "rename_chat_thread", "cancel_run"],
    ]) {
      const token = f.token({ scope: `user:org:read okou:chat:read ${scope}` });
      const listed = z
        .object({
          result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
        })
        .parse(await mcp.rpc(token, "tools/list"));
      const names = listed.result.tools.map((tool) => {
        return tool.name;
      });
      expect(names).toContain(present);
      expect(names).not.toContain(absent);
      expect(
        z
          .object({ error: z.object({ code: z.number() }) })
          .safeParse(
            await mcp.rpc(token, "tools/call", { name: absent, arguments: {} }),
          ).success,
      ).toBeTruthy();
    }
    const sent = await send(f, "operation-scoped Web events");
    await flushWaitUntilForTest();
    const deniedRecall = await mcp.web(
      f.token({ scope: "user:org:read okou:chat:send" }),
      "/api/chat/events",
      "POST",
      {
        agentId: f.agentId,
        threadId: sent.threadId,
        revokesEventId: randomUUID(),
      },
    );
    expect(deniedRecall.status).toBe(403);
    const deniedSend = await mcp.web(
      f.token({ scope: "user:org:read okou:run:cancel" }),
      "/api/chat/events",
      "POST",
      {
        agentId: f.agentId,
        threadId: sent.threadId,
        prompt: "not authorized to send",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "not authorized to send" }],
        },
        hasTextContent: true,
      },
    );
    expect(deniedSend.status).toBe(403);
  });

  it("returns unmodified Web agents, models and indicator responses", async () => {
    const f = await fixture();
    for (const [name, path] of [
      ["list_agents", "/api/agents"],
      ["list_models", "/api/run-models"],
      ["get_chat_indicators", "/api/indicators"],
    ]) {
      if (!name || !path) {
        throw new Error("Invalid route case");
      }
      const web = await mcp.web(f.token(), path);
      expect(web.status).toBe(200);
      const result = await mcp.call(f.token(), name);
      expect(result.isError).not.toBeTruthy();
      expect(body(result)).toStrictEqual(web.body);
      if (name === "list_agents") {
        expect(result.structuredContent).toBeUndefined();
      }
    }
  });

  it("reflects committed Run transitions without marking indicator or history reads as read", async () => {
    const f = await publicChatActor(context, { stripeTransport: "http" });
    const token = mcp.authorize(f.actor);
    const runs = createRunsApi(context);
    await f.run(async () => {
      const run = await runs.createThreadRun(f.actor, {
        agentId: f.agentId,
        prompt: "observe indicator transitions",
      });
      expect(run.status).toBe("pending");
      const before = await chat.readThread(f.actor, run.threadId);
      expect(before.lastReadAt).toBeNull();

      const pending = await mcp.call(token(), "get_chat_indicators");
      expect(pending.isError).not.toBeTruthy();
      expect(indicatorsSchema.parse(body(pending))).toStrictEqual({
        agents: { [f.agentId]: "active" },
        threads: { [run.threadId]: "active" },
        unreadAt: {},
      });

      await runs.heartbeatRunner(f.runnerGroup);
      await f.claimRunnerRun(run.runId);
      expect((await runs.readRun(f.actor, run.runId)).status).toBe("running");
      const running = await mcp.call(token(), "get_chat_indicators");
      expect(running.isError).not.toBeTruthy();
      expect(body(running)).toStrictEqual(body(pending));

      const cancelled = await mcp.call(token(), "cancel_run", {
        runId: run.runId,
      });
      expect(cancelled.isError).not.toBeTruthy();
      expect(body(cancelled)).toMatchObject({
        runId: run.runId,
        status: "cancelled",
      });
      await flushWaitUntilForTest();

      const history = await mcp.call(token(), "get_chat_messages", {
        threadId: run.threadId,
      });
      expect(history.isError).not.toBeTruthy();
      const page = mcpGetChatMessagesOutputSchema.parse(body(history));
      expect(page.snapshot).toBeNull();
      expect(page.hasMore).toBeFalsy();
      const terminal = page.rows.find((row) => {
        return row.runId === run.runId && row.eventType === "run.cancelled";
      });
      expect(terminal).toMatchObject({
        runId: run.runId,
        eventType: "run.cancelled",
      });

      const unread = await mcp.call(token(), "get_chat_indicators");
      expect(unread.isError).not.toBeTruthy();
      expect(indicatorsSchema.parse(body(unread))).toStrictEqual({
        agents: { [f.agentId]: "unread" },
        threads: { [run.threadId]: "unread" },
        unreadAt: { [run.threadId]: terminal?.createdAt },
      });
      expect((await chat.readThread(f.actor, run.threadId)).lastReadAt).toBe(
        before.lastReadAt,
      );
    });
  });

  it("returns the generated input identity and persists plain text through the ordinary event stream", async () => {
    await withMockNowForTest(now(), async () => {
      const f = await fixture();
      const input = {
        agentId: f.agentId,
        prompt: "Figma logo\n请展示最终方案",
      };
      const result = await send(f, input.prompt);
      const second = await send(f, input.prompt, result.threadId);
      expect(second.threadId).toBe(result.threadId);
      expect(second.eventId).not.toBe(result.eventId);
      await flushWaitUntilForTest();
      const rows = await chat.listThreadEventRows(f.actor, result.threadId);
      expect(
        rows.filter((row) => {
          return row.id === result.eventId;
        }),
      ).toHaveLength(1);
      expect(
        rows.find((row) => {
          return row.id === result.eventId;
        }),
      ).toMatchObject({
        eventType: "input.prompt",
        payload: {
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: input.prompt },
              { type: "source", kind: "mcp", clientId: "mcp_test_client" },
            ],
          },
        },
      });
      const web = await mcp.web(f.token(), "/api/chat/events", "POST", {
        ...input,
        threadId: result.threadId,
        clientEventId: result.eventId,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: input.prompt }],
        },
        hasTextContent: true,
      });
      expect(web.status).toBe(201);
      expect(web.body).toStrictEqual({
        threadId: result.threadId,
        createdAt: result.createdAt,
      });
      expect(
        (await chat.listThreadEventRows(f.actor, result.threadId)).filter(
          (row) => {
            return row.id === result.eventId;
          },
        ),
      ).toHaveLength(1);
    });
  });

  it("uses ordinary Web send semantics for independent requests", async () => {
    const f = await fixture();
    const first = await send(f, "same ordinary message");
    const second = await send(f, "same ordinary message");
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.eventId).not.toBe(second.eventId);
  });

  it("projects raw-row entity references and preserves payloads, event identities and paired cursors", async () => {
    const f = await fixture();
    const sent = await send(f, "bounded raw history");
    await flushWaitUntilForTest();
    const args = { threadId: sent.threadId, limit: 1 };
    const first = mcpGetChatMessagesOutputSchema.parse(
      body(await mcp.call(f.token(), "get_chat_messages", args)),
    );
    const web = await mcp.web(
      f.token(),
      `/api/chat-threads/${sent.threadId}/event-rows?sinceSeqId=0&limit=1`,
    );
    const nativePage = chatThreadEventsContract.rows.responses[200].parse(
      web.body,
    );
    expect(first).toStrictEqual({
      snapshot: null,
      ...nativePage,
      rows: nativePage.rows.map(({ id, chatThreadId, ...row }) => {
        return { ...row, eventId: id, threadId: chatThreadId };
      }),
    });
    expect(first.rows).toHaveLength(1);
    expect(first.hasMore).toBeTruthy();
    const next = mcpGetChatMessagesOutputSchema.parse(
      body(
        await mcp.call(f.token(), "get_chat_messages", {
          ...args,
          sinceSeqId: first.cursor.lastSeqId,
          sinceEventId: first.cursor.lastEventId,
        }),
      ),
    );
    expect(next.rows[0]?.seqId).toBeGreaterThan(first.rows[0]?.seqId ?? 0);
    expect(
      error(
        await mcp.call(f.token(), "get_chat_messages", {
          ...args,
          sinceSeqId: first.cursor.lastSeqId,
          sinceEventId: randomUUID(),
        }),
      ).code,
    ).toBe("CHAT_EVENTS_EXPIRED");
    expect(
      error(
        await mcp.call(f.token(), "get_chat_messages", {
          ...args,
          sinceSeqId: 1,
        }),
      ).code,
    ).toBe("BAD_REQUEST");
  });

  it("preserves the native snapshot pointer and projects inline lifecycle entity references", async () => {
    const f = await fixture();
    const sent = await send(f, "lifecycle aggregate");
    await flushWaitUntilForTest();
    const page = mcpGetChatThreadOutputSchema.parse(
      body(await mcp.call(f.token(), "get_chat_thread_list")),
    );
    const snapshot = await mcp.web(f.token(), "/api/chat-threads/snapshot");
    const events = await mcp.web(f.token(), "/api/chat-threads/events");
    const nativeEvents = chatThreadsContract.events.responses[200].parse(
      events.body,
    );
    expect(page).toStrictEqual({
      snapshot: snapshot.body,
      ...nativeEvents,
      events: nativeEvents.events.map(({ id, chatThreadId, ...event }) => {
        return { ...event, eventId: id, threadId: chatThreadId };
      }),
    });
    expect(
      page.events.some((event) => {
        return event.threadId === sent.threadId;
      }),
    ).toBeTruthy();
    const last = page.events.at(-1);
    if (!last) {
      throw new Error("Expected lifecycle events");
    }
    const next = mcpGetChatThreadOutputSchema.parse(
      body(
        await mcp.call(f.token(), "get_chat_thread_list", {
          sinceSeqId: last.seqId,
        }),
      ),
    );
    expect(next.events).toStrictEqual([]);
    expect(next.hasMore).toBeFalsy();
  });

  it("shares rename and model-selection responses and emits the same Web model/tier events", async () => {
    const f = await fixture();
    const sent = await send(f, "rename and model parity");
    await flushWaitUntilForTest();
    const renamed = await mcp.call(f.token(), "rename_chat_thread", {
      threadId: sent.threadId,
      title: "Renamed with Web",
      eventId: randomUUID(),
    });
    expect(renamed).toStrictEqual({ content: [] });
    await expect(
      chat.readThreadMetadata(f.actor, sent.threadId),
    ).resolves.toMatchObject({ title: "Renamed with Web" });
    const eventId = randomUUID();
    const serviceTierEventId = randomUUID();
    await expect(
      mcp.call(f.token(), "update_chat_thread_model", {
        threadId: sent.threadId,
        model: null,
        eventId,
        serviceTierEventId,
      }),
    ).resolves.toStrictEqual({ content: [] });
    const events = await chat.requestThreadEvents(f.actor, {}, [200]);
    expect(events.body).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          id: eventId,
          kind: "model_selection_updated",
          selectedModel: "auto",
        }),
        expect.objectContaining({
          id: serviceTierEventId,
          kind: "service_tier_updated",
          serviceTier: null,
        }),
      ]),
    });
    const lifecycle = mcpGetChatThreadOutputSchema.parse(
      body(await mcp.call(f.token(), "get_chat_thread_list")),
    );
    expect(lifecycle.events).toContainEqual(
      expect.objectContaining({ eventId, kind: "model_selection_updated" }),
    );
    expect(lifecycle.events).toContainEqual(
      expect.objectContaining({
        eventId: serviceTierEventId,
        kind: "service_tier_updated",
      }),
    );
  });

  it("recalls the supplied event directly and returns the native Web response", async () => {
    const f = await fixture();
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(f.actor);
    await runs.ensurePersonalSubscriptionModel(f.actor);
    const active = await runs.createThreadRun(f.actor, {
      agentId: f.agentId,
      prompt: "hold the queue",
    });
    const sent = await send(f, "recall me", active.threadId);
    await flushWaitUntilForTest();
    const args = {
      agentId: f.agentId,
      threadId: sent.threadId,
      eventId: sent.eventId,
    };
    const recalled = await mcp.call(
      f.token({ scope: "user:org:read okou:chat:read okou:run:cancel" }),
      "revoke_queued_message",
      args,
    );
    expect(recalled.isError).not.toBeTruthy();
    const web = await mcp.web(f.token(), "/api/chat/events", "POST", {
      agentId: args.agentId,
      threadId: args.threadId,
      revokesEventId: args.eventId,
    });
    // The published MCP output keeps its always-null runId; the Web send
    // response no longer carries one.
    const accepted = chatEventsContract.send.responses[201].parse(web.body);
    expect(body(recalled)).toStrictEqual({ ...accepted, runId: null });
    const history = mcpGetChatMessagesOutputSchema.parse(
      body(
        await mcp.call(f.token(), "get_chat_messages", {
          threadId: sent.threadId,
        }),
      ),
    );
    expect(history.rows).toContainEqual(
      expect.objectContaining({
        eventType: "control.revoke",
        revokesEventId: sent.eventId,
      }),
    );
  });

  it("preserves Web search filters and empty results", async () => {
    const f = await fixture();
    const query = {
      keyword: "plain keyword",
      agentId: f.agentId,
      since: "1970-01-01T00:00:00.001Z",
    };
    const web = await mcp.web(
      f.token(),
      `/api/chat/search?keyword=plain%20keyword&agentId=${f.agentId}&since=1`,
    );
    const search = await mcp.call(f.token(), "search_chat_messages", query);
    expect(search.isError).not.toBeTruthy();
    expect(
      mcpChatSearchContract.search.responses[200].parse(body(search)),
    ).toStrictEqual({ results: [] });
    expect(body(search)).toStrictEqual(web.body);
  });

  it("keeps ownership and organization checks in the Web routes", async () => {
    const f = await fixture();
    const sent = await send(f, "owner-only history");
    await flushWaitUntilForTest();
    const peer = f.token({ sub: `user_${randomUUID()}` });
    expect(
      error(
        await mcp.call(peer, "get_chat_messages", { threadId: sent.threadId }),
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      error(
        await mcp.call(peer, "rename_chat_thread", {
          threadId: sent.threadId,
          title: "forged",
        }),
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      error(
        await mcp.call(peer, "revoke_queued_message", {
          agentId: f.agentId,
          threadId: sent.threadId,
          eventId: randomUUID(),
        }),
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      error(
        await mcp.call(peer, "send_chat_message", {
          agentId: f.agentId,
          threadId: sent.threadId,
          prompt: "forged",
        }),
      ).code,
    ).toBe("FORBIDDEN");
    const unrelated = bdd.user({ orgId: `org_${randomUUID()}` });
    const unrelatedAgent = await bdd.createAgent(unrelated, {
      displayName: "Other organization",
    });
    expect(
      error(
        await mcp.call(f.token(), "send_chat_message", {
          agentId: unrelatedAgent.agentId,
          prompt: "wrong organization",
        }),
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("binds OAuth snapshots and raw rows to the grant organization even for the same user", async () => {
    const f = await fixture();
    await send(f, "establish the first organization");
    await flushWaitUntilForTest();
    const other = bdd.user({
      userId: f.actor.userId,
      orgId: `org_${randomUUID()}`,
    });
    const agent = await bdd.createAgent(other, {
      displayName: "Same user, different organization",
    });
    const thread = await chat.createThread(other, {
      agentId: agent.agentId,
      title: "Other organization thread",
    });
    for (const endpoint of ["event-snapshot", "event-rows?sinceSeqId=0"]) {
      const result = await mcp.web(
        f.token(),
        `/api/chat-threads/${thread.id}/${endpoint}`,
      );
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    expect(
      error(
        await mcp.call(f.token(), "get_chat_messages", { threadId: thread.id }),
      ).code,
    ).toBe("NOT_FOUND");
    const list = mcpGetChatThreadOutputSchema.parse(
      body(await mcp.call(f.token(), "get_chat_thread_list")),
    );
    expect(
      list.events.some((event) => {
        return event.threadId === thread.id;
      }),
    ).toBeFalsy();
  });

  it("preserves Web validation errors rather than inventing MCP error codes", async () => {
    const f = await fixture();
    const args = { agentId: f.agentId, prompt: "" };
    const result = await mcp.call(f.token(), "send_chat_message", args);
    const web = await mcp.web(f.token(), "/api/chat/events", "POST", {
      ...args,
      userMessage: { version: 1, parts: [{ type: "text", text: "" }] },
      hasTextContent: true,
    });
    expect(error(result).code).toBe("BAD_REQUEST");
    expect(body(result)).toStrictEqual(web.body);
  });

  it("authorizes OAuth cancellation through the same Web entry, preserving peer denial and cancellation side effects", async () => {
    const f = await fixture();
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(f.actor);
    await runs.ensurePersonalSubscriptionModel(f.actor);
    const run = await runs.createThreadRun(f.actor, {
      agentId: f.agentId,
      prompt: "native cancellation",
    });
    const history = mcpGetChatMessagesOutputSchema.parse(
      body(
        await mcp.call(f.token(), "get_chat_messages", {
          threadId: run.threadId,
        }),
      ),
    );
    const assigned = history.rows.find((row) => {
      return row.runId === run.runId;
    });
    if (!assigned?.runId) {
      throw new Error(
        "Expected a public event carrying the assigned Run reference",
      );
    }
    const activity = await mcp.call(f.token(), "get_chat_activity_summary", {
      threadId: assigned.threadId,
      runId: assigned.runId,
    });
    const webActivity = await mcp.web(
      f.token(),
      `/api/chat-threads/${run.threadId}/activity-summary`,
      "POST",
      { runId: run.runId },
    );
    expect(webActivity.status).toBe(200);
    expect(activity.isError).not.toBeTruthy();
    // On-demand requests may observe different summary/cooldown states;
    // neither transport promises to stabilize that ordinary Web behavior.
    expect(activitySummaryResponseSchema.parse(body(activity))).toMatchObject({
      runId: run.runId,
    });
    expect(activitySummaryResponseSchema.parse(webActivity.body)).toMatchObject(
      { runId: run.runId },
    );
    const path = `/api/runs/${run.runId}/cancel`;
    const insufficient = await mcp.web(
      f.token({ scope: "user:org:read okou:chat:read" }),
      path,
      "POST",
    );
    expect(insufficient.status).toBe(403);
    expect(insufficient.body).toMatchObject({ error: { code: "FORBIDDEN" } });
    const peer = f.token({ sub: `user_${randomUUID()}` });
    const denied = await mcp.web(peer, path, "POST");
    expect(
      body(await mcp.call(peer, "cancel_run", { runId: assigned.runId })),
    ).toStrictEqual(denied.body);
    const cancelled = await mcp.call(f.token(), "cancel_run", {
      runId: assigned.runId.toUpperCase(),
    });
    expect(cancelled.isError).not.toBeTruthy();
    expect(body(cancelled)).toStrictEqual({
      runId: run.runId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });
    await flushWaitUntilForTest();
    expect((await runs.readRun(f.actor, run.runId)).status).toBe("cancelled");
    const again = await mcp.web(f.token(), path, "POST");
    expect(again.status).toBe(200);
    const canonical = mcpCancelRunOutputSchema.parse(body(cancelled));
    expect(again.body).toStrictEqual({
      id: canonical.runId,
      status: canonical.status,
      message: canonical.message,
    });
  });
});
