import { createHash, randomUUID } from "node:crypto";
import { MORNING_BRIEF_PREFERENCES_PATH } from "@okouai/api-contracts/contracts/morning-brief-preference";
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
import {
  conflict,
  notConfigured,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { env, optionalEnv } from "../../lib/env";
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
type Receipt = typeof mailNotifications.$inferSelect;

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

function notificationSkipReason(
  unsubscribed: boolean,
  email: string | null,
  suppressed: boolean,
) {
  return unsubscribed
    ? ("unsubscribed" as const)
    : !email
      ? ("no-email" as const)
      : suppressed
        ? ("suppressed" as const)
        : null;
}

function notificationAdmissionReadPlan() {
  return {
    run: {
      id: agentRuns.id,
      workflowAutomationId: agentRuns.workflowAutomationId,
      officialWorkflowProvenance: agentRuns.officialWorkflowProvenance,
    },
    source: {
      automationId: workflowAutomations.id,
      automationOrgId: workflowAutomations.orgId,
      automationOwnerUserId: workflowAutomations.ownerUserId,
      workflowOrgId: workflows.orgId,
      workflowOwnerUserId: workflows.ownerUserId,
      officialDefinitionName: workflows.officialDefinitionName,
      officialBlueprintKey: workflowAutomations.officialBlueprintKey,
    },
    sourceJoin: eq(workflows.id, workflowAutomations.workflowId),
  };
}

interface NotificationDelivery {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly email: string | null;
}

const MORNING_BRIEF_SOURCE_REQUIRED =
  "morning-brief notifications require a run from your official Morning Brief automation. Use --kind notification for ordinary updates.";

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
    { idempotencyKey, payloadHash, email }: NotificationDelivery,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const keyScope = notificationKeyScope(owner, idempotencyKey);
    const runScope = activeRunScope(owner);
    const plan = notificationAdmissionReadPlan();
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0176; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // Serialize admission with run termination and the user's opt-out writes.
      const [activeRun] = await tx
        .select(plan.run)
        .from(agentRuns)
        .where(runScope)
        .for("update");
      if (!activeRun) {
        return resourceUnavailable(
          "Mail notifications require an active run owned by you in this workspace.",
        );
      }
      await tx.insert(users).values({ id: owner.userId }).onConflictDoNothing();
      const [user] = await tx
        .select({ unsubscribed: users.emailUnsubscribed })
        .from(users)
        .where(eq(users.id, owner.userId))
        .for("update");
      if (!user) {
        throw new Error("Mail notification user preference row disappeared");
      }
      // Re-read the claim after acquiring locks: concurrent same-key requests
      // return their winner even if preferences or provider configuration changed.
      const [winner] = await tx
        .select()
        .from(mailNotifications)
        .where(keyScope)
        .limit(1);
      if (winner) {
        return replay(winner, body, payloadHash);
      }
      if (body.kind === "morning-brief") {
        const [source] = activeRun.workflowAutomationId
          ? await tx
              .select(plan.source)
              .from(workflowAutomations)
              .innerJoin(workflows, plan.sourceJoin)
              .where(eq(workflowAutomations.id, activeRun.workflowAutomationId))
              .limit(1)
          : [];
        signal.throwIfAborted();
        if (!isMorningBriefNotificationSource(owner, activeRun, source)) {
          return resourceUnavailable(MORNING_BRIEF_SOURCE_REQUIRED);
        }
      }
      const [suppression] = email
        ? await tx
            .select({ id: emailSuppressions.id })
            .from(emailSuppressions)
            .where(
              eq(
                sql`lower(${emailSuppressions.emailAddress})`,
                email.toLowerCase(),
              ),
            )
            .limit(1)
        : [];
      const reason = notificationSkipReason(
        user.unsubscribed,
        email,
        suppression !== undefined,
      );
      if (!reason && !optionalEnv("RESEND_API_KEY")) {
        return notConfigured(
          "Okou email delivery is not configured. Retry with the same key after configuration is restored.",
        );
      }
      const outboxId = reason ? null : randomUUID();
      const [receipt] = await tx
        .insert(mailNotifications)
        .values({
          orgId: owner.orgId,
          userId: owner.userId,
          sourceRunId: owner.runId,
          idempotencyKey,
          payloadHash,
          outboxId,
          status: reason ? "skipped" : "queued",
          reason,
        })
        .onConflictDoNothing({
          target: [
            mailNotifications.orgId,
            mailNotifications.userId,
            mailNotifications.idempotencyKey,
          ],
        })
        .returning();
      if (!receipt) {
        const [concurrent] = await tx
          .select()
          .from(mailNotifications)
          .where(keyScope)
          .limit(1);
        if (!concurrent) {
          throw new Error("Mail notification claim missing after conflict");
        }
        return replay(concurrent, body, payloadHash);
      }
      if (outboxId && email) {
        await tx.insert(emailOutbox).values({
          id: outboxId,
          fromAddress: buildFromAddress(),
          toAddresses: [email],
          subject: body.subject,
          headers: buildUnsubscribeHeaders(
            buildOneClickUnsubscribeUrl(owner.userId),
          ),
          template: notificationTemplate(body, owner.runId),
          status: "pending",
          attempts: 0,
        });
      }
      signal.throwIfAborted();
      return { status: 200 as const, body: response(receipt, false) };
    });
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
      .select({ id: agentRuns.id })
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
      { idempotencyKey, payloadHash, email: subscription.email },
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
