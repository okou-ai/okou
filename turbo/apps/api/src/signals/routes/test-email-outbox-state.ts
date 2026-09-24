import {
  testEmailOutboxStateContract,
  type TestEmailOutboxStateActionBody,
} from "@okouai/api-contracts/contracts/test-email-outbox-state";
import { randomUUID } from "node:crypto";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { users } from "@okouai/db/schema/user";
import { officialAutomationResultEmailClaims } from "@okouai/db/schema/official-automation-result-email-claim";
import { command } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { now } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  cleanupExpiredEmailOutboxItems$,
  drainEmailOutboxItems$,
} from "../services/email-common.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(testEmailOutboxStateContract.action);
const drainBody$ = bodyResultOf(testEmailOutboxStateContract.drain);
const cleanupBody$ = bodyResultOf(testEmailOutboxStateContract.cleanup);

const historicalNativeMailTemplate = {
  template: "morning-brief-result",
  props: {
    title: "Historical Morning Brief",
    resultMarkdown: "Historical content",
    threadUrl: "https://app.okou.test/threads/historical",
    manageUrl: "https://app.okou.test/settings/morning-brief",
  },
} as const;

function itemStateSelection() {
  return {
    id: emailOutbox.id,
    from_address: emailOutbox.fromAddress,
    to_addresses: emailOutbox.toAddresses,
    subject: emailOutbox.subject,
    headers: emailOutbox.headers,
    public_brand: emailOutbox.publicBrand,
    template: emailOutbox.template,
    source_run_id: emailOutbox.sourceRunId,
    source_workflow_automation_id: emailOutbox.sourceWorkflowAutomationId,
    status: emailOutbox.status,
    attempts: emailOutbox.attempts,
    last_error: emailOutbox.lastError,
    resend_id: emailOutbox.resendId,
    provider_idempotency_key: emailOutbox.providerIdempotencyKey,
    provider_request: emailOutbox.providerRequest,
  };
}

/**
 * Report whether the immutable provider request is committed without exposing
 * the rendered message body through a test endpoint.
 */
function itemState<Item extends { readonly provider_request: unknown }>(
  item: Item,
): Omit<Item, "provider_request"> & {
  readonly has_provider_request: boolean;
} {
  const { provider_request: providerRequest, ...state } = item;
  return { ...state, has_provider_request: providerRequest !== null };
}

async function seedTestOutboxItem(
  db: Db,
  body: Extract<TestEmailOutboxStateActionBody, { action: "seed-item" }>,
  signal: AbortSignal,
) {
  const [item] = await db
    .insert(emailOutbox)
    .values({
      fromAddress: "Okou <outbox-fixture@mail.example.com>",
      toAddresses: body.to_address,
      subject: body.subject,
      template:
        body.template === "morning-brief-result"
          ? historicalNativeMailTemplate
          : {
              template: "data-export-ready",
              props: {
                downloadUrl: "https://storage.example/email-outbox-fixture.zip",
                expiresAt: "January 1, 2030",
                artifactCount: 1,
              },
            },
      status: body.status,
      attempts: 0,
      createdAt: new Date(body.created_at),
    })
    .returning(itemStateSelection());
  signal.throwIfAborted();
  if (!item) {
    throw new Error("Failed to seed email outbox item");
  }
  return {
    status: 200 as const,
    body: { action: "seed-item" as const, item: itemState(item) },
  };
}

/** Reconstruct one old in-flight owner only inside the test-only state route. */
async function seedActiveHistoricalAuthority(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly membershipId: string;
    readonly agentId: string;
    readonly threadId: string;
    readonly workflowId: string;
    readonly automationId: string;
    readonly at: Date;
  },
) {
  await tx.insert(users).values({ id: args.userId });
  await tx.insert(morningBriefNativeSchedules).values({
    orgId: args.orgId,
    userId: args.userId,
    enabled: true,
    cronExpression: "0 7 * * *",
    timezone: "UTC",
    nextRunAt: null,
    scheduleOwner: null,
    phase: "native",
    target: "native",
    ownerEpoch: 1,
    membershipId: args.membershipId,
    agentId: args.agentId,
    chatThreadId: args.threadId,
    materializedAt: args.at,
  });
  await tx.insert(morningBriefCollectionOccurrences).values({
    orgId: args.orgId,
    userId: args.userId,
    scheduledFor: args.at,
    collectionKind: "sources",
    collectionVersion: 1,
    windowStart: new Date(args.at.getTime() - 60 * 60 * 1000),
    windowEnd: args.at,
    timezone: "UTC",
    membershipId: args.membershipId,
    workflowId: args.workflowId,
    automationId: args.automationId,
    agentId: args.agentId,
    status: "completed",
    attempt: 1,
    outcome: "complete",
    claimedAt: args.at,
    finishedAt: args.at,
  });
}

async function seedLinkedNativeMail(
  db: Db,
  body: Extract<TestEmailOutboxStateActionBody, { action: "seed-native-mail" }>,
  signal: AbortSignal,
) {
  const owner = { orgId: body.org_id, userId: body.user_id };
  const agentId = randomUUID();
  const threadId = randomUUID();
  const workflowId = randomUUID();
  const automationId = randomUUID();
  const at = new Date(body.created_at);
  const item = await db.transaction(async (tx) => {
    await tx.insert(orgMembersMetadata).values({ ...owner, timezone: "UTC" });
    await tx.insert(agents).values({
      id: agentId,
      orgId: owner.orgId,
      owner: owner.userId,
      name: `historical-mail-${agentId.slice(0, 8)}`,
      visibility: "private",
    });
    await tx.insert(chatThreads).values({
      id: threadId,
      userId: owner.userId,
      agentId,
      title: "Historical Native mail fixture",
    });
    if (body.active_authority === true) {
      await seedActiveHistoricalAuthority(tx, {
        ...owner,
        membershipId: body.membership_id,
        agentId,
        threadId,
        workflowId,
        automationId,
        at,
      });
    }
    const [queued] = await tx
      .insert(emailOutbox)
      .values({
        fromAddress: "Okou <outbox-fixture@mail.example.com>",
        toAddresses: body.to_address,
        subject: "Historical Native Morning Brief",
        template: historicalNativeMailTemplate,
        createdAt: at,
      })
      .returning(itemStateSelection());
    if (!queued) {
      throw new Error("Failed to seed linked Native email intent");
    }
    await tx.insert(morningBriefDeliveries).values({
      ...owner,
      scheduledFor: at,
      collectionKind: "sources",
      collectionVersion: 1,
      executionPurpose: "production",
      resultAttemptId: randomUUID(),
      membershipId: body.membership_id,
      nativeOwnerEpoch: 1,
      workflowId,
      automationId,
      agentId,
      chatThreadId: threadId,
      chatEventId: randomUUID(),
      resultDigest: "historical-mail-fixture",
      emailResolution: "enqueued",
      emailOutboxId: queued.id,
      deliveredAt: at,
    });
    return queued;
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { action: "seed-native-mail" as const, item: itemState(item) },
  };
}

async function deleteLinkedNativeMail(
  db: Db,
  itemId: string,
  signal: AbortSignal,
) {
  const deleted = await db.transaction(async (tx) => {
    const [delivery] = await tx
      .select({
        orgId: morningBriefDeliveries.orgId,
        userId: morningBriefDeliveries.userId,
        agentId: morningBriefDeliveries.agentId,
        chatThreadId: morningBriefDeliveries.chatThreadId,
      })
      .from(morningBriefDeliveries)
      .where(eq(morningBriefDeliveries.emailOutboxId, itemId));
    if (!delivery) {
      return false;
    }
    await tx
      .delete(morningBriefDeliveries)
      .where(eq(morningBriefDeliveries.emailOutboxId, itemId));
    await tx.delete(emailOutbox).where(eq(emailOutbox.id, itemId));
    await tx
      .delete(morningBriefCollectionOccurrences)
      .where(
        and(
          eq(morningBriefCollectionOccurrences.orgId, delivery.orgId),
          eq(morningBriefCollectionOccurrences.userId, delivery.userId),
        ),
      );
    await tx
      .delete(morningBriefNativeSchedules)
      .where(
        and(
          eq(morningBriefNativeSchedules.orgId, delivery.orgId),
          eq(morningBriefNativeSchedules.userId, delivery.userId),
        ),
      );
    await tx
      .delete(chatThreads)
      .where(eq(chatThreads.id, delivery.chatThreadId));
    await tx.delete(agents).where(eq(agents.id, delivery.agentId));
    await tx.delete(users).where(eq(users.id, delivery.userId));
    await tx
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, delivery.orgId),
          eq(orgMembersMetadata.userId, delivery.userId),
        ),
      );
    return true;
  });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { action: "delete-native-mail" as const, deleted },
  };
}

async function applyAction(
  db: Db,
  body: TestEmailOutboxStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-item": {
      return await seedTestOutboxItem(db, body, signal);
    }
    case "seed-native-mail": {
      return await seedLinkedNativeMail(db, body, signal);
    }
    case "read-native-receipt": {
      const [delivery] = await db
        .select({ emailOutboxId: morningBriefDeliveries.emailOutboxId })
        .from(morningBriefDeliveries)
        .where(eq(morningBriefDeliveries.emailOutboxId, body.item_id));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "read-native-receipt" as const, exists: !!delivery },
      };
    }
    case "delete-native-mail": {
      return await deleteLinkedNativeMail(db, body.item_id, signal);
    }
    case "find-item": {
      const items = await db
        .select(itemStateSelection())
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.toAddresses, body.to_address),
            eq(emailOutbox.subject, body.subject),
          ),
        )
        .orderBy(asc(emailOutbox.createdAt));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "find-item" as const, items: items.map(itemState) },
      };
    }
    case "find-source": {
      const [items, claims] = await Promise.all([
        db
          .select(itemStateSelection())
          .from(emailOutbox)
          .where(
            and(
              eq(emailOutbox.sourceRunId, body.source_run_id),
              eq(
                emailOutbox.sourceWorkflowAutomationId,
                body.source_workflow_automation_id,
              ),
            ),
          )
          .orderBy(asc(emailOutbox.createdAt)),
        db
          .select({
            source_run_id: officialAutomationResultEmailClaims.runId,
            source_workflow_automation_id:
              officialAutomationResultEmailClaims.workflowAutomationId,
            email_outbox_id: officialAutomationResultEmailClaims.emailOutboxId,
          })
          .from(officialAutomationResultEmailClaims)
          .where(
            and(
              eq(officialAutomationResultEmailClaims.runId, body.source_run_id),
              eq(
                officialAutomationResultEmailClaims.workflowAutomationId,
                body.source_workflow_automation_id,
              ),
            ),
          )
          .limit(1),
      ]);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          action: "find-source" as const,
          items: items.map(itemState),
          claim: claims[0] ?? null,
        },
      };
    }
    case "read-items": {
      const items = await db
        .select(itemStateSelection())
        .from(emailOutbox)
        .where(inArray(emailOutbox.id, body.item_ids));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "read-items" as const, items: items.map(itemState) },
      };
    }
    case "delete-items": {
      const deleted = await db
        .delete(emailOutbox)
        .where(inArray(emailOutbox.id, body.item_ids))
        .returning({ id: emailOutbox.id });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "delete-items" as const, deleted: deleted.length },
      };
    }
  }
}

const mutateTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await applyAction(set(writeDb$), bodyResult.data, signal);
  },
);

const drainTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(drainBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const drained = await set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: bodyResult.data.item_ids },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { drained } };
  },
);

const cleanupTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(cleanupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const cleaned = await set(
      cleanupExpiredEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: bodyResult.data.item_ids },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { cleaned } };
  },
);

export const testEmailOutboxStateRoutes: readonly RouteEntry[] = [
  {
    route: testEmailOutboxStateContract.action,
    handler: mutateTestEmailOutboxState$,
  },
  {
    route: testEmailOutboxStateContract.drain,
    handler: drainTestEmailOutboxState$,
  },
  {
    route: testEmailOutboxStateContract.cleanup,
    handler: cleanupTestEmailOutboxState$,
  },
];
