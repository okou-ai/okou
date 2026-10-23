import { z } from "zod";
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
const cleanupResultSchema = z.object({
  runId: z.string(),
  sandboxId: z.string().nullable(),
  status: z.enum(["cleaned", "error"]),
  error: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Cleanup response schema
 */
const cleanupResponseSchema = z.object({
  cleaned: z.number(),
  errors: z.number(),
  results: z.array(cleanupResultSchema),
  exportJobsCleaned: z.number(),
  exportJobsStuck: z.number(),
  threadlessRuns: z.object({
    discovered: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errors: z.array(
      z.object({
        runId: z.string().uuid(),
        error: z.string(),
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
export type CronCleanupSandboxesResponse = z.infer<
  typeof cleanupResponseSchema
>;

export const cronCleanupXResourceReadsContract = c.router({
  cleanup: {
    method: "GET",
    path: "/api/cron/cleanup-x-resource-reads",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ deleted: z.number().int().nonnegative() }),
      401: apiErrorSchema,
    },
    summary: "Delete X resource reads older than yesterday in UTC",
  },
});
export type CronCleanupXResourceReadsContract =
  typeof cronCleanupXResourceReadsContract;

const cronProcessUsageEventsResponseSchema = z.object({
  success: z.literal(true),
  processed: z.number(),
});

const cronReconcileSocialKitDownloadsResponseSchema = z.object({
  success: z.literal(true),
  processed: z.number().int().nonnegative(),
});

const cronCompactChatThreadSnapshotsResponseSchema = z.object({
  // Compaction completed; inspect gc.failed independently for cleanup failures.
  success: z.literal(true),
  scopes: z.number(),
  eventsApplied: z.number(),
  eventsPruned: z.number(),
  gc: z.object({
    pagesScanned: z.number().int().nonnegative(),
    objectsScanned: z.number().int().nonnegative(),
    deleteAttempts: z.number().int().nonnegative(),
    objectsDeleted: z.number().int().nonnegative(),
    deferred: z.boolean(),
    failed: z.boolean(),
  }),
});

export const cronProjectChatEventSearchResponseSchema = z.object({
  success: z.literal(true),
  threads: z.number(),
  indexedEvents: z.number(),
  deletedDocs: z.number(),
  orphanedThreads: z.number(),
  convergence: z.object({
    eligibleThreads: z.number(),
    durableCaughtUpThreads: z.number(),
  }),
});

const cronSnapshotChatEventsResponseSchema = z.object({
  success: z.literal(true),
  snapshots: z.number(),
  archivedEvents: z.number(),
  selectedCandidates: z.number().int().nonnegative(),
  processedCandidates: z.number().int().nonnegative(),
  deferredCandidates: z.number().int().nonnegative(),
  unreadableParents: z.number().int().nonnegative(),
  skippedUnreadableHeads: z.number().int().nonnegative(),
  skippedUndecodableHeads: z.number().int().nonnegative(),
  skippedIncompleteHeads: z.number().int().nonnegative(),
  skippedFailedHeads: z.number().int().nonnegative(),
  skippedTimedOutHeads: z.number().int().nonnegative(),
  oldestCandidateAgeMs: z.number().int().nonnegative(),
  scanCursorAdvanced: z.boolean(),
  scanWrapped: z.boolean(),
  duplicateEventIdConflictThreads: z.number().int().nonnegative(),
  duplicateEventIdConflicts: z.number().int().nonnegative(),
  duplicateEventIdsRemapped: z.number().int().nonnegative(),
  duplicateEventReferencesRemapped: z.number().int().nonnegative(),
  r2ObjectsScanned: z.number().int().nonnegative(),
  r2ObjectsMeasured: z.number().int().nonnegative(),
  r2ObjectsDeleted: z.number().int().nonnegative(),
  r2BytesMeasured: z.number().int().nonnegative(),
  r2BytesDeleted: z.number().int().nonnegative(),
  r2GcShardsScanned: z.number().int().nonnegative(),
  r2GcSubpartitionedShards: z.number().int().nonnegative(),
  r2GcPagesScanned: z.number().int().nonnegative(),
  r2GcDeferred: z.boolean(),
  r2GcFailed: z.boolean(),
});

const cronRetainChatEventsResponseSchema = z.object({
  success: z.literal(true),
  cutoff: z.iso.datetime(),
  scanLimit: z.number().int().positive(),
  scanned: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  skippedSnapshot: z.number().int().nonnegative(),
  skippedSearchWatermark: z.number().int().nonnegative(),
  skippedPendingRunless: z.number().int().nonnegative(),
  skippedNonterminalRun: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  sweepRestarted: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

const cronCompactUsageEventsResponseSchema = z.object({
  success: z.literal(true),
  cutoff: z.string(),
  rawSeedLimit: z.number().int().positive(),
  seededRawRows: z.number().int().nonnegative(),
  selectedGrains: z.number().int().nonnegative(),
  probedRawRows: z.number().int().nonnegative(),
  billingErrorHeldRows: z.number().int().nonnegative(),
  rawRowsDeleted: z.number().int().nonnegative(),
  hourlyRowsDeleted: z.number().int().nonnegative(),
  hourlyRowsInserted: z.number().int().nonnegative(),
  quantity: z.string().regex(/^-?\d+$/),
  creditsCharged: z.string().regex(/^-?\d+$/),
  reconciled: z.literal(true),
  hasMore: z.boolean(),
  lockWaitMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

const cronMonitorChatEventQueueResponseSchema = z.object({
  success: z.literal(true),
  orphanedMessages: z.number().int().nonnegative(),
});

const cronSteerRunTimeBudgetResponseSchema = z.object({
  scanned: z.number().int().nonnegative(),
  steered: z.number().int().nonnegative(),
});

const cronReconcileBillingEntitlementsResponseSchema = z.object({
  success: z.literal(true),
  downgraded: z.number(),
});

const cronTelegramCleanupResponseSchema = z.object({
  deleted: z.number(),
});

const cronConnectorOauthStateCleanupResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

const cronComputerUseScreenshotCleanupResponseSchema = z.object({
  cleaned: z.number(),
});

const cronBrowserReconcileResponseSchema = z.object({
  checked: z.number().int().nonnegative(),
  stopped: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  healthy: z.number().int().nonnegative(),
});

const cronDrainEmailOutboxResponseSchema = z.object({
  success: z.literal(true),
  drained: z.number(),
  cleaned: z.number(),
});

const cronSyncSkillsResponseSchema = z.object({
  success: z.literal(true),
  commitSha: z.string(),
  synced: z.number(),
  skipped: z.number(),
  failed: z.number(),
  removed: z.number(),
  total: z.number(),
});

// The writer's report of this attempt only.
const connectorCatalogSyncResponseSchema =
  connectorCatalogSyncAttemptReportSchema;

export type ConnectorCatalogSyncResponse = z.infer<
  typeof connectorCatalogSyncResponseSchema
>;

const cronExecuteWorkflowAutomationsResponseSchema = z.object({
  success: z.literal(true),
  executed: z.number(),
  skipped: z.number(),
});

const cronRenewGmailWatchesResponseSchema = z.object({
  success: z.literal(true),
  renewed: z.number(),
  failed: z.number(),
});

const cronRenewGoogleFormsWatchesResponseSchema = z.object({
  success: z.literal(true),
  renewed: z.number(),
  failed: z.number(),
});

const cronRenewGoogleCalendarWatchesResponseSchema = z.object({
  success: z.literal(true),
  renewed: z.number(),
  failed: z.number(),
});

const cronRenewGoogleWorkspaceEventSubscriptionsResponseSchema = z.object({
  success: z.literal(true),
  renewed: z.number(),
  repaired: z.number(),
  failed: z.number(),
});

const storagePresignedUrlPruneResultSchema = z.object({
  pruned: z.number(),
});

const cronPruneStoragePresignedUrlsResponseSchema = z.object({
  success: z.literal(true),
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

export const cronReconcileCommerceJobsContract = c.router({
  reconcile: {
    method: "GET",
    path: "/api/cron/reconcile-commerce-jobs",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        success: z.literal(true),
        processed: z.number().int().nonnegative(),
      }),
      401: apiErrorSchema,
    },
    summary: "Advance a bounded batch of managed Commerce jobs",
  },
});

export const cronReconcileSocialKitDownloadsContract = c.router({
  reconcile: {
    method: "GET",
    path: "/api/cron/reconcile-socialkit-downloads",
    headers: authHeadersSchema,
    responses: {
      200: cronReconcileSocialKitDownloadsResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Reconcile managed SocialKit downloads",
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
      200: z.object({
        processed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
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
      500: z.object({ error: z.string() }),
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
      500: z.object({ error: z.string() }),
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
      500: z.object({ error: z.string() }),
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
      200: z.object({
        success: z.literal(true),
        claimed: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        unindexable: z.number().int().nonnegative(),
        retried: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
      }),
      401: apiErrorSchema,
    },
    summary: "Materialize a bounded batch of immutable Pi resource indexes",
  },
});

export type CronProcessUsageEventsContract =
  typeof cronProcessUsageEventsContract;
export type CronReconcileSocialKitDownloadsContract =
  typeof cronReconcileSocialKitDownloadsContract;
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
  cronReconcileSocialKitDownloadsResponseSchema,
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
      200: z.object({ processed: z.number() }),
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
      200: z.object({ processed: z.number(), cleaned: z.number() }),
      401: apiErrorSchema,
    },
    summary:
      "Resume compatible background jobs and reclaim terminal export resources",
  },
});
