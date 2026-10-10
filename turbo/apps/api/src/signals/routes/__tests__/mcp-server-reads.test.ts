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
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  mcpGetChatMessagesOutputSchema,
  mcpGetChatThreadOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-snapshots";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import { cronCompactChatThreadSnapshotsRoutes } from "../cron-compact-chat-thread-snapshots";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mcpServerRoutes } from "../mcp-server";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMcpWebApi } from "./helpers/mcp-web-api";
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
  clientEventId?: string,
) {
  const result = await mcp.call(f.token(), "send_chat_message", {
    agentId: f.agentId,
    prompt,
    ...(threadId ? { threadId } : {}),
    ...(clientEventId ? { clientEventId } : {}),
  });
  expect(result.isError).not.toBeTruthy();
  return chatEventsContract.send.responses[201].parse(body(result));
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
          "get_chat_messages",
          "get_chat_thread",
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
      expect(JSON.stringify(tools)).not.toMatch(
        /nextContentCursor|olderCursor|around|waitMs|inputRef|effectiveModel/,
      );
      const listed = await sdk.callTool({
        name: "get_chat_thread",
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

  it("uses Web normal-send response and persists plain text through the ordinary event stream", async () => {
    await withMockNowForTest(now(), async () => {
      const f = await fixture();
      const clientEventId = randomUUID();
      const input = {
        agentId: f.agentId,
        prompt: "Figma logo\n请展示最终方案",
        clientEventId,
      };
      const result = await send(f, input.prompt, undefined, clientEventId);
      expect(result.runId).toBeNull();
      expect(
        body(
          await mcp.call(f.token(), "send_chat_message", {
            ...input,
            threadId: result.threadId,
          }),
        ),
      ).toMatchObject({ runId: null, threadId: result.threadId });
      await flushWaitUntilForTest();
      const rows = await chat.listThreadEventRows(f.actor, result.threadId);
      expect(
        rows.filter((row) => {
          return row.id === clientEventId;
        }),
      ).toHaveLength(1);
      expect(
        rows.find((row) => {
          return row.id === clientEventId;
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
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: input.prompt }],
        },
        hasTextContent: true,
      });
      expect(web.status).toBe(201);
      expect(result).toStrictEqual(web.body);
    });
  });

  it("does not add send deduplication or wait/state protocols", async () => {
    const f = await fixture();
    const first = await send(f, "same ordinary message");
    const second = await send(f, "same ordinary message");
    expect(first.threadId).not.toBe(second.threadId);
    for (const name of [
      "get_chat_input",
      "get_run_status",
      "list_chat_threads",
      "update_chat_thread",
    ]) {
      expect(
        z
          .object({ error: z.object({ code: z.number() }) })
          .safeParse(
            await mcp.rpc(f.token(), "tools/call", { name, arguments: {} }),
          ).success,
      ).toBeTruthy();
    }
  });

  it("returns one raw-row Web page and resumes using its unchanged paired cursor", async () => {
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
    expect(first).toStrictEqual({
      snapshot: null,
      ...chatThreadEventsContract.rows.responses[200].parse(web.body),
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

  it("aggregates the Web conversation-list pointer and bounded lifecycle events without projecting metadata", async () => {
    const f = await fixture();
    const sent = await send(f, "lifecycle aggregate");
    await flushWaitUntilForTest();
    const page = mcpGetChatThreadOutputSchema.parse(
      body(await mcp.call(f.token(), "get_chat_thread")),
    );
    const snapshot = await mcp.web(f.token(), "/api/chat-threads/snapshot");
    const events = await mcp.web(f.token(), "/api/chat-threads/events");
    expect(page).toStrictEqual({
      snapshot: snapshot.body,
      ...z.record(z.string(), z.unknown()).parse(events.body),
    });
    expect(
      page.events.some((event) => {
        return event.chatThreadId === sent.threadId;
      }),
    ).toBeTruthy();
    const last = page.events.at(-1);
    if (!last) {
      throw new Error("Expected lifecycle events");
    }
    const next = mcpGetChatThreadOutputSchema.parse(
      body(
        await mcp.call(f.token(), "get_chat_thread", {
          sinceSeqId: last.seqId,
        }),
      ),
    );
    expect(next.events).toStrictEqual([]);
    expect(next.hasMore).toBeFalsy();
  });

  it("returns compacted R2 pointers and only one tail page without downloading either archive", async () => {
    const f = await fixture();
    const sent = await send(f, "snapshot baseline");
    await flushWaitUntilForTest();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const name =
        typeof command === "object" && command !== null
          ? command.constructor.name
          : "";
      return Promise.resolve(
        name === "ListObjectsV2Command"
          ? { Contents: [], IsTruncated: false }
          : {},
      );
    });
    const cron = setupRawAppRequest({
      context,
      routes: [
        ...cronCompactChatThreadSnapshotsRoutes,
        ...cronProjectChatEventSearchRoutes,
        ...cronSnapshotChatEventsRoutes,
      ],
    });
    for (const path of [
      "project-chat-event-search",
      "snapshot-chat-events",
      "compact-chat-thread-snapshots",
    ]) {
      const result = await cron(`/api/cron/${path}`, {
        headers: { authorization: "Bearer test-cron-secret" },
      });
      expect(result.status).toBe(200);
    }
    const before = mcpGetChatMessagesOutputSchema.parse(
      body(
        await mcp.call(f.token(), "get_chat_messages", {
          threadId: sent.threadId,
        }),
      ),
    );
    expect(before.snapshot).toMatchObject({
      url: expect.stringContaining("https://r2.example.com/"),
      expiresInSeconds: expect.any(Number),
    });
    expect(before.rows).toStrictEqual([]);
    const snapshot = before.snapshot;
    if (!snapshot) {
      throw new Error("Expected the published message pointer");
    }
    expect(snapshot.lastSeqId).toBeGreaterThan(0);
    expect(snapshot.expiresInSeconds).toBeGreaterThan(0);
    await send(f, "snapshot tail", sent.threadId);
    await flushWaitUntilForTest();
    const storageCallsBeforeRead = context.mocks.s3.send.mock.calls.length;
    const after = mcpGetChatMessagesOutputSchema.parse(
      body(
        await mcp.call(f.token(), "get_chat_messages", {
          threadId: sent.threadId,
          limit: 1,
        }),
      ),
    );
    expect(after.snapshot).toStrictEqual(snapshot);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.seqId).toBeGreaterThan(snapshot.lastSeqId);
    expect(after.hasMore).toBeTruthy();
    const threads = mcpGetChatThreadOutputSchema.parse(
      body(await mcp.call(f.token(), "get_chat_thread")),
    );
    expect(threads.snapshot).toMatchObject({
      url: expect.stringContaining("https://r2.example.com/"),
      expiresInSeconds: snapshot.expiresInSeconds,
    });
    expect(
      threads.events.every((event) => {
        return event.seqId > (threads.snapshot.latestSeqId ?? 0);
      }),
    ).toBeTruthy();
    const web = await mcp.web(
      f.token(),
      `/api/chat-threads/${sent.threadId}/event-snapshot`,
    );
    expect(web.body).toStrictEqual(after.snapshot);
    expect(context.mocks.s3.send.mock.calls).toHaveLength(
      storageCallsBeforeRead,
    );
  });

  it("shares rename and model-selection responses and emits the same Web model/tier events", async () => {
    const f = await fixture();
    const sent = await send(f, "rename and model parity");
    await flushWaitUntilForTest();
    const renamed = await mcp.call(f.token(), "rename_chat_thread", {
      id: sent.threadId,
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
        id: sent.threadId,
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
    const inputId = randomUUID();
    const sent = await send(f, "recall me", active.threadId, inputId);
    await flushWaitUntilForTest();
    const clientEventId = randomUUID();
    const args = {
      agentId: f.agentId,
      threadId: sent.threadId,
      revokesEventId: inputId,
      clientEventId,
    };
    const recalled = await mcp.call(
      f.token({ scope: "user:org:read okou:chat:read okou:run:cancel" }),
      "revoke_queued_message",
      args,
    );
    expect(recalled.isError).not.toBeTruthy();
    const web = await mcp.web(f.token(), "/api/chat/events", "POST", args);
    expect(body(recalled)).toStrictEqual(web.body);
    const rows = await chat.listThreadEventRows(f.actor, sent.threadId);
    expect(
      rows.find((row) => {
        return row.id === clientEventId;
      }),
    ).toMatchObject({
      revokesEventId: inputId,
    });
  });

  it("uses Web keyword search and activity-summary contracts without MCP filters or projections", async () => {
    const f = await fixture();
    await send(f, "A plain keyword in an ordinary conversation");
    await flushWaitUntilForTest();
    const cron = setupRawAppRequest({
      context,
      routes: cronProjectChatEventSearchRoutes,
    });
    const projected = await cron("/api/cron/project-chat-event-search", {
      headers: { authorization: "Bearer test-cron-secret" },
    });
    expect(projected.status).toBe(200);
    const query = { keyword: "plain keyword", agentId: f.agentId, since: 1 };
    const web = await mcp.web(
      f.token(),
      `/api/chat/search?keyword=plain%20keyword&agentId=${f.agentId}&since=1`,
    );
    const search = await mcp.call(f.token(), "search_chat_messages", query);
    expect(search.isError).not.toBeTruthy();
    expect(body(search)).toStrictEqual(web.body);
    expect(
      z.object({ results: z.array(z.unknown()) }).parse(web.body).results
        .length,
    ).toBeGreaterThan(0);
    const id = randomUUID();
    const runId = randomUUID();
    const activity = await mcp.call(f.token(), "get_chat_activity_summary", {
      id,
      runId,
    });
    const webActivity = await mcp.web(
      f.token(),
      `/api/chat-threads/${id}/activity-summary`,
      "POST",
      { runId },
    );
    expect(body(activity)).toStrictEqual(webActivity.body);
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
          id: sent.threadId,
          title: "forged",
        }),
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      error(
        await mcp.call(peer, "revoke_queued_message", {
          agentId: f.agentId,
          threadId: sent.threadId,
          revokesEventId: randomUUID(),
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
      body(await mcp.call(f.token(), "get_chat_thread")),
    );
    expect(
      list.events.some((event) => {
        return event.chatThreadId === thread.id;
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
    const activity = await mcp.call(f.token(), "get_chat_activity_summary", {
      id: run.threadId,
      runId: run.runId,
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
      body(await mcp.call(peer, "cancel_run", { id: run.runId })),
    ).toStrictEqual(denied.body);
    const cancelled = await mcp.call(f.token(), "cancel_run", {
      id: run.runId,
    });
    expect(cancelled.isError).not.toBeTruthy();
    expect(body(cancelled)).toStrictEqual({
      id: run.runId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });
    await flushWaitUntilForTest();
    expect((await runs.readRun(f.actor, run.runId)).status).toBe("cancelled");
    const again = await mcp.web(f.token(), path, "POST");
    expect(again.status).toBe(200);
    expect(body(cancelled)).toStrictEqual(again.body);
  });
});
