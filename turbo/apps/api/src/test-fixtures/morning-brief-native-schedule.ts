import { chatEvents } from "@okouai/db/schema/chat-event";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { userCache } from "@okouai/db/schema/user-cache";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { now } from "../lib/time";
import { loadResumableOccurrences } from "../signals/services/morning-brief-native-schedule.service";

/**
 * Infrastructure the native Morning Brief cron suite needs and no production
 * endpoint exposes.
 *
 * The scheduler's durable state has no HTTP surface by design: the cron is the
 * only caller, and the contract it is asserted against is about rows a crashed
 * worker leaves behind. These helpers therefore read those rows and reconstruct
 * exact interruption states. They never seed a generation or delivery result —
 * every brief the suite observes is produced by the real pipeline through the
 * registered cron route.
 */

export interface MorningBriefNativeOwner {
  readonly orgId: string;
  readonly userId: string;
}

export async function readNativeSchedule(owner: MorningBriefNativeOwner) {
  const [row] = await db()
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    )
    .limit(1);
  return row;
}

export async function readNativeOccurrences(owner: MorningBriefNativeOwner) {
  return await db()
    .select()
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
      ),
    );
}

export async function readNativeGenerations(owner: MorningBriefNativeOwner) {
  return await db()
    .select()
    .from(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, owner.orgId),
        eq(morningBriefGenerations.userId, owner.userId),
      ),
    );
}

export async function readNativeDeliveries(owner: MorningBriefNativeOwner) {
  return await db()
    .select()
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, owner.orgId),
        eq(morningBriefDeliveries.userId, owner.userId),
      ),
    );
}

export async function readLegacyAutomation(automationId: string) {
  const [row] = await db()
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, automationId))
    .limit(1);
  return row;
}

export async function readThreadEventTypes(
  chatThreadId: string,
): Promise<readonly string[]> {
  const rows = await db()
    .select({ eventType: chatEvents.eventType })
    .from(chatEvents)
    .where(eq(chatEvents.chatThreadId, chatThreadId));
  return rows.map((row) => {
    return row.eventType;
  });
}

export async function countEmailOutboxRows(outboxId: string): Promise<number> {
  const rows = await db()
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(eq(emailOutbox.id, outboxId));
  return rows.length;
}

/** Zero agent Runs is part of the product contract, so the suite asserts it. */
export async function countOrgAgentRuns(orgId: string): Promise<number> {
  const rows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, orgId));
  return rows.length;
}

export async function seedRecipientAddress(
  userId: string,
  email: string,
): Promise<void> {
  await db()
    .insert(userCache)
    .values({ userId, email, name: "Test Member", cachedAt: new Date(now()) })
    .onConflictDoNothing();
}

/** Make the member's native obligation due right now. */
export async function makeNativeOccurrenceDue(
  owner: MorningBriefNativeOwner,
): Promise<Date> {
  const due = new Date(now() - 60 * 1000);
  await db()
    .update(morningBriefNativeSchedules)
    .set({ nextRunAt: due, scheduleOwner: "native" })
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    );
  return due;
}

/**
 * Reconstruct the exact state a worker leaves behind when it dies after the
 * Chat receipt COMMIT and before its own native settlement.
 *
 * The obligation is still held by the occurrence, the claimant's lease is still
 * recorded, and the settlement never ran. No delivered content is fabricated:
 * the Chat event, its receipt and the email intent are the ones the real
 * pipeline already committed.
 */
export async function interruptNativeSettlement(
  owner: MorningBriefNativeOwner,
  args: { readonly scheduledFor: Date; readonly leaseToken: string },
): Promise<void> {
  await db()
    .update(morningBriefNativeSchedules)
    .set({ nextRunAt: null, scheduleOwner: null })
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    );
  await db()
    .update(morningBriefNativeOccurrences)
    .set({
      settledAt: null,
      settledNextRunAt: null,
      outcome: null,
      state: "claimed",
      deliveryPending: true,
      leaseToken: args.leaseToken,
      leaseExpiresAt: new Date(now() - 60 * 1000),
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
      ),
    );
}

/**
 * What the resume scan would pick up right now.
 *
 * The receipt-first invariant is a statement about which rows are resumable at
 * all, which no HTTP response exposes; the suite asserts it directly so the
 * property holds independently of how many rows one recovery batch fits.
 */
export async function resumableOccurrenceAnchors(): Promise<readonly Date[]> {
  const rows = await loadResumableOccurrences(db(), {
    now: new Date(now()),
    limit: 50,
  });
  return rows.map((row) => {
    return row.scheduledFor;
  });
}
