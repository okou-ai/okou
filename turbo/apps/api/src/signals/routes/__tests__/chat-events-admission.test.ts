import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runsQueueContract } from "@okouai/api-contracts/contracts/run-routes";
import { describe, expect, it } from "vitest";
import { array, boolean, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatInputStatusRoutes } from "../chat-input-status";
import { chatThreadRoutes } from "../chat-threads";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { runsRoutes } from "../runs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const mcp = createMcpWebApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [
    ...chatThreadRoutes,
    ...chatEventsRoutes,
    ...chatInputStatusRoutes,
    ...meModelProvidersDeleteRoutes,
    ...runsRoutes,
  ],
});
const threadsApi = app(chatThreadsContract);
const metadataApi = app(chatThreadMetadataContract);
const threadEventsApi = app(chatThreadEventsContract);
const chatEventsApi = app(chatEventsContract);
const inputStatusApi = app(chatInputStatusContract);
const providersDeleteApi = app(personalModelProvidersByTypeContract);
const runsQueueApi = app(runsQueueContract);

const toolsListResultSchema = object({
  result: object({
    tools: array(
      object({
        name: string(),
        annotations: object({
          readOnlyHint: boolean().optional(),
        }).optional(),
      }),
    ),
  }),
});

function signIn(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

describe("CHAT-02: web chat send and client ids", () => {
  it("chat-events-admission-006 authorizes existing-thread sends by owner", async () => {
    const owner = bdd.user();
    if (!owner.orgId) {
      throw new Error("Expected owner orgId");
    }
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });

    const created = await accept(
      threadsApi.create({
        headers: signIn(owner),
        body: { title: "Owner thread" },
      }),
      [201],
    );
    const threadId = created.body.id;

    const peerSend = await accept(
      chatEventsApi.send({
        headers: signIn(peer),
        body: {
          threadId,
          prompt: "Unauthorized prompt",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Unauthorized prompt" }],
          },
        },
      }),
      [404],
    );
    expect(peerSend.body.error.message).toBe("Chat thread not found");

    const beforeOwnerSend = await accept(
      threadEventsApi.rows({
        headers: signIn(owner),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    expect(beforeOwnerSend.body.rows).toStrictEqual([]);

    const ownerEventId = randomUUID();
    await accept(
      chatEventsApi.send({
        headers: signIn(owner),
        body: {
          threadId,
          prompt: "Owner prompt",
          hasTextContent: true,
          clientEventId: ownerEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Owner prompt" }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();

    const afterOwnerSend = await accept(
      threadEventsApi.rows({
        headers: signIn(owner),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    const events = projectChatEventRows(afterOwnerSend.body.rows);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: ownerEventId,
        eventType: "input.prompt",
      }),
    );
  });
});

describe("CHAT-02: admission without spendable credits", () => {
  async function givenSuspendedMemberSentPrompt() {
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = bdd.user();
    await publicPlanLifecycle(context, member, "pro").update("canceled");

    const authHeaders = signIn(member);
    const clientEventId = randomUUID();
    const firstSend = await accept(
      chatEventsApi.send({
        headers: authHeaders,
        extraHeaders: { origin: "https://app.okou.ai" },
        body: {
          prompt: "Need help with credits",
          hasTextContent: true,
          model: null,
          clientEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Need help with credits" }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    return {
      authHeaders,
      clientEventId,
      threadId: firstSend.body.threadId,
    };
  }

  it("chat-events-admission-009 (1/2) records rejection and request-branded credit guidance visible from the initial cursor", async () => {
    const { authHeaders, clientEventId, threadId } =
      await givenSuspendedMemberSentPrompt();

    const initialRows = await accept(
      threadEventsApi.rows({
        headers: authHeaders,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    const events = projectChatEventRows(initialRows.body.rows);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      id: clientEventId,
      eventType: "input.prompt",
    });
    expect(events[1]).toMatchObject({
      eventType: "input.rejected",
      revokesEventId: clientEventId,
      error: "insufficient_credits",
    });
    expect(events[1]?.runId).toBeUndefined();
    expect(events[2]).toMatchObject({
      eventType: "output.error",
    });
    const guidance =
      events[2]?.eventType === "output.error" ? events[2].content : "";
    expect(guidance).toContain("https://app.okou.ai/?settings=usage");

    const firstSeqId = initialRows.body.rows[0]?.seqId;
    if (firstSeqId === undefined) {
      throw new Error("Expected initial queued row seqId");
    }
    const afterCursor = await accept(
      threadEventsApi.rows({
        headers: authHeaders,
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: clientEventId,
          limit: 50,
        },
      }),
      [200],
    );
    expect(projectChatEventRows(afterCursor.body.rows)).toStrictEqual(
      events.slice(1),
    );
  });

  it("chat-events-admission-009 (2/2) keeps retry idempotent without adding events or active concurrency", async () => {
    const { authHeaders, clientEventId, threadId } =
      await givenSuspendedMemberSentPrompt();

    const initialRows = await accept(
      threadEventsApi.rows({
        headers: authHeaders,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );

    const retrySend = await accept(
      chatEventsApi.send({
        headers: authHeaders,
        extraHeaders: { origin: "https://app.okou.ai" },
        body: {
          threadId,
          prompt: "Need help with credits",
          hasTextContent: true,
          model: null,
          clientEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Need help with credits" }],
          },
        },
      }),
      [201],
    );
    expect(retrySend.body.threadId).toBe(threadId);
    await flushWaitUntilForTest();

    const [rowsAfterRetry, queue] = await Promise.all([
      accept(
        threadEventsApi.rows({
          headers: authHeaders,
          params: { threadId },
          query: { sinceSeqId: 0, limit: 50 },
        }),
        [200],
      ),
      accept(runsQueueApi.getQueue({ headers: authHeaders }), [200]),
    ]);
    expect(rowsAfterRetry.body.rows).toStrictEqual(initialRows.body.rows);
    expect(queue.body.concurrency.active).toBe(0);
  });
});

describe("CHAT-02: run-level model overrides", () => {
  it("chat-events-model-overrides-003 rejects a disconnected personal thread model even when the member default is Auto", async () => {
    const member = bdd.user();
    mockClaudeCodeTokenEndpoint();
    await Promise.all([
      publicPlanLifecycle(context, member, "pro").update("active"),
      createRunsApi(context).createPersonalModelProvider(member, {
        type: "claude-code-oauth-token",
        secret: `claude-token-${randomUUID()}`,
      }),
    ]);

    const authHeaders = signIn(member);
    const created = await accept(
      threadsApi.create({
        headers: authHeaders,
        body: { title: "Disconnected Sonnet", model: "claude-sonnet-5-5" },
      }),
      [201],
    );
    const threadId = created.body.id;

    await accept(
      providersDeleteApi.delete({
        headers: authHeaders,
        params: { type: "claude-code-oauth-token" },
      }),
      [204],
    );

    const clientEventId = randomUUID();
    await accept(
      chatEventsApi.send({
        headers: authHeaders,
        body: {
          threadId,
          prompt: "Continue on Sonnet",
          hasTextContent: true,
          clientEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Continue on Sonnet" }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();

    const [rows, metadata] = await Promise.all([
      accept(
        threadEventsApi.rows({
          headers: authHeaders,
          params: { threadId },
          query: { sinceSeqId: 0, limit: 50 },
        }),
        [200],
      ),
      accept(
        metadataApi.get({
          headers: authHeaders,
          params: { id: threadId },
        }),
        [200],
      ),
    ]);
    const events = projectChatEventRows(rows.body.rows);
    const rejected = events.find((event) => {
      return event.eventType === "input.rejected";
    });
    expect(rejected).toMatchObject({
      eventType: "input.rejected",
      revokesEventId: clientEventId,
      error: "conflict",
    });
    expect(rejected?.runId).toBeUndefined();
    expect(
      events.some((event) => {
        return event.runId !== undefined;
      }),
    ).toBeFalsy();
    expect(metadata.body.selectedModel).toBe("claude-sonnet-5-5");
  });
});

describe("retained chat input observation", () => {
  it("chat-input-status-009 exposes observation by default and enforces the read scope and validation", async () => {
    const member = bdd.user();
    const authHeaders = signIn(member);
    const created = await accept(
      threadsApi.create({
        headers: authHeaders,
        body: { title: "Empty observation thread" },
      }),
      [201],
    );
    const threadId = created.body.id;
    const unknownEventId = randomUUID();

    const issueToken = mcp.authorize(member);
    const defaultToken = issueToken();
    const restrictedToken = issueToken({
      scope: "user:org:read okou:chat:send",
    });

    const [listed, , httpStatus, mcpStatus] = await Promise.all([
      mcp.rpc(defaultToken, "tools/list"),
      accept(
        inputStatusApi.get({
          headers: { authorization: `Bearer ${restrictedToken}` },
          params: { threadId, eventId: unknownEventId },
        }),
        [403],
      ),
      accept(
        inputStatusApi.get({
          headers: { authorization: `Bearer ${defaultToken}` },
          params: { threadId, eventId: unknownEventId },
        }),
        [200],
      ),
      mcp.call(defaultToken, "get_chat_input_status", {
        threadId,
        eventId: unknownEventId,
      }),
    ]);

    const observationTool = toolsListResultSchema
      .parse(listed)
      .result.tools.find((tool) => {
        return tool.name === "get_chat_input_status";
      });
    expect(observationTool).toMatchObject({
      name: "get_chat_input_status",
      annotations: { readOnlyHint: true },
    });
    expect(httpStatus.body.status).toBe("unavailable");
    expect(mcpStatus.isError).toBeFalsy();
    expect(mcpStatus.structuredContent).toMatchObject({
      status: "unavailable",
    });
  });
});
