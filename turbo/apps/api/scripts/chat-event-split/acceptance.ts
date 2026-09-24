import "./env";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventWriteControl } from "@okouai/db/schema/chat-event-write-control";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { runOutputMemoryCitations } from "@okouai/db/schema/run-output-memory-citation";
import { insertChatEvent } from "../../src/signals/services/chat-event.service";
import { isSplitChatEventWriteEnabled } from "../../src/signals/services/chat-event-write-mode.service";
import { insertRunLifecycleMarkerProjection } from "../../src/signals/services/internal-chat-run-callback.service";
import { materializeRunOutputEvents } from "../../src/signals/services/agent-event-consumer-run-output.service";
import {
  RunOutputDiagnostics,
  readRunContentOwnership,
  withRunOutputWrite,
} from "../../src/signals/services/run-content-erasure-admission.service";
import { activityContentTransaction } from "../../src/signals/services/run-activity-snapshot.service";
import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import {
  createDeferredPromise,
  settleIncludingAbort,
} from "../../src/signals/utils";
import { deleteChatThreadContent } from "../../src/signals/services/chat-thread.service";
import { deleteAgentInTransaction } from "../../src/signals/services/agent-deletion.service";
import { safeSqlStateCode } from "../../src/lib/pg-errors";
import { flushWaitUntilForTest } from "../../src/signals/context/wait-until";
import { flushAxiom } from "../../src/signals/external/axiom";
import { flushLogs } from "../../src/lib/log";

// Infrastructure acceptance: the intermediate crash boundary and PostgreSQL
// faults are not exposed by a public route. Use the production projections,
// their actual migration and an owned database; only telemetry is external.
assert.ok(process.env.DATABASE_URL, "local DATABASE_URL required");
const base = new URL(process.env.DATABASE_URL);
assert.ok(["127.0.0.1", "localhost", "postgres"].includes(base.hostname));
const databaseName = `chat_event_split_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(base);
databaseUrl.pathname = `/${databaseName}`;
const applicationName = `split_writer_${randomUUID()}`;
const admin = new Client({ connectionString: base.toString() });
const pool = new Pool({
  connectionString: databaseUrl.toString(),
  application_name: applicationName,
  options: "-c lock_timeout=1000 -c statement_timeout=5000",
});
// pg-pool resolves end() after removing clients from its list, before every
// socket emits end. Await those actual closes before dropping the owned DB.
const poolClientClosures: Promise<void>[] = [];
pool.on("connect", (client) => {
  poolClientClosures.push(
    new Promise<void>((resolve) => {
      client.once("end", resolve);
    }),
  );
});
const db = drizzle(pool);
const suiteController = new AbortController();
const signal = suiteController.signal;
let realtimePublications = 0;
const telemetry = setupServer(
  http.post("https://main.realtime.ably.net/channels/:channel/messages", () => {
    realtimePublications++;
    return new HttpResponse(null, { status: 201 });
  }),
  http.get("https://main.realtime.ably.net/time", () => {
    return HttpResponse.json([Date.now()]);
  }),
  http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
    return HttpResponse.json({ ingested: 1, failed: 0, processedBytes: 1 });
  }),
);
telemetry.listen({ onUnhandledRequest: "error" });
// The existing sandbox telemetry SDK owns a final buffered flush timer. Keep
// its external HTTP stub alive until Node has drained that process-owned work.
process.once("beforeExit", () => {
  telemetry.close();
});
await admin.connect();

async function fixture(status: "running" | "completed" = "completed") {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const runId = randomUUID();
  const sourceCallbackId = randomUUID();
  await db
    .insert(agents)
    .values({ id: agentId, owner: userId, orgId, name: agentId });
  await db
    .insert(agentSessions)
    .values({ id: sessionId, userId, orgId, agentId });
  await db.insert(chatThreads).values({ id: threadId, userId, agentId });
  await db.insert(agentRuns).values({
    id: runId,
    userId,
    orgId,
    sessionId,
    status,
    prompt: "Synthetic split output acceptance",
    triggerSource: "teams",
    autonomyBudget: 10,
    chatThreadId: threadId,
    apiStartedAt: new Date(),
  });
  const target = {
    tenantId: orgId,
    tenantName: null,
    teamId: null,
    teamName: null,
    channelId: null,
    conversationId: `conversation_${randomUUID()}`,
    conversationType: "personal",
    threadId: `topic_${randomUUID()}`,
    activityId: `activity_${randomUUID()}`,
    serviceUrl: "https://synthetic.invalid",
    connectionId: randomUUID(),
    teamsUserId: userId,
    teamsUserDisplayName: null,
    teamsUserPrincipalName: null,
    botId: null,
    botName: null,
    publicBrand: "okou" as const,
  };
  const input = {
    db,
    runId,
    threadId,
    userId,
    orgId,
    event: "completed" as const,
    teamsDelivery: target,
    sourceCallbackId,
    publicBrand: "okou" as const,
  };
  return {
    ...input,
    agentId,
    input,
    source: async () => {
      await db.insert(agentRunCallbacks).values({
        id: sourceCallbackId,
        runId,
        internalKind: "chat",
        payload: { threadId },
      });
    },
    project: async () => {
      return await insertRunLifecycleMarkerProjection({
        tx: db,
        input,
        markerCreatedAt: new Date(),
        goalId: undefined,
        splitWrites: await isSplitChatEventWriteEnabled(db),
      });
    },
  };
}

async function waitForBlockedQuery(
  queryFragment: string,
  settled: () => boolean,
) {
  let blocked = false;
  while (!blocked && !settled()) {
    const state = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND query LIKE $2 AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked",
      [applicationName, `%${queryFragment}%`],
    );
    blocked = state.rows[0]?.blocked === true;
    if (!blocked) {
      await setImmediate();
    }
  }
  assert.ok(
    blocked,
    `expected a real database waiter containing ${queryFragment}`,
  );
}

try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await promisify(execFile)("node", ["--import", "tsx", "scripts/migrate.ts"], {
    cwd: fileURLToPath(new URL("../../../../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(await isSplitChatEventWriteEnabled(db), false);
  await test("legacy deletion waits for the thread before taking child locks", async () => {
    const f = await fixture("running");
    const control = new Client({ connectionString: databaseUrl.toString() });
    await control.connect();
    await control.query("BEGIN");
    await control.query(
      "SELECT id FROM chat_threads WHERE id = $1 FOR NO KEY UPDATE",
      [f.threadId],
    );
    let deletionSettled = false;
    const deletion = settleIncludingAbort(
      deleteChatThreadContent(
        db,
        {
          threadId: f.threadId,
          userId: f.userId,
          orgId: f.orgId,
        },
        signal,
      ),
    ).then((result) => {
      deletionSettled = true;
      return result;
    });
    try {
      await waitForBlockedQuery('from "chat_threads"', () => {
        return deletionSettled;
      });
      // Legacy control can finish under its existing thread-first order.
      await control.query(
        "SELECT id FROM agent_runs WHERE id = $1 FOR NO KEY UPDATE NOWAIT",
        [f.runId],
      );
    } finally {
      await control.query("ROLLBACK");
      await deletion;
      await control.end();
    }
    const deleted = await deletion;
    assert.ok(deleted.ok && deleted.value.deleted);
    assert.deepEqual(deleted.value.activeRuns, [
      { runId: f.runId, orgId: f.orgId },
    ]);
  });
  await db
    .update(chatEventWriteControl)
    .set({ activatedAt: new Date() })
    .where(eq(chatEventWriteControl.id, "global"));
  assert.equal(await isSplitChatEventWriteEnabled(db), true);

  await test("a committed terminal marker retries missing registration and concurrent replays share one delivery", async () => {
    const f = await fixture();
    await assert.rejects(f.project(), /missing its chat callback/u);
    const [marker] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.runId, f.runId),
          eq(chatEvents.eventType, "run.completed"),
        ),
      );
    assert.ok(
      marker,
      "callback registration failure must not roll back the marker",
    );
    await f.source();
    const [first, second] = await Promise.all([f.project(), f.project()]);
    assert.ok(first?.teamsDeliveryCallbackId);
    assert.equal(first.markerInserted, false);
    assert.equal(
      second?.teamsDeliveryCallbackId,
      first.teamsDeliveryCallbackId,
    );
    const callbacks = await db
      .select()
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, f.runId));
    assert.equal(
      callbacks.filter((row) => {
        return row.internalKind === "chat";
      }).length,
      1,
    );
    assert.equal(
      callbacks.filter((row) => {
        return row.internalKind === "teams:chat";
      }).length,
      1,
    );
    const delivery = callbacks.find((row) => {
      return row.internalKind === "teams:chat";
    });
    assert.equal(delivery?.status, "pending");
    assert.deepEqual(delivery?.payload, {
      ...f.teamsDelivery,
      chatEventId: (
        await db
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.runId, f.runId),
              eq(chatEvents.eventType, "output.message"),
            ),
          )
      )[0]?.id,
    });
  });

  await test("replay reuses the delivered legacy callback instead of creating another delivery", async () => {
    const f = await fixture();
    await f.source();
    const output = await insertChatEvent(
      db,
      {
        chatThreadId: f.threadId,
        runId: f.runId,
        eventType: "output.message",
        content: "Legacy completion",
        runEventSequenceNumber: 0,
        runEventId: "legacy:0",
      },
      "none",
      { splitWrites: true },
    );
    assert.ok(output);
    await insertChatEvent(
      db,
      {
        chatThreadId: f.threadId,
        runId: f.runId,
        eventType: "run.completed",
        content: null,
      },
      "run-lifecycle",
      { splitWrites: true },
    );
    const legacyId = randomUUID();
    await db.insert(agentRunCallbacks).values({
      id: legacyId,
      runId: f.runId,
      internalKind: "teams:chat",
      status: "delivered",
      attempts: 1,
      payload: { ...f.teamsDelivery, chatEventId: output.id },
      deliveredAt: new Date(),
    });
    assert.equal((await f.project())?.teamsDeliveryCallbackId, legacyId);
    const [delivery] = await db
      .select({ count: count() })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, f.runId),
          eq(agentRunCallbacks.internalKind, "teams:chat"),
        ),
      );
    assert.equal(delivery?.count, 1);
  });

  await test("event commit and later projections survive a failed materialization, and retry stays monotonic", async () => {
    const f = await fixture("running");
    await pool.query(
      `CREATE FUNCTION reject_split_materialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic materialization failure'; END $$; CREATE TRIGGER reject_split_materialization BEFORE INSERT ON chat_output_materializations FOR EACH ROW EXECUTE FUNCTION reject_split_materialization()`,
    );
    const payload = {
      runId: f.runId,
      context: { userId: f.userId, orgId: f.orgId },
      events: [
        {
          type: "item.completed",
          sequenceNumber: 5,
          item: {
            id: "message_5",
            type: "agent_message",
            text: "Committed before the failed auxiliary write",
          },
        },
      ],
    };
    const admission = {
      diagnostics: new RunOutputDiagnostics(),
      payload,
      suppliedCitations: [
        {
          sequenceNumber: 5,
          citation: {
            entries: [
              {
                path: "MEMORY.md",
                lineStart: 1,
                lineEnd: 1,
                note: "Synthetic reference",
              },
            ],
            rolloutIds: [],
          },
        },
      ],
    };
    const priorPublications = realtimePublications;
    await assert.rejects(
      materializeRunOutputEvents(db, admission, signal),
      (error: unknown) => {
        return safeSqlStateCode(error) === "P0001";
      },
    );
    await flushWaitUntilForTest();
    assert.ok(
      realtimePublications > priorPublications,
      "a failed auxiliary projection must not suppress the committed event notification",
    );
    const [eventCount] = await db
      .select({ count: count() })
      .from(chatEvents)
      .where(eq(chatEvents.runId, f.runId));
    assert.equal(eventCount?.count, 1);
    const [citationCount] = await db
      .select({ count: count() })
      .from(runOutputMemoryCitations)
      .where(eq(runOutputMemoryCitations.runId, f.runId));
    assert.equal(
      citationCount?.count,
      1,
      "citation write still runs after materialization failure",
    );
    const [metric] = await db
      .select({ acknowledgedAt: agentRuns.firstAssistantEventAcknowledgedAt })
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId));
    assert.ok(
      metric?.acknowledgedAt,
      "conditional first-assistant metadata still gets its independent attempt",
    );
    await pool.query(
      "DROP TRIGGER reject_split_materialization ON chat_output_materializations; DROP FUNCTION reject_split_materialization()",
    );
    await materializeRunOutputEvents(db, admission, signal);
    await materializeRunOutputEvents(
      db,
      {
        ...admission,
        suppliedCitations: [],
        payload: {
          ...payload,
          events: [
            {
              type: "item.completed",
              sequenceNumber: 3,
              item: {
                id: "message_3",
                type: "agent_message",
                text: "Older output",
              },
            },
          ],
        },
      },
      signal,
    );
    const [materialization] = await db
      .select()
      .from(runOutputMaterializations)
      .where(eq(runOutputMaterializations.runId, f.runId));
    assert.equal(materialization?.latestOutputSequence, 5);
    assert.equal(
      materialization?.latestOutputText,
      "Committed before the failed auxiliary write",
    );
  });

  await test("activity control waiting on the run cannot deadlock the output event foreign key", async () => {
    const f = await fixture("running");
    const [run] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId));
    assert.ok(run);
    await db
      .update(chatThreads)
      .set({ agentSessionId: run.sessionId, agentSessionRunId: f.runId })
      .where(eq(chatThreads.id, f.threadId));
    const ownership = await readRunContentOwnership(db, f.runId);
    const runLocked = createDeferredPromise<void>(signal);
    const releaseOutput = createDeferredPromise<void>(signal);
    const output = withRunOutputWrite(
      db,
      { runId: f.runId, ownership },
      async (tx) => {
        runLocked.resolve();
        await releaseOutput.promise;
        return await insertChatEvent(
          tx,
          {
            chatThreadId: f.threadId,
            runId: f.runId,
            eventType: "output.message",
            content: "Output crosses a concurrent activity control lock",
            runEventSequenceNumber: 0,
            runEventId: "activity_concurrency:0",
          },
          "none",
          { splitWrites: true },
        );
      },
      signal,
    );
    const outputResult = output.then(
      (value) => {
        return { value };
      },
      (error: unknown) => {
        return { error };
      },
    );
    assert.equal(
      await Promise.race([
        runLocked.promise.then(() => {
          return true;
        }),
        outputResult.then(() => {
          return false;
        }),
      ]),
      true,
      "output must acquire its run boundary before the competing activity starts",
    );
    const activity = activityContentTransaction(
      db,
      {
        runId: f.runId,
        threadId: f.threadId,
        userId: f.userId,
        orgId: f.orgId,
      },
      ownership,
      async (tx) => {
        await tx.insert(runActivitySnapshots).values({ runId: f.runId });
        return "activity committed";
      },
      signal,
    );
    let activitySettled = false;
    const activityResult = activity.then(
      (value) => {
        activitySettled = true;
        return { value };
      },
      (error: unknown) => {
        activitySettled = true;
        return { error };
      },
    );
    try {
      let blocked = false;
      while (!blocked && !activitySettled) {
        const state = await pool.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND query LIKE '%agent_runs%' AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked",
          [applicationName],
        );
        blocked = state.rows[0]?.blocked === true;
        if (!blocked) {
          await setImmediate();
        }
      }
      assert.ok(
        blocked,
        "activity must acquire its thread control lock before waiting for the run",
      );
    } finally {
      releaseOutput.resolve();
      await Promise.all([outputResult, activityResult]);
    }
    const written = await outputResult;
    assert.ok(
      "value" in written && written.value,
      "the event FK must pass the activity thread lock",
    );
    assert.deepEqual(await activityResult, { value: "activity committed" });
  });

  for (const existingSequence of [false, true]) {
    await test(`strong deletion waits for run output before fencing its event FK (existing sequence: ${existingSequence})`, async () => {
      const f = await fixture("running");
      if (existingSequence) {
        await insertChatEvent(
          db,
          {
            chatThreadId: f.threadId,
            runId: f.runId,
            eventType: "output.message",
            content: "Existing sequence",
            runEventId: "deletion:seed",
          },
          "none",
          { splitWrites: true },
        );
      }
      const ownership = await readRunContentOwnership(db, f.runId);
      const runLocked = createDeferredPromise<void>(signal);
      const releaseOutput = createDeferredPromise<void>(signal);
      const output = settleIncludingAbort(
        withRunOutputWrite(
          db,
          { runId: f.runId, ownership },
          async (tx) => {
            runLocked.resolve();
            await releaseOutput.promise;
            return await insertChatEvent(
              tx,
              {
                chatThreadId: f.threadId,
                runId: f.runId,
                eventType: "output.message",
                content: "Output precedes strong deletion",
                runEventId: "deletion:output",
              },
              "none",
              { splitWrites: true },
            );
          },
          signal,
        ),
      );
      await runLocked.promise;
      let deletionSettled = false;
      const deletion = settleIncludingAbort(
        deleteChatThreadContent(
          db,
          {
            threadId: f.threadId,
            userId: f.userId,
            orgId: f.orgId,
          },
          signal,
        ),
      ).then((result) => {
        deletionSettled = true;
        return result;
      });
      try {
        await waitForBlockedQuery('from "agent_runs"', () => {
          return deletionSettled;
        });
      } finally {
        releaseOutput.resolve();
        await Promise.all([output, deletion]);
      }
      const written = await output;
      assert.ok(
        written.ok && written.value,
        "output commits before deletion takes its strong thread fence",
      );
      const deleted = await deletion;
      assert.ok(deleted.ok && deleted.value.deleted);
      assert.deepEqual(deleted.value.activeRuns, [
        { runId: f.runId, orgId: f.orgId },
      ]);
      const [run] = await db
        .select({ threadId: agentRuns.chatThreadId })
        .from(agentRuns)
        .where(eq(agentRuns.id, f.runId));
      assert.equal(run?.threadId, null);
      const sequences = await db
        .select()
        .from(chatEventSequences)
        .where(eq(chatEventSequences.chatThreadId, f.threadId));
      assert.equal(sequences.length, 0, "thread cascade includes its sequence");
    });

    await test(`strong deletion admits an atomic direct append before cascade (existing sequence: ${existingSequence})`, async () => {
      const f = await fixture();
      if (existingSequence) {
        await insertChatEvent(
          db,
          {
            chatThreadId: f.threadId,
            eventType: "output.message",
            content: "Existing direct sequence",
          },
          "none",
          { splitWrites: true },
        );
      }
      const barrier = new Client({ connectionString: databaseUrl.toString() });
      await barrier.connect();
      const lockKey = 29_384_621;
      await barrier.query("BEGIN");
      await barrier.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
      await pool.query(
        `CREATE FUNCTION pause_direct_append() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chat_thread_id = '${f.threadId}'::uuid THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_direct_append BEFORE INSERT ON chat_events FOR EACH ROW EXECUTE FUNCTION pause_direct_append()`,
      );
      let writerSettled = false;
      const writer = settleIncludingAbort(
        insertChatEvent(
          db,
          {
            chatThreadId: f.threadId,
            eventType: "output.message",
            content:
              "Canonical direct append paused after its sequence allocation",
          },
          "none",
          { splitWrites: true },
        ),
      ).then((result) => {
        writerSettled = true;
        return result;
      });
      let deletionSettled = false;
      const deletionArgs = {
        threadId: f.threadId,
        userId: f.userId,
        orgId: f.orgId,
      };
      let deletion:
        | ReturnType<
            typeof settleIncludingAbort<
              Awaited<ReturnType<typeof deleteChatThreadContent>>
            >
          >
        | undefined;
      try {
        await waitForBlockedQuery("WITH input AS MATERIALIZED", () => {
          return writerSettled;
        });
        deletion = settleIncludingAbort(
          deleteChatThreadContent(db, deletionArgs, signal),
        ).then((result) => {
          deletionSettled = true;
          return result;
        });
        if (existingSequence) {
          await waitForBlockedQuery('from "chat_event_sequences"', () => {
            return deletionSettled;
          });
        } else {
          const blockedDeletion = await deletion;
          assert.ok(
            blockedDeletion.ok && blockedDeletion.value.deleted,
            "deletion can commit before an uncommitted first sequence reaches its FK check",
          );
        }
      } finally {
        await barrier.query("ROLLBACK");
        await Promise.all([writer, deletion]);
        await barrier.end();
        await pool.query(
          "DROP TRIGGER pause_direct_append ON chat_events; DROP FUNCTION pause_direct_append()",
        );
      }
      const written = await writer;
      if (existingSequence) {
        assert.ok(
          written.ok && written.value,
          "the direct CTE must commit without a sequence/thread-FK deadlock",
        );
        const deleted = await deletion;
        assert.ok(deleted && deleted.ok && deleted.value.deleted);
      } else {
        assert.ok(
          !written.ok && safeSqlStateCode(written.error) === "23503",
          "a first append racing committed deletion fails its FK and rolls the whole statement back",
        );
        const sequences = await db
          .select()
          .from(chatEventSequences)
          .where(eq(chatEventSequences.chatThreadId, f.threadId));
        assert.equal(
          sequences.length,
          0,
          "the failed first append leaves no sequence orphan",
        );
      }
      const events = await db
        .select({ id: chatEvents.id })
        .from(chatEvents)
        .where(eq(chatEvents.chatThreadId, f.threadId));
      assert.equal(events.length, 0);
    });
  }

  await test("agent cascade refuses an in-flight direct sequence before locking its thread", async () => {
    const f = await fixture();
    await insertChatEvent(
      db,
      {
        chatThreadId: f.threadId,
        eventType: "output.message",
        content: "Existing sequence before agent deletion",
      },
      "none",
      { splitWrites: true },
    );
    const barrier = new Client({ connectionString: databaseUrl.toString() });
    await barrier.connect();
    const lockKey = 29_384_623;
    await barrier.query("BEGIN");
    await barrier.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
    await pool.query(
      `CREATE FUNCTION pause_agent_cascade_append() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chat_thread_id = '${f.threadId}'::uuid THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_agent_cascade_append BEFORE INSERT ON chat_events FOR EACH ROW EXECUTE FUNCTION pause_agent_cascade_append()`,
    );
    let writerSettled = false;
    const writer = settleIncludingAbort(
      insertChatEvent(
        db,
        {
          chatThreadId: f.threadId,
          eventType: "output.message",
          content: "Direct writer before agent cascade",
        },
        "none",
        { splitWrites: true },
      ),
    ).then((result) => {
      writerSettled = true;
      return result;
    });
    const deleteArgs = {
      agentId: f.agentId,
      orgId: f.orgId,
      member: { userId: f.userId, role: "admin" },
    };
    try {
      await waitForBlockedQuery("WITH input AS MATERIALIZED", () => {
        return writerSettled;
      });
      await assert.rejects(
        db.transaction(async (tx) => {
          return await deleteAgentInTransaction(tx, deleteArgs);
        }),
        (error: unknown) => {
          return safeSqlStateCode(error) === "55P03";
        },
      );
    } finally {
      await barrier.query("ROLLBACK");
      await writer;
      await barrier.end();
      await pool.query(
        "DROP TRIGGER pause_agent_cascade_append ON chat_events; DROP FUNCTION pause_agent_cascade_append()",
      );
    }
    const written = await writer;
    assert.ok(
      written.ok && written.value,
      "the rejected cascade releases its parent locks so the direct append commits",
    );
    const deleted = await db.transaction(async (tx) => {
      return await deleteAgentInTransaction(tx, deleteArgs);
    });
    assert.equal(deleted.kind, "deleted");
    const sequences = await db
      .select()
      .from(chatEventSequences)
      .where(eq(chatEventSequences.chatThreadId, f.threadId));
    assert.equal(sequences.length, 0);
  });

  await test("a retained control lock causes bounded deletion retries without blocking event FK checks", async () => {
    const f = await fixture("running");
    const control = new Client({ connectionString: databaseUrl.toString() });
    await control.connect();
    try {
      await control.query("BEGIN");
      await control.query(
        "SELECT id FROM chat_threads WHERE id = $1 FOR NO KEY UPDATE",
        [f.threadId],
      );
      const args = { threadId: f.threadId, userId: f.userId, orgId: f.orgId };
      await assert.rejects(
        deleteChatThreadContent(db, args, signal),
        (error: unknown) => {
          return safeSqlStateCode(error) === "55P03";
        },
      );
      assert.ok(
        await insertChatEvent(
          db,
          {
            chatThreadId: f.threadId,
            runId: f.runId,
            eventType: "output.message",
            content: "The failed deletion released its child locks",
          },
          "none",
          { splitWrites: true },
        ),
      );
      await control.query("COMMIT");
      assert.equal(
        (await deleteChatThreadContent(db, args, signal)).deleted,
        true,
      );
    } finally {
      await control.query("ROLLBACK");
      await control.end();
    }
  });

  await test("strong deletion still rejects a run attachment that arrives after active-run capture", async () => {
    const f = await fixture("running");
    const [existingRun] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId));
    assert.ok(existingRun);
    const barrier = new Client({ connectionString: databaseUrl.toString() });
    await barrier.connect();
    const lockKey = 29_384_622;
    await barrier.query("BEGIN");
    await barrier.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
    await pool.query(
      `CREATE FUNCTION pause_thread_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${f.threadId}'::uuid THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN OLD; END $$; CREATE TRIGGER pause_thread_deletion BEFORE DELETE ON chat_threads FOR EACH ROW EXECUTE FUNCTION pause_thread_deletion()`,
    );
    let deletionSettled = false;
    const deletion = settleIncludingAbort(
      deleteChatThreadContent(
        db,
        {
          threadId: f.threadId,
          userId: f.userId,
          orgId: f.orgId,
        },
        signal,
      ),
    ).then((result) => {
      deletionSettled = true;
      return result;
    });
    let attachment: ReturnType<typeof settleIncludingAbort> | undefined;
    try {
      await waitForBlockedQuery('delete from "chat_threads"', () => {
        return deletionSettled;
      });
      let attachmentSettled = false;
      attachment = settleIncludingAbort(
        db.insert(agentRuns).values({
          id: randomUUID(),
          userId: f.userId,
          orgId: f.orgId,
          sessionId: existingRun.sessionId,
          status: "running",
          prompt: "Late attachment must fail",
          triggerSource: "web",
          autonomyBudget: 10,
          chatThreadId: f.threadId,
        }),
      ).then((result) => {
        attachmentSettled = true;
        return result;
      });
      await waitForBlockedQuery('insert into "agent_runs"', () => {
        return attachmentSettled;
      });
    } finally {
      await barrier.query("ROLLBACK");
      await Promise.all([deletion, attachment]);
      await barrier.end();
      await pool.query(
        "DROP TRIGGER pause_thread_deletion ON chat_threads; DROP FUNCTION pause_thread_deletion()",
      );
    }
    const deleted = await deletion;
    assert.ok(deleted.ok && deleted.value.deleted);
    assert.deepEqual(deleted.value.activeRuns, [
      { runId: f.runId, orgId: f.orgId },
    ]);
    const attached = await attachment;
    assert.ok(
      attached && !attached.ok && safeSqlStateCode(attached.error) === "23503",
    );
  });

  await test("a timeout winning the run-row arbitration prevents the prepared output append", async () => {
    const f = await fixture("running");
    const blocker = new Client({ connectionString: databaseUrl.toString() });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE agent_runs SET status = 'timeout' WHERE id = $1",
        [f.runId],
      );
      let outputSettled = false;
      const pending = materializeRunOutputEvents(
        db,
        {
          diagnostics: new RunOutputDiagnostics(),
          suppliedCitations: [],
          payload: {
            runId: f.runId,
            context: { userId: f.userId, orgId: f.orgId },
            events: [
              {
                type: "item.completed",
                sequenceNumber: 0,
                item: {
                  id: "timeout_output",
                  type: "agent_message",
                  text: "Must remain absent",
                },
              },
            ],
          },
        },
        signal,
      ).then(
        (value) => {
          outputSettled = true;
          return { value };
        },
        (error: unknown) => {
          outputSettled = true;
          return { error };
        },
      );
      // Observe a real waiter on this test's blocker; do not guess a sleep.
      let blocked = false;
      while (!blocked && !outputSettled) {
        const state = await blocker.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS blocked",
          [applicationName],
        );
        blocked = state.rows[0]?.blocked === true;
        if (!blocked) {
          await setImmediate();
        }
      }
      assert.ok(
        blocked,
        "prepared output must arbitrate with the terminal transition",
      );
      await blocker.query("COMMIT");
      assert.deepEqual(await pending, {
        value: { outcome: "ignored-timeout" },
      });
      const [events] = await db
        .select({ count: count() })
        .from(chatEvents)
        .where(eq(chatEvents.runId, f.runId));
      assert.equal(events?.count, 0);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });
} finally {
  suiteController.abort();
  await flushWaitUntilForTest();
  await flushAxiom();
  await flushLogs();
  await pool.end();
  await Promise.all(poolClientClosures);
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
