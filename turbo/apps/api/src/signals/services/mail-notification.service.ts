import { createHash, randomUUID } from "node:crypto";
import { MORNING_BRIEF_PREFERENCES_PATH } from "@okouai/api-contracts/contracts/morning-brief-preference";
import type {
  NotificationResponse,
  NotifyMailBody,
} from "@okouai/api-contracts/contracts/notifications";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { mailNotifications } from "@okouai/db/schema/mail-notification";
import { users } from "@okouai/db/schema/user";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command, computed } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
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

function replay(receipt: Receipt, payloadHash: string) {
  return receipt.payloadHash === payloadHash
    ? { status: 200 as const, body: response(receipt, true) }
    : conflict(
        "This idempotency key already has different content. Reuse the original content or choose a new key for an intentional new notification.",
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
  readonly payloadHash: string;
  readonly email: string | null;
}

const commitMailNotification$ = command(
  async (
    { set },
    owner: Owner & { readonly runId: string },
    body: NotifyMailBody,
    { payloadHash, email }: NotificationDelivery,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const keyScope = notificationKeyScope(owner, body.idempotencyKey);
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
        return replay(winner, payloadHash);
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
          return resourceUnavailable(
            "morning-brief notifications require a run from your official Morning Brief automation. Use --kind notification for ordinary updates.",
          );
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
          idempotencyKey: body.idempotencyKey,
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
        return replay(concurrent, payloadHash);
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
    { set },
    owner: Owner & { readonly runId: string },
    body: NotifyMailBody,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const keyScope = notificationKeyScope(owner, body.idempotencyKey);
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
      return replay(existing, payloadHash);
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
      { payloadHash, email: subscription.email },
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
  async (
    { set },
    owner: { readonly userId?: string; readonly orgId?: string },
    signal: AbortSignal,
  ) => {
    if (!owner.userId && !owner.orgId) {
      throw new Error("Mail notification erasure requires an owner");
    }
    const db = set(writeDb$);
    const scope = and(
      owner.userId ? eq(mailNotifications.userId, owner.userId) : undefined,
      owner.orgId ? eq(mailNotifications.orgId, owner.orgId) : undefined,
    );
    const erased = db
      .$with("erased_mail_notifications")
      .as(
        db
          .delete(mailNotifications)
          .where(scope)
          .returning({ outboxId: mailNotifications.outboxId }),
      );
    // Use the deleted receipts' identities; receipts may have no surviving outbox.
    await db
      .with(erased)
      .delete(emailOutbox)
      .where(
        inArray(
          emailOutbox.id,
          db.select({ id: erased.outboxId }).from(erased),
        ),
      );
    // SQL has committed; cancellation stops the caller's remaining cleanup.
    signal.throwIfAborted();
  },
);
