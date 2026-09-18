import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, asc, eq, sql } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { userCache } from "@okouai/db/schema/user-cache";
import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import { users } from "@okouai/db/schema/user";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";

import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import { holdDeferredRow } from "./pi-deferred-lock";
import { nowDate } from "../lib/time";
import { deleteChatThread$ } from "../signals/services/chat-thread.service";
import { drainEmailOutboxItems$ } from "../signals/services/email-common.service";
import { revokeMorningBriefDeliveryOwnership } from "../signals/services/morning-brief-delivery.service";

/**
 * Owner-scoped infrastructure for native Morning Brief delivery tests.
 *
 * The delivery suite asserts external behavior through the real preview routes
 * and the real Resend boundary. What it cannot express through an endpoint is
 * the state those routes are supposed to leave behind, and the lifecycle
 * transactions that no HTTP surface exposes — Agent and thread deletion, the
 * shared outbox drain, and owner revocation. Those live here rather than in the
 * suite, which keeps the route tests on the external-behavior boundary.
 *
 * Every read and write below is scoped to one owner, one thread or one outbox
 * row supplied by the caller, so concurrent suites never observe or disturb
 * each other's rows.
 */

const store = createStore();

interface DeliveryOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** Give this member a cached address, the only source delivery will read. */
export async function seedMemberEmailAddress(
  userId: string,
  email: string,
): Promise<void> {
  await db()
    .insert(userCache)
    .values({ userId, email, name: "Test Member", cachedAt: nowDate() })
    .onConflictDoNothing();
}

/** True when the member still has no cached address at all. */
export async function memberEmailAddressIsAbsent(
  userId: string,
): Promise<boolean> {
  const rows = await db()
    .select({ userId: userCache.userId })
    .from(userCache)
    .where(eq(userCache.userId, userId));
  return rows.length === 0;
}

export async function suppressEmailAddress(address: string): Promise<void> {
  await db()
    .insert(emailSuppressions)
    .values({ emailAddress: address, reason: "bounce" })
    .onConflictDoNothing();
}

export async function unsubscribeMember(userId: string): Promise<void> {
  await db()
    .insert(users)
    .values({ id: userId, emailUnsubscribed: true })
    .onConflictDoUpdate({
      target: users.id,
      set: { emailUnsubscribed: true },
    });
}

interface MorningBriefDeliveryRow {
  readonly chatThreadId: string;
  readonly chatEventId: string;
  readonly emailResolution: string;
  readonly emailOutboxId: string | null;
  readonly executionPurpose: string;
  readonly workflowId: string;
  readonly automationId: string;
}

/** Every delivery this owner holds, for identity and dedupe assertions. */
export async function readMorningBriefDeliveries(
  owner: DeliveryOwner,
): Promise<readonly MorningBriefDeliveryRow[]> {
  return await db()
    .select({
      chatThreadId: morningBriefDeliveries.chatThreadId,
      chatEventId: morningBriefDeliveries.chatEventId,
      emailResolution: morningBriefDeliveries.emailResolution,
      emailOutboxId: morningBriefDeliveries.emailOutboxId,
      executionPurpose: morningBriefDeliveries.executionPurpose,
      workflowId: morningBriefDeliveries.workflowId,
      automationId: morningBriefDeliveries.automationId,
    })
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, owner.orgId),
        eq(morningBriefDeliveries.userId, owner.userId),
      ),
    )
    .orderBy(asc(morningBriefDeliveries.createdAt));
}

interface EmailOutboxRow {
  readonly id: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly resendId: string | null;
  readonly providerIdempotencyKey: string | null;
  readonly providerRequest: unknown;
  readonly toAddresses: unknown;
  readonly template: unknown;
}

export async function readEmailOutboxRow(
  itemId: string,
): Promise<EmailOutboxRow | undefined> {
  const [row] = await db()
    .select({
      id: emailOutbox.id,
      status: emailOutbox.status,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
      resendId: emailOutbox.resendId,
      providerIdempotencyKey: emailOutbox.providerIdempotencyKey,
      providerRequest: emailOutbox.providerRequest,
      toAddresses: emailOutbox.toAddresses,
      template: emailOutbox.template,
    })
    .from(emailOutbox)
    .where(eq(emailOutbox.id, itemId));
  return row;
}

/** The outbox intents this owner's deliveries currently point at. */
export async function readMorningBriefDeliveryOutbox(
  owner: DeliveryOwner,
): Promise<readonly EmailOutboxRow[]> {
  const deliveries = await readMorningBriefDeliveries(owner);
  const rows: EmailOutboxRow[] = [];
  for (const delivery of deliveries) {
    if (delivery.emailOutboxId === null) {
      continue;
    }
    const row = await readEmailOutboxRow(delivery.emailOutboxId);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

interface ChatThreadMessage {
  readonly id: string;
  readonly eventType: string;
  readonly runId: string | null;
  readonly content: string | null;
  readonly createdAt: Date;
}

/** One thread's canonical events, in committed order. */
export async function readChatThreadEvents(
  chatThreadId: string,
): Promise<readonly ChatThreadMessage[]> {
  const rows = await db()
    .select({
      id: chatEvents.id,
      eventType: chatEvents.eventType,
      runId: chatEvents.runId,
      payload: chatEvents.payload,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(eq(chatEvents.chatThreadId, chatThreadId))
    .orderBy(asc(chatEvents.seqId));
  return rows.map((row) => {
    const payload = row.payload as { readonly content?: string } | null;
    return {
      id: row.id,
      eventType: row.eventType,
      runId: row.runId,
      content: payload?.content ?? null,
      createdAt: row.createdAt,
    };
  });
}

interface ChatThreadState {
  readonly userId: string;
  readonly agentId: string | null;
  readonly provenance: string | null;
  readonly lastMessageAt: Date | null;
}

export async function readChatThreadState(
  chatThreadId: string,
): Promise<ChatThreadState | undefined> {
  const [row] = await db()
    .select({
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
      provenance: chatThreads.provenance,
      lastMessageAt: chatThreads.lastMessageAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId));
  return row;
}

/**
 * One unrelated producer's queued mail, so a native failure can be shown not to
 * stall the shared queue.
 */
export async function seedUnrelatedEmailIntent(
  toAddress: string,
): Promise<string> {
  const [row] = await db()
    .insert(emailOutbox)
    .values({
      fromAddress: "Okou <okou@mail.okou.test>",
      toAddresses: toAddress,
      subject: "unrelated",
      template: {
        template: "data-export-ready",
        props: {
          downloadUrl: "https://x.test",
          expiresAt: "",
          artifactCount: 0,
        },
      },
      status: "pending",
      attempts: 0,
    })
    .returning({ id: emailOutbox.id });
  if (!row) {
    throw new Error("Unrelated email intent was not created");
  }
  return row.id;
}

/** Let a `sending` row's recovery lease elapse without touching its payload. */
export async function elapseEmailOutboxRecoveryLease(
  itemId: string,
): Promise<void> {
  await db()
    .update(emailOutbox)
    .set({ nextRetryAt: new Date(nowDate().getTime() - 1000) })
    .where(eq(emailOutbox.id, itemId));
}

/**
 * Age one queued intent, which is what fixes its position in the drain's FIFO
 * order and, far enough back, its original 15-minute lifetime.
 *
 * `created_at` is the only input to both, and no producer endpoint can choose
 * it: a real backlog is made by waiting. Only the row id the caller owns is
 * touched.
 */
export async function ageEmailOutboxItem(
  itemId: string,
  ageMs: number,
): Promise<void> {
  await db()
    .update(emailOutbox)
    .set({ createdAt: new Date(nowDate().getTime() - ageMs) })
    .where(eq(emailOutbox.id, itemId));
}

/**
 * Leave one queued intent with its delivery attempts already spent, the state a
 * row reaches after the drain has failed it as many times as it allows.
 */
export async function spendEmailOutboxAttempts(
  itemId: string,
  attempts: number,
): Promise<void> {
  await db()
    .update(emailOutbox)
    .set({ attempts })
    .where(eq(emailOutbox.id, itemId));
}

/** Remove native provenance while leaving its mail queued. */
export async function discardMorningBriefDeliveries(
  owner: DeliveryOwner,
): Promise<void> {
  await db()
    .delete(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, owner.orgId),
        eq(morningBriefDeliveries.userId, owner.userId),
      ),
    );
}

/** The member-scoped owner revocation a cleanup transaction performs. */
export async function revokeMemberMorningBriefDeliveries(
  owner: DeliveryOwner,
): Promise<void> {
  await db().transaction(async (tx) => {
    await revokeMorningBriefDeliveryOwnership(tx, {
      kind: "membership",
      orgId: owner.orgId,
      userId: owner.userId,
    });
  });
}

/** The real owned thread deletion, including its own cleanup transaction. */
export async function deleteOwnedChatThread(
  args: {
    readonly threadId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await store.set(deleteChatThread$, args, signal);
}

/** Drain exactly these outbox rows through the real shared worker. */
export async function drainEmailOutbox(
  itemIds: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  return await store.set(
    drainEmailOutboxItems$,
    { currentTimeMs: nowDate().getTime(), itemIds },
    signal,
  );
}

/**
 * Hold this owner's durable member row, the first lock a delivery takes.
 *
 * `waitForBlocked` resolves once some session is actually waiting on it, so a
 * caller starts the request it wants to suspend **before** awaiting that — the
 * barrier observes a real lock wait rather than a sleep.
 */
export async function holdDeliveryOwnerRow(
  owner: DeliveryOwner,
  signal: AbortSignal,
): Promise<{
  readonly waitForBlocked: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM org_members_metadata
          WHERE org_id = ${owner.orgId} AND user_id = ${owner.userId}
          FOR UPDATE`,
    );
  });
  onTestFinished(held.release);
  return { waitForBlocked: held.waitForBlocked, release: held.release };
}

/**
 * Hold this owner's installation Agent row, which Chat delivery takes before
 * the automation and the native drain takes before its own automation lock.
 *
 * Both of them contending on this one row is what proves they share an order:
 * neither can be holding the automation while it waits here.
 */
export async function holdDeliveryAgentRow(
  agentId: string,
  signal: AbortSignal,
): Promise<{
  readonly waitForBlocked: () => Promise<number>;
  readonly release: () => Promise<void>;
}> {
  const held = await holdDeferredRow(signal, async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM agents WHERE id = ${agentId}::uuid FOR UPDATE`,
    );
  });
  onTestFinished(held.release);
  return { waitForBlocked: held.waitForBlocked, release: held.release };
}

/** Move one generation's retention deadline to an exact instant. */
export async function setGenerationExpiry(
  owner: DeliveryOwner,
  expiresAt: Date,
): Promise<void> {
  await db()
    .update(morningBriefGenerations)
    .set({ expiresAt })
    .where(
      and(
        eq(morningBriefGenerations.orgId, owner.orgId),
        eq(morningBriefGenerations.userId, owner.userId),
      ),
    );
}

/** Remove the generation rows outright, as the real retention sweep does. */
export async function sweepGenerations(owner: DeliveryOwner): Promise<void> {
  await db()
    .delete(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, owner.orgId),
        eq(morningBriefGenerations.userId, owner.userId),
      ),
    );
}

/** The canonical thread this member's Morning Brief installation is bound to. */
export async function readBoundChatThreadId(
  workflowId: string,
): Promise<string | null> {
  const [row] = await db()
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(eq(workflowUserAutomationThreads.workflowId, workflowId));
  return row?.chatThreadId ?? null;
}

/**
 * Fail this owner's delivery row insert, the last write the transaction makes.
 *
 * No product input can reject one specific write inside the delivery
 * transaction, so the fault is injected at the row itself. The trigger matches
 * only this owner's organization, so a concurrent suite is never affected.
 */
export async function rejectMorningBriefDeliveryInsert(
  orgId: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const functionName = `test_mb_delivery_insert_${randomUUID().replaceAll("-", "")}`;
  // The trigger carries the owner in its own name, so the function body needs
  // no parameter: a bind placeholder inside a function body would be stored as
  // literal text rather than substituted.
  const triggerName = orgId;
  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.org_id = TG_NAME THEN
          RAISE EXCEPTION 'Test Morning Brief delivery insert failed'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE INSERT ON morning_brief_deliveries
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
    signal.throwIfAborted();
  });

  let dropped = false;
  const drop = async () => {
    if (dropped) {
      return;
    }
    dropped = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON morning_brief_deliveries`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
  onTestFinished(drop);
  return drop;
}
