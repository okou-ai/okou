import {
  morningBriefReceiptSql,
  proactiveRunReceipt$,
} from "./proactive-run-context.service";
import { createHash, randomUUID } from "node:crypto";
import { MORNING_BRIEF_PREFERENCES_PATH } from "@okouai/api-contracts/contracts/morning-brief-preference";
import type {
  NotificationResponse,
  NotifyMailBody,
} from "@okouai/api-contracts/contracts/notifications";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { mailNotifications } from "@okouai/db/schema/mail-notification";
import { users } from "@okouai/db/schema/user";
import { command, computed } from "ccstate";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { boolean, strictObject, string, enum as zEnum } from "zod";
import {
  conflict,
  notConfigured,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { env, optionalEnv } from "../../lib/env";
import { parseRawRows } from "../../lib/db-raw-rows";
import { db$, writeDb$ } from "../external/db";
import { emailSubscription$ } from "./email-subscription.service";
import {
  sendEmailOutboxItem$,
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  type EmailTemplate,
} from "./email-common.service";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}
type Receipt = Pick<
  typeof mailNotifications.$inferSelect,
  "id" | "payloadHash" | "status" | "reason"
>;

function response(
  receipt: Receipt,
  deduplicated: boolean,
): NotificationResponse {
  return {
    notificationId: receipt.id,
    channel: "mail",
    recipient: "me",
    status: receipt.status,
    reason: receipt.reason,
    deduplicated,
  };
}

function notificationKeyScope(owner: Owner, key: string) {
  return and(
    eq(mailNotifications.orgId, owner.orgId),
    eq(mailNotifications.userId, owner.userId),
    eq(mailNotifications.idempotencyKey, key),
  );
}

function activeRunScope(owner: Owner & { readonly runId: string }) {
  return and(
    eq(agentRuns.id, owner.runId),
    eq(agentRuns.userId, owner.userId),
    eq(agentRuns.orgId, owner.orgId),
    eq(agentRuns.status, "running"),
  );
}

function replay(receipt: Receipt, body: NotifyMailBody, payloadHash: string) {
  if (receipt.payloadHash === payloadHash) {
    return { status: 200 as const, body: response(receipt, true) };
  }
  return conflict(
    body.kind === "morning-brief"
      ? "This scheduled Morning Brief already has a notification with different content. Retry with the original subject and body."
      : "This idempotency key already has different content. Reuse the original content or choose a new key for an intentional new notification.",
  );
}

function notificationTemplate(
  body: NotifyMailBody,
  runId: string,
): EmailTemplate {
  const props = {
    subject: body.subject,
    text: body.text,
    runUrl: `${env("APP_URL")}/activities/${runId}`,
  };
  return body.kind === "morning-brief"
    ? {
        template: "agent-morning-brief",
        props: {
          ...props,
          manageUrl: `${env("APP_URL")}${MORNING_BRIEF_PREFERENCES_PATH}`,
        },
      }
    : { template: "agent-notification", props };
}

interface NotificationDelivery {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly email: string | null;
}

const MORNING_BRIEF_SOURCE_REQUIRED =
  "morning-brief notifications require a scheduled Morning Brief run. Use --kind notification for ordinary updates.";

const mailAdmissionSchema = strictObject({
  active: boolean(),
  sourceAllowed: boolean(),
  reason: zEnum(["unsubscribed", "no-email", "suppressed"]).nullable(),
  inserted: boolean(),
  receipt: strictObject({
    id: string(),
    payloadHash: string(),
    status: zEnum(["queued", "sent", "skipped", "failed"]),
    reason: zEnum([
      "unsubscribed",
      "suppressed",
      "no-email",
      "expired",
      "delivery-failed",
    ]).nullable(),
  }).nullable(),
});

function notificationOutboxSql(
  owner: Owner & { readonly runId: string },
  body: NotifyMailBody,
  email: string | null,
  configured: boolean,
) {
  if (!email || !configured) {
    return sql`outbox AS (SELECT NULL::uuid AS id WHERE false)`;
  }
  return sql`outbox AS (
    INSERT INTO ${emailOutbox} (
      id, from_address, to_addresses, subject, headers, template, status, attempts
    ) SELECT outbox_id,
      ${sql.param(buildFromAddress(), emailOutbox.fromAddress)},
      ${sql.param([email], emailOutbox.toAddresses)},
      ${sql.param(body.subject, emailOutbox.subject)},
      ${sql.param(buildUnsubscribeHeaders(buildOneClickUnsubscribeUrl(owner.userId)), emailOutbox.headers)},
      ${sql.param(notificationTemplate(body, owner.runId), emailOutbox.template)},
      'pending', 0
    FROM inserted_receipt WHERE outbox_id IS NOT NULL
    RETURNING id
  )`;
}

function mailAdmissionSql(
  owner: Owner & { readonly runId: string },
  body: NotifyMailBody,
  delivery: NotificationDelivery,
  configured: boolean,
) {
  const query = new QueryBuilder();
  const run = query
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(activeRunScope(owner))
    .for("update");
  const winner = query
    .select()
    .from(mailNotifications)
    .where(notificationKeyScope(owner, delivery.idempotencyKey))
    .limit(1);
  const suppression = query
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      eq(
        sql`lower(${emailSuppressions.emailAddress})`,
        delivery.email?.toLowerCase() ?? "",
      ),
    );
  const sourceAllowed =
    body.kind === "morning-brief"
      ? morningBriefReceiptSql(sql`active_run.id`, owner.orgId, owner.userId)
      : sql`true`;
  return sql`WITH active_run AS MATERIALIZED (${run}),
    preference AS (
      INSERT INTO ${users} (id) SELECT ${owner.userId} FROM active_run WHERE true
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      RETURNING email_unsubscribed
    ), visible_winner AS MATERIALIZED (${winner}),
    eligibility AS MATERIALIZED (
      SELECT ${sourceAllowed} AS source_allowed,
        CASE WHEN preference.email_unsubscribed THEN 'unsubscribed'
          WHEN ${!delivery.email} THEN 'no-email'
          WHEN EXISTS (${suppression}) THEN 'suppressed'
          ELSE NULL END AS reason
      FROM active_run CROSS JOIN preference
    ), inserted_receipt AS (
      INSERT INTO ${mailNotifications} (
        org_id, user_id, source_run_id, idempotency_key, payload_hash,
        outbox_id, status, reason
      ) SELECT ${owner.orgId}, ${owner.userId}, ${owner.runId}::uuid,
        ${delivery.idempotencyKey}, ${delivery.payloadHash},
        CASE WHEN reason IS NULL THEN ${randomUUID()}::uuid ELSE NULL END,
        CASE WHEN reason IS NULL THEN 'queued' ELSE 'skipped' END, reason
      FROM eligibility
      WHERE source_allowed AND (reason IS NOT NULL OR ${configured})
        AND NOT EXISTS (SELECT 1 FROM visible_winner)
      ON CONFLICT (org_id, user_id, idempotency_key) DO NOTHING
      RETURNING id, payload_hash, status, reason, outbox_id
    ), ${notificationOutboxSql(owner, body, delivery.email, configured)}
    SELECT EXISTS (SELECT 1 FROM active_run) AS active,
      COALESCE((SELECT source_allowed FROM eligibility), false) AS "sourceAllowed",
      (SELECT reason FROM eligibility) AS reason,
      EXISTS (SELECT 1 FROM inserted_receipt) AS inserted,
      (SELECT jsonb_build_object('id', id, 'payloadHash', payload_hash,
          'status', status, 'reason', reason)
        FROM (SELECT id, payload_hash, status, reason FROM inserted_receipt
          UNION ALL SELECT id, payload_hash, status, reason FROM visible_winner
        ) AS receipt LIMIT 1) AS receipt`;
}

const commitMailNotification$ = command(
  async (
    { set },
    owner: Owner & { readonly runId: string },
    body: NotifyMailBody,
    delivery: NotificationDelivery,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { idempotencyKey, payloadHash } = delivery;
    const keyScope = notificationKeyScope(owner, idempotencyKey);
    const configured = Boolean(optionalEnv("RESEND_API_KEY"));
    // The preference upsert returns the current opt-out after any row wait.
    // Keep the existing Run -> user order; receipt and outbox commit together.
    signal.throwIfAborted();
    const rows = parseRawRows(
      mailAdmissionSchema,
      await db.execute(mailAdmissionSql(owner, body, delivery, configured)),
    );
    signal.throwIfAborted();
    if (rows.length !== 1 || !rows[0]) {
      throw new Error("Expected one mail notification admission outcome");
    }
    const result = rows[0];
    if (!result.active) {
      return resourceUnavailable(
        "Mail notifications require an active run owned by you in this workspace.",
      );
    }
    if (result.receipt) {
      return result.inserted
        ? { status: 200 as const, body: response(result.receipt, false) }
        : replay(result.receipt, body, payloadHash);
    }
    // A uniqueness winner can commit while this statement waits for Run/user.
    // Read a new snapshot before returning source/configuration errors too.
    const [winner] = await db
      .select()
      .from(mailNotifications)
      .where(keyScope)
      .limit(1);
    signal.throwIfAborted();
    if (winner) {
      return replay(winner, body, payloadHash);
    }
    if (!result.sourceAllowed) {
      return resourceUnavailable(MORNING_BRIEF_SOURCE_REQUIRED);
    }
    if (!result.reason && !configured) {
      return notConfigured(
        "Okou email delivery is not configured. Retry with the same key after configuration is restored.",
      );
    }
    throw new Error("Mail notification claim missing after conflict");
  },
);

export const queueMailNotification$ = command(
  async (
    { set },
    owner: Owner & { readonly runId: string },
    body: NotifyMailBody,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [run] = await db
      .select({
        triggerSource: agentRuns.triggerSource,
        status: agentRuns.status,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, owner.runId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.orgId, owner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const proactive =
      run?.triggerSource === "proactive"
        ? await set(proactiveRunReceipt$, owner, signal)
        : null;
    if (
      run?.triggerSource === "proactive" &&
      proactive?.task !== "morning-brief"
    ) {
      return resourceUnavailable(
        "Only Morning Brief may send mail from a proactive Run.",
      );
    }
    const occurrenceKey = proactive && `morning-brief:${proactive.id}`;
    const idempotencyKey =
      body.kind === "morning-brief" ? occurrenceKey : body.idempotencyKey;
    if (idempotencyKey === null) {
      return resourceUnavailable(MORNING_BRIEF_SOURCE_REQUIRED);
    }
    const keyScope = notificationKeyScope(owner, idempotencyKey);
    // The default purpose keeps its established byte encoding. An explicit
    // Morning Brief purpose adds a discriminator, so changing kind conflicts.
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify([
          body.to,
          body.subject,
          body.text,
          ...(body.kind === "morning-brief" ? [body.kind] : []),
        ]),
      )
      .digest("hex");
    const [existing] = await db
      .select()
      .from(mailNotifications)
      .where(keyScope)
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      return replay(existing, body, payloadHash);
    }

    if (run?.status !== "running") {
      return resourceUnavailable(
        "Mail notifications require an active run owned by you in this workspace.",
      );
    }
    const subscription = await set(emailSubscription$, owner.userId, signal);
    return await set(
      commitMailNotification$,
      owner,
      body,
      {
        idempotencyKey,
        payloadHash,
        email: subscription.email,
      },
      signal,
    );
  },
);

/** Deliver only the committed receipt accepted for this owner. */
export const deliverMailNotification$ = command(
  async (
    { get, set },
    owner: Owner,
    notificationId: string,
    signal: AbortSignal,
  ) => {
    const [receipt] = await get(db$)
      .select({ outboxId: mailNotifications.outboxId })
      .from(mailNotifications)
      .where(
        and(
          eq(mailNotifications.id, notificationId),
          eq(mailNotifications.orgId, owner.orgId),
          eq(mailNotifications.userId, owner.userId),
          eq(mailNotifications.status, "queued"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (receipt?.outboxId) {
      await set(sendEmailOutboxItem$, receipt.outboxId, signal);
    }
  },
);

export function mailNotification(owner: Owner, id: string) {
  return computed(async (get) => {
    const [receipt] = await get(db$)
      .select()
      .from(mailNotifications)
      .where(
        and(
          eq(mailNotifications.id, id),
          eq(mailNotifications.orgId, owner.orgId),
          eq(mailNotifications.userId, owner.userId),
        ),
      )
      .limit(1);
    return receipt
      ? { status: 200 as const, body: response(receipt, false) }
      : notFound("Notification not found in your workspace.");
  });
}

export const eraseMailNotifications$ = command(
  async ({ set }, owner: Owner, signal: AbortSignal) => {
    const db = set(writeDb$);
    const scope = and(
      eq(mailNotifications.userId, owner.userId),
      eq(mailNotifications.orgId, owner.orgId),
    );
    const erasedOutbox = db.$with("erased_email_outbox").as(
      db
        .delete(emailOutbox)
        .where(
          inArray(
            emailOutbox.id,
            db
              .select({ id: mailNotifications.outboxId })
              .from(mailNotifications)
              .where(scope),
          ),
        )
        .returning({ id: emailOutbox.id }),
    );
    // Exhaust the outbox DELETE before locking receipts, matching completion/TTL
    // order. COUNT also keeps receipts eligible when no outbox survives.
    await db
      .with(erasedOutbox)
      .delete(mailNotifications)
      .where(
        and(scope, gte(db.select({ count: count() }).from(erasedOutbox), 0)),
      );
    // SQL has committed; cancellation stops the caller's remaining cleanup.
    signal.throwIfAborted();
  },
);
