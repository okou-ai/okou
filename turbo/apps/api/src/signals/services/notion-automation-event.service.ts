import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
  type NotionChildPageCreatedEventConfig,
  type NotionDatabaseItemCreatedEventConfig,
  type NotionDataSourceReference,
  type NotionPageContentUpdatedEventConfig,
  type NotionPageContentUpdatedScope,
  type NotionPageReference,
} from "@okouai/api-contracts/contracts/workflows";
import {
  notionWebhookEvents,
  notionWebhookSecrets,
  notionWorkflowPendingEvents,
  type NotionWorkflowPendingEventContext,
} from "@okouai/db/schema/notion-event";
import {
  workflowAutomations,
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { logger } from "../../lib/log";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { workflowAutomationConnectorSelectionSql } from "./workflow-automation-account.service";
import type {
  AutomationRow,
  RunWorkflowAutomationResult,
} from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { NotionAutomationSourceChangedError } from "./workflow-notion-queue.service";
import {
  notionConfigConnectorId,
  notionConfigWithConnectorId,
} from "./notion-automation-account.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import {
  type NotionPageResponse,
  type NotionAutomationEventType,
  normalizeNotionUuid,
  notionTitleFromProperties,
  notionPageReference,
  notionDataSourceReference,
  pageIsUsable,
  resolveNotionCredentialAccess$,
  retrieveNotionPage,
  retrieveNotionDataSource,
} from "./notion-automation-preparation.service";

const log = logger("api:notion-automation-event");

const NOTION_CHILD_PAGE_SETTLE_MS = 15 * 60 * 1000;

const NOTION_PENDING_RETRY_MS = 5 * 60 * 1000;

const NOTION_PENDING_MAX_ATTEMPTS = 8;

const NOTION_PENDING_BATCH_SIZE = 25;

const NOTION_VALIDATION_ISSUE_LOG_LIMIT = 10;

const NOTION_CHILD_PAGE_MOVED_SKIP_REASON =
  "Notion page is no longer a direct child of the configured parent";

const NOTION_DATABASE_ITEM_MOVED_SKIP_REASON =
  "Notion page is no longer inside the configured data source";

const NOTION_PAGE_CONTENT_UPDATED_MOVED_SKIP_REASON =
  "Notion page is no longer inside the configured content update scope";

const NOTION_ACCOUNT_CHANGED_SKIP_REASON =
  "Notion account selection changed before the event was processed";

const notionAuthorSchema = z
  .object({
    id: z.string(),
    type: z.enum(["person", "bot", "agent"]),
  })
  .passthrough();

const notionEntitySchema = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
  })
  .passthrough();

const notionParentDataSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    data_source_id: z.string().optional(),
  })
  .passthrough();

const notionWebhookVerificationSchema = z
  .object({
    verification_token: z.string().min(1),
  })
  .passthrough();

const notionWebhookEventTypeSchema = z.enum([
  "page.created",
  "page.content_updated",
  "page.properties_updated",
]);

const notionWebhookLogMetadataSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    subscription_id: z.string().optional(),
    api_version: z.string().optional(),
    attempt_number: z.number().optional(),
  })
  .passthrough()
  .transform((value) => {
    return {
      notionEventId: value.id,
      notionEventType: value.type,
      notionSubscriptionId: value.subscription_id,
      notionApiVersion: value.api_version,
      attemptNumber: value.attempt_number,
    };
  });

const notionWebhookEventSchema = z
  .object({
    id: z.string().uuid(),
    timestamp: z.string().datetime(),
    workspace_id: z.string().uuid(),
    workspace_name: z.string().optional(),
    subscription_id: z.string().uuid(),
    integration_id: z.string().uuid(),
    type: notionWebhookEventTypeSchema,
    authors: z.array(notionAuthorSchema).default([]),
    attempt_number: z.number().int().positive().optional(),
    entity: notionEntitySchema,
    data: z
      .object({
        parent: notionParentDataSchema.optional(),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();

type NotionWebhookEvent = z.infer<typeof notionWebhookEventSchema>;

type NotionPendingRow = typeof notionWorkflowPendingEvents.$inferSelect;

function notionPendingEventColumns() {
  return {
    id: notionWorkflowPendingEvents.id,
    automationId: notionWorkflowPendingEvents.automationId,
    connectorId: notionWorkflowPendingEvents.connectorId,
    pageId: notionWorkflowPendingEvents.pageId,
    scopeType: notionWorkflowPendingEvents.scopeType,
    scopeId: notionWorkflowPendingEvents.scopeId,
    eventFamily: notionWorkflowPendingEvents.eventFamily,
    status: notionWorkflowPendingEvents.status,
    firstNotionEventId: notionWorkflowPendingEvents.firstNotionEventId,
    latestNotionEventId: notionWorkflowPendingEvents.latestNotionEventId,
    firstEventAt: notionWorkflowPendingEvents.firstEventAt,
    latestEventAt: notionWorkflowPendingEvents.latestEventAt,
    latestEventContext: notionWorkflowPendingEvents.latestEventContext,
    runAfter: notionWorkflowPendingEvents.runAfter,
    attempts: notionWorkflowPendingEvents.attempts,
    pageTitle: notionWorkflowPendingEvents.pageTitle,
    pageUrl: notionWorkflowPendingEvents.pageUrl,
    parentTitle: notionWorkflowPendingEvents.parentTitle,
    parentUrl: notionWorkflowPendingEvents.parentUrl,
    skipReason: notionWorkflowPendingEvents.skipReason,
    lastError: notionWorkflowPendingEvents.lastError,
    processedAt: notionWorkflowPendingEvents.processedAt,
    createdAt: notionWorkflowPendingEvents.createdAt,
    updatedAt: notionWorkflowPendingEvents.updatedAt,
  };
}

type NotionWebhookDispatchResult =
  | {
      readonly kind: "ok";
      readonly webhookKind: "verification" | "event";
      readonly pending: number;
      readonly refreshed: number;
      readonly duplicates: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "config_error"; readonly message: string };

const ACKNOWLEDGED_NOTION_EVENT_RESULT = {
  kind: "ok",
  webhookKind: "event",
  pending: 0,
  refreshed: 0,
  duplicates: 0,
} as const satisfies NotionWebhookDispatchResult;

type ExecuteDueNotionEventsResult = {
  readonly executed: number;
  readonly skipped: number;
};

type DueNotionAutomationRow = {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string | null;
};

interface ProcessClaimedNotionPendingEventArgs {
  readonly row: DueNotionAutomationRow;
  readonly pending: NotionPendingRow;
}

function notionPageParentPageId(page: NotionPageResponse): string | null {
  return page.parent.type === "page_id" ? page.parent.page_id : null;
}

function notionPageParentDataSourceId(page: NotionPageResponse): string | null {
  return page.parent.type === "data_source_id"
    ? page.parent.data_source_id
    : null;
}

function notionEventContext(
  event: NotionWebhookEvent,
): NotionWorkflowPendingEventContext {
  return {
    workspaceId: event.workspace_id,
    workspaceName: event.workspace_name ?? null,
    authors: event.authors.map((author) => {
      return {
        id: author.id,
        type: author.type,
      };
    }),
    attemptNumber: event.attempt_number ?? null,
  };
}

const storeVerificationToken$ = command(
  async (
    { set },
    args: {
      readonly token: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const encryptedVerificationToken = await encryptStoredSecretValue(
      args.token,
    );
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      await tx
        .update(notionWebhookSecrets)
        .set({ active: false, updatedAt: currentTime })
        .where(eq(notionWebhookSecrets.active, true));
      signal.throwIfAborted();
      await tx.insert(notionWebhookSecrets).values({
        encryptedVerificationToken,
        active: true,
        createdAt: currentTime,
        updatedAt: currentTime,
      });
      signal.throwIfAborted();
    });
  },
);

const activeVerificationTokenExists$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const rows = await db
      .select({ id: notionWebhookSecrets.id })
      .from(notionWebhookSecrets)
      .where(eq(notionWebhookSecrets.active, true))
      .limit(1);
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

const loadActiveVerificationTokens$ = command(
  async ({ set }, signal: AbortSignal): Promise<readonly string[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        encryptedVerificationToken:
          notionWebhookSecrets.encryptedVerificationToken,
      })
      .from(notionWebhookSecrets)
      .where(eq(notionWebhookSecrets.active, true))
      .orderBy(desc(notionWebhookSecrets.createdAt));
    signal.throwIfAborted();
    return await Promise.all(
      rows.map((row) => {
        return decryptStoredSecretValue(row.encryptedVerificationToken);
      }),
    );
  },
);

function signatureMatches(args: {
  readonly rawBody: string;
  readonly signature: string;
  readonly token: string;
}): boolean {
  const calculated = `sha256=${createHmac("sha256", args.token)
    .update(args.rawBody)
    .digest("hex")}`;
  const calculatedBuffer = Buffer.from(calculated);
  const signatureBuffer = Buffer.from(args.signature);
  return (
    calculatedBuffer.byteLength === signatureBuffer.byteLength &&
    timingSafeEqual(calculatedBuffer, signatureBuffer)
  );
}

function verifyNotionSignature(args: {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly tokens: readonly string[];
}): boolean {
  const signature = args.signature;
  if (!signature) {
    return false;
  }
  return args.tokens.some((token) => {
    return signatureMatches({
      rawBody: args.rawBody,
      signature,
      token,
    });
  });
}

function eventPageParentId(event: NotionWebhookEvent): string | null {
  const parent = event.data.parent;
  if (!parent || parent.data_source_id) {
    return null;
  }
  if (parent.type && parent.type !== "page" && parent.type !== "page_id") {
    return null;
  }
  return parent.id ? normalizeNotionUuid(parent.id) : null;
}

function eventDataSourceParentId(event: NotionWebhookEvent): string | null {
  const parent = event.data.parent;
  if (!parent) {
    return null;
  }
  if (parent.data_source_id) {
    return normalizeNotionUuid(parent.data_source_id);
  }
  if (parent.type !== "data_source" && parent.type !== "data_source_id") {
    return null;
  }
  return parent.id ? normalizeNotionUuid(parent.id) : null;
}

function eventPageId(event: NotionWebhookEvent): string | null {
  return event.entity.type === "page"
    ? normalizeNotionUuid(event.entity.id)
    : null;
}

function eventTimestamp(event: NotionWebhookEvent): Date {
  return new Date(event.timestamp);
}

function runAfterForEvent(event: NotionWebhookEvent): Date {
  return new Date(
    eventTimestamp(event).getTime() + NOTION_CHILD_PAGE_SETTLE_MS,
  );
}

const insertNotionWebhookEvent$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
      readonly pageId: string | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [inserted] = await db
      .insert(notionWebhookEvents)
      .values({
        notionEventId: args.event.id,
        eventType: args.event.type,
        pageId: args.pageId,
        receivedAt: nowDate(),
        createdAt: nowDate(),
      })
      .onConflictDoNothing()
      .returning({ id: notionWebhookEvents.id });
    signal.throwIfAborted();
    return inserted !== undefined;
  },
);

const queryNotionAutomations$ = command(
  async (
    { set },
    eventType: NotionAutomationEventType,
    signal: AbortSignal,
  ): Promise<readonly AutomationRow[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select(workflowAutomationColumns())
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.kind, "event"),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.eventType, eventType),
        ),
      );
    signal.throwIfAborted();
    return rows;
  },
);

const repairNotionAutomationProjection$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    // No row locks: the automation and the member's selected account are
    // read plainly, then the retarget is a conditional UPDATE that only
    // applies while the automation still has the observed target and the
    // selection still resolves to the computed one. A concurrent change makes
    // it a no-op; that change's own repair converges the projection.
    const [automation] = await db
      .select({
        id: workflowAutomations.id,
        workflowId: workflowAutomations.workflowId,
        eventType: workflowAutomations.eventType,
        eventConfig: workflowAutomations.eventConfig,
        eventConnectorId: workflowAutomations.eventConnectorId,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.id, args.automationId),
          eq(workflowAutomations.orgId, args.orgId),
          eq(workflowAutomations.ownerUserId, args.userId),
          eq(workflowAutomations.kind, "event"),
          inArray(workflowAutomations.eventType, [
            "notion-child-page-created",
            "notion-database-item-created",
            "notion-page-content-updated",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!automation) {
      return;
    }
    const selectionSql = workflowAutomationConnectorSelectionSql({
      orgId: args.orgId,
      userId: args.userId,
      workflowId: automation.workflowId,
      connectorSlug: "notion",
    });
    const [selection] = parseRawRows(
      z.object({ connectorId: z.string().nullable() }),
      await db.execute(selectionSql),
    );
    signal.throwIfAborted();
    const eventConnectorId = selection?.connectorId ?? null;
    if (
      automation.eventConnectorId === eventConnectorId &&
      (eventConnectorId === null ||
        notionConfigConnectorId(
          automation.eventType,
          automation.eventConfig,
        ) === eventConnectorId)
    ) {
      return;
    }
    const eventConfig =
      eventConnectorId === null
        ? automation.eventConfig
        : notionConfigWithConnectorId(
            automation.eventType,
            automation.eventConfig,
            eventConnectorId,
          );
    await db.transaction(async (tx) => {
      const [retargeted] = await tx
        .update(workflowAutomations)
        .set({
          eventConnectorId,
          ...(eventConfig === null ? {} : { eventConfig }),
        })
        .where(
          and(
            eq(workflowAutomations.id, automation.id),
            sql`${workflowAutomations.eventConnectorId} IS NOT DISTINCT FROM ${automation.eventConnectorId}::uuid`,
            automation.eventConfig === null
              ? isNull(workflowAutomations.eventConfig)
              : eq(workflowAutomations.eventConfig, automation.eventConfig),
            sql`(${selectionSql}) IS NOT DISTINCT FROM ${eventConnectorId}::uuid`,
          ),
        )
        .returning({ id: workflowAutomations.id });
      signal.throwIfAborted();
      if (!retargeted) {
        return;
      }
      const currentTime = nowDate();
      await tx
        .update(notionWorkflowPendingEvents)
        .set({
          status: "skipped",
          skipReason: NOTION_ACCOUNT_CHANGED_SKIP_REASON,
          processedAt: currentTime,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(notionWorkflowPendingEvents.automationId, automation.id),
            inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
          ),
        );
      signal.throwIfAborted();
    });
  },
);

const repairNotionAutomationProjections$ = command(
  async (
    { set },
    automations: readonly AutomationRow[],
    signal: AbortSignal,
  ): Promise<boolean> => {
    const owners = new Map<
      string,
      { readonly orgId: string; readonly userId: string }
    >();
    for (const automation of automations) {
      if (
        automation.eventConnectorId !== null &&
        notionConfigConnectorId(
          automation.eventType,
          automation.eventConfig,
        ) === automation.eventConnectorId
      ) {
        continue;
      }
      const owner = { orgId: automation.orgId, userId: automation.ownerUserId };
      owners.set(`${owner.orgId}:${owner.userId}`, owner);
    }
    const orderedOwners = [...owners.values()].sort((left, right) => {
      return (
        left.orgId.localeCompare(right.orgId) ||
        left.userId.localeCompare(right.userId)
      );
    });
    const db = set(writeDb$);
    for (const owner of orderedOwners) {
      const rows = await db
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(
          and(
            eq(workflowAutomations.orgId, owner.orgId),
            eq(workflowAutomations.ownerUserId, owner.userId),
            eq(workflowAutomations.kind, "event"),
            inArray(workflowAutomations.eventType, [
              "notion-child-page-created",
              "notion-database-item-created",
              "notion-page-content-updated",
            ]),
          ),
        )
        .orderBy(asc(workflowAutomations.id));
      signal.throwIfAborted();
      for (const row of rows) {
        await set(
          repairNotionAutomationProjection$,
          { ...owner, automationId: row.id },
          signal,
        );
      }
    }
    return orderedOwners.length > 0;
  },
);

const loadCurrentNotionAutomations$ = command(
  async (
    { set },
    eventType: NotionAutomationEventType,
    signal: AbortSignal,
  ): Promise<readonly AutomationRow[]> => {
    const automations = await set(queryNotionAutomations$, eventType, signal);
    if (!(await set(repairNotionAutomationProjections$, automations, signal))) {
      return automations;
    }
    return await set(queryNotionAutomations$, eventType, signal);
  },
);

const enqueueNotionChildPageEvents$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
      readonly parentPageId: string;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const automations = await set(
      loadCurrentNotionAutomations$,
      "notion-child-page-created",
      signal,
    );
    let pending = 0;
    for (const automation of automations) {
      const config = notionChildPageCreatedEventConfigSchema.safeParse(
        automation.eventConfig,
      );
      if (!config.success || config.data.parentPage.id !== args.parentPageId) {
        continue;
      }
      if (
        automation.eventConnectorId === null ||
        automation.eventConnectorId !== config.data.connectorId
      ) {
        continue;
      }
      const connectorId = automation.eventConnectorId;
      const inserted = await set(
        publishNotionPendingEvent$,
        {
          automation,
          connectorId,
          eventType: "notion-child-page-created",
          pendingEvent: {
            automationId: automation.id,
            connectorId,
            pageId: args.pageId,
            scopeType: "page",
            scopeId: args.parentPageId,
            eventFamily: "new_child_page",
            status: "pending",
            firstNotionEventId: args.event.id,
            latestNotionEventId: args.event.id,
            firstEventAt: eventTimestamp(args.event),
            latestEventAt: eventTimestamp(args.event),
            latestEventContext: notionEventContext(args.event),
            runAfter: runAfterForEvent(args.event),
            parentTitle: config.data.parentPage.title,
            parentUrl: config.data.parentPage.url,
            createdAt: nowDate(),
            updatedAt: nowDate(),
          },
        },
        signal,
      );
      signal.throwIfAborted();
      if (inserted === "inserted") {
        pending += 1;
      }
    }
    return pending;
  },
);

const enqueueNotionDatabaseItemEvents$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
      readonly dataSourceId: string;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const automations = await set(
      loadCurrentNotionAutomations$,
      "notion-database-item-created",
      signal,
    );
    let pending = 0;
    for (const automation of automations) {
      const config = notionDatabaseItemCreatedEventConfigSchema.safeParse(
        automation.eventConfig,
      );
      if (!config.success || config.data.dataSource.id !== args.dataSourceId) {
        continue;
      }
      if (
        automation.eventConnectorId === null ||
        automation.eventConnectorId !== config.data.connectorId
      ) {
        continue;
      }
      const connectorId = automation.eventConnectorId;
      const inserted = await set(
        publishNotionPendingEvent$,
        {
          automation,
          connectorId,
          eventType: "notion-database-item-created",
          pendingEvent: {
            automationId: automation.id,
            connectorId,
            pageId: args.pageId,
            scopeType: "data_source",
            scopeId: args.dataSourceId,
            eventFamily: "new_database_item",
            status: "pending",
            firstNotionEventId: args.event.id,
            latestNotionEventId: args.event.id,
            firstEventAt: eventTimestamp(args.event),
            latestEventAt: eventTimestamp(args.event),
            latestEventContext: notionEventContext(args.event),
            runAfter: runAfterForEvent(args.event),
            parentTitle: config.data.dataSource.title,
            parentUrl: config.data.dataSource.url,
            createdAt: nowDate(),
            updatedAt: nowDate(),
          },
        },
        signal,
      );
      signal.throwIfAborted();
      if (inserted === "inserted") {
        pending += 1;
      }
    }
    return pending;
  },
);

function pageContentUpdatedScopeType(
  scope: NotionPageContentUpdatedScope,
): "page" | "data_source" {
  return scope.type === "page" ? "page" : "data_source";
}

function pageContentUpdatedScopeId(
  scope: NotionPageContentUpdatedScope,
): string {
  return scope.type === "page" ? scope.page.id : scope.dataSource.id;
}

function pageContentUpdatedScopeParent(scope: NotionPageContentUpdatedScope): {
  readonly title: string | null;
  readonly url: string;
} {
  return scope.type === "page"
    ? { title: scope.page.title, url: scope.page.url }
    : { title: scope.dataSource.title, url: scope.dataSource.url };
}

type NotionPendingPublication = "inserted" | "refreshed" | "none" | null;

const publishNotionPendingEvent$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly connectorId: string;
      readonly eventType: NotionAutomationEventType;
      readonly pendingEvent: typeof notionWorkflowPendingEvents.$inferInsert;
      readonly refreshExisting?: boolean;
    },
    signal: AbortSignal,
  ): Promise<NotionPendingPublication> => {
    const db = set(writeDb$);
    // No row lock: the consumer is checked with a plain read, the refresh is
    // conditional on that consumer still being current, and the insert relies
    // on its automation/connector FK checks. A disable racing this write can
    // still publish one pending row; queue admission re-checks the consumer.
    // A FK violation (automation or account deleted concurrently) maps to the
    // same "no current consumer" result.
    const automationCondition = and(
      eq(workflowAutomations.id, args.automation.id),
      eq(workflowAutomations.enabled, true),
      eq(workflowAutomations.eventType, args.eventType),
      eq(workflowAutomations.eventConnectorId, args.connectorId),
    );
    const published = await settle(
      db.transaction(async (tx): Promise<NotionPendingPublication> => {
        const [current] = await tx
          .select({
            eventType: workflowAutomations.eventType,
            eventConfig: workflowAutomations.eventConfig,
          })
          .from(workflowAutomations)
          .where(automationCondition)
          .limit(1);
        signal.throwIfAborted();
        if (
          !current ||
          notionConfigConnectorId(current.eventType, current.eventConfig) !==
            args.connectorId
        ) {
          return null;
        }
        if (args.refreshExisting) {
          const [updated] = await tx
            .update(notionWorkflowPendingEvents)
            .set({
              latestNotionEventId: args.pendingEvent.latestNotionEventId,
              latestEventAt: args.pendingEvent.latestEventAt,
              latestEventContext: args.pendingEvent.latestEventContext,
              runAfter: args.pendingEvent.runAfter,
              lastError: null,
              updatedAt: args.pendingEvent.updatedAt,
            })
            .where(
              and(
                eq(
                  notionWorkflowPendingEvents.automationId,
                  args.automation.id,
                ),
                eq(
                  notionWorkflowPendingEvents.pageId,
                  args.pendingEvent.pageId,
                ),
                eq(
                  notionWorkflowPendingEvents.eventFamily,
                  "page_content_updated",
                ),
                eq(notionWorkflowPendingEvents.status, "pending"),
                eq(notionWorkflowPendingEvents.connectorId, args.connectorId),
                exists(
                  db
                    .select({ id: workflowAutomations.id })
                    .from(workflowAutomations)
                    .where(automationCondition),
                ),
              ),
            )
            .returning({ id: notionWorkflowPendingEvents.id });
          signal.throwIfAborted();
          if (updated) {
            return "refreshed";
          }
        }
        const [inserted] = await tx
          .insert(notionWorkflowPendingEvents)
          .values(args.pendingEvent)
          .onConflictDoNothing()
          .returning({ id: notionWorkflowPendingEvents.id });
        signal.throwIfAborted();
        return inserted ? "inserted" : "none";
      }),
      signal,
    );
    if (published.ok) {
      return published.value;
    }
    if (isForeignKeyViolation(published.error)) {
      return null;
    }
    throw published.error;
  },
);

const dataSourceIdForContentUpdatedEvent$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly config: NotionPageContentUpdatedEventConfig;
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const eventDataSourceId = eventDataSourceParentId(args.event);
    if (eventDataSourceId) {
      return eventDataSourceId;
    }

    const accessResult = await set(
      resolveNotionCredentialAccess$,
      {
        orgId: args.automation.orgId,
        userId: args.automation.ownerUserId,
        connectorId: args.config.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      return null;
    }
    const pageResult = await retrieveNotionPage(
      {
        accessToken: accessResult.access.accessToken,
        pageId: args.pageId,
      },
      signal,
    );
    signal.throwIfAborted();
    return pageResult.kind === "ok"
      ? notionPageParentDataSourceId(pageResult.value)
      : null;
  },
);

const contentUpdatedAutomationMatchesEvent$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly config: NotionPageContentUpdatedEventConfig;
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.config.scope.type === "page") {
      return args.config.scope.page.id === args.pageId;
    }
    const dataSourceId = await set(
      dataSourceIdForContentUpdatedEvent$,
      args,
      signal,
    );
    return dataSourceId === args.config.scope.dataSource.id;
  },
);

const enqueueOrRefreshNotionPageContentUpdatedEvents$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly pending: number; readonly refreshed: number }> => {
    const automations = await set(
      loadCurrentNotionAutomations$,
      "notion-page-content-updated",
      signal,
    );
    let pending = 0;
    let refreshed = 0;
    for (const automation of automations) {
      const config = notionPageContentUpdatedEventConfigSchema.safeParse(
        automation.eventConfig,
      );
      if (!config.success) {
        continue;
      }
      if (
        automation.eventConnectorId === null ||
        automation.eventConnectorId !== config.data.connectorId
      ) {
        continue;
      }
      const connectorId = automation.eventConnectorId;
      if (
        !(await set(
          contentUpdatedAutomationMatchesEvent$,
          {
            automation,
            config: config.data,
            event: args.event,
            pageId: args.pageId,
          },
          signal,
        ))
      ) {
        continue;
      }

      const currentTime = nowDate();
      const parent = pageContentUpdatedScopeParent(config.data.scope);
      const persistence = await set(
        publishNotionPendingEvent$,
        {
          automation,
          connectorId,
          eventType: "notion-page-content-updated",
          refreshExisting: true,
          pendingEvent: {
            automationId: automation.id,
            connectorId,
            pageId: args.pageId,
            scopeType: pageContentUpdatedScopeType(config.data.scope),
            scopeId: pageContentUpdatedScopeId(config.data.scope),
            eventFamily: "page_content_updated",
            status: "pending",
            firstNotionEventId: args.event.id,
            latestNotionEventId: args.event.id,
            firstEventAt: eventTimestamp(args.event),
            latestEventAt: eventTimestamp(args.event),
            latestEventContext: notionEventContext(args.event),
            runAfter: runAfterForEvent(args.event),
            parentTitle: parent.title,
            parentUrl: parent.url,
            createdAt: currentTime,
            updatedAt: currentTime,
          },
        },
        signal,
      );
      signal.throwIfAborted();
      if (persistence === "refreshed") {
        refreshed += 1;
        continue;
      }
      if (persistence === "inserted") {
        pending += 1;
      }
    }
    return { pending, refreshed };
  },
);

const refreshPendingNotionCreatedPageEvents$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const refreshed = await db
      .update(notionWorkflowPendingEvents)
      .set({
        latestNotionEventId: args.event.id,
        latestEventAt: eventTimestamp(args.event),
        latestEventContext: notionEventContext(args.event),
        runAfter: runAfterForEvent(args.event),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(notionWorkflowPendingEvents.pageId, args.pageId),
          eq(notionWorkflowPendingEvents.status, "pending"),
          inArray(notionWorkflowPendingEvents.eventFamily, [
            "new_child_page",
            "new_database_item",
          ]),
        ),
      )
      .returning({ id: notionWorkflowPendingEvents.id });
    signal.throwIfAborted();
    return refreshed.length;
  },
);

const hasActiveNotionCreatedPageEvent$ = command(
  async (
    { set },
    args: {
      readonly pageId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [active] = await db
      .select({ id: notionWorkflowPendingEvents.id })
      .from(notionWorkflowPendingEvents)
      .where(
        and(
          eq(notionWorkflowPendingEvents.pageId, args.pageId),
          inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
          inArray(notionWorkflowPendingEvents.eventFamily, [
            "new_child_page",
            "new_database_item",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return active !== undefined;
  },
);

const dispatchNotionEvent$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly pending: number;
    readonly refreshed: number;
    readonly duplicates: number;
  }> => {
    const pageId = eventPageId(args.event);
    if (!pageId) {
      return { pending: 0, refreshed: 0, duplicates: 0 };
    }

    const inserted = await set(
      insertNotionWebhookEvent$,
      {
        event: args.event,
        pageId,
      },
      signal,
    );
    if (!inserted) {
      return { pending: 0, refreshed: 0, duplicates: 1 };
    }

    if (args.event.type === "page.created") {
      const parentPageId = eventPageParentId(args.event);
      if (parentPageId) {
        return {
          pending: await set(
            enqueueNotionChildPageEvents$,
            {
              event: args.event,
              pageId,
              parentPageId,
            },
            signal,
          ),
          refreshed: 0,
          duplicates: 0,
        };
      }
      const dataSourceId = eventDataSourceParentId(args.event);
      if (!dataSourceId) {
        return { pending: 0, refreshed: 0, duplicates: 0 };
      }
      return {
        pending: await set(
          enqueueNotionDatabaseItemEvents$,
          {
            event: args.event,
            pageId,
            dataSourceId,
          },
          signal,
        ),
        refreshed: 0,
        duplicates: 0,
      };
    }

    const refreshedCreated = await set(
      refreshPendingNotionCreatedPageEvents$,
      {
        event: args.event,
        pageId,
      },
      signal,
    );
    if (args.event.type !== "page.content_updated") {
      return { pending: 0, refreshed: refreshedCreated, duplicates: 0 };
    }
    if (
      refreshedCreated > 0 ||
      (await set(
        hasActiveNotionCreatedPageEvent$,
        {
          pageId,
        },
        signal,
      ))
    ) {
      return { pending: 0, refreshed: refreshedCreated, duplicates: 0 };
    }
    const contentUpdated = await set(
      enqueueOrRefreshNotionPageContentUpdatedEvents$,
      {
        event: args.event,
        pageId,
      },
      signal,
    );
    return {
      pending: contentUpdated.pending,
      refreshed: refreshedCreated + contentUpdated.refreshed,
      duplicates: 0,
    };
  },
);

export const dispatchNotionWebhook$ = command(
  async (
    { set },
    args: {
      readonly rawBody: string;
      readonly signature: string | null;
    },
    signal: AbortSignal,
  ): Promise<NotionWebhookDispatchResult> => {
    const rawJson = safeJsonParse(args.rawBody);
    if (rawJson === undefined) {
      return { kind: "bad_request", message: "Invalid Notion webhook payload" };
    }

    const verification = notionWebhookVerificationSchema.safeParse(rawJson);
    if (verification.success) {
      if (await set(activeVerificationTokenExists$, signal)) {
        return { kind: "unauthorized" };
      }
      await set(
        storeVerificationToken$,
        {
          token: verification.data.verification_token,
        },
        signal,
      );
      return {
        kind: "ok",
        webhookKind: "verification",
        pending: 0,
        refreshed: 0,
        duplicates: 0,
      };
    }

    const tokens = await set(loadActiveVerificationTokens$, signal);
    if (tokens.length === 0) {
      return {
        kind: "config_error",
        message: "Notion webhook verification token is not configured",
      };
    }
    if (
      !verifyNotionSignature({
        rawBody: args.rawBody,
        signature: args.signature,
        tokens,
      })
    ) {
      return { kind: "unauthorized" };
    }

    const metadataResult = notionWebhookLogMetadataSchema.safeParse(rawJson);
    const metadata = metadataResult.success ? metadataResult.data : null;
    if (
      metadata?.notionEventType !== undefined &&
      !notionWebhookEventTypeSchema.safeParse(metadata.notionEventType).success
    ) {
      log.error("Notion webhook event type is unsupported", {
        type: "notion_webhook_unsupported_event_type",
        ...metadata,
      });
      return ACKNOWLEDGED_NOTION_EVENT_RESULT;
    }

    const event = notionWebhookEventSchema.safeParse(rawJson);
    if (!event.success) {
      log.error("Notion webhook event schema validation failed", {
        type: "notion_webhook_schema_validation_failed",
        ...metadata,
        validationIssueCount: event.error.issues.length,
        validationIssues: event.error.issues
          .slice(0, NOTION_VALIDATION_ISSUE_LOG_LIMIT)
          .map((issue) => {
            return {
              path:
                issue.path.length === 0
                  ? "<root>"
                  : issue.path.map(String).join("."),
              code: issue.code,
            };
          }),
        validationIssuesOmitted: Math.max(
          0,
          event.error.issues.length - NOTION_VALIDATION_ISSUE_LOG_LIMIT,
        ),
      });
      return ACKNOWLEDGED_NOTION_EVENT_RESULT;
    }

    const result = await set(
      dispatchNotionEvent$,
      {
        event: event.data,
      },
      signal,
    );
    return {
      kind: "ok",
      webhookKind: "event",
      pending: result.pending,
      refreshed: result.refreshed,
      duplicates: result.duplicates,
    };
  },
);

const loadDueNotionPendingEvents$ = command(
  async (
    { set },
    args: {
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<readonly NotionPendingRow[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select(notionPendingEventColumns())
      .from(notionWorkflowPendingEvents)
      .where(
        and(
          eq(notionWorkflowPendingEvents.status, "pending"),
          lte(notionWorkflowPendingEvents.runAfter, args.currentTime),
        ),
      )
      .orderBy(asc(notionWorkflowPendingEvents.runAfter))
      .limit(NOTION_PENDING_BATCH_SIZE);
    signal.throwIfAborted();
    return rows;
  },
);

const executeDueNotionAutomationEventsBatch$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ExecuteDueNotionEventsResult> => {
    const dueEvents = await set(
      loadDueNotionPendingEvents$,
      {
        currentTime: nowDate(),
      },
      signal,
    );
    let executed = 0;
    let skipped = 0;
    for (const pending of dueEvents) {
      const claimed = await set(
        claimNotionPendingEvent$,
        {
          pending,
          currentTime: nowDate(),
        },
        signal,
      );
      if (!claimed) {
        continue;
      }
      const outcome = await set(
        processClaimedNotionPendingEvent$,
        {
          pending: claimed,
        },
        signal,
      );
      if (outcome === "executed") {
        executed += 1;
      } else {
        skipped += 1;
      }
    }
    return { executed, skipped };
  },
);

const claimNotionPendingEvent$ = command(
  async (
    { set },
    args: {
      readonly pending: NotionPendingRow;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<NotionPendingRow | null> => {
    const db = set(writeDb$);
    const [claimed] = await db
      .update(notionWorkflowPendingEvents)
      .set({
        status: "running",
        attempts: sql`${notionWorkflowPendingEvents.attempts} + 1`,
        updatedAt: args.currentTime,
      })
      .where(
        and(
          eq(notionWorkflowPendingEvents.id, args.pending.id),
          eq(notionWorkflowPendingEvents.status, "pending"),
          lte(notionWorkflowPendingEvents.runAfter, args.currentTime),
        ),
      )
      .returning(notionPendingEventColumns());
    signal.throwIfAborted();
    return claimed ?? null;
  },
);

const loadDueNotionAutomationRow$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
    },
    signal: AbortSignal,
  ): Promise<DueNotionAutomationRow | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        automation: workflowAutomationColumns(),
        agentId: workflows.agentId,
        workflowName: workflows.name,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
      .leftJoin(
        workflowUserAutomationThreads,
        and(
          eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
          eq(
            workflowUserAutomationThreads.userId,
            workflowAutomations.ownerUserId,
          ),
          eq(
            workflowUserAutomationThreads.workflowId,
            workflowAutomations.workflowId,
          ),
        ),
      )
      .where(eq(workflowAutomations.id, args.automationId))
      .limit(1);
    signal.throwIfAborted();
    return row ?? null;
  },
);

const skipPendingEvent$ = command(
  async (
    { set },
    args: {
      readonly pendingId: string;
      readonly reason: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(notionWorkflowPendingEvents)
      .set({
        status: "skipped",
        skipReason: args.reason,
        processedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(eq(notionWorkflowPendingEvents.id, args.pendingId));
    signal.throwIfAborted();
  },
);

const retryPendingEvent$ = command(
  async (
    { set },
    args: {
      readonly pending: NotionPendingRow;
      readonly message: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (args.pending.attempts >= NOTION_PENDING_MAX_ATTEMPTS) {
      await set(
        skipPendingEvent$,
        {
          pendingId: args.pending.id,
          reason: args.message,
        },
        signal,
      );
      return;
    }
    await db
      .update(notionWorkflowPendingEvents)
      .set({
        status: "pending",
        lastError: args.message,
        runAfter: new Date(now() + NOTION_PENDING_RETRY_MS),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(notionWorkflowPendingEvents.id, args.pending.id),
          eq(notionWorkflowPendingEvents.status, "running"),
        ),
      );
    signal.throwIfAborted();
  },
);

const NOTION_PAGE_BODY_NOTE =
  "Not included below: the Notion page body and child blocks. Connected Notion tools and the Notion API return them for the page id below.";

function notionChildPageTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly config: NotionChildPageCreatedEventConfig;
  readonly page: NotionPageResponse;
  readonly parent: NotionPageReference;
  readonly firstEventAt: Date;
  readonly latestEventAt: Date;
}): WorkflowAutomationContext {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  return {
    workflowName: args.workflowName,
    eventType: "notion-child-page-created",
    trigger: `Notion child page ${args.page.id} was created under the configured parent page (latest change ${args.latestEventAt.toISOString()}).`,
    notes: [NOTION_PAGE_BODY_NOTE],
    event: {
      automationId: args.automationId,
      event: args.config.event,
      connectorId: args.config.connectorId,
      page: {
        id: args.page.id,
        title: pageTitle,
        url: args.page.url ?? null,
        createdTime: args.page.created_time ?? null,
        lastEditedTime: args.page.last_edited_time ?? null,
      },
      parent: {
        id: args.parent.id,
        title: args.parent.title,
        url: args.parent.url,
      },
      firstEventAt: args.firstEventAt.toISOString(),
      latestEventAt: args.latestEventAt.toISOString(),
    },
  };
}

function notionDatabaseItemTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly config: NotionDatabaseItemCreatedEventConfig;
  readonly page: NotionPageResponse;
  readonly dataSource: NotionDataSourceReference;
  readonly firstEventAt: Date;
  readonly latestEventAt: Date;
}): WorkflowAutomationContext {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  return {
    workflowName: args.workflowName,
    eventType: "notion-database-item-created",
    trigger: `Notion database item ${args.page.id} was created in the configured database (latest change ${args.latestEventAt.toISOString()}).`,
    notes: [NOTION_PAGE_BODY_NOTE],
    event: {
      automationId: args.automationId,
      event: args.config.event,
      connectorId: args.config.connectorId,
      page: {
        id: args.page.id,
        title: pageTitle,
        url: args.page.url ?? null,
        createdTime: args.page.created_time ?? null,
        lastEditedTime: args.page.last_edited_time ?? null,
        properties: args.page.properties ?? {},
      },
      dataSource: {
        id: args.dataSource.id,
        title: args.dataSource.title,
        url: args.dataSource.url,
      },
      firstEventAt: args.firstEventAt.toISOString(),
      latestEventAt: args.latestEventAt.toISOString(),
    },
  };
}

function notionPageContentUpdatedTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly config: NotionPageContentUpdatedEventConfig;
  readonly page: NotionPageResponse;
  readonly scope: NotionPageContentUpdatedScope;
  readonly firstEventAt: Date;
  readonly latestEventAt: Date;
  readonly latestEventContext: NotionWorkflowPendingEventContext | null;
}): WorkflowAutomationContext {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const scope =
    args.scope.type === "page"
      ? {
          type: "page" as const,
          page: {
            id: args.scope.page.id,
            title: args.scope.page.title,
            url: args.scope.page.url,
          },
        }
      : {
          type: "database" as const,
          dataSource: {
            id: args.scope.dataSource.id,
            title: args.scope.dataSource.title,
            url: args.scope.dataSource.url,
          },
        };
  return {
    workflowName: args.workflowName,
    eventType: "notion-page-content-updated",
    trigger: `Notion page ${args.page.id} content was updated (latest change ${args.latestEventAt.toISOString()}).`,
    notes: [NOTION_PAGE_BODY_NOTE],
    event: {
      automationId: args.automationId,
      event: args.config.event,
      connectorId: args.config.connectorId,
      page: {
        id: args.page.id,
        title: pageTitle,
        url: args.page.url ?? null,
        createdTime: args.page.created_time ?? null,
        lastEditedTime: args.page.last_edited_time ?? null,
        properties: args.page.properties ?? {},
      },
      scope,
      firstEventAt: args.firstEventAt.toISOString(),
      latestEventAt: args.latestEventAt.toISOString(),
      latestEventContext: args.latestEventContext,
    },
  };
}

function buildNotionChildPageWorkflowAutomationBrief(args: {
  readonly page: NotionPageResponse;
  readonly parent: NotionPageReference;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const parentTitle = args.parent.title ?? "configured parent";
  return `New Notion child page${pageTitle ? ` "${pageTitle}"` : ""} under ${parentTitle}`;
}

function buildNotionDatabaseItemWorkflowAutomationBrief(args: {
  readonly page: NotionPageResponse;
  readonly dataSource: NotionDataSourceReference;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const dataSourceTitle = args.dataSource.title ?? "configured database";
  return `New Notion database item${pageTitle ? ` "${pageTitle}"` : ""} in ${dataSourceTitle}`;
}

function buildNotionPageContentUpdatedWorkflowAutomationBrief(args: {
  readonly page: NotionPageResponse;
  readonly scope: NotionPageContentUpdatedScope;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const scopeTitle =
    args.scope.type === "page"
      ? (args.scope.page.title ?? "configured page")
      : (args.scope.dataSource.title ?? "configured database");
  return `Notion page content updated${pageTitle ? ` "${pageTitle}"` : ""} in ${scopeTitle}`;
}

async function resolveCurrentParentReference(
  args: {
    readonly accessToken: string;
    readonly config: NotionChildPageCreatedEventConfig;
  },
  signal: AbortSignal,
): Promise<NotionPageReference> {
  const parentResult = await retrieveNotionPage(
    {
      accessToken: args.accessToken,
      pageId: args.config.parentPage.id,
    },
    signal,
  );
  signal.throwIfAborted();
  if (parentResult.kind !== "ok") {
    return args.config.parentPage;
  }
  return notionPageReference(parentResult.value, args.config.parentPage.rawUrl);
}

async function resolveCurrentDataSourceReference(
  args: {
    readonly accessToken: string;
    readonly config: {
      readonly dataSource: NotionDataSourceReference;
    };
  },
  signal: AbortSignal,
): Promise<NotionDataSourceReference> {
  const dataSourceResult = await retrieveNotionDataSource(
    {
      accessToken: args.accessToken,
      dataSourceId: args.config.dataSource.id,
    },
    signal,
  );
  signal.throwIfAborted();
  if (dataSourceResult.kind !== "ok") {
    return args.config.dataSource;
  }
  return notionDataSourceReference({
    dataSource: dataSourceResult.value,
    title: dataSourceResult.value.name ?? args.config.dataSource.title,
    rawUrl: args.config.dataSource.rawUrl,
  });
}

async function resolveCurrentPageContentUpdatedScope(
  args: {
    readonly accessToken: string;
    readonly page: NotionPageResponse;
    readonly scope: NotionPageContentUpdatedScope;
  },
  signal: AbortSignal,
): Promise<NotionPageContentUpdatedScope> {
  if (args.scope.type === "page") {
    return {
      type: "page",
      page: notionPageReference(args.page, args.scope.page.rawUrl),
    };
  }
  return {
    type: "data_source",
    dataSource: await resolveCurrentDataSourceReference(
      {
        accessToken: args.accessToken,
        config: { dataSource: args.scope.dataSource },
      },
      signal,
    ),
  };
}

function pageContentUpdatedScopeStillMatches(args: {
  readonly page: NotionPageResponse;
  readonly scope: NotionPageContentUpdatedScope;
}): boolean {
  return args.scope.type === "page"
    ? args.page.id === args.scope.page.id
    : notionPageParentDataSourceId(args.page) === args.scope.dataSource.id;
}

type NotionWorkflowRunStartResult =
  | { readonly kind: "source-changed" }
  | {
      readonly kind: "result";
      readonly result: RunWorkflowAutomationResult;
    };

const startNotionWorkflowRun$ = command(
  async (
    { set },
    args: {
      readonly row: DueNotionAutomationRow;
      readonly chatThreadId: string;
      readonly connectorSourceId: string;
      readonly pending: NotionPendingRow;
      readonly page: NotionPageResponse;
      readonly parent: {
        readonly title: string | null;
        readonly url: string;
      };
      readonly context: WorkflowAutomationContext;
      readonly triggerBrief: string;
    },
    signal: AbortSignal,
  ): Promise<NotionWorkflowRunStartResult> => {
    const result = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: args.row.automation,
            agentId: args.row.agentId,
            chatThreadId: args.chatThreadId,
          },
          automationContext: args.context,
          connectorSourceId: args.connectorSourceId,
          apiStartTime: now(),
          triggerSource: "automation-event",
          triggerBrief: args.triggerBrief,
          sourcePlan: {
            kind: "notion",
            source: {
              automationId: args.row.automation.id,
              orgId: args.row.automation.orgId,
              userId: args.row.automation.ownerUserId,
              pending: args.pending,
              pageTitle: notionTitleFromProperties(args.page.properties),
              pageUrl: args.page.url ?? null,
              parentTitle: args.parent.title,
              parentUrl: args.parent.url,
            },
          },
        },
        signal,
      ),
      signal,
    );
    if (result.ok) {
      return {
        kind: "result",
        result: result.value,
      };
    }
    if (result.error instanceof NotionAutomationSourceChangedError) {
      return { kind: "source-changed" };
    }
    throw result.error;
  },
);

const persistNotionWorkflowRunOutcome$ = command(
  async (
    { set },
    args: {
      readonly pending: NotionPendingRow;
      readonly result: NotionWorkflowRunStartResult;
    },
    signal: AbortSignal,
  ): Promise<"executed" | "skipped"> => {
    if (args.result.kind === "source-changed") {
      await set(
        skipPendingEvent$,
        {
          pendingId: args.pending.id,
          reason: NOTION_ACCOUNT_CHANGED_SKIP_REASON,
        },
        signal,
      );
      return "skipped";
    }
    return "executed";
  },
);

function notionAutomationIsActive(
  row: DueNotionAutomationRow,
  eventType: NotionAutomationEventType,
): boolean {
  return (
    row.automation.kind === "event" &&
    row.automation.eventType === eventType &&
    row.automation.enabled
  );
}

const skipClaimedNotionPendingEvent$ = command(
  async (
    { set },
    args: ProcessClaimedNotionPendingEventArgs,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      skipPendingEvent$,
      { pendingId: args.pending.id, reason },
      signal,
    );
  },
);

const processClaimedNotionChildPagePendingEvent$ = command(
  async (
    { set },
    args: ProcessClaimedNotionPendingEventArgs,
    signal: AbortSignal,
  ): Promise<"executed" | "skipped"> => {
    if (
      !notionAutomationIsActive(args.row, "notion-child-page-created") ||
      !args.row.chatThreadId
    ) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        "Automation is no longer active",
        signal,
      );
      return "skipped";
    }

    const config = notionChildPageCreatedEventConfigSchema.safeParse(
      args.row.automation.eventConfig,
    );
    if (
      !config.success ||
      args.pending.connectorId === null ||
      args.row.automation.eventConnectorId !== args.pending.connectorId ||
      config.data.connectorId !== args.pending.connectorId ||
      args.pending.scopeType !== "page" ||
      config.data.parentPage.id !== args.pending.scopeId
    ) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        "Automation config no longer matches",
        signal,
      );
      return "skipped";
    }
    const accessResult = await set(
      resolveNotionCredentialAccess$,
      {
        orgId: args.row.automation.orgId,
        userId: args.row.automation.ownerUserId,
        connectorId: config.data.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        accessResult.message,
        signal,
      );
      return "skipped";
    }

    const childPage = await set(
      retrieveUsablePendingNotionPage$,
      {
        pending: args.pending,
        accessToken: accessResult.access.accessToken,
      },
      signal,
    );
    if (!childPage) {
      return "skipped";
    }

    if (notionPageParentPageId(childPage) !== config.data.parentPage.id) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        NOTION_CHILD_PAGE_MOVED_SKIP_REASON,
        signal,
      );
      return "skipped";
    }

    const parent = await resolveCurrentParentReference(
      {
        accessToken: accessResult.access.accessToken,
        config: config.data,
      },
      signal,
    );
    const result = await set(
      startNotionWorkflowRun$,
      {
        row: args.row,
        chatThreadId: args.row.chatThreadId,
        connectorSourceId: args.pending.connectorId,
        pending: args.pending,
        page: childPage,
        parent,
        context: notionChildPageTriggerContext({
          workflowName: args.row.workflowName,
          automationId: args.row.automation.id,
          config: config.data,
          page: childPage,
          parent,
          firstEventAt: args.pending.firstEventAt,
          latestEventAt: args.pending.latestEventAt,
        }),
        triggerBrief: buildNotionChildPageWorkflowAutomationBrief({
          page: childPage,
          parent,
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return await set(
      persistNotionWorkflowRunOutcome$,
      { pending: args.pending, result },
      signal,
    );
  },
);

const processClaimedNotionDatabaseItemPendingEvent$ = command(
  async (
    { set },
    args: ProcessClaimedNotionPendingEventArgs,
    signal: AbortSignal,
  ): Promise<"executed" | "skipped"> => {
    if (
      !notionAutomationIsActive(args.row, "notion-database-item-created") ||
      !args.row.chatThreadId
    ) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        "Automation is no longer active",
        signal,
      );
      return "skipped";
    }

    const config = notionDatabaseItemCreatedEventConfigSchema.safeParse(
      args.row.automation.eventConfig,
    );
    if (
      !config.success ||
      args.pending.connectorId === null ||
      args.row.automation.eventConnectorId !== args.pending.connectorId ||
      config.data.connectorId !== args.pending.connectorId ||
      args.pending.scopeType !== "data_source" ||
      config.data.dataSource.id !== args.pending.scopeId
    ) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        "Automation config no longer matches",
        signal,
      );
      return "skipped";
    }
    const dataSourceId = config.data.dataSource.id;

    const accessResult = await set(
      resolveNotionCredentialAccess$,
      {
        orgId: args.row.automation.orgId,
        userId: args.row.automation.ownerUserId,
        connectorId: config.data.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        accessResult.message,
        signal,
      );
      return "skipped";
    }

    const page = await set(
      retrieveUsablePendingNotionPage$,
      {
        pending: args.pending,
        accessToken: accessResult.access.accessToken,
      },
      signal,
    );
    if (!page) {
      return "skipped";
    }

    if (notionPageParentDataSourceId(page) !== dataSourceId) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        NOTION_DATABASE_ITEM_MOVED_SKIP_REASON,
        signal,
      );
      return "skipped";
    }

    const dataSource = await resolveCurrentDataSourceReference(
      {
        accessToken: accessResult.access.accessToken,
        config: config.data,
      },
      signal,
    );
    const result = await set(
      startNotionWorkflowRun$,
      {
        row: args.row,
        chatThreadId: args.row.chatThreadId,
        connectorSourceId: args.pending.connectorId,
        pending: args.pending,
        page,
        parent: dataSource,
        context: notionDatabaseItemTriggerContext({
          workflowName: args.row.workflowName,
          automationId: args.row.automation.id,
          config: config.data,
          page,
          dataSource,
          firstEventAt: args.pending.firstEventAt,
          latestEventAt: args.pending.latestEventAt,
        }),
        triggerBrief: buildNotionDatabaseItemWorkflowAutomationBrief({
          page,
          dataSource,
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return await set(
      persistNotionWorkflowRunOutcome$,
      { pending: args.pending, result },
      signal,
    );
  },
);

const retrieveUsablePendingNotionPage$ = command(
  async (
    { set },
    args: {
      readonly pending: NotionPendingRow;
      readonly accessToken: string;
    },
    signal: AbortSignal,
  ): Promise<NotionPageResponse | null> => {
    const pageResult = await retrieveNotionPage(
      {
        accessToken: args.accessToken,
        pageId: args.pending.pageId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (pageResult.kind === "transient_error") {
      await set(
        retryPendingEvent$,
        {
          pending: args.pending,
          message: pageResult.message,
        },
        signal,
      );
      return null;
    }
    if (pageResult.kind !== "ok" || !pageIsUsable(pageResult.value)) {
      await set(
        skipPendingEvent$,
        {
          pendingId: args.pending.id,
          reason: "Notion page is no longer accessible",
        },
        signal,
      );
      return null;
    }
    return pageResult.value;
  },
);

const processClaimedNotionPageContentUpdatedPendingEvent$ = command(
  async (
    { set },
    args: ProcessClaimedNotionPendingEventArgs,
    signal: AbortSignal,
  ): Promise<"executed" | "skipped"> => {
    if (
      !notionAutomationIsActive(args.row, "notion-page-content-updated") ||
      !args.row.chatThreadId
    ) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        "Automation is no longer active",
        signal,
      );
      return "skipped";
    }

    const config = notionPageContentUpdatedEventConfigSchema.safeParse(
      args.row.automation.eventConfig,
    );
    if (
      !config.success ||
      args.pending.connectorId === null ||
      args.row.automation.eventConnectorId !== args.pending.connectorId ||
      config.data.connectorId !== args.pending.connectorId ||
      args.pending.scopeType !==
        pageContentUpdatedScopeType(config.data.scope) ||
      args.pending.scopeId !== pageContentUpdatedScopeId(config.data.scope)
    ) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        "Automation config no longer matches",
        signal,
      );
      return "skipped";
    }

    const accessResult = await set(
      resolveNotionCredentialAccess$,
      {
        orgId: args.row.automation.orgId,
        userId: args.row.automation.ownerUserId,
        connectorId: config.data.connectorId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (accessResult.kind !== "ok") {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        accessResult.message,
        signal,
      );
      return "skipped";
    }

    const page = await set(
      retrieveUsablePendingNotionPage$,
      {
        pending: args.pending,
        accessToken: accessResult.access.accessToken,
      },
      signal,
    );
    if (!page) {
      return "skipped";
    }

    if (
      !pageContentUpdatedScopeStillMatches({
        page,
        scope: config.data.scope,
      })
    ) {
      await set(
        skipClaimedNotionPendingEvent$,
        args,
        NOTION_PAGE_CONTENT_UPDATED_MOVED_SKIP_REASON,
        signal,
      );
      return "skipped";
    }

    const scope = await resolveCurrentPageContentUpdatedScope(
      {
        accessToken: accessResult.access.accessToken,
        page,
        scope: config.data.scope,
      },
      signal,
    );
    const result = await set(
      startNotionWorkflowRun$,
      {
        row: args.row,
        chatThreadId: args.row.chatThreadId,
        connectorSourceId: args.pending.connectorId,
        pending: args.pending,
        page,
        parent: pageContentUpdatedScopeParent(scope),
        context: notionPageContentUpdatedTriggerContext({
          workflowName: args.row.workflowName,
          automationId: args.row.automation.id,
          config: config.data,
          page,
          scope,
          firstEventAt: args.pending.firstEventAt,
          latestEventAt: args.pending.latestEventAt,
          latestEventContext: args.pending.latestEventContext ?? null,
        }),
        triggerBrief: buildNotionPageContentUpdatedWorkflowAutomationBrief({
          page,
          scope,
        }),
      },
      signal,
    );
    signal.throwIfAborted();
    return await set(
      persistNotionWorkflowRunOutcome$,
      { pending: args.pending, result },
      signal,
    );
  },
);

const processClaimedNotionPendingEvent$ = command(
  async (
    { set },
    args: {
      readonly pending: NotionPendingRow;
    },
    signal: AbortSignal,
  ): Promise<"executed" | "skipped"> => {
    const row = await set(
      loadDueNotionAutomationRow$,
      {
        automationId: args.pending.automationId,
      },
      signal,
    );
    if (!row) {
      return "skipped";
    }
    if (args.pending.eventFamily === "new_database_item") {
      return await set(
        processClaimedNotionDatabaseItemPendingEvent$,
        {
          ...args,
          row,
        },
        signal,
      );
    }
    if (args.pending.eventFamily === "page_content_updated") {
      return await set(
        processClaimedNotionPageContentUpdatedPendingEvent$,
        {
          ...args,
          row,
        },
        signal,
      );
    }
    return await set(
      processClaimedNotionChildPagePendingEvent$,
      {
        ...args,
        row,
      },
      signal,
    );
  },
);

export const executeDueNotionAutomationEvents$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ExecuteDueNotionEventsResult> => {
    return await set(executeDueNotionAutomationEventsBatch$, signal);
  },
);
