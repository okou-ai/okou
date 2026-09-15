import { http, HttpResponse } from "msw";
import { z } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  withContractedGoalSchema,
  seedRetainedRunProvenance,
  removeSnapshottedRunEvents,
  retainedUsageRows,
  appendRetainedRunPrompt,
  appendRetainedUsageWebContext,
  withEmptySnapshotReadBarrier,
} from "../../../test-fixtures/goal-schema-contraction";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRouteMocks } from "./helpers/route-test";
import { installFakeChatEventR2 } from "./helpers/fake-chat-event-r2";

const context = testContext();
createRouteMocks(context);
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);

async function archive(threadId: string, keepEventId?: string): Promise<void> {
  const previous = context.mocks.s3.send.getMockImplementation();
  installFakeChatEventR2(context);
  const snapshot = context.mocks.s3.send.getMockImplementation();
  if (!previous || !snapshot) {
    throw new Error("Expected object storage fixtures");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      (command instanceof GetObjectCommand ||
        command instanceof PutObjectCommand) &&
      command.input.Key?.startsWith("chat-events/")
    ) {
      return snapshot(command);
    }
    return previous(command);
  });
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
  await removeSnapshottedRunEvents(threadId, keepEventId);
}

test("executes normal and CTE launches, callbacks and late historical billing after Goal schema contraction", async () => {
  await withContractedGoalSchema(async (statements) => {
    const actor = bdd.user();
    const callbacks = createChatCallbacksApi(context);
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Consumer-free runtime",
      visibility: "private",
    });
    const send = async () => {
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "ordinary chat after contraction",
          model: "claude-sonnet-5",
        },
        [201],
      );
      if (response.status !== 201 || !response.body.runId) {
        throw new Error("Expected a persisted run");
      }
      await flushWaitUntilForTest();
      return { runId: response.body.runId, threadId: response.body.threadId };
    };
    // No configured runner: preparation failure exercises the ordinary insert
    // and metadata path, retaining the real failed run and its terminal callback.
    const failed = await send();
    expect((await api.readRun(actor, failed.runId)).status).toBe("failed");
    const runnerGroup = api.configureRunnerGroup();
    await api.heartbeatRunner(runnerGroup);
    const provider = `contraction-${randomUUID()}`;
    await seedUsagePricingRows([
      {
        kind: "connector",
        provider,
        category: "api_request",
        unitPrice: 7,
        unitSize: 1,
      },
    ]);
    for (const provenance of [
      "hot",
      "snapshot",
      "absent",
      "manual-hot",
      "manual-snapshot",
      "snapshot-null",
      "snapshot-legacy",
    ] as const) {
      const run = await send();
      expect((await api.readRun(actor, run.runId)).status).toBe("pending");
      const claim = await api.claimRunnerJob(run.runId);
      const headers = { authorization: `Bearer ${claim.sandboxToken}` };
      const archived = provenance.includes("snapshot");
      const groupId =
        provenance === "absent" || provenance === "snapshot-null"
          ? null
          : randomUUID();
      await seedRetainedRunProvenance(
        run.runId,
        run.threadId,
        groupId,
        provenance.startsWith("manual") ? "web" : "goal",
      );
      // This is a callback from an already-claimed historical run, not a new
      // Goal claim. Its status and output still settle exactly once.
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "historical terminal callback",
        },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      expect((await api.readRun(actor, run.runId)).status).toBe("failed");
      const terminal = (
        await chat.listThreadEvents(actor, run.threadId)
      ).events.filter((event) => {
        return event.eventType === "run.failed";
      });
      expect(terminal).toHaveLength(1);
      if (archived) {
        // A covered initial claim may remain hot. A later legacy input is not
        // an initial claim, and neither can exclude the archived Goal context.
        await archive(
          run.threadId,
          provenance === "manual-snapshot" ? run.runId : undefined,
        );
        await appendRetainedRunPrompt(run.runId, run.threadId);
      }
      const record = async (key: string) => {
        await webhooks.requestAgentUsageEvent(
          {
            runId: run.runId,
            events: [
              {
                idempotencyKey: key,
                kind: "connector",
                provider,
                category: "api_request",
                quantity: 1,
              },
            ],
          },
          headers,
          [200],
        );
        await createBillingMediaApi(context).processOrgUsageEvents(actor);
        await flushWaitUntilForTest();
      };
      const firstKey = randomUUID();
      const archiveGets = () => {
        return context.mocks.s3.send.mock.calls.filter(([command]) => {
          return (
            command instanceof GetObjectCommand &&
            command.input.Key?.startsWith("chat-events/")
          );
        }).length;
      };
      const readsBeforeFirst = archiveGets();
      await record(firstKey);
      expect(archiveGets() - readsBeforeFirst).toBe(archived ? 1 : 0);
      let first = (await retainedUsageRows(run.runId)).at(-1);
      expect(first).toMatchObject({
        contextType: groupId ? "goal" : null,
        contextId: groupId,
        payload: { usage: { totalCredits: 7 } },
      });
      if (!first) {
        throw new Error("Expected first late usage");
      }
      await record(firstKey);
      await expect(retainedUsageRows(run.runId)).resolves.toHaveLength(1);
      // Revisions inherit even a null pointer; subsequent unrelated provenance
      // must not silently regroup an already-authoritative usage event.
      if (provenance === "absent" || provenance === "snapshot-null") {
        await seedRetainedRunProvenance(run.runId, run.threadId, randomUUID());
      }
      if (provenance === "snapshot-legacy") {
        // This historical nullable source pointer is not emitted by current billing.
        await appendRetainedUsageWebContext(run.runId);
        first = (await retainedUsageRows(run.runId)).at(-1);
        if (!first) {
          throw new Error("Expected retained legacy usage");
        }
      }
      if (archived) {
        await archive(run.threadId);
      }
      const secondKey = randomUUID();
      await record(secondKey);
      const revisions = await retainedUsageRows(run.runId);
      const revised = revisions.at(-1);
      expect(revised).toMatchObject({
        revokesEventId: first.id,
        contextType: first.contextType,
        contextId: first.contextId,
        payload: {
          usage: {
            totalCredits: 14,
            settledAt: first.payload?.usage?.settledAt,
          },
        },
      });
      expect(revised?.createdAt.getTime()).toBeGreaterThan(
        first.createdAt.getTime(),
      );
      await record(secondKey);
      await expect(retainedUsageRows(run.runId)).resolves.toStrictEqual(
        revisions,
      );
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "historical terminal callback",
        },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      await expect(retainedUsageRows(run.runId)).resolves.toStrictEqual(
        revisions,
      );
    }
    const sql = statements();
    expect(
      sql.some((statement) => {
        return /^insert into "agent_runs"/i.test(statement);
      }),
    ).toBeTruthy();
    expect(
      sql.some((statement) => {
        return (
          /^with /i.test(statement) &&
          statement.includes('insert into "agent_runs"')
        );
      }),
    ).toBeTruthy();
    expect(
      sql.filter((statement) => {
        return /\b(goal_id|thread_goals|retirement_archive_event_id|retirement_search_materialized_at)\b/i.test(
          statement,
        );
      }),
    ).toStrictEqual([]);
    expect(
      sql.some((statement) => {
        return statement.includes('update "agent_runs"');
      }),
    ).toBeTruthy();
  });
}, 180_000);

test.each(
  (["failed", "completed", "cancelled"] as const).flatMap((terminal) => {
    return [false, true].map((historicalGoal) => {
      return {
        terminal,
        historicalGoal,
      };
    });
  }),
)(
  "persists $terminal ordinary continuation writes with an unavailable prior archive (historical Goal: $historicalGoal)",
  async ({ terminal, historicalGoal }) => {
    const actor = bdd.user();
    const callbacks = createChatCallbacksApi(context);
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Continue archived conversation",
      visibility: "private",
    });
    const send = async (threadId?: string) => {
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          threadId,
          prompt: "continue ordinary conversation",
          model: "claude-sonnet-5",
        },
        [201],
      );
      if (response.status !== 201 || !response.body.runId) {
        throw new Error("Expected a new run");
      }
      await flushWaitUntilForTest();
      return { runId: response.body.runId, threadId: response.body.threadId };
    };
    const old = await send();
    // Retired historical provenance cannot be created through the live API.
    if (historicalGoal) {
      await seedRetainedRunProvenance(old.runId, old.threadId, randomUUID());
    }
    const oldEvents = (await chat.listThreadEvents(actor, old.threadId)).events;
    const cursor = oldEvents.at(-1);
    if (!cursor) {
      throw new Error("Expected a previous conversation cursor");
    }
    await archive(old.threadId);
    const runnerGroup = api.configureRunnerGroup();
    await api.heartbeatRunner(runnerGroup);
    const storage = context.mocks.s3.send.getMockImplementation();
    if (!storage) {
      throw new Error("Expected object storage fixture");
    }
    let archiveGets = 0;
    let archiveUnavailable = false;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (
        archiveUnavailable &&
        command instanceof GetObjectCommand &&
        command.input.Key?.startsWith("chat-events/")
      ) {
        archiveGets++;
        throw new Error("Prior archive is unavailable");
      }
      return storage(command);
    });
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ThreadActivitySummary]: false,
      },
    );
    mockOptionalEnv("OPENROUTER_API_KEY", "archive-thinking-test");
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const body = z
            .object({ messages: z.array(z.object({ content: z.string() })) })
            .parse(await request.json());
          if (
            body.messages[0]?.content.includes(
              "Write user-visible progress copy",
            )
          ) {
            // The external provider finishes after the old archive becomes unavailable.
            archiveUnavailable = true;
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Preparing this ordinary reply" },
              },
            ],
          });
        },
      ),
    );
    const run = await send(old.threadId);
    expect(archiveUnavailable).toBeTruthy();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "pending",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    for (const sequenceNumber of [0, 1, 1]) {
      await webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber,
              message: {
                id: `archive-continuation-${sequenceNumber}`,
                content: [
                  { type: "text", text: `Current answer ${sequenceNumber}` },
                ],
              },
            },
          ],
        },
        headers,
        [200],
      );
    }
    const provider = `archive-continuation-${randomUUID()}`;
    await seedUsagePricingRows([
      {
        kind: "connector",
        provider,
        category: "api_request",
        unitPrice: 7,
        unitSize: 1,
      },
    ]);
    const usage = {
      runId: run.runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "connector" as const,
          provider,
          category: "api_request",
          quantity: 1,
        },
      ],
    };
    await webhooks.requestAgentUsageEvent(usage, headers, [200]);
    if (terminal === "cancelled") {
      await api.requestCancelRun(actor, run.runId, [200]);
    }
    const completion =
      terminal === "completed"
        ? {
            runId: run.runId,
            exitCode: 0,
            lastEventSequence: 1,
            checkpoint: {
              cliAgentType: "claude-code" as const,
              cliAgentSessionId: `archive-${run.runId}`,
              cliAgentSessionHistoryHash: createHash("sha256")
                .update(run.runId)
                .digest("hex"),
            },
          }
        : {
            runId: run.runId,
            exitCode: 1,
            error: "ordinary terminal delivery",
          };
    for (let delivery = 0; delivery < 2; delivery++) {
      await webhooks.requestAgentComplete(completion, headers, [200]);
      await flushWaitUntilForTest();
    }
    await webhooks.requestAgentUsageEvent(usage, headers, [200]);
    await createBillingMediaApi(context).processOrgUsageEvents(actor);
    await flushWaitUntilForTest();
    await webhooks.requestAgentUsageEvent(usage, headers, [200]);
    await createBillingMediaApi(context).processOrgUsageEvents(actor);
    await flushWaitUntilForTest();
    expect((await api.readRun(actor, run.runId)).status).toBe(terminal);
    expect(archiveGets).toBe(0);
    const events = (
      await chat.listThreadEvents(actor, run.threadId, {
        sinceSeqId: cursor.seqId,
        sinceEventId: cursor.id,
      })
    ).events.filter((event) => {
      return event.runId === run.runId;
    });
    expect(
      events
        .filter((event) => {
          return event.eventType === "output.message";
        })
        .map((event) => {
          return event.content;
        }),
    ).toStrictEqual(
      expect.arrayContaining(["Current answer 0", "Current answer 1"]),
    );
    expect(
      events.filter((event) => {
        return (
          event.eventType === "output.message" &&
          event.content?.startsWith("Current answer")
        );
      }),
    ).toHaveLength(2);
    expect(
      events.filter((event) => {
        return event.eventType === `run.${terminal}`;
      }),
    ).toHaveLength(1);
    const usages = events.filter((event) => {
      return event.eventType === "usage.recorded";
    });
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      usage: { totalCredits: 7 },
    });
    expect(usages[0]?.runGroupId).toBeUndefined();
    expect(
      events.filter((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toMatchObject([
      {
        eventType: "output.thinking",
        thinking: "Preparing this ordinary reply",
      },
    ]);
  },
  60_000,
);

async function startArchiveTestRun() {
  const actor = bdd.user();
  const callbacks = createChatCallbacksApi(context);
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Historical delivery",
    visibility: "private",
  });
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "ordinary historical input",
      model: "claude-sonnet-5",
    },
    [201],
  );
  if (sent.status !== 201 || !sent.body.runId) {
    throw new Error("Expected run");
  }
  await flushWaitUntilForTest();
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(sent.body.runId);
  return {
    actor,
    runId: sent.body.runId,
    threadId: sent.body.threadId,
    headers: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

test("surfaces a required archive failure and retries historical manual output without losing its context", async () => {
  const run = await startArchiveTestRun();
  const groupId = randomUUID();
  // A retained manual run with Goal provenance cannot be recreated by live admission.
  await seedRetainedRunProvenance(run.runId, run.threadId, groupId, "web");
  const cursor = (
    await chat.listThreadEvents(run.actor, run.threadId)
  ).events.at(-1);
  if (!cursor) {
    throw new Error("Expected retained history");
  }
  await archive(run.threadId, run.runId);
  await appendRetainedRunPrompt(run.runId, run.threadId);
  const storage = context.mocks.s3.send.getMockImplementation();
  if (!storage) {
    throw new Error("Expected object storage fixture");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand &&
      command.input.Key?.startsWith("chat-events/")
    ) {
      throw new Error("Required history unavailable");
    }
    return storage(command);
  });
  const batch = {
    runId: run.runId,
    events: [
      {
        type: "assistant" as const,
        sequenceNumber: 0,
        message: {
          id: "historical-retry",
          content: [
            { type: "text" as const, text: "Retried historical output" },
          ],
        },
      },
    ],
  };
  const failed = await webhooks.requestAgentEvents(batch, run.headers, [503]);
  expect(failed.body).toMatchObject({
    error: { code: "EVENT_DELIVERY_UNAVAILABLE" },
  });
  const failedRows = await chat.listThreadEventRows(run.actor, run.threadId, {
    lastEventId: cursor.id,
    lastSeqId: cursor.seqId,
  });
  expect(
    failedRows.filter((event) => {
      return event.eventType === "output.message";
    }),
  ).toHaveLength(0);
  context.mocks.s3.send.mockImplementation(storage);
  await webhooks.requestAgentEvents(batch, run.headers, [200]);
  await webhooks.requestAgentEvents(batch, run.headers, [200]);
  const rows = await chat.listThreadEventRows(run.actor, run.threadId, {
    lastEventId: cursor.id,
    lastSeqId: cursor.seqId,
  });
  expect(
    rows.filter((event) => {
      return event.eventType === "output.message";
    }),
  ).toMatchObject([
    {
      contextType: "goal",
      contextId: groupId,
      payload: { content: "Retried historical output" },
    },
  ]);
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 1, error: "settle historical run" },
    run.headers,
    [200],
  );
  await flushWaitUntilForTest();
}, 60_000);

test("recovers first late usage context when snapshot publication and retention move past an in-flight archive read", async () => {
  const run = await startArchiveTestRun();
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 1, error: "settled manual run" },
    run.headers,
    [200],
  );
  await flushWaitUntilForTest();
  const oldCursor = (
    await chat.listThreadEvents(run.actor, run.threadId)
  ).events.at(-1);
  if (!oldCursor) {
    throw new Error("Expected completed conversation");
  }
  await archive(run.threadId);
  const groupId = randomUUID();
  // The historical tail exists before reading; publication moves it from hot
  // storage to a newer snapshot while the earlier immutable GET is in flight.
  await seedRetainedRunProvenance(run.runId, run.threadId, groupId, "web");
  const cursor = (
    await chat.listThreadEvents(run.actor, run.threadId, {
      sinceEventId: oldCursor.id,
      sinceSeqId: oldCursor.seqId,
    })
  ).events.at(-1);
  if (!cursor) {
    throw new Error("Expected retained provenance tail");
  }
  const provider = `archive-race-${randomUUID()}`;
  await seedUsagePricingRows([
    {
      kind: "connector",
      provider,
      category: "api_request",
      unitPrice: 7,
      unitSize: 1,
    },
  ]);
  const usage = {
    runId: run.runId,
    events: [
      {
        idempotencyKey: randomUUID(),
        kind: "connector" as const,
        provider,
        category: "api_request",
        quantity: 1,
      },
    ],
  };
  await webhooks.requestAgentUsageEvent(usage, run.headers, [200]);
  const storage = context.mocks.s3.send.getMockImplementation();
  if (!storage) {
    throw new Error("Expected object storage fixture");
  }
  let moved = false;
  const readWhilePublishing = async (command: unknown): Promise<unknown> => {
    if (
      !moved &&
      command instanceof GetObjectCommand &&
      command.input.Key?.startsWith("chat-events/")
    ) {
      moved = true;
      await archive(run.threadId);
      context.mocks.s3.send.mockImplementation(readWhilePublishing);
    }
    return await storage(command);
  };
  context.mocks.s3.send.mockImplementation(readWhilePublishing);
  await createBillingMediaApi(context).processOrgUsageEvents(run.actor);
  await flushWaitUntilForTest();
  expect(moved).toBeTruthy();
  const rows = await chat.listThreadEventRows(run.actor, run.threadId, {
    lastEventId: cursor.id,
    lastSeqId: cursor.seqId,
  });
  const usageRows = rows.filter((event) => {
    return event.eventType === "usage.recorded";
  });
  expect(usageRows).toMatchObject([
    {
      contextType: "goal",
      contextId: groupId,
      payload: { usage: { totalCredits: 7 } },
    },
  ]);
  await webhooks.requestAgentUsageEvent(usage, run.headers, [200]);
  await createBillingMediaApi(context).processOrgUsageEvents(run.actor);
  await flushWaitUntilForTest();
  await expect(
    chat.listThreadEventRows(run.actor, run.threadId, {
      lastEventId: cursor.id,
      lastSeqId: cursor.seqId,
    }),
  ).resolves.toStrictEqual(rows);
}, 60_000);

test("preserves first late usage context when a first snapshot replaces hot history after an empty head read", async () => {
  const run = await startArchiveTestRun();
  const groupId = randomUUID();
  await seedRetainedRunProvenance(run.runId, run.threadId, groupId, "web");
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 1, error: "settled historical manual run" },
    run.headers,
    [200],
  );
  await flushWaitUntilForTest();
  const cursor = (
    await chat.listThreadEvents(run.actor, run.threadId)
  ).events.at(-1);
  if (!cursor) {
    throw new Error("Expected retained history before publication");
  }
  const provider = `first-snapshot-race-${randomUUID()}`;
  await seedUsagePricingRows([
    {
      kind: "connector",
      provider,
      category: "api_request",
      unitPrice: 7,
      unitSize: 1,
    },
  ]);
  await webhooks.requestAgentUsageEvent(
    {
      runId: run.runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "connector",
          provider,
          category: "api_request",
          quantity: 1,
        },
      ],
    },
    run.headers,
    [200],
  );
  await flushWaitUntilForTest();
  // No API can suspend a completed SQL response. Hold the real driver's empty
  // result while the real snapshot route and retention fixture move the rows.
  await withEmptySnapshotReadBarrier({
    threadId: run.threadId,
    whileResponseHeld: async () => {
      await archive(run.threadId);
    },
    work: async () => {
      await createBillingMediaApi(context).processOrgUsageEvents(run.actor);
      await flushWaitUntilForTest();
    },
  });
  const rows = await chat.listThreadEventRows(run.actor, run.threadId, {
    lastEventId: cursor.id,
    lastSeqId: cursor.seqId,
  });
  expect(
    rows.filter((event) => {
      return event.eventType === "usage.recorded";
    }),
  ).toMatchObject([
    {
      contextType: "goal",
      contextId: groupId,
      payload: { usage: { totalCredits: 7 } },
    },
  ]);
}, 60_000);
