import "./env";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { chatContentErasureSubjects } from "@okouai/db/schema/chat-content-erasure-subject";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import {
  chatThreadEvents,
  chatThreadEventSequences,
} from "@okouai/db/schema/chat-thread-event";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatEventWriteControl } from "@okouai/db/schema/chat-event-write-control";
import { completeChatContentDeletion } from "@okouai/db/operations/chat-content-erasure";
import { insertChatEvent } from "../../src/signals/services/chat-event.service";
import { clearThreadDraftIndependently } from "../../src/signals/services/chat-event-write-side-effects.service";
import { touchChatThreadLastMessageAtIndependently } from "../../src/signals/services/chat-event-shared.service";
import {
  cleanupLateChatContent,
  sweepLateChatContent,
} from "../../src/signals/services/chat-content-erasure-cleanup.service";
import { flushLogs } from "../../src/lib/log";
import { flushWaitUntilForTest } from "../../src/signals/context/wait-until";

// PostgreSQL failure injection is an infrastructure boundary; own a migrated
// database and invoke real production writes. Only telemetry leaves the process.
assert.ok(process.env.DATABASE_URL);
const base = new URL(process.env.DATABASE_URL);
assert.ok(["127.0.0.1", "localhost", "postgres"].includes(base.hostname));
const databaseName = `chat_aux_${randomUUID().replaceAll("-", "")}`;
const url = new URL(base);
url.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: base.toString() });
const pool = new Pool({
  connectionString: url.toString(),
  options: "-c lock_timeout=1000 -c statement_timeout=5000",
});
const db = drizzle(pool);
const telemetry = setupServer(
  http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
    return HttpResponse.json({ ingested: 1, failed: 0, processedBytes: 1 });
  }),
);
telemetry.listen({ onUnhandledRequest: "error" });
const document = {
  version: 1 as const,
  parts: [{ type: "text" as const, text: "Synthetic message" }],
};
const signal = AbortSignal.timeout(120_000);

async function fixture() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const agentId = randomUUID();
  const threadId = randomUUID();
  await db
    .insert(agents)
    .values({ id: agentId, name: agentId, owner: userId, orgId });
  await db
    .insert(chatThreads)
    .values({ id: threadId, userId, agentId, draftUserMessage: document });
  await db
    .insert(chatThreadDrafts)
    .values({ chatThreadId: threadId, draftUserMessage: document });
  const append = async () => {
    return await insertChatEvent(db, {
      chatThreadId: threadId,
      eventType: "input.prompt",
      userMessage: document,
      contextType: "web",
    });
  };
  return { threadId, userId, orgId, append };
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await promisify(execFile)("node", ["--import", "tsx", "scripts/migrate.ts"], {
    cwd: fileURLToPath(new URL("../../../../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url.toString() },
    maxBuffer: 20 * 1024 * 1024,
  });
  await db
    .update(chatEventWriteControl)
    .set({ activatedAt: new Date() })
    .where(eq(chatEventWriteControl.id, "global"));

  await test("draft failures preserve the committed message and do not suppress later writes", async () => {
    const f = await fixture();
    await pool.query(`CREATE FUNCTION fail_draft_clear() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${f.threadId}' AND NEW.draft_user_message IS NULL AND OLD.draft_user_message IS NOT NULL
        THEN RAISE EXCEPTION 'synthetic draft clear fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_draft_clear BEFORE UPDATE ON chat_threads FOR EACH ROW EXECUTE FUNCTION fail_draft_clear()`);
    const event = await f.append();
    assert.ok(event);
    await clearThreadDraftIndependently(db, f);
    const touchedAt = new Date("2030-01-01T00:00:00Z");
    await touchChatThreadLastMessageAtIndependently(
      db,
      f.threadId,
      touchedAt,
      undefined,
      f,
    );
    assert.equal(
      (await db.select().from(chatEvents).where(eq(chatEvents.id, event.id)))
        .length,
      1,
    );
    const [legacy] = await db
      .select({
        draft: chatThreads.draftUserMessage,
        at: chatThreads.lastMessageAt,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, f.threadId));
    const [child] = await db
      .select()
      .from(chatThreadDrafts)
      .where(eq(chatThreadDrafts.chatThreadId, f.threadId));
    assert.deepEqual(legacy?.draft, document);
    assert.equal(child?.draftUserMessage, null);
    assert.equal(legacy?.at?.toISOString(), touchedAt.toISOString());
    assert.equal(
      (
        await db
          .select()
          .from(chatThreadEvents)
          .where(eq(chatThreadEvents.chatThreadId, f.threadId))
      ).length,
      1,
    );
    await pool.query(
      "DROP TRIGGER fail_draft_clear ON chat_threads; DROP FUNCTION fail_draft_clear()",
    );
  });

  await test("timestamp failure still attempts sort; sort failure keeps timestamp and committed input", async () => {
    const f = await fixture();
    const event = await f.append();
    assert.ok(event);
    await pool.query(`CREATE FUNCTION fail_thread_touch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${f.threadId}' THEN RAISE EXCEPTION 'synthetic timestamp fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_thread_touch BEFORE UPDATE OF last_message_at ON chat_threads FOR EACH ROW EXECUTE FUNCTION fail_thread_touch()`);
    await touchChatThreadLastMessageAtIndependently(
      db,
      f.threadId,
      new Date("2030-01-02T00:00:00Z"),
      undefined,
      f,
    );
    assert.equal(
      (
        await db
          .select()
          .from(chatThreadEvents)
          .where(eq(chatThreadEvents.chatThreadId, f.threadId))
      ).length,
      1,
    );
    await pool.query(
      "DROP TRIGGER fail_thread_touch ON chat_threads; DROP FUNCTION fail_thread_touch()",
    );
    await pool.query(`CREATE FUNCTION fail_sort_touch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.chat_thread_id = '${f.threadId}' THEN RAISE EXCEPTION 'synthetic sort fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_sort_touch BEFORE INSERT ON chat_thread_events FOR EACH ROW EXECUTE FUNCTION fail_sort_touch()`);
    const newest = new Date("2030-01-03T00:00:00Z");
    await touchChatThreadLastMessageAtIndependently(
      db,
      f.threadId,
      newest,
      undefined,
      f,
    );
    const [thread] = await db
      .select({ at: chatThreads.lastMessageAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, f.threadId));
    assert.equal(thread?.at?.toISOString(), newest.toISOString());
    assert.equal(
      (await db.select().from(chatEvents).where(eq(chatEvents.id, event.id)))
        .length,
      1,
    );
    await pool.query(
      "DROP TRIGGER fail_sort_touch ON chat_thread_events; DROP FUNCTION fail_sort_touch()",
    );
  });

  await test("completed deletion catches late rows after its local job is absent, without touching survivors", async () => {
    for (const subjectKind of ["user", "organization"] as const) {
      const erased = await fixture();
      const survivor = await fixture();
      const subject = {
        subjectKind,
        subjectId: subjectKind === "user" ? erased.userId : erased.orgId,
      };
      await erased.append();
      assert.equal(
        await cleanupLateChatContent(db, subject, signal),
        0,
        "absence of confirmed deletion grants no cleanup authority",
      );
      await db
        .delete(chatEvents)
        .where(eq(chatEvents.chatThreadId, erased.threadId));
      await completeChatContentDeletion(db, {
        ...subject,
        sourceReference: randomUUID(),
      });
      // No job row exists: the durable receipt deliberately outlives retirement.
      await erased.append();
      await survivor.append();
      await db.insert(chatSlackContext).values({
        chatThreadId: erased.threadId,
        publicBrand: "okou",
        conversationContext: "Synthetic late history",
      });
      await touchChatThreadLastMessageAtIndependently(
        db,
        erased.threadId,
        new Date(),
        undefined,
        erased,
      );
      assert.ok((await cleanupLateChatContent(db, subject, signal)) >= 3);
      assert.equal(
        (
          await db
            .select()
            .from(chatEvents)
            .where(eq(chatEvents.chatThreadId, erased.threadId))
        ).length,
        0,
      );
      assert.equal(
        (
          await db
            .select()
            .from(chatSlackContext)
            .where(eq(chatSlackContext.chatThreadId, erased.threadId))
        ).length,
        0,
      );
      assert.equal(
        (
          await db
            .select()
            .from(chatEventSequences)
            .where(eq(chatEventSequences.chatThreadId, erased.threadId))
        ).length,
        0,
      );
      assert.equal(
        (
          await db
            .select()
            .from(chatEvents)
            .where(eq(chatEvents.chatThreadId, survivor.threadId))
        ).length,
        1,
      );
      assert.equal(
        (
          await db
            .select()
            .from(chatThreadEventSequences)
            .where(eq(chatThreadEventSequences.userId, erased.userId))
        ).length,
        0,
      );
      assert.equal(await cleanupLateChatContent(db, subject, signal), 0);
    }
  });
  await test("periodic sweep reconciles completed old jobs and revisits late writes after retirement", async () => {
    const erased = await fixture();
    const survivor = await fixture();
    await erased.append();
    await survivor.append();
    const jobId = randomUUID();
    await db.insert(backgroundJobs).values({
      id: jobId,
      kind: "clerk-user-deletion",
      handlerVersion: 1,
      userId: erased.userId,
      orgId: "",
      input: {},
      status: "completed",
      completedAt: new Date(),
    });
    const first = await sweepLateChatContent(db, signal);
    assert.ok(first.deleted >= 2);
    const [receipt] = await db
      .select()
      .from(chatContentErasureSubjects)
      .where(eq(chatContentErasureSubjects.subjectId, erased.userId));
    assert.ok(receipt?.completedAt);
    await db.delete(backgroundJobs).where(eq(backgroundJobs.id, jobId));
    await erased.append();
    await db
      .update(chatContentErasureSubjects)
      .set({ nextSweepAt: new Date(0) })
      .where(eq(chatContentErasureSubjects.subjectId, erased.userId));
    const second = await sweepLateChatContent(db, signal);
    assert.ok(second.deleted >= 2);
    assert.equal(
      (
        await db
          .select()
          .from(chatEvents)
          .where(eq(chatEvents.chatThreadId, erased.threadId))
      ).length,
      0,
    );
    assert.equal(
      (
        await db
          .select()
          .from(chatEvents)
          .where(eq(chatEvents.chatThreadId, survivor.threadId))
      ).length,
      1,
    );
  });
} finally {
  await flushWaitUntilForTest();
  await flushLogs();
  telemetry.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
