import { createHash, randomUUID } from "node:crypto";
import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
  MORNING_BRIEF_PREFERENCES_PATH,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { PROACTIVE_SUGGESTIONS_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-suggestions";
import type {
  NotificationResponse,
  NotifyMailBody,
} from "@okouai/api-contracts/contracts/notifications";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { mailNotifications } from "@okouai/db/schema/mail-notification";
import { users } from "@okouai/db/schema/user";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command, computed } from "ccstate";
import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as z from "zod";
import {
  conflict,
  notConfigured,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { env, optionalEnv } from "../../lib/env";
import { parseRawRows } from "../../lib/db-raw-rows";
import { isMorningBriefNotificationSource } from "../../lib/morning-brief-notification-source";
import { db$, writeDb$ } from "../external/db";
import { emailSubscription$ } from "./email-subscription.service";
import {
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
      ? "This Morning Brief automation event already has a notification with different content. Okou sends at most one Morning Brief email per event; retry only with the original subject and body."
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
  readonly runSource: Pick<
    typeof agentRuns.$inferSelect,
    "workflowAutomationId" | "officialWorkflowProvenance"
  >;
}

const MORNING_BRIEF_SOURCE_REQUIRED =
  "morning-brief notifications require a run from your official Morning Brief automation. Use --kind notification for ordinary updates.";

const mailAdmissionSchema = z.strictObject({
  active: z.boolean(),
  sourceAllowed: z.boolean(),
  reason: z.enum(["unsubscribed", "no-email", "suppressed"]).nullable(),
  inserted: z.boolean(),
  receipt: z
    .strictObject({
      id: z.string(),
      payloadHash: z.string(),
      status: z.enum(["queued", "sent", "skipped", "failed"]),
      reason: z
        .enum([
          "unsubscribed",
          "suppressed",
          "no-email",
          "expired",
          "delivery-failed",
        ])
        .nullable(),
    })
    .nullable(),
});

function morningBriefSourceSql(owner: Owner) {
  const query = new QueryBuilder();
  const source = query
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
    .where(
      and(
        eq(workflowAutomations.id, sql`active_run.workflow_automation_id`),
        eq(workflowAutomations.orgId, owner.orgId),
        eq(workflowAutomations.ownerUserId, owner.userId),
        eq(workflows.orgId, owner.orgId),
        eq(workflows.ownerUserId, owner.userId),
        inArray(workflows.officialDefinitionName, [
          ...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
        ]),
        eq(
          workflowAutomations.officialBlueprintKey,
          MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
        ),
      ),
    );
  const definitionName = sql`definition->>'name'`;
  return sql`EXISTS (${source}) AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      active_run.official_workflow_provenance->'definitions'
    ) AS definition
    WHERE ${inArray(definitionName, [...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES])}
  )`;
}

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
  preparedSourceAllowed: boolean,
) {
  const query = new QueryBuilder();
  const run = query
    .select({
      id: agentRuns.id,
      workflowAutomationId: agentRuns.workflowAutomationId,
      officialWorkflowProvenance: agentRuns.officialWorkflowProvenance,
    })
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
    body.kind === "morning-brief" ? morningBriefSourceSql(owner) : sql`true`;
  return sql`WITH active_run AS MATERIALIZED (${run}),
    preference AS (
      INSERT INTO ${users} (id) SELECT ${owner.userId} FROM active_run WHERE true
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      RETURNING email_unsubscribed
    ), visible_winner AS MATERIALIZED (${winner}),
    eligibility AS MATERIALIZED (
      SELECT ${preparedSourceAllowed} AND (${sourceAllowed}) AS source_allowed,
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

/**
 * Okou sends one Morning Brief email per automation event. The key comes from
 * the event that started this Run rather than from the agent, whose context
 * can lose the prompt's identity before it decides to send.
 */
const morningBriefNotificationKey$ = command(
  async ({ set }, runId: string, signal: AbortSignal) => {
    const [event] = await set(writeDb$)
      .select({
        automationId: chatAutomationContext.automationId,
        automationEventId: chatAutomationContext.id,
      })
      .from(chatEvents)
      .innerJoin(
        chatAutomationContext,
        eq(chatAutomationContext.id, chatEvents.contextId),
      )
      .where(
        and(
          eq(chatEvents.runId, runId),
          eq(chatEvents.eventType, "input.prompt"),
          eq(chatEvents.contextType, "automation"),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(1);
    signal.throwIfAborted();
    return event
      ? `morning-brief:${event.automationId}:${event.automationEventId}`
      : null;
  },
);

const commitMailNotification$ = command(
  async (
    { set },
    owner: Owner & { readonly runId: string },
    body: NotifyMailBody,
    delivery: NotificationDelivery,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { idempotencyKey, payloadHash, runSource } = delivery;
    const keyScope = notificationKeyScope(owner, idempotencyKey);
    let preparedSourceAllowed = true;
    if (body.kind === "morning-brief") {
      const [source] = runSource.workflowAutomationId
        ? await db
            .select({
              automationId: workflowAutomations.id,
              automationOrgId: workflowAutomations.orgId,
              automationOwnerUserId: workflowAutomations.ownerUserId,
              workflowOrgId: workflows.orgId,
              workflowOwnerUserId: workflows.ownerUserId,
              officialDefinitionName: workflows.officialDefinitionName,
              officialBlueprintKey: workflowAutomations.officialBlueprintKey,
            })
            .from(workflowAutomations)
            .innerJoin(
              workflows,
              eq(workflows.id, workflowAutomations.workflowId),
            )
            .where(eq(workflowAutomations.id, runSource.workflowAutomationId))
            .limit(1)
        : [];
      signal.throwIfAborted();
      preparedSourceAllowed = isMorningBriefNotificationSource(
        owner,
        runSource,
        source,
      );
    }
    const configured = Boolean(optionalEnv("RESEND_API_KEY"));
    // The preference upsert returns the current opt-out after any row wait.
    // Keep the existing Run -> user order; receipt and outbox commit together.
    signal.throwIfAborted();
    const rows = parseRawRows(
      mailAdmissionSchema,
      await db.execute(
        mailAdmissionSql(
          owner,
          body,
          delivery,
          configured,
          preparedSourceAllowed,
        ),
      ),
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
    { get, set },
    owner: Owner & { readonly runId: string },
    body: NotifyMailBody,
    signal: AbortSignal,
  ) => {
    const [source] = await get(db$)
      .select({ provenance: agentRuns.officialWorkflowProvenance })
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
    if (
      source?.provenance?.definitions.some((definition) => {
        return definition.name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME;
      })
    ) {
      return resourceUnavailable(
        "Proactive Suggestions only updates your home page and cannot send mail.",
      );
    }
    const idempotencyKey =
      body.kind === "morning-brief"
        ? await set(morningBriefNotificationKey$, owner.runId, signal)
        : body.idempotencyKey;
    if (idempotencyKey === null) {
      return resourceUnavailable(MORNING_BRIEF_SOURCE_REQUIRED);
    }
    const db = set(writeDb$);
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

    const runScope = activeRunScope(owner);
    const [run] = await db
      .select({
        workflowAutomationId: agentRuns.workflowAutomationId,
        officialWorkflowProvenance: agentRuns.officialWorkflowProvenance,
      })
      .from(agentRuns)
      .where(runScope)
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
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
        runSource: run,
      },
      signal,
    );
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
