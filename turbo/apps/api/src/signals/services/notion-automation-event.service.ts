import { automationWorkflowJoinCondition } from "./workflow-visibility";
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
import { connectors } from "@okouai/db/schema/connector";
import {
  notionWebhookEvents,
  notionWebhookSecrets,
  notionWorkflowPendingEvents,
  type NotionWorkflowPendingEventContext,
} from "@okouai/db/schema/notion-event";
import {
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  array,
  iso,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
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
import {
  readWorkflowAutomationConnectorAccount$,
  workflowAutomationBoundConnectorEligibleSql,
  workflowAutomationConnectorSelectionSql,
} from "./workflow-automation-account.service";
import type {
  AutomationRow,
  RunWorkflowAutomationResult,
} from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { NotionAutomationSourceChangedError } from "./workflow-notion-queue.service";
import {
  NOTION_ACCOUNT_CHANGED_SKIP_REASON,
  notionAutomationProjectionColumns,
  notionAutomationProjectionCondition,
  notionAutomationProjectionValues,
  notionConfigConnectorId,
} from "./notion-automation-account.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import {
  type NotionPageResponse,
  type NotionAutomationEventType,
  normalizeNotionUuid,
  notionTitleFromProperties,
  notionPageReference,
  notionPageParentDataSourceId,
  notionDataSourceReference,
  pageIsUsable,
  resolveNotionCredentialAccess$,
  retrieveNotionPage,
  retrieveNotionDataSource,
  validateNotionEventConfigForConnector$,
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

const notionAuthorSchema = object({
  id: string(),
  type: zEnum(["person", "bot", "agent"]),
}).passthrough();

const notionEntitySchema = object({
  id: uuid(),
  type: string(),
}).passthrough();

const notionParentDataSchema = object({
  id: string().optional(),
  type: string().optional(),
  data_source_id: string().optional(),
}).passthrough();

const notionWebhookVerificationSchema = object({
  verification_token: string().min(1),
}).passthrough();

const notionWebhookEventTypeSchema = zEnum([
  "page.created",
  "page.content_updated",
  "page.properties_updated",
]);

const notionWebhookLogMetadataSchema = object({
  id: string().optional(),
  type: string().optional(),
  subscription_id: string().optional(),
  api_version: string().optional(),
  attempt_number: number().optional(),
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

const notionWebhookEventSchema = object({
  id: uuid(),
  timestamp: iso.datetime(),
  workspace_id: uuid(),
  workspace_name: string().optional(),
  subscription_id: uuid(),
  integration_id: uuid(),
  type: notionWebhookEventTypeSchema,
  authors: array(notionAuthorSchema).default([]),
  accessible_by: array(notionAuthorSchema).optional(),
  attempt_number: number().int().positive().optional(),
  entity: notionEntitySchema,
  data: object({
    parent: notionParentDataSchema.optional(),
  })
    .passthrough()
    .default({}),
}).passthrough();

type NotionWebhookEvent = zInfer<typeof notionWebhookEventSchema>;

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
  | { readonly kind: "config_error"; readonly message: string }
  | { readonly kind: "provider_unavailable"; readonly message: string };

const ACKNOWLEDGED_NOTION_EVENT_RESULT = {
  kind: "ok",
  webhookKind: "event",
  pending: 0,
  refreshed: 0,
  duplicates: 0,
} as const satisfies NotionWebhookDispatchResult;

const DUPLICATE_NOTION_EVENT_RESULT = {
  ...ACKNOWLEDGED_NOTION_EVENT_RESULT,
  duplicates: 1,
} as const satisfies NotionWebhookDispatchResult;

type ExecuteDueNotionEventsResult = {
  readonly executed: number;
  readonly skipped: number;
};

type DueNotionAutomationRow = {
  readonly automation: AutomationRow;
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
    const retiredSecrets = db
      .$with("retired_secrets")
      .as(
        db
          .update(notionWebhookSecrets)
          .set({ active: false, updatedAt: currentTime })
          .where(eq(notionWebhookSecrets.active, true))
          .returning({ id: notionWebhookSecrets.id }),
      );
    await db
      .with(retiredSecrets)
      .insert(notionWebhookSecrets)
      .values({
        // Consume the retirement before checking the single-active unique index.
        // The aggregate yields one value even when there is no previous secret.
        encryptedVerificationToken: sql`(
        SELECT ${encryptedVerificationToken}
        FROM (SELECT ${count()} FROM ${retiredSecrets}) AS retirement
      )`,
        active: true,
        createdAt: currentTime,
        updatedAt: currentTime,
      });
    signal.throwIfAborted();
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

function notionWebhookSourceMatchesSql(event: NotionWebhookEvent) {
  if (event.accessible_by === undefined) {
    return sql`true`;
  }
  const accessibleUsers = event.accessible_by
    .filter((entry) => {
      return entry.type === "person";
    })
    .map((entry) => {
      return entry.id;
    });
  // Notion OAuth stores the authorizing user's ID as the connector external ID.
  return exists(
    new QueryBuilder()
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.id, workflowAutomations.eventConnectorId),
          inArray(connectors.externalId, accessibleUsers),
        ),
      ),
  );
}

interface NotionWebhookAutomation {
  readonly automation: AutomationRow;
  readonly eligible: boolean;
  readonly sourceMatches: boolean;
}

const queryNotionAutomations$ = command(
  async (
    { set },
    args: {
      readonly eventType: NotionAutomationEventType;
      readonly event: NotionWebhookEvent;
      readonly beforeReceipt?: boolean;
    },
    signal: AbortSignal,
  ): Promise<readonly NotionWebhookAutomation[]> => {
    const db = set(writeDb$);
    const existingReceipt = db
      .select({ id: notionWebhookEvents.id })
      .from(notionWebhookEvents)
      .where(eq(notionWebhookEvents.notionEventId, args.event.id));
    const rows = await db
      .select({
        automation: workflowAutomationColumns(),
        eligible:
          workflowAutomationBoundConnectorEligibleSql("notion").mapWith(
            pgBooleanDecoder,
          ),
        sourceMatches: notionWebhookSourceMatchesSql(args.event).mapWith(
          pgBooleanDecoder,
        ),
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.kind, "event"),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.eventType, args.eventType),
          notionWebhookScopeCondition(args.eventType, args.event),
          args.beforeReceipt ? notExists(existingReceipt) : undefined,
        ),
      );
    signal.throwIfAborted();
    return rows;
  },
);

type NotionProjectionObservation = Pick<
  AutomationRow,
  | "id"
  | "orgId"
  | "ownerUserId"
  | "workflowId"
  | "eventType"
  | "eventConfig"
  | "eventConnectorId"
>;

interface NotionProjectionUpdate {
  readonly automation: NotionProjectionObservation;
  readonly selectedConnectorId: string | null;
  readonly values: NonNullable<
    ReturnType<typeof notionAutomationProjectionValues>
  >;
}

function notionProjectionScope(automation: NotionProjectionObservation) {
  return {
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    workflowId: automation.workflowId,
    connectorSlug: "notion" as const,
  };
}

const selectNotionProjectionUpdate$ = command(
  async (
    { set },
    automation: NotionProjectionObservation,
    signal: AbortSignal,
  ): Promise<NotionProjectionUpdate | null> => {
    const selectedConnectorId = await set(
      readWorkflowAutomationConnectorAccount$,
      notionProjectionScope(automation),
      signal,
    );
    const values = notionAutomationProjectionValues(
      automation,
      selectedConnectorId,
    );
    return values === null ? null : { automation, selectedConnectorId, values };
  },
);

const publishNotionProjectionUpdate$ = command(
  async (
    { set },
    update: NotionProjectionUpdate,
    requireEnabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { automation, selectedConnectorId, values } = update;
    const scope = notionProjectionScope(automation);
    const selectionSql = workflowAutomationConnectorSelectionSql({
      ...scope,
      workflowId: sql`${scope.workflowId}`,
    });
    // Only retarget the observed resource if the selection still resolves to
    // the prepared account. A concurrent reconfiguration owns its new scope.
    const currentTime = nowDate();
    const retargeted = db.$with("retargeted_notion_automation").as(
      db
        .update(workflowAutomations)
        .set(values)
        .where(
          and(
            eq(workflowAutomations.id, automation.id),
            notionAutomationProjectionCondition(scope),
            eq(workflowAutomations.workflowId, automation.workflowId),
            sql`${workflowAutomations.eventType} IS NOT DISTINCT FROM ${automation.eventType}`,
            requireEnabled ? eq(workflowAutomations.enabled, true) : undefined,
            sql`${workflowAutomations.eventConnectorId} IS NOT DISTINCT FROM ${automation.eventConnectorId}::uuid`,
            automation.eventConfig === null
              ? isNull(workflowAutomations.eventConfig)
              : eq(workflowAutomations.eventConfig, automation.eventConfig),
            sql`(${selectionSql}) IS NOT DISTINCT FROM ${selectedConnectorId}::uuid`,
          ),
        )
        .returning({ id: workflowAutomations.id }),
    );
    await db
      .with(retargeted)
      .update(notionWorkflowPendingEvents)
      .set({
        status: "skipped",
        skipReason: NOTION_ACCOUNT_CHANGED_SKIP_REASON,
        processedAt: currentTime,
        updatedAt: currentTime,
      })
      .where(
        and(
          inArray(
            notionWorkflowPendingEvents.automationId,
            db.select({ id: retargeted.id }).from(retargeted),
          ),
          inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
        ),
      );
    signal.throwIfAborted();
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
    const [automation] = await db
      .select(notionAutomationProjectionColumns())
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.id, args.automationId),
          notionAutomationProjectionCondition(args),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!automation) {
      return;
    }
    const update = await set(
      selectNotionProjectionUpdate$,
      { ...automation, orgId: args.orgId, ownerUserId: args.userId },
      signal,
    );
    if (update !== null) {
      await set(publishNotionProjectionUpdate$, update, false, signal);
    }
  },
);

export const repairNotionAutomationAccountProjectionsForOwner$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const rows = await db
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(notionAutomationProjectionCondition(owner))
      .orderBy(asc(workflowAutomations.id));
    signal.throwIfAborted();
    for (const row of rows) {
      await set(
        repairNotionAutomationProjection$,
        { ...owner, automationId: row.id },
        signal,
      );
    }
  },
);

function notionWebhookScopeCondition(
  eventType: NotionAutomationEventType,
  event: NotionWebhookEvent,
) {
  const config = workflowAutomations.eventConfig;
  switch (eventType) {
    case "notion-child-page-created": {
      return eq(sql`${config}->'parentPage'->>'id'`, eventPageParentId(event));
    }
    case "notion-database-item-created": {
      return eq(
        sql`${config}->'dataSource'->>'id'`,
        eventDataSourceParentId(event),
      );
    }
    case "notion-page-content-updated": {
      const dataSourceId = eventDataSourceParentId(event);
      // Without a data-source identity, retain the provider's current parent
      // lookup, including when a delayed event still names a page parent.
      return or(
        eq(sql`${config}->'scope'->'page'->>'id'`, eventPageId(event)),
        and(
          eq(sql`${config}->'scope'->>'type'`, "data_source"),
          dataSourceId === null
            ? undefined
            : eq(sql`${config}->'scope'->'dataSource'->>'id'`, dataSourceId),
        ),
      );
    }
  }
}

interface VerifiedNotionDataSource {
  readonly connectorId: string;
  readonly dataSourceId: string;
}

interface PreparedNotionWebhookAutomations {
  readonly kind: "prepared";
  readonly observations: readonly NotionWebhookAutomation[];
  readonly updates: readonly NotionProjectionUpdate[];
  readonly verifiedDataSources: ReadonlyMap<string, VerifiedNotionDataSource>;
  readonly reload: boolean;
}

type NotionWebhookRepairUnavailable = Extract<
  NotionWebhookDispatchResult,
  { kind: "provider_unavailable" }
>;

const prepareNotionWebhookAutomations$ = command(
  async (
    { set },
    args: {
      readonly eventType: NotionAutomationEventType;
      readonly event: NotionWebhookEvent;
    },
    signal: AbortSignal,
  ): Promise<
    PreparedNotionWebhookAutomations | NotionWebhookRepairUnavailable
  > => {
    const observations = await set(
      queryNotionAutomations$,
      { ...args, beforeReceipt: true },
      signal,
    );
    const stale = observations
      .filter(({ automation, eligible }) => {
        return (
          !eligible ||
          notionConfigConnectorId(
            automation.eventType,
            automation.eventConfig,
          ) !== automation.eventConnectorId
        );
      })
      .sort((left, right) => {
        return left.automation.id.localeCompare(right.automation.id);
      });
    // Finish provider checks before recording the delivery or retargeting any
    // binding, so transient failures can be retried without partial changes.
    const updates: NotionProjectionUpdate[] = [];
    const verifiedDataSources = new Map<string, VerifiedNotionDataSource>();
    const pageWithoutDataSource =
      args.eventType === "notion-page-content-updated" &&
      eventDataSourceParentId(args.event) === null
        ? eventPageId(args.event)
        : null;
    for (const { automation } of stale) {
      const contentConfig =
        pageWithoutDataSource === null
          ? null
          : notionPageContentUpdatedEventConfigSchema.safeParse(
              automation.eventConfig,
            );
      const dataSource =
        contentConfig?.success &&
        contentConfig.data.scope.type === "data_source"
          ? contentConfig.data.scope.dataSource
          : null;
      const update = await set(
        selectNotionProjectionUpdate$,
        automation,
        signal,
      );
      if (update === null) {
        continue;
      }
      if (update.selectedConnectorId === null) {
        if (dataSource === null) {
          updates.push(update);
        }
        continue;
      }
      const validation = await set(
        validateNotionEventConfigForConnector$,
        {
          orgId: automation.orgId,
          userId: automation.ownerUserId,
          connectorId: update.selectedConnectorId,
          eventType: args.eventType,
          eventConfig: update.values.eventConfig,
          dataSourcePageId:
            dataSource === null
              ? undefined
              : (pageWithoutDataSource ?? undefined),
        },
        signal,
      );
      if (validation.kind === "provider-unavailable") {
        return { kind: "provider_unavailable", message: validation.message };
      }
      if (validation.kind === "scope-mismatch") {
        continue;
      }
      if (validation.kind === "ok" && dataSource !== null) {
        verifiedDataSources.set(automation.id, {
          connectorId: update.selectedConnectorId,
          dataSourceId: dataSource.id,
        });
      }
      const values =
        validation.kind === "ok"
          ? update.values
          : notionAutomationProjectionValues(automation, null);
      if (values !== null) {
        updates.push({ ...update, values });
      }
    }
    return {
      kind: "prepared",
      observations,
      updates,
      verifiedDataSources,
      reload: stale.length > 0,
    };
  },
);

const publishNotionWebhookAutomations$ = command(
  async (
    { set },
    args: {
      readonly eventType: NotionAutomationEventType;
      readonly event: NotionWebhookEvent;
      readonly prepared: PreparedNotionWebhookAutomations;
    },
    signal: AbortSignal,
  ): Promise<readonly AutomationRow[]> => {
    const { observations, updates, reload } = args.prepared;
    for (const update of updates) {
      await set(publishNotionProjectionUpdate$, update, true, signal);
    }
    const current = reload
      ? await set(
          queryNotionAutomations$,
          { eventType: args.eventType, event: args.event },
          signal,
        )
      : observations;
    const originalSources =
      reload && args.event.accessible_by === undefined
        ? new Map(
            observations.map(({ automation }) => {
              return [automation.id, automation.eventConnectorId] as const;
            }),
          )
        : undefined;
    return current
      .filter(({ automation, eligible, sourceMatches }) => {
        // A delivery without a provider account list keeps its original binding.
        return (
          eligible &&
          sourceMatches &&
          (originalSources === undefined ||
            originalSources.get(automation.id) === automation.eventConnectorId)
        );
      })
      .map(({ automation }) => {
        return automation;
      });
  },
);

const enqueueNotionChildPageEvents$ = command(
  async (
    { set },
    args: {
      readonly automations: readonly AutomationRow[];
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
      readonly parentPageId: string;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    let pending = 0;
    for (const automation of args.automations) {
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
          event: args.event,
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
      readonly automations: readonly AutomationRow[];
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
      readonly dataSourceId: string;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    let pending = 0;
    for (const automation of args.automations) {
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
          event: args.event,
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
      readonly event: NotionWebhookEvent;
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
      workflowAutomationBoundConnectorEligibleSql("notion"),
      notionWebhookSourceMatchesSql(args.event),
    );
    const published = await settle(
      (async (): Promise<NotionPendingPublication> => {
        const [current] = await db
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
          const [updated] = await db
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
        const [inserted] = await db
          .insert(notionWorkflowPendingEvents)
          .values(args.pendingEvent)
          .onConflictDoNothing()
          .returning({ id: notionWorkflowPendingEvents.id });
        signal.throwIfAborted();
        return inserted ? "inserted" : "none";
      })(),
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
      readonly verifiedDataSource: VerifiedNotionDataSource | undefined;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.config.scope.type === "page") {
      return args.config.scope.page.id === args.pageId;
    }
    if (
      args.verifiedDataSource?.connectorId === args.config.connectorId &&
      args.verifiedDataSource.dataSourceId === args.config.scope.dataSource.id
    ) {
      return true;
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
      readonly automations: readonly AutomationRow[];
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
      readonly verifiedDataSources: ReadonlyMap<
        string,
        VerifiedNotionDataSource
      >;
    },
    signal: AbortSignal,
  ): Promise<{ readonly pending: number; readonly refreshed: number }> => {
    let pending = 0;
    let refreshed = 0;
    for (const automation of args.automations) {
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
            verifiedDataSource: args.verifiedDataSources.get(automation.id),
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
          event: args.event,
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

function activeNotionCreatedEventCondition(
  event: NotionWebhookEvent,
  pageId: string,
) {
  const consumer = new QueryBuilder()
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, notionWorkflowPendingEvents.automationId),
        eq(workflowAutomations.enabled, true),
        eq(
          workflowAutomations.eventConnectorId,
          notionWorkflowPendingEvents.connectorId,
        ),
        workflowAutomationBoundConnectorEligibleSql("notion"),
        notionWebhookSourceMatchesSql(event),
      ),
    );
  return and(
    eq(notionWorkflowPendingEvents.pageId, pageId),
    inArray(notionWorkflowPendingEvents.eventFamily, [
      "new_child_page",
      "new_database_item",
    ]),
    or(
      isNull(notionWorkflowPendingEvents.latestEventContext),
      eq(
        sql`${notionWorkflowPendingEvents.latestEventContext}->>'workspaceId'`,
        event.workspace_id,
      ),
    ),
    exists(consumer),
  );
}

type NotionPageUpdateReceipt =
  | { readonly kind: "unmatched" | "duplicate" }
  | {
      readonly kind: "accepted";
      readonly coalesced: boolean;
      readonly refreshed: number;
    };

const claimNotionPageUpdate$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
      readonly pageId: string;
      readonly coalesceOnly: boolean;
    },
    signal: AbortSignal,
  ): Promise<NotionPageUpdateReceipt> => {
    const db = set(writeDb$);
    const { event, pageId } = args;
    const currentTime = nowDate();
    const active = db.$with("active_notion_created_events").as(
      db
        .select({ id: notionWorkflowPendingEvents.id })
        .from(notionWorkflowPendingEvents)
        .where(
          and(
            activeNotionCreatedEventCondition(event, pageId),
            inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
          ),
        ),
    );
    const activeIds = db.select({ id: active.id }).from(active);
    const hasActive = exists(activeIds);
    const receipt = db.$with("received_notion_page_update").as(
      db
        .insert(notionWebhookEvents)
        .select(
          sql`SELECT gen_random_uuid(), ${event.id}, ${event.type}, ${pageId},
            ${sql.param(currentTime, notionWebhookEvents.receivedAt)},
            ${sql.param(currentTime, notionWebhookEvents.createdAt)}
          WHERE ${args.coalesceOnly ? hasActive : sql`true`}`,
        )
        .onConflictDoNothing()
        .returning({ id: notionWebhookEvents.id }),
    );
    const claimed = exists(db.select({ id: receipt.id }).from(receipt));
    const refreshed = db.$with("refreshed_notion_created_events").as(
      db
        .update(notionWorkflowPendingEvents)
        .set({
          latestNotionEventId: event.id,
          latestEventAt: eventTimestamp(event),
          latestEventContext: notionEventContext(event),
          runAfter: runAfterForEvent(event),
          updatedAt: currentTime,
        })
        .where(
          and(
            claimed,
            inArray(notionWorkflowPendingEvents.id, activeIds),
            eq(notionWorkflowPendingEvents.status, "pending"),
          ),
        )
        .returning({ id: notionWorkflowPendingEvents.id }),
    );
    const previouslyReceived = exists(
      db
        .select({ id: notionWebhookEvents.id })
        .from(notionWebhookEvents)
        .where(eq(notionWebhookEvents.notionEventId, event.id)),
    );
    const [result] = await db
      .with(active, receipt, refreshed)
      .select({
        claimed: claimed.mapWith(pgBooleanDecoder),
        coalesced: hasActive.mapWith(pgBooleanDecoder),
        previouslyReceived: previouslyReceived.mapWith(pgBooleanDecoder),
        refreshed: count(),
      })
      .from(refreshed);
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Notion page update receipt returned no outcome");
    }
    if (result.claimed) {
      return {
        kind: "accepted",
        coalesced: result.coalesced,
        refreshed: result.refreshed,
      };
    }
    return {
      kind:
        args.coalesceOnly && !result.coalesced && !result.previouslyReceived
          ? "unmatched"
          : "duplicate",
    };
  },
);

function notionWebhookEventTarget(event: NotionWebhookEvent) {
  if (event.type === "page.content_updated") {
    return { eventType: "notion-page-content-updated" } as const;
  }
  if (event.type !== "page.created") {
    return null;
  }
  const parentPageId = eventPageParentId(event);
  if (parentPageId !== null) {
    return { eventType: "notion-child-page-created", parentPageId } as const;
  }
  const dataSourceId = eventDataSourceParentId(event);
  return dataSourceId === null
    ? null
    : ({ eventType: "notion-database-item-created", dataSourceId } as const);
}

const dispatchNotionEvent$ = command(
  async (
    { set },
    args: {
      readonly event: NotionWebhookEvent;
    },
    signal: AbortSignal,
  ): Promise<NotionWebhookDispatchResult> => {
    const { event } = args;
    const pageId = eventPageId(event);
    if (!pageId) {
      return ACKNOWLEDGED_NOTION_EVENT_RESULT;
    }

    if (event.type !== "page.created") {
      const receipt = await set(
        claimNotionPageUpdate$,
        { event, pageId, coalesceOnly: event.type === "page.content_updated" },
        signal,
      );
      if (receipt.kind === "duplicate") {
        return DUPLICATE_NOTION_EVENT_RESULT;
      }
      if (receipt.kind === "accepted") {
        return {
          ...ACKNOWLEDGED_NOTION_EVENT_RESULT,
          refreshed: receipt.refreshed,
        };
      }
    }

    const target = notionWebhookEventTarget(event);
    if (target === null) {
      return (await set(insertNotionWebhookEvent$, { event, pageId }, signal))
        ? ACKNOWLEDGED_NOTION_EVENT_RESULT
        : DUPLICATE_NOTION_EVENT_RESULT;
    }
    const prepared = await set(
      prepareNotionWebhookAutomations$,
      { eventType: target.eventType, event },
      signal,
    );
    if (prepared.kind === "provider_unavailable") {
      return prepared;
    }

    if (target.eventType === "notion-page-content-updated") {
      const receipt = await set(
        claimNotionPageUpdate$,
        { event, pageId, coalesceOnly: false },
        signal,
      );
      if (receipt.kind === "duplicate") {
        return DUPLICATE_NOTION_EVENT_RESULT;
      }
      if (receipt.kind !== "accepted") {
        throw new Error("Notion content update was not accepted");
      }
      if (receipt.coalesced) {
        return {
          ...ACKNOWLEDGED_NOTION_EVENT_RESULT,
          refreshed: receipt.refreshed,
        };
      }
    } else if (
      !(await set(insertNotionWebhookEvent$, { event, pageId }, signal))
    ) {
      return DUPLICATE_NOTION_EVENT_RESULT;
    }

    const automations = await set(
      publishNotionWebhookAutomations$,
      { eventType: target.eventType, event, prepared },
      signal,
    );
    const dispatch = { automations, event, pageId };
    switch (target.eventType) {
      case "notion-child-page-created": {
        const pending = await set(
          enqueueNotionChildPageEvents$,
          { ...dispatch, parentPageId: target.parentPageId },
          signal,
        );
        return { ...ACKNOWLEDGED_NOTION_EVENT_RESULT, pending };
      }
      case "notion-database-item-created": {
        const pending = await set(
          enqueueNotionDatabaseItemEvents$,
          { ...dispatch, dataSourceId: target.dataSourceId },
          signal,
        );
        return { ...ACKNOWLEDGED_NOTION_EVENT_RESULT, pending };
      }
      case "notion-page-content-updated": {
        const outcome = await set(
          enqueueOrRefreshNotionPageContentUpdatedEvents$,
          { ...dispatch, verifiedDataSources: prepared.verifiedDataSources },
          signal,
        );
        return { ...ACKNOWLEDGED_NOTION_EVENT_RESULT, ...outcome };
      }
    }
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

    return await set(
      dispatchNotionEvent$,
      {
        event: event.data,
      },
      signal,
    );
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
        workflowName: workflows.name,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, automationWorkflowJoinCondition())
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
      .where(
        and(
          eq(workflowAutomations.id, args.automationId),
          workflowAutomationBoundConnectorEligibleSql("notion"),
        ),
      )
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
          automation: args.row.automation,
          chatThreadId: args.chatThreadId,
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
