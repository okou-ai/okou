import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
  type NotionChildPageCreatedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionDatabaseItemCreatedEventConfig,
  type NotionDatabaseItemCreatedEventCreateConfig,
  type NotionDataSourceReference,
  type NotionPageContentUpdatedEventConfig,
  type NotionPageContentUpdatedEventCreateConfig,
  type NotionPageContentUpdatedScope,
  type NotionPageReference,
} from "@okouai/api-contracts/contracts/workflows";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import {
  notionWebhookEvents,
  notionWebhookSecrets,
  notionWorkflowPendingEvents,
  type NotionWorkflowPendingEventContext,
} from "@okouai/db/schema/notion-event";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { safeJsonParse, safeUrlParse, settle, tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  builtinConnectorCredentialRuntimeValueRef,
  loadBuiltinConnectorCredentialConnection,
  loadBuiltinConnectorCredentialValues,
  refreshBuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-runtime.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import type {
  RunWorkflowAutomationNowArgs,
  RunWorkflowAutomationResult,
  AutomationRow,
} from "./workflow-automation-launch.service";
import type { WorkflowQueueAdmissionTransaction } from "./workflow-chat-event-queue.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import {
  notionConfigConnectorId,
  reprojectNotionAutomationsForOwner,
} from "./notion-automation-account.service";

const log = logger("api:notion-automation-event");

const NOTION_ACCESS_TOKEN_ENVIRONMENT_NAME = "NOTION_TOKEN";
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
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

const notionPageParentSchema = z.union([
  z.object({ type: z.literal("page_id"), page_id: z.string().uuid() }),
  z.object({
    type: z.literal("data_source_id"),
    data_source_id: z.string().uuid(),
    database_id: z.string().uuid().optional(),
  }),
  z.object({ type: z.literal("database_id"), database_id: z.string().uuid() }),
  z.object({ type: z.literal("block_id"), block_id: z.string().uuid() }),
  z.object({ type: z.literal("workspace") }).passthrough(),
]);

const notionPageResponseSchema = z
  .object({
    object: z.literal("page"),
    id: z.string().uuid(),
    created_time: z.string().datetime().optional(),
    last_edited_time: z.string().datetime().optional(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional(),
    url: z.string().url().optional(),
    parent: notionPageParentSchema,
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const notionDataSourceResponseSchema = z
  .object({
    object: z.literal("data_source"),
    id: z.string().uuid(),
    name: z.string().nullable().optional(),
    url: z.string().url().optional(),
    parent: z
      .object({
        type: z.literal("database_id"),
        database_id: z.string().uuid(),
      })
      .passthrough(),
  })
  .passthrough();

const notionDatabaseResponseSchema = z
  .object({
    object: z.literal("database"),
    id: z.string().uuid(),
    url: z.string().url().optional(),
    title: z
      .array(
        z
          .object({
            plain_text: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    data_sources: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

type NotionWebhookEvent = z.infer<typeof notionWebhookEventSchema>;
type NotionPageResponse = z.infer<typeof notionPageResponseSchema>;
type NotionDataSourceResponse = z.infer<typeof notionDataSourceResponseSchema>;
type NotionDatabaseResponse = z.infer<typeof notionDatabaseResponseSchema>;
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

interface NotionAccess {
  readonly connectorId: string;
  readonly accessToken: string;
}

type NotionAccessResult =
  | { readonly kind: "ok"; readonly access: NotionAccess }
  | { readonly kind: "bad_request"; readonly message: string };

type NotionFetchResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | {
      readonly kind: "transient_error";
      readonly status: number | null;
      readonly message: string;
    };

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
type NotionAutomationEventType =
  | "notion-child-page-created"
  | "notion-database-item-created"
  | "notion-page-content-updated";
type NotionRunStarter = (
  args: RunWorkflowAutomationNowArgs,
  signal: AbortSignal,
) => Promise<RunWorkflowAutomationResult>;
interface ProcessClaimedNotionPendingEventArgs {
  readonly db: Db;
  readonly row: DueNotionAutomationRow;
  readonly pending: NotionPendingRow;
  readonly startRun: NotionRunStarter;
}

function tokenNeedsRefresh(tokenExpiresAt: Date | null, currentTime: Date) {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

function normalizeNotionUuid(value: string): string | null {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    return null;
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function parseStandardNotionUrlId(value: string): string | null {
  const url = safeUrlParse(value.trim());
  if (!url) {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (url.hostname !== "notion.so" && url.hostname !== "www.notion.so") {
    return null;
  }

  const path = url.pathname.replace(/\/+$/, "");
  const match = path.match(
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );
  return match ? normalizeNotionUuid(match[1]!) : null;
}

function parseStandardNotionPageUrl(value: string): string | null {
  return parseStandardNotionUrlId(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notionTitleFromProperties(
  properties: Record<string, unknown> | undefined,
): string | null {
  for (const property of Object.values(properties ?? {})) {
    if (!isRecord(property) || property.type !== "title") {
      continue;
    }
    const titleItems = property.title;
    if (!Array.isArray(titleItems)) {
      continue;
    }
    const title = titleItems
      .flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }
        const plainText = item.plain_text;
        return typeof plainText === "string" ? [plainText] : [];
      })
      .join("")
      .trim();
    if (title.length > 0) {
      return title;
    }
  }
  return null;
}

function notionPageReference(
  page: NotionPageResponse,
  rawUrl?: string,
): NotionPageReference {
  return {
    id: page.id,
    url: page.url ?? rawUrl ?? `https://www.notion.so/${page.id}`,
    title: notionTitleFromProperties(page.properties),
    ...(rawUrl ? { rawUrl } : {}),
  };
}

function notionDatabaseTitle(database: NotionDatabaseResponse): string | null {
  const title = database.title
    .map((item) => {
      return item.plain_text ?? "";
    })
    .join("")
    .trim();
  return title.length > 0 ? title : null;
}

function notionDataSourceReference(args: {
  readonly dataSource: NotionDataSourceResponse;
  readonly title: string | null;
  readonly rawUrl?: string;
}): NotionDataSourceReference {
  return {
    id: args.dataSource.id,
    url:
      args.dataSource.url ??
      args.rawUrl ??
      `https://www.notion.so/${args.dataSource.id}`,
    title: args.title,
    ...(args.rawUrl ? { rawUrl: args.rawUrl } : {}),
  };
}

function notionPageParentPageId(page: NotionPageResponse): string | null {
  return page.parent.type === "page_id" ? page.parent.page_id : null;
}

function notionPageParentDataSourceId(page: NotionPageResponse): string | null {
  return page.parent.type === "data_source_id"
    ? page.parent.data_source_id
    : null;
}

function pageIsUsable(page: NotionPageResponse): boolean {
  return page.archived !== true && page.in_trash !== true;
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

async function resolveNotionAccess(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<NotionAccessResult> {
  const currentTime = nowDate();
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  signal.throwIfAborted();
  const loaded = await loadBuiltinConnectorCredentialConnection({
    db: args.db,
    snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: "notion",
    connectorId: args.connectorId,
  });
  signal.throwIfAborted();
  if (loaded.kind === "missing") {
    return {
      kind: "bad_request",
      message: "Connect Notion before adding a Notion event automation",
    };
  }
  if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event automations",
    };
  }
  const connection = loaded.connection;
  const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
    connection,
    NOTION_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event automations",
    };
  }
  const values = await loadBuiltinConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
  signal.throwIfAborted();
  const accessToken = values.get(accessTokenValueRef);
  if (!accessToken) {
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event automations",
    };
  }
  if (!tokenNeedsRefresh(connection.tokenExpiresAt, currentTime)) {
    return {
      kind: "ok",
      access: {
        connectorId: connection.connectorId,
        accessToken,
      },
    };
  }
  const refreshed = await refreshBuiltinConnectorCredentialAccess(
    {
      connection,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      runtimeEnvironmentName: NOTION_ACCESS_TOKEN_ENVIRONMENT_NAME,
      persist: { db: args.db, markNeedsReconnectOnFailure: true },
    },
    signal,
  );
  if (refreshed.kind === "configuration-unavailable") {
    return {
      kind: "bad_request",
      message: "Notion OAuth client env vars are not configured",
    };
  }
  if (refreshed.kind !== "ok") {
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event automations",
    };
  }
  return {
    kind: "ok",
    access: {
      connectorId: connection.connectorId,
      accessToken: refreshed.accessToken,
    },
  };
}

async function notionFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  signal: AbortSignal,
): Promise<NotionFetchResult<T>> {
  const response = await tapError(
    fetch(url, {
      method: "GET",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": NOTION_VERSION,
      },
    }),
  );
  signal.throwIfAborted();
  if (!response) {
    return {
      kind: "transient_error",
      status: null,
      message: "Failed to reach Notion API",
    };
  }

  if (response.status === 401) {
    return { kind: "unauthorized" };
  }
  if (response.status === 403 || response.status === 404) {
    return { kind: "not_found" };
  }
  if (!response.ok) {
    return {
      kind: "transient_error",
      status: response.status,
      message: await response.text(),
    };
  }

  const responseText = await tapError(response.text());
  signal.throwIfAborted();
  const json = safeJsonParse(responseText ?? "");
  if (json === undefined) {
    return {
      kind: "transient_error",
      status: response.status,
      message: "Failed to parse Notion API response",
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: "transient_error",
      status: response.status,
      message: "Unexpected Notion API response",
    };
  }
  return { kind: "ok", value: parsed.data };
}

async function retrieveNotionPage(
  args: {
    readonly accessToken: string;
    readonly pageId: string;
  },
  signal: AbortSignal,
): Promise<NotionFetchResult<NotionPageResponse>> {
  return await notionFetchJson(
    notionPageResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/pages/${args.pageId}`,
    signal,
  );
}

async function retrieveNotionDataSource(
  args: {
    readonly accessToken: string;
    readonly dataSourceId: string;
  },
  signal: AbortSignal,
): Promise<NotionFetchResult<NotionDataSourceResponse>> {
  return await notionFetchJson(
    notionDataSourceResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/data_sources/${args.dataSourceId}`,
    signal,
  );
}

async function retrieveNotionDatabase(
  args: {
    readonly accessToken: string;
    readonly databaseId: string;
  },
  signal: AbortSignal,
): Promise<NotionFetchResult<NotionDatabaseResponse>> {
  return await notionFetchJson(
    notionDatabaseResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/databases/${args.databaseId}`,
    signal,
  );
}

export async function prepareNotionChildPageEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly eventConfig: NotionChildPageCreatedEventCreateConfig;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: NotionChildPageCreatedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const parentPageId = parseStandardNotionPageUrl(
    args.eventConfig.parentPageUrl,
  );
  if (!parentPageId) {
    return {
      kind: "bad-request",
      message: "Enter a standard notion.so page URL",
    };
  }

  const accessResult = await resolveNotionAccess(
    {
      db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return { kind: "bad-request", message: accessResult.message };
  }

  const pageResult = await retrieveNotionPage(
    {
      accessToken: accessResult.access.accessToken,
      pageId: parentPageId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (pageResult.kind === "not_found" || pageResult.kind === "unauthorized") {
    return {
      kind: "bad-request",
      message: `${PUBLIC_BRAND_PRESENTATION.assistantName} cannot access this Notion page`,
    };
  }
  if (pageResult.kind !== "ok") {
    return {
      kind: "bad-request",
      message: "Failed to validate Notion page URL",
    };
  }
  if (!pageIsUsable(pageResult.value)) {
    return {
      kind: "bad-request",
      message: "Notion page is archived or in trash",
    };
  }

  return {
    kind: "ok",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      connectorId: accessResult.access.connectorId,
      parentPage: notionPageReference(
        pageResult.value,
        args.eventConfig.parentPageUrl,
      ),
    },
  };
}

export async function prepareNotionDatabaseItemEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly eventConfig: NotionDatabaseItemCreatedEventCreateConfig;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: NotionDatabaseItemCreatedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const notionId = parseStandardNotionUrlId(args.eventConfig.databaseUrl);
  if (!notionId) {
    return {
      kind: "bad-request",
      message: "Enter a standard notion.so database URL",
    };
  }

  const accessResult = await resolveNotionAccess(
    {
      db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return { kind: "bad-request", message: accessResult.message };
  }
  const accessToken = accessResult.access.accessToken;
  const retrieveDataSource = (dataSourceId: string) => {
    return retrieveNotionDataSource({ accessToken, dataSourceId }, signal);
  };

  const databaseResult = await retrieveNotionDatabase(
    {
      accessToken,
      databaseId: notionId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (databaseResult.kind === "ok") {
    const [firstDataSource] = databaseResult.value.data_sources;
    if (!firstDataSource) {
      return {
        kind: "bad-request",
        message: "Notion database does not expose a data source",
      };
    }
    const dataSourceResult = await retrieveDataSource(firstDataSource.id);
    signal.throwIfAborted();
    if (
      dataSourceResult.kind === "not_found" ||
      dataSourceResult.kind === "unauthorized"
    ) {
      return {
        kind: "bad-request",
        message: `${PUBLIC_BRAND_PRESENTATION.assistantName} cannot access this Notion database`,
      };
    }
    if (dataSourceResult.kind !== "ok") {
      return {
        kind: "bad-request",
        message: "Failed to validate Notion database URL",
      };
    }
    return {
      kind: "ok",
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        connectorId: accessResult.access.connectorId,
        dataSource: notionDataSourceReference({
          dataSource: dataSourceResult.value,
          title:
            firstDataSource.name ??
            dataSourceResult.value.name ??
            notionDatabaseTitle(databaseResult.value),
          rawUrl: args.eventConfig.databaseUrl,
        }),
      },
    };
  }
  if (databaseResult.kind === "transient_error") {
    return {
      kind: "bad-request",
      message: "Failed to validate Notion database URL",
    };
  }

  const dataSourceResult = await retrieveDataSource(notionId);
  signal.throwIfAborted();
  if (
    dataSourceResult.kind === "not_found" ||
    dataSourceResult.kind === "unauthorized"
  ) {
    return {
      kind: "bad-request",
      message: `${PUBLIC_BRAND_PRESENTATION.assistantName} cannot access this Notion database`,
    };
  }
  if (dataSourceResult.kind !== "ok") {
    return {
      kind: "bad-request",
      message: "Failed to validate Notion database URL",
    };
  }

  return {
    kind: "ok",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      connectorId: accessResult.access.connectorId,
      dataSource: notionDataSourceReference({
        dataSource: dataSourceResult.value,
        title: dataSourceResult.value.name ?? null,
        rawUrl: args.eventConfig.databaseUrl,
      }),
    },
  };
}

export async function prepareNotionPageContentUpdatedEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly eventConfig: NotionPageContentUpdatedEventCreateConfig;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: NotionPageContentUpdatedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  if (args.eventConfig.pageUrl !== undefined) {
    const pageResult = await prepareNotionChildPageEventConfigForPersist(
      db,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorId: args.connectorId,
        eventConfig: {
          provider: "notion",
          event: "child_page_created",
          parentPageUrl: args.eventConfig.pageUrl,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (pageResult.kind !== "ok") {
      return pageResult;
    }
    return {
      kind: "ok",
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        connectorId: pageResult.eventConfig.connectorId,
        scope: {
          type: "page",
          page: pageResult.eventConfig.parentPage,
        },
      },
    };
  }

  if (args.eventConfig.databaseUrl === undefined) {
    return {
      kind: "bad-request",
      message: "Provide exactly one of pageUrl or databaseUrl",
    };
  }
  const dataSourceResult = await prepareNotionDatabaseItemEventConfigForPersist(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        databaseUrl: args.eventConfig.databaseUrl,
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if (dataSourceResult.kind !== "ok") {
    return dataSourceResult;
  }
  return {
    kind: "ok",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      connectorId: dataSourceResult.eventConfig.connectorId,
      scope: {
        type: "data_source",
        dataSource: dataSourceResult.eventConfig.dataSource,
      },
    },
  };
}

export async function validateNotionEventConfigForConnector(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly eventType: NotionAutomationEventType;
    readonly eventConfig: unknown;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok" }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const accessResult = await resolveNotionAccess(
    {
      db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return { kind: "bad-request", message: accessResult.message };
  }

  let resourceResult: NotionFetchResult<
    NotionPageResponse | NotionDataSourceResponse
  >;
  if (args.eventType === "notion-child-page-created") {
    const config = notionChildPageCreatedEventConfigSchema.safeParse(
      args.eventConfig,
    );
    if (!config.success || config.data.connectorId !== args.connectorId) {
      return {
        kind: "bad-request",
        message: "Notion automation account projection is out of date",
      };
    }
    resourceResult = await retrieveNotionPage(
      {
        accessToken: accessResult.access.accessToken,
        pageId: config.data.parentPage.id,
      },
      signal,
    );
  } else if (args.eventType === "notion-database-item-created") {
    const config = notionDatabaseItemCreatedEventConfigSchema.safeParse(
      args.eventConfig,
    );
    if (!config.success || config.data.connectorId !== args.connectorId) {
      return {
        kind: "bad-request",
        message: "Notion automation account projection is out of date",
      };
    }
    resourceResult = await retrieveNotionDataSource(
      {
        accessToken: accessResult.access.accessToken,
        dataSourceId: config.data.dataSource.id,
      },
      signal,
    );
  } else {
    const config = notionPageContentUpdatedEventConfigSchema.safeParse(
      args.eventConfig,
    );
    if (!config.success || config.data.connectorId !== args.connectorId) {
      return {
        kind: "bad-request",
        message: "Notion automation account projection is out of date",
      };
    }
    resourceResult =
      config.data.scope.type === "page"
        ? await retrieveNotionPage(
            {
              accessToken: accessResult.access.accessToken,
              pageId: config.data.scope.page.id,
            },
            signal,
          )
        : await retrieveNotionDataSource(
            {
              accessToken: accessResult.access.accessToken,
              dataSourceId: config.data.scope.dataSource.id,
            },
            signal,
          );
  }
  signal.throwIfAborted();
  if (
    resourceResult.kind === "ok" &&
    (resourceResult.value.object !== "page" ||
      pageIsUsable(resourceResult.value))
  ) {
    return { kind: "ok" };
  }
  return {
    kind: "bad-request",
    message:
      resourceResult.kind === "transient_error"
        ? "Failed to validate the Notion automation resource"
        : "The selected Notion account cannot access the automation resource",
  };
}

async function storeVerificationToken(
  args: {
    readonly db: Db;
    readonly token: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const currentTime = nowDate();
  await args.db
    .update(notionWebhookSecrets)
    .set({ active: false, updatedAt: currentTime })
    .where(eq(notionWebhookSecrets.active, true));
  signal.throwIfAborted();
  await args.db.insert(notionWebhookSecrets).values({
    encryptedVerificationToken: await encryptStoredSecretValue(args.token),
    active: true,
    createdAt: currentTime,
    updatedAt: currentTime,
  });
  signal.throwIfAborted();
}

async function activeVerificationTokenExists(
  args: {
    readonly db: ReadonlyDb;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const rows = await args.db
    .select({ id: notionWebhookSecrets.id })
    .from(notionWebhookSecrets)
    .where(eq(notionWebhookSecrets.active, true))
    .limit(1);
  signal.throwIfAborted();
  return rows.length > 0;
}

async function loadActiveVerificationTokens(
  args: {
    readonly db: ReadonlyDb;
  },
  signal: AbortSignal,
): Promise<readonly string[]> {
  const rows = await args.db
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
}

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

async function insertNotionWebhookEvent(
  args: {
    readonly db: Db;
    readonly event: NotionWebhookEvent;
    readonly pageId: string | null;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [inserted] = await args.db
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
}

async function queryNotionAutomations(
  args: {
    readonly db: Db;
  },
  eventType: NotionAutomationEventType,
  signal: AbortSignal,
): Promise<readonly AutomationRow[]> {
  const rows = await args.db
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
}

async function repairNotionAutomationProjections(
  args: {
    readonly db: Db;
  },
  automations: readonly AutomationRow[],
  signal: AbortSignal,
): Promise<boolean> {
  const owners = new Map<
    string,
    { readonly orgId: string; readonly userId: string }
  >();
  for (const automation of automations) {
    if (
      automation.eventConnectorId !== null &&
      notionConfigConnectorId(automation.eventType, automation.eventConfig) ===
        automation.eventConnectorId
    ) {
      continue;
    }
    const owner = {
      orgId: automation.orgId,
      userId: automation.ownerUserId,
    };
    owners.set(`${owner.orgId}:${owner.userId}`, owner);
  }
  const orderedOwners = [...owners.values()].sort((left, right) => {
    return (
      left.orgId.localeCompare(right.orgId) ||
      left.userId.localeCompare(right.userId)
    );
  });
  for (const owner of orderedOwners) {
    await args.db.transaction(async (tx) => {
      await lockConnectorAccountTarget(tx, {
        orgId: owner.orgId,
        userId: owner.userId,
        target: { kind: "builtin", connectorSlug: "notion" },
      });
      await reprojectNotionAutomationsForOwner(tx, owner);
    });
    signal.throwIfAborted();
  }
  return orderedOwners.length > 0;
}

async function loadCurrentNotionAutomations(
  args: {
    readonly db: Db;
  },
  eventType: NotionAutomationEventType,
  signal: AbortSignal,
): Promise<readonly AutomationRow[]> {
  const automations = await queryNotionAutomations(args, eventType, signal);
  if (!(await repairNotionAutomationProjections(args, automations, signal))) {
    return automations;
  }
  return await queryNotionAutomations(args, eventType, signal);
}

async function loadNotionChildPageAutomations(
  args: { readonly db: Db },
  signal: AbortSignal,
): Promise<readonly AutomationRow[]> {
  return await loadCurrentNotionAutomations(
    args,
    "notion-child-page-created",
    signal,
  );
}

async function loadNotionDatabaseItemAutomations(
  args: { readonly db: Db },
  signal: AbortSignal,
): Promise<readonly AutomationRow[]> {
  return await loadCurrentNotionAutomations(
    args,
    "notion-database-item-created",
    signal,
  );
}

async function loadNotionPageContentUpdatedAutomations(
  args: { readonly db: Db },
  signal: AbortSignal,
): Promise<readonly AutomationRow[]> {
  return await loadCurrentNotionAutomations(
    args,
    "notion-page-content-updated",
    signal,
  );
}

async function enqueueNotionChildPageEvents(
  args: {
    readonly db: Db;
    readonly event: NotionWebhookEvent;
    readonly pageId: string;
    readonly parentPageId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  const automations = await loadNotionChildPageAutomations(args, signal);
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
    const inserted = await persistForCurrentNotionAutomation(
      args.db,
      {
        automation,
        connectorId,
        eventType: "notion-child-page-created",
        persist: async (tx) => {
          const [row] = await tx
            .insert(notionWorkflowPendingEvents)
            .values({
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
            })
            .onConflictDoNothing()
            .returning({ id: notionWorkflowPendingEvents.id });
          return row ?? null;
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (inserted) {
      pending += 1;
    }
  }
  return pending;
}

async function enqueueNotionDatabaseItemEvents(
  args: {
    readonly db: Db;
    readonly event: NotionWebhookEvent;
    readonly pageId: string;
    readonly dataSourceId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  const automations = await loadNotionDatabaseItemAutomations(args, signal);
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
    const inserted = await persistForCurrentNotionAutomation(
      args.db,
      {
        automation,
        connectorId,
        eventType: "notion-database-item-created",
        persist: async (tx) => {
          const [row] = await tx
            .insert(notionWorkflowPendingEvents)
            .values({
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
            })
            .onConflictDoNothing()
            .returning({ id: notionWorkflowPendingEvents.id });
          return row ?? null;
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (inserted) {
      pending += 1;
    }
  }
  return pending;
}

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

async function persistForCurrentNotionAutomation<T>(
  db: Db,
  args: {
    readonly automation: AutomationRow;
    readonly connectorId: string;
    readonly eventType: NotionAutomationEventType;
    readonly persist: (tx: Tx) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T | null> {
  return await db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, {
      orgId: args.automation.orgId,
      userId: args.automation.ownerUserId,
      target: { kind: "builtin", connectorSlug: "notion" },
    });
    const [current] = await tx
      .select({
        eventType: workflowAutomations.eventType,
        eventConfig: workflowAutomations.eventConfig,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.id, args.automation.id),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.eventType, args.eventType),
          eq(workflowAutomations.eventConnectorId, args.connectorId),
        ),
      )
      .for("update")
      .limit(1);
    signal.throwIfAborted();
    if (
      !current ||
      notionConfigConnectorId(current.eventType, current.eventConfig) !==
        args.connectorId
    ) {
      return null;
    }
    return await args.persist(tx);
  });
}

async function dataSourceIdForContentUpdatedEvent(
  args: {
    readonly db: Db;
    readonly automation: AutomationRow;
    readonly config: NotionPageContentUpdatedEventConfig;
    readonly event: NotionWebhookEvent;
    readonly pageId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const eventDataSourceId = eventDataSourceParentId(args.event);
  if (eventDataSourceId) {
    return eventDataSourceId;
  }

  const accessResult = await resolveNotionAccess(
    {
      db: args.db,
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
}

async function contentUpdatedAutomationMatchesEvent(
  args: {
    readonly db: Db;
    readonly automation: AutomationRow;
    readonly config: NotionPageContentUpdatedEventConfig;
    readonly event: NotionWebhookEvent;
    readonly pageId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  if (args.config.scope.type === "page") {
    return args.config.scope.page.id === args.pageId;
  }
  const dataSourceId = await dataSourceIdForContentUpdatedEvent(args, signal);
  return dataSourceId === args.config.scope.dataSource.id;
}

async function enqueueOrRefreshNotionPageContentUpdatedEvents(
  args: {
    readonly db: Db;
    readonly event: NotionWebhookEvent;
    readonly pageId: string;
  },
  signal: AbortSignal,
): Promise<{ readonly pending: number; readonly refreshed: number }> {
  const automations = await loadNotionPageContentUpdatedAutomations(
    args,
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
      !(await contentUpdatedAutomationMatchesEvent(
        {
          db: args.db,
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

    const persistence = await persistForCurrentNotionAutomation(
      args.db,
      {
        automation,
        connectorId,
        eventType: "notion-page-content-updated",
        persist: async (tx) => {
          const currentTime = nowDate();
          const [updated] = await tx
            .update(notionWorkflowPendingEvents)
            .set({
              latestNotionEventId: args.event.id,
              latestEventAt: eventTimestamp(args.event),
              latestEventContext: notionEventContext(args.event),
              runAfter: runAfterForEvent(args.event),
              lastError: null,
              updatedAt: currentTime,
            })
            .where(
              and(
                eq(notionWorkflowPendingEvents.automationId, automation.id),
                eq(notionWorkflowPendingEvents.pageId, args.pageId),
                eq(
                  notionWorkflowPendingEvents.eventFamily,
                  "page_content_updated",
                ),
                eq(notionWorkflowPendingEvents.status, "pending"),
                eq(notionWorkflowPendingEvents.connectorId, connectorId),
              ),
            )
            .returning({ id: notionWorkflowPendingEvents.id });
          if (updated) {
            return "refreshed" as const;
          }

          const parent = pageContentUpdatedScopeParent(config.data.scope);
          const [inserted] = await tx
            .insert(notionWorkflowPendingEvents)
            .values({
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
            })
            .onConflictDoNothing()
            .returning({ id: notionWorkflowPendingEvents.id });
          return inserted ? ("inserted" as const) : ("none" as const);
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
}

async function refreshPendingNotionCreatedPageEvents(
  args: {
    readonly db: Db;
    readonly event: NotionWebhookEvent;
    readonly pageId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  const refreshed = await args.db
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
}

async function hasActiveNotionCreatedPageEvent(
  args: {
    readonly db: Db;
    readonly pageId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [active] = await args.db
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
}

async function dispatchNotionEvent(
  args: {
    readonly db: Db;
    readonly event: NotionWebhookEvent;
  },
  signal: AbortSignal,
): Promise<{
  readonly pending: number;
  readonly refreshed: number;
  readonly duplicates: number;
}> {
  const pageId = eventPageId(args.event);
  if (!pageId) {
    return { pending: 0, refreshed: 0, duplicates: 0 };
  }

  const inserted = await insertNotionWebhookEvent(
    {
      db: args.db,
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
        pending: await enqueueNotionChildPageEvents(
          {
            db: args.db,
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
      pending: await enqueueNotionDatabaseItemEvents(
        {
          db: args.db,
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

  const refreshedCreated = await refreshPendingNotionCreatedPageEvents(
    {
      db: args.db,
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
    (await hasActiveNotionCreatedPageEvent(
      {
        db: args.db,
        pageId,
      },
      signal,
    ))
  ) {
    return { pending: 0, refreshed: refreshedCreated, duplicates: 0 };
  }
  const contentUpdated = await enqueueOrRefreshNotionPageContentUpdatedEvents(
    {
      db: args.db,
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
}

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
    const db = set(writeDb$);
    if (verification.success) {
      if (await activeVerificationTokenExists({ db }, signal)) {
        return { kind: "unauthorized" };
      }
      await storeVerificationToken(
        {
          db,
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

    const tokens = await loadActiveVerificationTokens({ db }, signal);
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

    const result = await dispatchNotionEvent(
      {
        db,
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

async function loadDueNotionPendingEvents(
  args: {
    readonly db: Db;
    readonly currentTime: Date;
    readonly automationId?: string;
  },
  signal: AbortSignal,
): Promise<readonly NotionPendingRow[]> {
  const rows = await args.db
    .select(notionPendingEventColumns())
    .from(notionWorkflowPendingEvents)
    .where(
      and(
        args.automationId === undefined
          ? undefined
          : eq(notionWorkflowPendingEvents.automationId, args.automationId),
        eq(notionWorkflowPendingEvents.status, "pending"),
        lte(notionWorkflowPendingEvents.runAfter, args.currentTime),
      ),
    )
    .orderBy(asc(notionWorkflowPendingEvents.runAfter))
    .limit(NOTION_PENDING_BATCH_SIZE);
  signal.throwIfAborted();
  return rows;
}

async function executeDueNotionAutomationEvents(
  args: {
    readonly db: Db;
    readonly automationId?: string;
    readonly startRun: NotionRunStarter;
  },
  signal: AbortSignal,
): Promise<ExecuteDueNotionEventsResult> {
  const dueEvents = await loadDueNotionPendingEvents(
    {
      db: args.db,
      currentTime: nowDate(),
      automationId: args.automationId,
    },
    signal,
  );
  let executed = 0;
  let skipped = 0;
  for (const pending of dueEvents) {
    const claimed = await claimNotionPendingEvent(
      {
        db: args.db,
        pending,
        currentTime: nowDate(),
      },
      signal,
    );
    if (!claimed) {
      continue;
    }
    const outcome = await processClaimedNotionPendingEvent(
      {
        db: args.db,
        pending: claimed,
        startRun: args.startRun,
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
}

async function claimNotionPendingEvent(
  args: {
    readonly db: Db;
    readonly pending: NotionPendingRow;
    readonly currentTime: Date;
  },
  signal: AbortSignal,
): Promise<NotionPendingRow | null> {
  const [claimed] = await args.db
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
}

async function loadDueNotionAutomationRow(
  args: {
    readonly db: Db;
    readonly automationId: string;
  },
  signal: AbortSignal,
): Promise<DueNotionAutomationRow | null> {
  const [row] = await args.db
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
}

async function skipPendingEvent(
  args: {
    readonly db: Db;
    readonly pendingId: string;
    readonly reason: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.db
    .update(notionWorkflowPendingEvents)
    .set({
      status: "skipped",
      skipReason: args.reason,
      processedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(eq(notionWorkflowPendingEvents.id, args.pendingId));
  signal.throwIfAborted();
}

async function retryPendingEvent(
  args: {
    readonly db: Db;
    readonly pending: NotionPendingRow;
    readonly message: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.pending.attempts >= NOTION_PENDING_MAX_ATTEMPTS) {
    await skipPendingEvent(
      {
        db: args.db,
        pendingId: args.pending.id,
        reason: args.message,
      },
      signal,
    );
    return;
  }
  await args.db
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
}

async function markPendingEventProcessed(
  args: {
    readonly db: Db;
    readonly pendingId: string;
    readonly page: NotionPageResponse;
    readonly parent: {
      readonly title: string | null;
      readonly url: string;
    };
  },
  signal: AbortSignal,
): Promise<void> {
  await args.db
    .update(notionWorkflowPendingEvents)
    .set({
      status: "processed",
      pageTitle: notionTitleFromProperties(args.page.properties),
      pageUrl: args.page.url ?? null,
      parentTitle: args.parent.title,
      parentUrl: args.parent.url,
      processedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(eq(notionWorkflowPendingEvents.id, args.pendingId));
  signal.throwIfAborted();
}

class NotionAutomationSourceChangedError extends Error {
  constructor() {
    super("Notion automation source changed before durable queue admission");
    this.name = "NotionAutomationSourceChangedError";
  }
}

function notionConfigMatchesPendingEvent(
  eventType: string | null,
  eventConfig: unknown,
  pending: NotionPendingRow,
): boolean {
  if (eventType === "notion-child-page-created") {
    const config =
      notionChildPageCreatedEventConfigSchema.safeParse(eventConfig);
    return (
      config.success &&
      pending.eventFamily === "new_child_page" &&
      pending.scopeType === "page" &&
      config.data.connectorId === pending.connectorId &&
      config.data.parentPage.id === pending.scopeId
    );
  }
  if (eventType === "notion-database-item-created") {
    const config =
      notionDatabaseItemCreatedEventConfigSchema.safeParse(eventConfig);
    return (
      config.success &&
      pending.eventFamily === "new_database_item" &&
      pending.scopeType === "data_source" &&
      config.data.connectorId === pending.connectorId &&
      config.data.dataSource.id === pending.scopeId
    );
  }
  if (eventType === "notion-page-content-updated") {
    const config =
      notionPageContentUpdatedEventConfigSchema.safeParse(eventConfig);
    return (
      config.success &&
      pending.eventFamily === "page_content_updated" &&
      pageContentUpdatedScopeType(config.data.scope) === pending.scopeType &&
      pageContentUpdatedScopeId(config.data.scope) === pending.scopeId &&
      config.data.connectorId === pending.connectorId
    );
  }
  return false;
}

async function persistCurrentNotionAutomationSource(
  tx: WorkflowQueueAdmissionTransaction,
  args: {
    readonly automationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly pending: NotionPendingRow;
    readonly page: NotionPageResponse;
    readonly parent: {
      readonly title: string | null;
      readonly url: string;
    };
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.pending.connectorId === null) {
    throw new NotionAutomationSourceChangedError();
  }
  await lockConnectorAccountTarget(tx, {
    orgId: args.orgId,
    userId: args.userId,
    target: { kind: "builtin", connectorSlug: "notion" },
  });
  const [current] = await tx
    .select({
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventConnectorId, args.pending.connectorId),
      ),
    )
    .for("update")
    .limit(1);
  const [pending] = await tx
    .select({ id: notionWorkflowPendingEvents.id })
    .from(notionWorkflowPendingEvents)
    .where(
      and(
        eq(notionWorkflowPendingEvents.id, args.pending.id),
        eq(notionWorkflowPendingEvents.automationId, args.automationId),
        eq(notionWorkflowPendingEvents.connectorId, args.pending.connectorId),
        eq(notionWorkflowPendingEvents.status, "running"),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (
    !current ||
    !pending ||
    !notionConfigMatchesPendingEvent(
      current.eventType,
      current.eventConfig,
      args.pending,
    )
  ) {
    throw new NotionAutomationSourceChangedError();
  }
  await markPendingEventProcessed(
    {
      db: tx,
      pendingId: args.pending.id,
      page: args.page,
      parent: args.parent,
    },
    signal,
  );
}

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

function notionRunFailureMessage(
  result: Exclude<
    RunWorkflowAutomationResult,
    { readonly kind: "ok" } | { readonly kind: "enqueued" }
  >,
): string {
  return result.kind === "conflict"
    ? result.message
    : result.response.body.error.message;
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

async function startNotionWorkflowRun(
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
    readonly startRun: NotionRunStarter;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "source-changed" }
  | {
      readonly kind: "result";
      readonly result: RunWorkflowAutomationResult;
      readonly sourceTransitionPersisted: boolean;
    }
> {
  let sourceTransitionPersisted = false;
  const result = await settle(
    args.startRun(
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
        persistSourceTransition: async (tx) => {
          await persistCurrentNotionAutomationSource(
            tx,
            {
              automationId: args.row.automation.id,
              orgId: args.row.automation.orgId,
              userId: args.row.automation.ownerUserId,
              pending: args.pending,
              page: args.page,
              parent: args.parent,
            },
            signal,
          );
          sourceTransitionPersisted = true;
        },
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    ),
    signal,
  );
  if (result.ok) {
    return {
      kind: "result",
      result: result.value,
      sourceTransitionPersisted,
    };
  }
  if (result.error instanceof NotionAutomationSourceChangedError) {
    return { kind: "source-changed" };
  }
  throw result.error;
}

async function persistNotionWorkflowRunOutcome(
  args: {
    readonly db: Db;
    readonly pending: NotionPendingRow;
    readonly result: Awaited<ReturnType<typeof startNotionWorkflowRun>>;
  },
  signal: AbortSignal,
): Promise<"executed" | "skipped"> {
  if (args.result.kind === "source-changed") {
    await skipPendingEvent(
      {
        db: args.db,
        pendingId: args.pending.id,
        reason: NOTION_ACCOUNT_CHANGED_SKIP_REASON,
      },
      signal,
    );
    return "skipped";
  }
  if (args.result.sourceTransitionPersisted) {
    return "executed";
  }
  if (
    args.result.result.kind === "ok" ||
    args.result.result.kind === "enqueued"
  ) {
    throw new Error(
      "Notion workflow run succeeded without persisting its source transition",
    );
  }
  await retryPendingEvent(
    {
      db: args.db,
      pending: args.pending,
      message: notionRunFailureMessage(args.result.result),
    },
    signal,
  );
  return "skipped";
}

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

async function skipClaimedNotionPendingEvent(
  args: ProcessClaimedNotionPendingEventArgs,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  await skipPendingEvent(
    { db: args.db, pendingId: args.pending.id, reason },
    signal,
  );
}

async function processClaimedNotionChildPagePendingEvent(
  args: ProcessClaimedNotionPendingEventArgs,
  signal: AbortSignal,
): Promise<"executed" | "skipped"> {
  if (
    !notionAutomationIsActive(args.row, "notion-child-page-created") ||
    !args.row.chatThreadId
  ) {
    await skipClaimedNotionPendingEvent(
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
    await skipClaimedNotionPendingEvent(
      args,
      "Automation config no longer matches",
      signal,
    );
    return "skipped";
  }
  const accessResult = await resolveNotionAccess(
    {
      db: args.db,
      orgId: args.row.automation.orgId,
      userId: args.row.automation.ownerUserId,
      connectorId: config.data.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    await skipClaimedNotionPendingEvent(args, accessResult.message, signal);
    return "skipped";
  }

  const childPage = await retrieveUsablePendingNotionPage(
    {
      db: args.db,
      pending: args.pending,
      accessToken: accessResult.access.accessToken,
    },
    signal,
  );
  if (!childPage) {
    return "skipped";
  }

  if (notionPageParentPageId(childPage) !== config.data.parentPage.id) {
    await skipClaimedNotionPendingEvent(
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
  const result = await startNotionWorkflowRun(
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
      startRun: args.startRun,
    },
    signal,
  );
  signal.throwIfAborted();
  return await persistNotionWorkflowRunOutcome(
    { db: args.db, pending: args.pending, result },
    signal,
  );
}

async function processClaimedNotionDatabaseItemPendingEvent(
  args: ProcessClaimedNotionPendingEventArgs,
  signal: AbortSignal,
): Promise<"executed" | "skipped"> {
  if (
    !notionAutomationIsActive(args.row, "notion-database-item-created") ||
    !args.row.chatThreadId
  ) {
    await skipClaimedNotionPendingEvent(
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
    await skipClaimedNotionPendingEvent(
      args,
      "Automation config no longer matches",
      signal,
    );
    return "skipped";
  }
  const dataSourceId = config.data.dataSource.id;

  const accessResult = await resolveNotionAccess(
    {
      db: args.db,
      orgId: args.row.automation.orgId,
      userId: args.row.automation.ownerUserId,
      connectorId: config.data.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    await skipClaimedNotionPendingEvent(args, accessResult.message, signal);
    return "skipped";
  }

  const page = await retrieveUsablePendingNotionPage(
    {
      db: args.db,
      pending: args.pending,
      accessToken: accessResult.access.accessToken,
    },
    signal,
  );
  if (!page) {
    return "skipped";
  }

  if (notionPageParentDataSourceId(page) !== dataSourceId) {
    await skipClaimedNotionPendingEvent(
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
  const result = await startNotionWorkflowRun(
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
      startRun: args.startRun,
    },
    signal,
  );
  signal.throwIfAborted();
  return await persistNotionWorkflowRunOutcome(
    { db: args.db, pending: args.pending, result },
    signal,
  );
}

async function retrieveUsablePendingNotionPage(
  args: {
    readonly db: Db;
    readonly pending: NotionPendingRow;
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<NotionPageResponse | null> {
  const pageResult = await retrieveNotionPage(
    {
      accessToken: args.accessToken,
      pageId: args.pending.pageId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (pageResult.kind === "transient_error") {
    await retryPendingEvent(
      {
        db: args.db,
        pending: args.pending,
        message: pageResult.message,
      },
      signal,
    );
    return null;
  }
  if (pageResult.kind !== "ok" || !pageIsUsable(pageResult.value)) {
    await skipPendingEvent(
      {
        db: args.db,
        pendingId: args.pending.id,
        reason: "Notion page is no longer accessible",
      },
      signal,
    );
    return null;
  }
  return pageResult.value;
}

async function processClaimedNotionPageContentUpdatedPendingEvent(
  args: ProcessClaimedNotionPendingEventArgs,
  signal: AbortSignal,
): Promise<"executed" | "skipped"> {
  if (
    !notionAutomationIsActive(args.row, "notion-page-content-updated") ||
    !args.row.chatThreadId
  ) {
    await skipClaimedNotionPendingEvent(
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
    args.pending.scopeType !== pageContentUpdatedScopeType(config.data.scope) ||
    args.pending.scopeId !== pageContentUpdatedScopeId(config.data.scope)
  ) {
    await skipClaimedNotionPendingEvent(
      args,
      "Automation config no longer matches",
      signal,
    );
    return "skipped";
  }

  const accessResult = await resolveNotionAccess(
    {
      db: args.db,
      orgId: args.row.automation.orgId,
      userId: args.row.automation.ownerUserId,
      connectorId: config.data.connectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    await skipClaimedNotionPendingEvent(args, accessResult.message, signal);
    return "skipped";
  }

  const page = await retrieveUsablePendingNotionPage(
    {
      db: args.db,
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
    await skipClaimedNotionPendingEvent(
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
  const result = await startNotionWorkflowRun(
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
      startRun: args.startRun,
    },
    signal,
  );
  signal.throwIfAborted();
  return await persistNotionWorkflowRunOutcome(
    { db: args.db, pending: args.pending, result },
    signal,
  );
}

async function processClaimedNotionPendingEvent(
  args: {
    readonly db: Db;
    readonly pending: NotionPendingRow;
    readonly startRun: NotionRunStarter;
  },
  signal: AbortSignal,
): Promise<"executed" | "skipped"> {
  const row = await loadDueNotionAutomationRow(
    {
      db: args.db,
      automationId: args.pending.automationId,
    },
    signal,
  );
  if (!row) {
    return "skipped";
  }
  if (args.pending.eventFamily === "new_database_item") {
    return await processClaimedNotionDatabaseItemPendingEvent(
      {
        ...args,
        row,
      },
      signal,
    );
  }
  if (args.pending.eventFamily === "page_content_updated") {
    return await processClaimedNotionPageContentUpdatedPendingEvent(
      {
        ...args,
        row,
      },
      signal,
    );
  }
  return await processClaimedNotionChildPagePendingEvent(
    {
      ...args,
      row,
    },
    signal,
  );
}

export const executeDueNotionAutomationEvents$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ExecuteDueNotionEventsResult> => {
    return await executeDueNotionAutomationEvents(
      {
        db: set(writeDb$),
        startRun: (input, childSignal) => {
          return set(runWorkflowAutomationNow$, input, childSignal);
        },
      },
      signal,
    );
  },
);

export const executeDueNotionAutomationEventsForAutomation$ = command(
  async (
    { set },
    automationId: string,
    signal: AbortSignal,
  ): Promise<ExecuteDueNotionEventsResult> => {
    return await executeDueNotionAutomationEvents(
      {
        db: set(writeDb$),
        automationId,
        startRun: (input, childSignal) => {
          return set(runWorkflowAutomationNow$, input, childSignal);
        },
      },
      signal,
    );
  },
);
