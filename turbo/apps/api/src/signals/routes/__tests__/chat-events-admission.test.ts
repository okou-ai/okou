import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runsQueueContract } from "@okouai/api-contracts/contracts/run-routes";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { array, boolean, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatInputStatusRoutes } from "../chat-input-status";
import { chatThreadRoutes } from "../chat-threads";
import { mailRoutes } from "../mail";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { runsRoutes } from "../runs";
import { userPreferencesRoutes } from "../user-preferences";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  createChatEventsFixture,
  eventBackedContents,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { completePublicClaudeRun } from "./helpers/public-native-run";
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

async function setupEntitledClaudeActor(
  fixture: ReturnType<typeof createChatEventsFixture>,
) {
  const actor = fixture.bdd.user();
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();
  mockClaudeCodeTokenEndpoint();
  const [runnerGroup] = await Promise.all([
    fixture.api.configureRunnerGroup(),
    fixture.api.grantProEntitlement(actor),
    fixture.api.createPersonalModelProvider(actor, {
      type: "claude-code-oauth-token",
      secret: `claude-token-${randomUUID()}`,
    }),
  ]);
  return { actor, runnerGroup };
}

describe("CHAT-02: on-demand member memory initialization", () => {
  it(
    "chat-events-admission-001 initializes an existing member's memory from preferences before the member's first run",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const owner = fixture.bdd.user();
      if (!owner.orgId) {
        throw new Error("Expected owner orgId");
      }
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      await Promise.all([
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(owner),
      ]);

      const member = fixture.bdd.user({
        orgId: owner.orgId,
        orgRole: "org:member",
      });
      mockClaudeCodeTokenEndpoint();
      await Promise.all([
        fixture.api.createPersonalModelProvider(member, {
          type: "claude-code-oauth-token",
          secret: `claude-token-${randomUUID()}`,
        }),
        fixture.misc.updatePreferences(
          member,
          { timezone: "Asia/Tokyo", locale: "ja-JP" },
          [200],
        ),
      ]);

      const preferencesApi = setupApp({
        context,
        routes: userPreferencesRoutes,
      })(userPreferencesContract);
      const [firstRead, secondRead] = await Promise.all([
        fixture.misc.readPreferences(member),
        fixture.misc.readPreferences(member),
      ]);
      expect(firstRead.body).toMatchObject({
        timezone: "Asia/Tokyo",
        locale: "ja-JP",
        memoryInitialized: false,
      });
      expect(secondRead.body).toMatchObject({
        timezone: "Asia/Tokyo",
        locale: "ja-JP",
        memoryInitialized: false,
      });

      const initialized = await accept(
        preferencesApi.initialize({
          headers: signIn(member),
          body: { timezone: "America/New_York", locale: "en-US" },
        }),
        [200],
      );
      expect(initialized.body).toMatchObject({
        timezone: "Asia/Tokyo",
        locale: "ja-JP",
        memoryInitialized: true,
      });

      const firstRun = await fixture.sendChatRun(member, {
        prompt: "First run with initialized memory",
        model: "claude-fable-5-1",
      });
      const [firstExecution, reinitialized] = await Promise.all([
        fixture.api.executionInput(firstRun.runId),
        accept(
          preferencesApi.initialize({
            headers: signIn(member),
            body: { timezone: "Europe/London", locale: "fr-FR" },
          }),
          [200],
        ),
      ]);
      const firstMemory = firstExecution.startupInputs.memory;
      expect(firstMemory).toMatchObject({
        storageId: expect.any(String),
        versionId: expect.any(String),
        empty: true,
      });
      expect(reinitialized.body).toMatchObject({
        timezone: "Asia/Tokyo",
        locale: "ja-JP",
        memoryInitialized: true,
      });

      const secondRun = await fixture.sendChatRun(member, {
        prompt: "Second run after repeat initialization",
        model: "claude-fable-5-1",
      });
      const secondExecution = await fixture.api.executionInput(secondRun.runId);
      expect(secondExecution.startupInputs.memory).toStrictEqual(firstMemory);
    },
  );
});

describe("CHAT-02: web chat send and client ids (runs)", () => {
  it(
    "chat-events-admission-004 creates a web chat run with client-provided ids",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const { actor } = await setupEntitledClaudeActor(fixture);
      const clientThreadId = randomUUID();
      const clientEventId = randomUUID();

      const firstSend = await fixture.chat.requestSendEvent(
        actor,
        {
          clientThreadId,
          clientEventId,
          model: "claude-fable-5-1",
          prompt: "Web prompt with client IDs",
        },
        [201],
      );
      if (!("threadId" in firstSend.body)) {
        throw new Error("Expected accepted chat send body");
      }
      expect(firstSend.body.threadId).toBe(clientThreadId);
      expect(firstSend.body.createdAt).toStrictEqual(expect.any(String));
      await flushWaitUntilForTest();

      const [history, threadDetail] = await Promise.all([
        fixture.chat.listThreadEvents(actor, clientThreadId),
        fixture.chat.readThread(actor, clientThreadId),
      ]);
      const original = history.events.find((event) => {
        return event.id === clientEventId;
      });
      const replacement = history.events.find((event) => {
        return event.revokesEventId === clientEventId;
      });
      expect(original).toMatchObject({
        id: clientEventId,
        eventType: "input.prompt",
        content: null,
        userMessage: {
          version: 1,
          parts: expect.arrayContaining([
            { type: "text", text: "Web prompt with client IDs" },
          ]),
        },
      });
      expect(original?.runId).toBeUndefined();
      expect(original?.revokesEventId).toBeUndefined();
      expect(replacement).toMatchObject({
        eventType: "input.prompt",
        revokesEventId: clientEventId,
        content: null,
        userMessage: {
          version: 1,
          parts: expect.arrayContaining([
            { type: "text", text: "Web prompt with client IDs" },
          ]),
        },
      });
      if (!replacement?.runId) {
        throw new Error("Expected replacement event with Run ID");
      }
      expect(threadDetail).toStrictEqual({
        lastReadAt: null,
        cancellationRecoveryPending: false,
      });

      const execution = await fixture.api.executionInput(replacement.runId);
      expect(execution.prompt).toContain("Web prompt with client IDs");
      expect(execution.appendSystemPrompt).toContain(
        "You are currently running inside: Web",
      );

      const occupiedThreadId = randomUUID();
      const [forgedFresh, forgedReplay] = await Promise.all([
        fixture.chat.requestSendEvent(
          actor,
          {
            threadId: clientThreadId,
            clientEventId: randomUUID(),
            prompt: "Forged MCP fresh",
            userMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Forged MCP fresh" },
                { type: "source", kind: "mcp", clientId: "forged-mcp-client" },
              ],
            },
          },
          [400],
        ),
        fixture.chat.requestSendEvent(
          actor,
          {
            threadId: clientThreadId,
            clientEventId,
            prompt: "Forged MCP replay",
            userMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Forged MCP replay" },
                { type: "source", kind: "mcp", clientId: "forged-mcp-client" },
              ],
            },
          },
          [400],
        ),
        fixture.chat.createThread(actor, {
          clientThreadId: occupiedThreadId,
          model: "claude-fable-5-1",
          title: "Occupied empty thread",
        }),
      ]);
      expect(forgedFresh.status).toBe(400);
      expect(forgedReplay.status).toBe(400);

      const occupiedSend = await fixture.chat.requestSendEvent(
        actor,
        {
          clientThreadId: occupiedThreadId,
          clientEventId: randomUUID(),
          model: "claude-fable-5-1",
          prompt: "Send into occupied client thread id",
        },
        [400],
      );
      expect(occupiedSend.body).toMatchObject({
        error: {
          message: "Client thread id is already in use",
        },
      });
    },
  );
});

describe("CHAT-02: interrupting active chat runs", () => {
  it(
    "chat-events-admission-007 interrupts an active run, guards interrupt ids, and feeds cancelled rounds into the next run",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const { actor, runnerGroup } = await setupEntitledClaudeActor(fixture);
      const outsider = fixture.bdd.user();

      const firstRun = await fixture.sendChatRun(actor, {
        prompt: "First interrupted round prompt",
        model: "claude-fable-5-1",
      });
      const firstExecution = await fixture.runExecution(firstRun.runId);

      await accept(
        chatEventsApi.send({
          headers: signIn(outsider),
          body: {
            threadId: firstRun.threadId,
            interruptsRunId: firstRun.runId,
            clientEventId: randomUUID(),
          },
        }),
        [404],
      );

      const interruptEventId = randomUUID();
      await accept(
        chatEventsApi.send({
          headers: signIn(actor),
          body: {
            threadId: firstRun.threadId,
            interruptsRunId: firstRun.runId.toUpperCase(),
            clientEventId: interruptEventId,
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();

      const cancellation = await createRunsApi(context).readRunnerCancellation(
        firstExecution.execution.sandboxToken,
        firstRun.runId,
        runnerGroup,
      );
      expect(cancellation).toStrictEqual({
        protocolVersion: 1,
        runId: firstRun.runId,
        state: "present",
        mode: "cooperative",
      });

      await Promise.all([
        accept(
          chatEventsApi.send({
            headers: signIn(actor),
            body: {
              threadId: firstRun.threadId,
              interruptsRunId: firstRun.runId,
              clientEventId: interruptEventId,
            },
          }),
          [201],
        ),
        accept(
          chatEventsApi.send({
            headers: signIn(actor),
            body: {
              threadId: firstRun.threadId,
              interruptsRunId: firstRun.runId,
              clientEventId: randomUUID(),
            },
          }),
          [201],
        ),
      ]);
      await fixture.failChatRun(
        firstRun.runId,
        firstExecution.sandboxHeaders,
        "Run cancelled",
      );
      await flushWaitUntilForTest();

      await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: firstRun.threadId,
          prompt: "Reused interrupt event id text should not enqueue",
          model: "claude-fable-5-1",
          clientEventId: interruptEventId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      const eventsAfterInterrupt = await fixture.chat.listThreadEvents(
        actor,
        firstRun.threadId,
      );
      const interruptRows = eventsAfterInterrupt.events.filter((event) => {
        return event.eventType === "control.interrupt";
      });
      expect(interruptRows).toHaveLength(1);
      expect(interruptRows[0]).toMatchObject({
        id: interruptEventId,
        eventType: "control.interrupt",
        interruptsRunId: firstRun.runId,
      });
      const cancelledRows = eventsAfterInterrupt.events.filter((event) => {
        return (
          event.eventType === "run.cancelled" && event.runId === firstRun.runId
        );
      });
      expect(cancelledRows).toHaveLength(1);
      expect(
        eventsAfterInterrupt.events.some((event) => {
          return (
            event.eventType === "input.prompt" &&
            event.userMessage.parts.some((part) => {
              return (
                part.type === "text" &&
                part.text ===
                  "Reused interrupt event id text should not enqueue"
              );
            })
          );
        }),
      ).toBeFalsy();

      const secondRun = await fixture.sendChatRun(actor, {
        threadId: firstRun.threadId,
        prompt: "Second directly cancelled round prompt",
        model: "claude-fable-5-1",
      });
      const secondExecution = await fixture.api.executionInput(secondRun.runId);
      await fixture.api.requestCancelRun(actor, secondRun.runId, [200]);
      await fixture.failChatRun(
        secondRun.runId,
        { authorization: `Bearer ${secondExecution.sandboxToken}` },
        "Run cancelled",
      );
      await flushWaitUntilForTest();

      await accept(
        chatEventsApi.send({
          headers: signIn(actor),
          body: {
            threadId: firstRun.threadId,
            interruptsRunId: secondRun.runId,
            clientEventId: randomUUID(),
          },
        }),
        [400],
      );

      const thirdRun = await fixture.sendChatRun(actor, {
        threadId: firstRun.threadId,
        prompt: "Third turn after both cancellations",
        model: "claude-fable-5-1",
      });
      const thirdExecution = await fixture.api.executionInput(thirdRun.runId);
      const incompletePrompt = thirdExecution.appendSystemPrompt ?? "";
      expect(incompletePrompt).toContain("# Incomplete Rounds Context");
      expect(incompletePrompt).toContain("First interrupted round prompt");
      expect(incompletePrompt).toContain(
        "Second directly cancelled round prompt",
      );
      expect(incompletePrompt).toContain("- RELATIVE_INDEX: -1");
      expect(incompletePrompt).toContain("- RELATIVE_INDEX: 0");
      expect(incompletePrompt).toContain("- RUN_STATUS: cancelled");
    },
  );
});

describe("CHAT-02: Okou Mail link delivery", () => {
  it(
    "chat-events-admission-011 delivers a linked Gmail draft exactly once through the agent reply",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const fixture = createChatEventsFixture(context);
      const actor = fixture.bdd.user();
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();
      mockClaudeCodeTokenEndpoint();

      const gmailToken = "gmail-bearer-token-admission-011";
      mockGmailConnectorOAuth({
        accessToken: gmailToken,
        email: "sender@example.test",
      });
      await Promise.all([
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor),
        fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: `claude-token-${randomUUID()}`,
        }),
        (async () => {
          const oauthStart = await fixture.connectors.startOauth(
            actor,
            "gmail",
            "oauth",
          );
          const oauthState = new URL(
            oauthStart.authorizationUrl,
          ).searchParams.get("state");
          if (!oauthState) {
            throw new Error("Expected Gmail OAuth state");
          }
          const oauthDone =
            await fixture.connectors.completeOauthCallbackResult("gmail", {
              code: "gmail-code-011",
              state: oauthState,
            });
          expect(oauthDone.body.status).toBe("success");
        })(),
      ]);

      const gmailDraftId = "r-draft-admission-011";
      const fetchedDraftRequests: {
        readonly url: string;
        readonly authorization: string | null;
      }[] = [];
      server.use(
        http.get(
          `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${gmailDraftId}`,
          ({ request }) => {
            fetchedDraftRequests.push({
              url: request.url,
              authorization: request.headers.get("authorization"),
            });
            return HttpResponse.json({
              id: gmailDraftId,
              message: {
                id: "gmail-msg-011",
                threadId: "gmail-thread-011",
                payload: {
                  partId: "",
                  mimeType: "text/plain",
                  filename: "",
                  headers: [
                    { name: "From", value: "sender@example.test" },
                    { name: "To", value: "recipient@example.test" },
                    { name: "Subject", value: "Quarterly update" },
                  ],
                  body: {
                    size: 12,
                    data: Buffer.from("Hello world!").toString("base64url"),
                  },
                },
              },
            });
          },
        ),
      );

      const run = await fixture.sendChatRun(actor, {
        prompt: "Link my Gmail draft for review",
        model: "claude-fable-5-1",
      });
      const { execution, sandboxHeaders } = await fixture.runExecution(
        run.runId,
      );
      const agentToken = okouTokenFromExecution(execution);

      const mailApi = setupApp({ context, routes: mailRoutes })(mailContract);
      const linked = await accept(
        mailApi.linkDraft({
          headers: { authorization: `Bearer ${agentToken}` },
          body: {
            threadId: run.threadId,
            gmailDraftId,
          },
        }),
        [200],
      );

      expect(fetchedDraftRequests).toStrictEqual([
        {
          url: `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${gmailDraftId}?format=full`,
          authorization: `Bearer ${gmailToken}`,
        },
      ]);
      const reviewUrl = linked.body.mailDraftUrl;
      expect(reviewUrl).toBe(
        `https://app.okou.ai/mail/drafts/${linked.body.mailDraftId}`,
      );

      const eventsBeforeReply = await fixture.chat.listThreadEvents(
        actor,
        run.threadId,
      );
      expect(
        eventBackedContents(eventsBeforeReply.events, run.runId),
      ).toStrictEqual([]);

      await completePublicClaudeRun(
        context,
        run,
        sandboxHeaders,
        `Please review your draft: ${reviewUrl}`,
      );

      const eventsAfterCompletion = await fixture.chat.listThreadEvents(
        actor,
        run.threadId,
      );
      const assistantReplies = eventBackedContents(
        eventsAfterCompletion.events,
        run.runId,
      );
      expect(assistantReplies).toHaveLength(1);
      expect(assistantReplies[0]?.content).toContain(reviewUrl);
    },
  );
});

describe("CHAT-02: network body capture", () => {
  it(
    "chat-events-admission-012 carries a send's network body capture into the run the pick launches",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const { actor } = await setupEntitledClaudeActor(fixture);

      const [capturedRun, standardRun] = await Promise.all([
        fixture.sendChatRun(actor, {
          prompt: "Prompt with network body capture enabled",
          model: "claude-fable-5-1",
          captureNetworkBodies: true,
        }),
        fixture.sendChatRun(actor, {
          prompt: "Prompt with network body capture omitted",
          model: "claude-fable-5-1",
        }),
      ]);

      const [capturedExecution, standardExecution] = await Promise.all([
        fixture.api.executionInput(capturedRun.runId),
        fixture.api.executionInput(standardRun.runId),
      ]);
      expect(capturedExecution.captureNetworkBodies).toBeTruthy();
      expect(standardExecution.captureNetworkBodies).toBeUndefined();
    },
  );
});
