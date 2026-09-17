import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { executeRawRows } from "../../../lib/db-raw-rows";
import { nowDate } from "../../../lib/time";
import {
  clearChatThreadProvenanceFixture,
  holdAgentOwnerTransferFixture,
  holdChatThreadReadBarrierFixture,
  holdMorningBriefExclusionWriteFixture,
  readChatThreadProvenanceFixture,
  readMorningBriefBindingThreadFixture,
  seedFinishedChatRunFixture$,
  seedMorningBriefChatMemberFixture,
  seedOrdinaryChatThreadFixture$,
  startActiveChatRunFixture$,
  uninstallMorningBriefFixture,
  type MorningBriefChatMember,
} from "../../../test-fixtures/morning-brief-chat-collection";
import { holdChatEventQueueAdmissionLockFixture } from "../../../test-fixtures/chat-events";
import { admitWorkflowAutomationEventFixture } from "../../../test-fixtures/workflow-queue";
import { writeDb$ } from "../../external/db";
import { settle } from "../../utils";
import { updateFeatureSwitchesForUser } from "../../routes/__tests__/helpers/feature-switches";
import { seedOrgMembership$ } from "../../routes/__tests__/helpers/org-membership";
import { collectMorningBriefChat$ } from "../morning-brief-chat-collection.service";
import { ensureWorkflowUserAutomationThread } from "../workflow-user-automation-thread.service";

/**
 * The persisted boundaries of Morning Brief thread provenance and unread Chat
 * collection.
 *
 * The route suite owns every case an HTTP caller can construct. This suite owns
 * the ones it cannot: the exact commit orders of a classification change and a
 * collection, an Agent transfer arriving mid-read, and the producer paths that
 * only a workflow admission or binding reaches. Every case here uses real
 * suspended PostgreSQL transactions and `pg_blocking_pids`; none of them sleeps
 * or substitutes a stubbed service for the race.
 */
describe("Morning Brief unread Chat collection boundaries", () => {
  const context = testContext();
  const store = createStore();
  const statementSchema = z.object({ query: z.string() });

  /** The statement a proven-blocked backend is waiting on. */
  async function activeStatement(pid: number): Promise<string> {
    const rows = await executeRawRows(
      db(),
      sql`SELECT query FROM pg_stat_activity WHERE pid = ${pid}::int`,
      statementSchema,
    );
    const [row] = rows;
    if (!row) {
      throw new Error("Missing blocked backend statement");
    }
    return row.query.toLowerCase();
  }

  async function seedCollectableMember(): Promise<{
    readonly member: MorningBriefChatMember;
    readonly workflowId: string;
    readonly automationId: string;
    readonly threadId: string;
  }> {
    const member = await seedMorningBriefChatMemberFixture();
    // Collection admits and releases on the member's live Clerk generation, not
    // on the durable row request authentication can answer from, and it admits
    // on the same default-off implementation switch the route gates with.
    await store.set(
      seedOrgMembership$,
      { orgId: member.orgId, userId: member.userId },
      context.signal,
    );
    await updateFeatureSwitchesForUser(context, member, {
      [FeatureSwitchKey.SimpleMorningBrief]: true,
    });
    const threadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      { member },
      context.signal,
    );
    await store.set(
      seedFinishedChatRunFixture$,
      {
        chatThreadId: threadId,
        prompt: "billing rollout status",
        reply: "The invoice migration is blocked.",
      },
      context.signal,
    );
    return {
      member,
      workflowId: member.workflowId,
      automationId: member.automationId,
      threadId,
    };
  }

  function collect(member: MorningBriefChatMember) {
    return store.set(
      collectMorningBriefChat$,
      { owner: member, scheduledFor: nowDate() },
      context.signal,
    );
  }

  it("discards the whole thread when a Brief admission wins the read boundary", async () => {
    const { member, threadId } = await seedCollectableMember();
    // The exclusion write is committed by nobody yet: the classification is
    // staged inside a suspended transaction that owns the thread row.
    const held = await holdMorningBriefExclusionWriteFixture(
      { chatThreadId: threadId, userId: member.userId },
      context.signal,
    );

    const collection = collect(member);
    const waiterPid = await held.waitForBlocked();
    // Proof that the collection queued behind the classification change rather
    // than reading around it: `FOR KEY SHARE` would not conflict here at all.
    await expect(activeStatement(waiterPid)).resolves.toContain(
      "for no key update",
    );

    await held.release();
    const result = await collection;

    expect(result).toMatchObject({
      kind: "collected",
      collection: {
        result: "no-eligible-content",
        items: [],
        skipped: [{ threadId, reason: "morning_brief_thread" }],
      },
    });
  }, 60_000);

  it("releases pre-admission content of the same thread when the read wins", async () => {
    const { member, threadId, automationId } = await seedCollectableMember();
    // The real admission transaction takes the queue lock as its first
    // statement, before it can reach the thread row, so holding that lock
    // suspends a genuine Brief admission — for this exact unread thread —
    // ahead of its classification write. Both sides therefore meet on one row
    // rather than on two unrelated threads.
    const queueLock = await holdChatEventQueueAdmissionLockFixture({
      threadId,
      signal: context.signal,
    });
    const admission = settle(
      admitWorkflowAutomationEventFixture({
        automationId,
        chatThreadId: threadId,
        triggerBrief: "brief-admission-loses",
      }),
    );
    await expect
      .poll(async () => {
        return await queueLock.directWaiterCount();
      })
      .toBeGreaterThan(0);
    await expect(readChatThreadProvenanceFixture(threadId)).resolves.toBe(
      "ordinary",
    );

    const result = await collect(member);

    expect(result).toMatchObject({
      kind: "collected",
      collection: { result: "collected" },
    });
    if (result.kind !== "collected") {
      throw new Error("Expected a collected envelope");
    }
    const [item] = result.collection.items;
    expect(item?.threadId).toBe(threadId);
    // Pre-admission content of the contested thread, not a neighbour's.
    expect(
      item?.excerpts.map((excerpt) => {
        return excerpt.text;
      }),
    ).toStrictEqual([
      "billing rollout status",
      "The invoice migration is blocked.",
    ]);

    queueLock.release();
    await admission;
    await queueLock.done;
    // The admission that lost the boundary still committed its exclusion on
    // that same thread, so no later collection can release it again.
    await expect(readChatThreadProvenanceFixture(threadId)).resolves.toBe(
      "morning_brief",
    );
    const afterwards = await collect(member);
    expect(afterwards).toMatchObject({
      kind: "collected",
      collection: { items: [] },
    });
  }, 60_000);

  it("abandons a thread whose Run starts after it was selected", async () => {
    const { member, threadId } = await seedCollectableMember();
    const barrier = await holdChatThreadReadBarrierFixture(
      threadId,
      context.signal,
    );

    const collection = collect(member);
    await barrier.waitForBlocked();
    // A Run row takes only the foreign key's `KEY SHARE` on the thread, so it
    // commits while the collection is still queued for the row.
    await store.set(startActiveChatRunFixture$, threadId, context.signal);
    await barrier.release();
    const result = await collection;

    expect(result).toMatchObject({
      kind: "collected",
      collection: {
        items: [],
        skipped: [{ threadId, reason: "active_run" }],
      },
    });
  }, 60_000);

  it("abandons a thread whose Agent ownership transfers during the read", async () => {
    const { member, threadId } = await seedCollectableMember();
    const held = await holdAgentOwnerTransferFixture(
      { agentId: member.agentId, nextOwner: `user_${randomUUID()}` },
      context.signal,
    );

    const collection = collect(member);
    const waiterPid = await held.waitForBlocked();
    await expect(activeStatement(waiterPid)).resolves.toContain(
      "for key share",
    );
    await held.release();
    const result = await collection;

    expect(result).toMatchObject({
      kind: "collected",
      collection: {
        items: [],
        skipped: [{ threadId, reason: "thread_unavailable" }],
      },
    });
  }, 60_000);

  it("keeps the Morning Brief exclusion through uninstall and later conversation", async () => {
    const member = await seedMorningBriefChatMemberFixture();
    const destination = await store.set(writeDb$).transaction(async (tx) => {
      return await ensureWorkflowUserAutomationThread(tx, {
        orgId: member.orgId,
        userId: member.userId,
        workflowId: member.workflowId,
        agentId: member.agentId,
        workflowTitle: "Okou Morning Brief",
        currentTime: nowDate(),
      });
    });
    await expect(readChatThreadProvenanceFixture(destination)).resolves.toBe(
      "morning_brief",
    );

    // Reusing the binding keeps the classification; so does deleting every
    // workflow row the binding hangs from.
    const reused = await store.set(writeDb$).transaction(async (tx) => {
      return await ensureWorkflowUserAutomationThread(tx, {
        orgId: member.orgId,
        userId: member.userId,
        workflowId: member.workflowId,
        agentId: member.agentId,
        workflowTitle: "Renamed brief",
        currentTime: nowDate(),
      });
    });
    expect(reused).toBe(destination);
    await uninstallMorningBriefFixture(member.workflowId);
    await expect(
      readMorningBriefBindingThreadFixture({
        orgId: member.orgId,
        userId: member.userId,
        workflowId: member.workflowId,
      }),
    ).resolves.toBeNull();
    await store.set(
      seedFinishedChatRunFixture$,
      {
        chatThreadId: destination,
        prompt: "ordinary follow-up in the brief thread",
        reply: "ordinary answer",
      },
      context.signal,
    );

    await expect(readChatThreadProvenanceFixture(destination)).resolves.toBe(
      "morning_brief",
    );
  }, 60_000);

  it("adopts an already excluded thread rather than upgrading it on replay", async () => {
    const member = await seedMorningBriefChatMemberFixture();
    const threadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      { member },
      context.signal,
    );
    await clearChatThreadProvenanceFixture(threadId);

    // The scheduler bypasses thread creation when the binding already has a
    // thread, so admission is the only place this classification can happen.
    await db().execute(sql`
      UPDATE workflow_user_automation_threads
      SET chat_thread_id = ${threadId}
      WHERE workflow_id = ${member.workflowId}
    `);
    await admitWorkflowAutomationEventFixture({
      automationId: member.automationId,
      chatThreadId: threadId,
      triggerBrief: "poller-bypass",
    });

    await expect(readChatThreadProvenanceFixture(threadId)).resolves.toBe(
      "morning_brief",
    );
  }, 60_000);

  it("never classifies another member's thread from a replayed admission", async () => {
    const member = await seedMorningBriefChatMemberFixture();
    const neighbour = await seedMorningBriefChatMemberFixture({
      orgId: member.orgId,
    });
    const neighbourThread = await store.set(
      seedOrdinaryChatThreadFixture$,
      { member: neighbour },
      context.signal,
    );

    await admitWorkflowAutomationEventFixture({
      automationId: member.automationId,
      chatThreadId: neighbourThread,
      triggerBrief: "foreign-thread",
    });

    // The admission belongs to `member`, and the thread belongs to someone
    // else, so the owner-scoped write matches no row.
    await expect(
      readChatThreadProvenanceFixture(neighbourThread),
    ).resolves.toBe("ordinary");
  }, 60_000);

  it("reports every unread candidate it could not inspect", async () => {
    const { member } = await seedCollectableMember();
    const unknownThread = await store.set(
      seedOrdinaryChatThreadFixture$,
      { member },
      context.signal,
    );
    await store.set(
      seedFinishedChatRunFixture$,
      {
        chatThreadId: unknownThread,
        prompt: "historical prompt",
        reply: "historical reply",
      },
      context.signal,
    );
    await clearChatThreadProvenanceFixture(unknownThread);

    const result = await collect(member);

    if (result.kind !== "collected") {
      throw new Error("Expected a collected envelope");
    }
    expect(result.collection.coverage).toBe("partial");
    expect(result.collection.skipped).toStrictEqual([
      { threadId: unknownThread, reason: "unknown_thread_provenance" },
    ]);
    expect(result.collection.items).toHaveLength(1);
  }, 60_000);
});
