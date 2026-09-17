import { createStore } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";

import { db } from "../lib/db";
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
