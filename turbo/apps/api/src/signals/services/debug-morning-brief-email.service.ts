import { createHash, randomUUID } from "node:crypto";
import {
  debugMorningBriefEmailResponseSchema,
  type DebugMorningBriefEmailResponse,
} from "@okouai/api-contracts/contracts/debug-morning-brief-email";
import { MORNING_BRIEF_PREFERENCES_PATH } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { mailNotifications } from "@okouai/db/schema/mail-notification";
import { users } from "@okouai/db/schema/user";
import { command, computed } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  DEBUG_MORNING_BRIEF_EMAIL_SUBJECT,
  DEBUG_MORNING_BRIEF_EMAIL_TEXT,
} from "../../lib/debug-morning-brief-email";
import { env, optionalEnv } from "../../lib/env";
import { conflict, notConfigured, notFound } from "../../lib/error";
import { db$, writeDb$ } from "../external/db";
import {
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  type EmailTemplate,
} from "./email-common.service";
import { emailSubscription$ } from "./email-subscription.service";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

function ownedTestEmailScope(owner: Owner, id: string) {
  return and(
    eq(mailNotifications.id, id),
    eq(mailNotifications.orgId, owner.orgId),
    eq(mailNotifications.userId, owner.userId),
    isNull(mailNotifications.sourceRunId),
    eq(mailNotifications.idempotencyKey, `debug-morning-brief:${id}`),
  );
}

function receipt(
  row: typeof mailNotifications.$inferSelect,
): DebugMorningBriefEmailResponse {
  return debugMorningBriefEmailResponseSchema.parse({
    requestId: row.id,
    status: row.status,
    reason: row.reason,
  });
}

export function debugMorningBriefEmail(owner: Owner, id: string) {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select()
      .from(mailNotifications)
      .where(ownedTestEmailScope(owner, id));
    return row
      ? { status: 200 as const, body: receipt(row) }
      : notFound("Test email not found in your workspace.");
  });
}

export const sendDebugMorningBriefEmail$ = command(
  async (
    { get, set },
    owner: Owner,
    requestId: string,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [existing] = await db
      .select({ id: mailNotifications.id })
      .from(mailNotifications)
      .where(eq(mailNotifications.id, requestId));
    signal.throwIfAborted();
    if (!existing) {
      const subscription = await set(emailSubscription$, owner.userId, signal);
      const reason = !subscription.subscribed
        ? "unsubscribed"
        : subscription.deliveryStatus === "no-email"
          ? "no-email"
          : subscription.deliveryStatus === "suppressed"
            ? "suppressed"
            : null;
      if (!reason && !optionalEnv("RESEND_API_KEY")) {
        return notConfigured("Okou email delivery is not configured.");
      }
      const outboxId = reason ? null : randomUUID();
      await db.insert(users).values({ id: owner.userId }).onConflictDoNothing();
      signal.throwIfAborted();
      const payloadHash = createHash("sha256")
        .update(
          JSON.stringify([
            "debug-morning-brief",
            DEBUG_MORNING_BRIEF_EMAIL_SUBJECT,
            DEBUG_MORNING_BRIEF_EMAIL_TEXT,
          ]),
        )
        .digest("hex");
      const template = {
        template: "debug-morning-brief",
        props: {
          subject: DEBUG_MORNING_BRIEF_EMAIL_SUBJECT,
          text: DEBUG_MORNING_BRIEF_EMAIL_TEXT,
          runUrl: env("APP_URL"),
          manageUrl: `${env("APP_URL")}${MORNING_BRIEF_PREFERENCES_PATH}`,
        },
      } satisfies EmailTemplate;
      // The durable receipt and optional outbox intent commit in one statement.
      // Re-read the user's opt-out at that same boundary; provider calls follow it.
      await db.execute(sql`
        WITH created_notification AS (
          INSERT INTO ${mailNotifications}
            (id, org_id, user_id, source_run_id, idempotency_key, payload_hash, outbox_id, status, reason)
          SELECT ${requestId}::uuid, ${owner.orgId}, ${owner.userId}, NULL,
            ${`debug-morning-brief:${requestId}`}, ${payloadHash},
            CASE WHEN ${users.emailUnsubscribed} OR ${reason}::text IS NOT NULL
              THEN NULL ELSE ${outboxId}::uuid END,
            CASE WHEN ${users.emailUnsubscribed} OR ${reason}::text IS NOT NULL
              THEN 'skipped' ELSE 'queued' END,
            CASE WHEN ${users.emailUnsubscribed} THEN 'unsubscribed' ELSE ${reason}::text END
          FROM ${users} WHERE ${eq(users.id, owner.userId)}
          ON CONFLICT DO NOTHING RETURNING outbox_id
        )
        INSERT INTO ${emailOutbox}
          (id, from_address, to_addresses, subject, headers, template)
        SELECT outbox_id, ${buildFromAddress()},
          ${JSON.stringify(subscription.email ? [subscription.email] : [])}::jsonb,
          ${DEBUG_MORNING_BRIEF_EMAIL_SUBJECT},
          ${JSON.stringify(buildUnsubscribeHeaders(buildOneClickUnsubscribeUrl(owner.userId)))}::jsonb,
          ${JSON.stringify(template)}::jsonb
        FROM created_notification WHERE outbox_id IS NOT NULL
      `);
      signal.throwIfAborted();
    }
    const [owned] = await db
      .select({ outboxId: mailNotifications.outboxId })
      .from(mailNotifications)
      .where(ownedTestEmailScope(owner, requestId));
    signal.throwIfAborted();
    if (!owned) {
      return conflict("This test email request ID is already in use.");
    }
    const result = await get(debugMorningBriefEmail(owner, requestId));
    signal.throwIfAborted();
    return result;
  },
);
