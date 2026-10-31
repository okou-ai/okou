import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorCatalogSyncAttemptReportSchema } from "./connector-catalog-sync";
import { apiErrorSchema } from "./errors";
import {
  officialWorkflowCatalogSyncResponseSchema,
  type OfficialWorkflowCatalogSyncResponse,
} from "./official-workflow-catalog";

const c = initContract();

/**
 * Cleanup result schema
 */
const cleanupResultSchema = object({
  runId: string(),
  sandboxId: string().nullable(),
  status: zEnum(["cleaned", "error"]),
  error: string().optional(),
  reason: string().optional(),
});

/**
 * Cleanup response schema
 */
const cleanupResponseSchema = object({
  cleaned: number(),
  errors: number(),
  results: array(cleanupResultSchema),
  exportJobsCleaned: number(),
  exportJobsStuck: number(),
  threadlessRuns: object({
    discovered: number().int().nonnegative(),
    cancelled: number().int().nonnegative(),
    waiting: number().int().nonnegative(),
    deleted: number().int().nonnegative(),
    failed: number().int().nonnegative(),
    errors: array(
      object({
        runId: uuid(),
        error: string(),
      }),
    ),
  }),
});

/**
 * Cron cleanup sandboxes contract for /api/cron/cleanup-sandboxes
 */
export const cronCleanupSandboxesContract = c.router({
  /**
   * GET /api/cron/cleanup-sandboxes
   * Cron job to cleanup sandboxes that have stopped sending heartbeats
   */
  cleanup: {
    method: "GET",
    path: "/api/cron/cleanup-sandboxes",
    headers: authHeadersSchema,
    responses: {
      200: cleanupResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Cleanup expired sandboxes",
  },
});

export type CronCleanupSandboxesContract = typeof cronCleanupSandboxesContract;
export type CronCleanupSandboxesResponse = zInfer<typeof cleanupResponseSchema>;

export const cronCleanupXResourceReadsContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/cleanup-x-resource-reads",
    headers: authHeadersSchema,
    responses: {
      200: object({ deleted: number().int().nonnegative() }),
      401: apiErrorSchema,
    },
    summary: "Delete X resource reads older than yesterday in UTC",
  },
});
export type CronCleanupXResourceReadsContract =
  typeof cronCleanupXResourceReadsContract;

const cronProcessUsageEventsResponseSchema = object({
  success: literal(true),
  processed: number(),
});

const cronCompactChatThreadSnapshotsResponseSchema = object({
  // Compaction completed; inspect gc.failed independently for cleanup failures.
  success: literal(true),
  scopes: number(),
  eventsApplied: number(),
  eventsPruned: number(),
  gc: object({
    pagesScanned: number().int().nonnegative(),
    objectsScanned: number().int().nonnegative(),
    deleteAttempts: number().int().nonnegative(),
    objectsDeleted: number().int().nonnegative(),
    deferred: boolean(),
    failed: boolean(),
  }),
});

export const cronProjectChatEventSearchResponseSchema = object({
  success: literal(true),
  threads: number(),
  indexedEvents: number(),
  deletedDocs: number(),
  orphanedThreads: number(),
  convergence: object({
    eligibleThreads: number(),
    durableCaughtUpThreads: number(),
  }),
});

const cronSnapshotChatEventsResponseSchema = object({
  success: literal(true),
  snapshots: number(),
  archivedEvents: number(),
  selectedCandidates: number().int().nonnegative(),
  processedCandidates: number().int().nonnegative(),
  deferredCandidates: number().int().nonnegative(),
  unreadableParents: number().int().nonnegative(),
  skippedUnreadableHeads: number().int().nonnegative(),
  skippedUndecodableHeads: number().int().nonnegative(),
  skippedIncompleteHeads: number().int().nonnegative(),
  skippedFailedHeads: number().int().nonnegative(),
  skippedTimedOutHeads: number().int().nonnegative(),
  oldestCandidateAgeMs: number().int().nonnegative(),
  scanCursorAdvanced: boolean(),
  scanWrapped: boolean(),
  duplicateEventIdConflictThreads: number().int().nonnegative(),
  duplicateEventIdConflicts: number().int().nonnegative(),
  duplicateEventIdsRemapped: number().int().nonnegative(),
  duplicateEventReferencesRemapped: number().int().nonnegative(),
  r2ObjectsScanned: number().int().nonnegative(),
  r2ObjectsMeasured: number().int().nonnegative(),
  r2ObjectsDeleted: number().int().nonnegative(),
  r2BytesMeasured: number().int().nonnegative(),
  r2BytesDeleted: number().int().nonnegative(),
  r2GcShardsScanned: number().int().nonnegative(),
  r2GcSubpartitionedShards: number().int().nonnegative(),
  r2GcPagesScanned: number().int().nonnegative(),
  r2GcDeferred: boolean(),
  r2GcFailed: boolean(),
});

const cronRetainChatEventsResponseSchema = object({
  success: literal(true),
  cutoff: iso.datetime(),
  scanLimit: number().int().positive(),
  scanned: number().int().nonnegative(),
  deleted: number().int().nonnegative(),
  skippedSnapshot: number().int().nonnegative(),
  skippedSearchWatermark: number().int().nonnegative(),
  skippedPendingRunless: number().int().nonnegative(),
  skippedNonterminalRun: number().int().nonnegative(),
  hasMore: boolean(),
  sweepRestarted: boolean(),
  durationMs: number().int().nonnegative(),
});

const cronCompactUsageEventsResponseSchema = object({
  success: literal(true),
  cutoff: string(),
  rawSeedLimit: number().int().positive(),
  seededRawRows: number().int().nonnegative(),
  selectedGrains: number().int().nonnegative(),
  probedRawRows: number().int().nonnegative(),
  billingErrorHeldRows: number().int().nonnegative(),
  rawRowsDeleted: number().int().nonnegative(),
  hourlyRowsDeleted: number().int().nonnegative(),
  hourlyRowsInserted: number().int().nonnegative(),
  quantity: string().regex(/^-?\d+$/),
  creditsCharged: string().regex(/^-?\d+$/),
  reconciled: literal(true),
  hasMore: boolean(),
  lockWaitMs: number().int().nonnegative(),
  durationMs: number().int().nonnegative(),
});

const cronMonitorChatEventQueueResponseSchema = object({
  success: literal(true),
  orphanedMessages: number().int().nonnegative(),
});

const cronSteerRunTimeBudgetResponseSchema = object({
  scanned: number().int().nonnegative(),
  steered: number().int().nonnegative(),
});

const cronReconcileBillingEntitlementsResponseSchema = object({
  success: literal(true),
  downgraded: number(),
});

const cronTelegramCleanupResponseSchema = object({
  deleted: number(),
});

const cronConnectorOauthStateCleanupResponseSchema = object({
  deleted: number().int().nonnegative(),
});

const cronCleanupSuggestionsResponseSchema = object({
  cleaned: number().int().nonnegative(),
  deleted: number().int().nonnegative(),
});

const cronComputerUseScreenshotCleanupResponseSchema = object({
  cleaned: number(),
});

const cronBrowserReconcileResponseSchema = object({
  checked: number().int().nonnegative(),
  stopped: number().int().nonnegative(),
  errors: number().int().nonnegative(),
  healthy: number().int().nonnegative(),
});

const cronDrainEmailOutboxResponseSchema = object({
  success: literal(true),
  drained: number(),
  cleaned: number(),
});

const cronSyncSkillsResponseSchema = object({
  success: literal(true),
  commitSha: string(),
  synced: number(),
  skipped: number(),
  failed: number(),
  removed: number(),
  total: number(),
});

// The writer's report of this attempt only.
const connectorCatalogSyncResponseSchema =
  connectorCatalogSyncAttemptReportSchema;

export type ConnectorCatalogSyncResponse = zInfer<
  typeof connectorCatalogSyncResponseSchema
>;

const cronExecuteWorkflowAutomationsResponseSchema = object({
  success: literal(true),
  executed: number(),
  skipped: number(),
});

const cronRenewGmailWatchesResponseSchema = object({
  success: literal(true),
  renewed: number(),
  failed: number(),
});

const cronRenewGoogleFormsWatchesResponseSchema = object({
  success: literal(true),
  renewed: number(),
  failed: number(),
});

const cronRenewGoogleCalendarWatchesResponseSchema = object({
  success: literal(true),
  renewed: number(),
  failed: number(),
});

const cronRenewGoogleWorkspaceEventSubscriptionsResponseSchema = object({
  success: literal(true),
  renewed: number(),
  repaired: number(),
  failed: number(),
});

const storagePresignedUrlPruneResultSchema = object({
  pruned: number(),
});

const cronPruneStoragePresignedUrlsResponseSchema = object({
  success: literal(true),
  system: storagePresignedUrlPruneResultSchema,
  workflowSkill: storagePresignedUrlPruneResultSchema,
  readOnly: storagePresignedUrlPruneResultSchema,
  presentationTemplatePreview: storagePresignedUrlPruneResultSchema,
  privateArtifactPreview: storagePresignedUrlPruneResultSchema.optional(),
});
export const cronProcessUsageEventsContract = c.router({
  process: {
    method: "GET",
    path: "/api/cron/process-usage-events",
    headers: authHeadersSchema,
    responses: {
      200: cronProcessUsageEventsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Process pending usage events",
  },
});

export const cronCompactChatThreadSnapshotsContract = c.router({
  compact: {
    method: "GET",
    path: "/api/cron/compact-chat-thread-snapshots",
    headers: authHeadersSchema,
    responses: {
      200: cronCompactChatThreadSnapshotsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Compact chat thread snapshots from lifecycle events",
  },
});

export const cronReconcileArtifactCatalogContract = c.router({
  reconcile: {
    method: "GET",
    path: "/api/cron/reconcile-artifact-catalog",
    headers: authHeadersSchema,
    responses: {
      200: object({
        processed: number().int().nonnegative(),
        failed: number().int().nonnegative(),
      }),
      401: apiErrorSchema,
    },
    summary: "Reconcile a bounded batch of pending artifact catalog files",
  },
});

export const cronProjectChatEventSearchContract = c.router({
  project: {
    method: "GET",
    path: "/api/cron/project-chat-event-search",
    headers: authHeadersSchema,
    responses: {
      200: cronProjectChatEventSearchResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Project chat events into durable search messages",
  },
});

export const cronSnapshotChatEventsContract = c.router({
  snapshot: {
    method: "GET",
    path: "/api/cron/snapshot-chat-events",
    headers: authHeadersSchema,
    responses: {
      200: cronSnapshotChatEventsResponseSchema,
      401: apiErrorSchema,
      500: object({ error: string() }),
    },
    summary: "Archive chat events into immutable full-thread R2 snapshots",
  },
});

export const cronRetainChatEventsContract = c.router({
  retain: {
    method: "GET",
    path: "/api/cron/retain-chat-events",
    headers: authHeadersSchema,
    responses: {
      200: cronRetainChatEventsResponseSchema,
      401: apiErrorSchema,
      500: object({ error: string() }),
    },
    summary: "Physically retain the 30-day PostgreSQL chat event window",
  },
});

export const cronCompactUsageEventsContract = c.router({
  compact: {
    method: "GET",
    path: "/api/cron/compact-usage-events",
    headers: authHeadersSchema,
    responses: {
      200: cronCompactUsageEventsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Compact stable usage events into hourly rollups",
  },
});

export const cronMonitorChatEventQueueContract = c.router({
  monitor: {
    method: "GET",
    path: "/api/cron/monitor-chat-event-queue",
    headers: authHeadersSchema,
    responses: {
      200: cronMonitorChatEventQueueResponseSchema,
      401: apiErrorSchema,
      500: object({ error: string() }),
    },
    summary: "Monitor for orphaned queued chat messages",
  },
});

export const cronSteerRunTimeBudgetContract = c.router({
  steer: {
    method: "GET",
    path: "/api/cron/steer-run-time-budget",
    headers: authHeadersSchema,
    responses: {
      200: cronSteerRunTimeBudgetResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Steer chat runs that reached their time budget",
  },
});

export const cronReconcileBillingEntitlementsContract = c.router({
  reconcile: {
    method: "GET",
    path: "/api/cron/reconcile-billing-entitlements",
    headers: authHeadersSchema,
    responses: {
      200: cronReconcileBillingEntitlementsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Reconcile billing entitlements",
  },
});

export const cronTelegramCleanupContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/telegram-cleanup",
    headers: authHeadersSchema,
    responses: {
      200: cronTelegramCleanupResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Delete expired Telegram messages",
  },
});

export const cronConnectorOauthStateCleanupContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/connector-oauth-state-cleanup",
    headers: authHeadersSchema,
    responses: {
      200: cronConnectorOauthStateCleanupResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Delete expired connector OAuth states",
  },
});

export const cronCleanupSuggestionsContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/cleanup-suggestions",
    headers: authHeadersSchema,
    responses: {
      200: cronCleanupSuggestionsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Prune expired suggestions and feedback after 24 hours",
  },
});

export const cronComputerUseScreenshotCleanupContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/computer-use-screenshot-cleanup",
    headers: authHeadersSchema,
    responses: {
      200: cronComputerUseScreenshotCleanupResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Delete expired desktop computer-use commands and screenshots",
  },
});

export const cronBrowserReconcileContract = c.router({
  reconcile: {
    method: "GET",
    path: "/api/cron/reconcile-browsers",
    headers: authHeadersSchema,
    responses: {
      200: cronBrowserReconcileResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Reconcile managed browser idle leases and provider state",
  },
});

export const cronDrainEmailOutboxContract = c.router({
  drain: {
    method: "GET",
    path: "/api/cron/drain-email-outbox",
    headers: authHeadersSchema,
    responses: {
      200: cronDrainEmailOutboxResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Drain pending email outbox messages",
  },
});

export const cronRenewGmailWatchesContract = c.router({
  renew: {
    method: "GET",
    path: "/api/cron/renew-gmail-watches",
    headers: authHeadersSchema,
    responses: {
      200: cronRenewGmailWatchesResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Renew Gmail push notification watches",
  },
});

export const cronRenewGoogleFormsWatchesContract = c.router({
  renew: {
    method: "GET",
    path: "/api/cron/renew-google-forms-watches",
    headers: authHeadersSchema,
    responses: {
      200: cronRenewGoogleFormsWatchesResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Renew Google Forms response watches",
  },
});

export const cronRenewGoogleCalendarWatchesContract = c.router({
  renew: {
    method: "GET",
    path: "/api/cron/renew-google-calendar-watches",
    headers: authHeadersSchema,
    responses: {
      200: cronRenewGoogleCalendarWatchesResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Renew Google Calendar push notification watches",
  },
});

export const cronRenewGoogleWorkspaceEventSubscriptionsContract = c.router({
  renew: {
    method: "GET",
    path: "/api/cron/renew-google-workspace-event-subscriptions",
    headers: authHeadersSchema,
    responses: {
      200: cronRenewGoogleWorkspaceEventSubscriptionsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Renew Google Workspace Events subscriptions",
  },
});

export const cronSyncSkillsContract = c.router({
  sync: {
    method: "GET",
    path: "/api/cron/sync-skills",
    headers: authHeadersSchema,
    responses: {
      200: cronSyncSkillsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Sync official skills from the skills repository",
  },
});

export const cronConnectorCatalogContract = c.router({
  sync: {
    method: "GET",
    path: "/api/cron/sync-connector-catalog",
    headers: authHeadersSchema,
    responses: {
      200: connectorCatalogSyncResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Publish the validated official connector catalog",
  },
});

export const cronOfficialWorkflowCatalogContract = c.router({
  sync: {
    method: "GET",
    path: "/api/cron/sync-official-workflow-catalog",
    headers: authHeadersSchema,
    responses: {
      200: officialWorkflowCatalogSyncResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Publish and accept the Official Workflow catalog",
  },
});

export const cronExecuteWorkflowAutomationsContract = c.router({
  execute: {
    method: "GET",
    path: "/api/cron/execute-workflow-automations",
    headers: authHeadersSchema,
    responses: {
      200: cronExecuteWorkflowAutomationsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Execute due workflow automations",
  },
});

export const cronPruneStoragePresignedUrlsContract = c.router({
  prune: {
    method: "GET",
    path: "/api/cron/prune-storage-presigned-urls",
    headers: authHeadersSchema,
    responses: {
      200: cronPruneStoragePresignedUrlsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Prune expired storage presigned URL cache entries",
  },
});

export const cronMaterializePiResourceIndexesContract = c.router({
  materialize: {
    method: "GET",
    path: "/api/cron/materialize-pi-resource-indexes",
    headers: authHeadersSchema,
    responses: {
      200: object({
        success: literal(true),
        claimed: number().int().nonnegative(),
        ready: number().int().nonnegative(),
        unindexable: number().int().nonnegative(),
        retried: number().int().nonnegative(),
        stale: number().int().nonnegative(),
      }),
      401: apiErrorSchema,
    },
    summary: "Materialize a bounded batch of immutable Pi resource indexes",
  },
});

export type CronProcessUsageEventsContract =
  typeof cronProcessUsageEventsContract;
export type CronCompactChatThreadSnapshotsContract =
  typeof cronCompactChatThreadSnapshotsContract;
export type CronMonitorChatEventQueueContract =
  typeof cronMonitorChatEventQueueContract;
export type CronReconcileBillingEntitlementsContract =
  typeof cronReconcileBillingEntitlementsContract;
export type CronPruneStoragePresignedUrlsContract =
  typeof cronPruneStoragePresignedUrlsContract;
export type CronTelegramCleanupContract = typeof cronTelegramCleanupContract;
export type CronConnectorOauthStateCleanupContract =
  typeof cronConnectorOauthStateCleanupContract;
export type CronComputerUseScreenshotCleanupContract =
  typeof cronComputerUseScreenshotCleanupContract;
export type CronBrowserReconcileContract = typeof cronBrowserReconcileContract;
export type CronDrainEmailOutboxContract = typeof cronDrainEmailOutboxContract;
export type CronSyncSkillsContract = typeof cronSyncSkillsContract;
export type CronConnectorCatalogContract = typeof cronConnectorCatalogContract;
export type CronOfficialWorkflowCatalogContract =
  typeof cronOfficialWorkflowCatalogContract;
export type { OfficialWorkflowCatalogSyncResponse };
export type CronRenewGmailWatchesContract =
  typeof cronRenewGmailWatchesContract;
export type CronRenewGoogleFormsWatchesContract =
  typeof cronRenewGoogleFormsWatchesContract;
export type CronRenewGoogleCalendarWatchesContract =
  typeof cronRenewGoogleCalendarWatchesContract;
export type CronRenewGoogleWorkspaceEventSubscriptionsContract =
  typeof cronRenewGoogleWorkspaceEventSubscriptionsContract;

// Export schemas for reuse
export {
  cleanupResultSchema,
  cronSnapshotChatEventsResponseSchema,
  cronProcessUsageEventsResponseSchema,
  cronReconcileBillingEntitlementsResponseSchema,
  cronTelegramCleanupResponseSchema,
  cronConnectorOauthStateCleanupResponseSchema,
  cronComputerUseScreenshotCleanupResponseSchema,
  cronBrowserReconcileResponseSchema,
  cronDrainEmailOutboxResponseSchema,
  cronSyncSkillsResponseSchema,
  cronExecuteWorkflowAutomationsResponseSchema,
  cronRenewGmailWatchesResponseSchema,
  cronRenewGoogleFormsWatchesResponseSchema,
  cronRenewGoogleCalendarWatchesResponseSchema,
  cronRenewGoogleWorkspaceEventSubscriptionsResponseSchema,
  cronPruneStoragePresignedUrlsResponseSchema,
};

export const cronReconcileImageGenerationsContract = c.router({
  process: {
    method: "GET",
    path: "/api/cron/reconcile-image-generations",
    headers: authHeadersSchema,
    responses: {
      200: object({ processed: number() }),
      401: apiErrorSchema,
    },
    summary: "Advance a bounded batch of durable OpenAI image responses",
  },
});

/** Durable jobs are claimed with short leases; every invocation has a fixed work budget. */
export const cronProcessBackgroundJobsContract = c.router({
  process: {
    method: "GET",
    path: "/api/cron/process-background-jobs",
    headers: authHeadersSchema,
    responses: {
      200: object({ processed: number(), cleaned: number() }),
      401: apiErrorSchema,
    },
    summary:
      "Resume compatible background jobs and reclaim terminal export resources",
  },
});
