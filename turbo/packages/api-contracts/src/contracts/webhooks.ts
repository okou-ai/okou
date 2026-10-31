import {
  array,
  boolean,
  literal,
  number,
  object,
  record,
  string,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { oomEvidenceSchema } from "./oom-evidence";
import { runFailureReasonTokenSchema } from "./run-failure-reasons";
import {
  homeReuseResultSchema,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxReuseResultSchema,
  sandboxStartupPathSchema,
  secretConnectorMetadataMapSchema,
} from "./runners";
import {
  eventSequenceNumberSchema,
  networkLogEntrySchema,
  runStorageOutputSchema,
} from "./runs";
import {
  presignedUploadSchema,
  storageChangesSchema,
  storageManifestFilesSchema,
} from "./storages";
import {
  X_RESOURCE_USAGE_MAX_IDS,
  xResourceUsageEventSchema,
} from "./x-resource-usage";

export {
  homeReuseResultSchema,
  sandboxReuseResultSchema,
  type HomeReuseResult,
  type SandboxReuseResult,
} from "./runners";

const c = initContract();

const thirdPartyWebhookErrorSchema = object({ error: string() });
const thirdPartyWebhookOkSchema = union([
  string(),
  object({ message: literal("pong") }),
]);

/**
 * Clerk third-party webhook contract for /api/webhooks/clerk.
 */
export const webhookClerkContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/clerk",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Clerk organization and user webhooks",
  },
});

/**
 * GitHub App third-party webhook contract for /api/webhooks/github.
 */
export const webhookGithubContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/github",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle GitHub App webhooks",
  },
});

/**
 * Stripe third-party webhook contract for /api/webhooks/stripe.
 */
export const webhookStripeContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/stripe",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Stripe billing webhooks",
  },
});

// Connect account notifications keep their configured URL and signing secret.
export const webhookStripeConnectContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/stripe-automation-events",
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      500: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Stripe Connect account notifications",
  },
});

const gmailWebhookResponseSchema = object({
  success: literal(true),
  watchStates: number(),
  dispatched: number(),
  duplicates: number(),
});

const googleCalendarWebhookResponseSchema = object({
  success: literal(true),
  watchStates: number(),
  dispatched: number(),
  duplicates: number(),
});

const googleFormsWebhookResponseSchema = object({
  success: literal(true),
  watchStates: number(),
  dispatched: number(),
  duplicates: number(),
});

const googleWorkspaceEventsWebhookResponseSchema = object({
  success: literal(true),
  watchStates: number(),
  dispatched: number(),
  duplicates: number(),
});

const notionWebhookResponseSchema = object({
  success: literal(true),
  kind: zEnum(["verification", "event"]),
  pending: number(),
  refreshed: number(),
  duplicates: number(),
});

const workflowAutomationWebhookResponseSchema = object({
  success: literal(true),
  duplicate: boolean(),
  runId: uuid().optional(),
});

/**
 * Gmail Pub/Sub push webhook contract for /api/webhooks/gmail.
 */
export const webhookGmailContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/gmail",
    body: c.type<string>(),
    responses: {
      200: gmailWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Gmail Pub/Sub push notifications",
  },
});

/**
 * Google Forms Pub/Sub push webhook contract.
 */
export const webhookGoogleFormsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-forms",
    body: c.type<string>(),
    responses: {
      200: googleFormsWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Forms Pub/Sub push notifications",
  },
});

/**
 * Google Calendar push webhook contract for /api/webhooks/google-calendar.
 */
export const webhookGoogleCalendarContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-calendar",
    body: c.type<string>(),
    responses: {
      200: googleCalendarWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Calendar push notifications",
  },
});

/**
 * Google Workspace Events Pub/Sub push webhook contract for
 * /api/webhooks/google-workspace-events.
 */
export const webhookGoogleWorkspaceEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/google-workspace-events",
    body: c.type<string>(),
    responses: {
      200: googleWorkspaceEventsWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      429: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Google Workspace Events Pub/Sub push notifications",
  },
});

/**
 * Notion webhook contract for /api/webhooks/notion.
 */
export const webhookNotionContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/notion",
    body: c.type<string>(),
    responses: {
      200: notionWebhookResponseSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle Notion webhook events",
  },
});

const workflowAutomationWebhookPostRoute = {
  method: "POST" as const,
  pathParams: object({
    token: string().min(1),
  }),
  body: c.type<string>(),
  responses: {
    200: workflowAutomationWebhookResponseSchema,
    400: thirdPartyWebhookErrorSchema,
    401: thirdPartyWebhookErrorSchema,
    404: thirdPartyWebhookErrorSchema,
    413: thirdPartyWebhookErrorSchema,
    429: thirdPartyWebhookErrorSchema,
    500: thirdPartyWebhookErrorSchema,
  },
};

/**
 * Workflow automation inbound webhook contract for
 * /api/webhooks/workflow-automations/:token.
 */
export const webhookWorkflowAutomationContract = c.router({
  post: {
    ...workflowAutomationWebhookPostRoute,
    path: "/api/webhooks/workflow-automations/:token",
    summary: "Handle inbound workflow automation webhooks",
  },
});

export const webhookBuiltInGenerationFalContract = c.router({
  post: {
    method: "POST",
    path: "/api/webhooks/built-in-generations/fal/:generationId",
    pathParams: object({
      generationId: uuid(),
    }),
    query: object({
      token: string().min(1),
      visualKey: string().min(1).optional(),
    }),
    body: c.type<string>(),
    responses: {
      200: thirdPartyWebhookOkSchema,
      400: thirdPartyWebhookErrorSchema,
      401: thirdPartyWebhookErrorSchema,
      503: thirdPartyWebhookErrorSchema,
    },
    summary: "Handle fal built-in generation webhooks",
  },
});

const storageOutputsSchema = array(runStorageOutputSchema);

/**
 * Volume versions snapshot schema
 */
const volumeVersionsSnapshotSchema = object({
  versions: record(string(), string()),
});

export const runCompletionMetadataSchema = object({
  cliAgentType: string().min(1, "cliAgentType is required"),
  cliAgentSessionId: string().min(1, "cliAgentSessionId is required"),
  cliAgentSessionHistoryDisposition: zEnum(["native_only"]),
  // Versions of the run's authorized writeback mounts after publication.
  storageOutputs: storageOutputsSchema.optional(),
  volumeVersionsSnapshot: volumeVersionsSnapshotSchema.optional(),
}).strict();

const webhookCompleteBodySchema = object({
  runId: string().min(1, "runId is required"),
  exitCode: number(),
  error: string().optional(),
  failureReason: runFailureReasonTokenSchema.optional(),
  lastEventSequence: eventSequenceNumberSchema.optional(),
  // Sandbox id the run executed against. Optional because a run that fails
  // before sandbox creation has no sandbox. Persisted to agent_runs.sandbox_id;
  // the 255-char cap matches the DB column (defense in depth).
  sandboxId: string().max(255).optional(),
  completion: runCompletionMetadataSchema.optional(),
});

/**
 * Agent event schema for webhook events
 * Note: Claude Code JSONL events have varying structures with different fields
 * depending on the event type (system, assistant, user, result, etc.)
 * We require `type` and `sequenceNumber`, and allow any other fields to pass through
 */
const agentEventSchema = object({
  type: string(),
  sequenceNumber: eventSequenceNumberSchema,
}).passthrough();

const webhookSessionOutputBodySchema = object({
  runId: uuid(),
  threadId: uuid(),
  runEventId: string().min(1).max(512),
  chunkIndex: number().int().nonnegative().max(4_294_967_295),
  delta: string().min(1).max(4096),
}).strict();

const webhookEventsBodySchema = object({
  runId: string().min(1, "runId is required"),
  events: array(agentEventSchema).min(1, "events array cannot be empty"),
});

const firewallAuthErrorSchema = object({
  error: object({
    message: string(),
    code: string(),
    connectors: array(string()).optional(),
    failureReason: zEnum([
      "upstream_provider",
      "reconnect_required",
    ]).optional(),
  }),
});

const firewallAwsSigv4AuthSchema = object({
  accessKeyId: string().min(1),
  secretAccessKey: string().min(1),
  sessionToken: string().min(1).optional(),
}).strict();

const firewallAuthResponseSchema = object({
  headers: record(string(), string()),
  base: string().optional(),
  query: record(string(), string()).optional(),
  awsSigv4: firewallAwsSigv4AuthSchema.optional(),
  // Effective expiry as Unix seconds: refreshable token expiry minus the API's
  // refresh buffer, capped by other authorization limits such as credit leases.
  // Remaining lifetime must be positive; null is non-expiring only for non-billable auth.
  expiresAt: number().nullable(),
  resolvedSecrets: array(string()),
  refreshedConnectors: array(string()),
  refreshedSecrets: array(string()),
});

const matchedFirewallAuthContextSchema = object({
  name: string().min(1),
  apiId: string().min(1),
  base: string().min(1).optional(),
  connectorSlug: connectorSlugSchema.optional(),
  customConnectorId: uuid().optional(),
  sourceId: uuid().optional(),
  routingVariables: record(string(), string()),
}).refine(
  (context) => {
    return (
      Number(context.connectorSlug !== undefined) +
        Number(context.customConnectorId !== undefined) ===
      1
    );
  },
  { message: "Matched firewall must identify exactly one connector" },
);

export const webhookFirewallAuthContract = c.router({
  /**
   * POST /api/webhooks/agent/firewall/auth
   * Resolve firewall auth templates and refresh access tokens on demand.
   */
  resolve: {
    method: "POST",
    path: "/api/webhooks/agent/firewall/auth",
    headers: authHeadersSchema,
    body: object({
      // Encrypted runtime secret namespace. After decryption, keys are the
      // `NAME` in `${{ secrets.NAME }}`.
      encryptedSecrets: string().min(1),
      authHeaders: record(string(), string()),
      authBase: string().optional(),
      authQuery: record(string(), string()).optional(),
      authAwsSigv4: firewallAwsSigv4AuthSchema.optional(),
      // Maps firewall auth secret env aliases (the `NAME` in `${{ secrets.NAME }}`)
      // to the connector or provider owner that can refresh/resolve access.
      secretConnectorMap: record(string(), string()).optional(),
      // Same keys as secretConnectorMap; adds source details when the owner
      // alone is not enough to locate access storage.
      secretConnectorMetadataMap: secretConnectorMetadataMapSchema.optional(),
      vars: record(string(), string()).optional(),
      // Stable matched-firewall identity plus exact routing inputs.
      // Inline and model-provider firewalls do not identify a connector.
      matchedFirewall: matchedFirewallAuthContextSchema.optional(),
      // Set by mitm from billableFirewalls. Server uses this only to bound
      // auth cache lifetime by the current credit authorization lease.
      firewallBillable: boolean().optional(),
      forceRefresh: boolean().optional(),
    }),
    responses: {
      200: firewallAuthResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      424: firewallAuthErrorSchema,
      502: firewallAuthErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve firewall auth templates",
  },
});

/**
 * Best-effort Sandbox session output contract.
 *
 * The sandbox token, rather than body fields, supplies the user and
 * organization that own the realtime channel. The thread ID is only a client
 * display hint inside that run-scoped channel. This path never enters durable
 * event ingestion.
 */
export const webhookSessionOutputContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/session-output",
    headers: authHeadersSchema,
    body: webhookSessionOutputBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Publish transient session output from sandbox",
  },
});

/**
 * Webhook events contract for /api/webhooks/agent/events
 */
export const webhookEventsContract = c.router({
  /**
   * POST /api/webhooks/agent/events
   * Receive agent events from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/events",
    headers: authHeadersSchema,
    body: webhookEventsBodySchema,
    responses: {
      200: object({
        received: number(),
        firstSequence: number(),
        lastSequence: number(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Receive agent events from sandbox",
  },
});

/**
 * Webhook complete contract for /api/webhooks/agent/complete
 */
export const webhookCompleteContract = c.router({
  /**
   * POST /api/webhooks/agent/complete
   * Handle agent run completion (success or failure)
   */
  complete: {
    method: "POST",
    path: "/api/webhooks/agent/complete",
    headers: authHeadersSchema,
    body: webhookCompleteBodySchema,
    responses: {
      200: object({
        success: boolean(),
        status: zEnum(["completed", "failed"]),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Handle agent run completion",
  },
});

/**
 * Webhook heartbeat contract for /api/webhooks/agent/heartbeat
 */
export const webhookHeartbeatContract = c.router({
  /**
   * POST /api/webhooks/agent/heartbeat
   * Receive heartbeat signals from sandbox
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/heartbeat",
    headers: authHeadersSchema,
    body: object({
      runId: string().min(1, "runId is required"),
    }),
    responses: {
      200: object({
        ok: boolean(),
        typingRefreshIntervalSeconds: number().int().min(3).max(10).optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive heartbeat from sandbox",
  },
});

const filesystemCounterSchema = number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const filesystemObservationSchema = object({
  used_bytes: filesystemCounterSchema,
  total_bytes: filesystemCounterSchema,
  available_bytes: filesystemCounterSchema,
  used_inodes: filesystemCounterSchema,
  total_inodes: filesystemCounterSchema,
  available_inodes: filesystemCounterSchema,
}).refine((fs) => {
  return (
    fs.used_bytes <= fs.total_bytes &&
    fs.available_bytes <= fs.total_bytes - fs.used_bytes &&
    fs.used_inodes <= fs.total_inodes &&
    fs.available_inodes <= fs.total_inodes - fs.used_inodes
  );
});

/**
 * Metric data point schema
 */
const metricDataSchema = object({
  // A periodic memory snapshot rides along with ordinary metrics. Rejecting it
  // must never discard the system logs, metrics, network logs, and sandbox
  // operations batched in the same request; the dedicated `oomEvidence` field
  // below stays strict because it decides the delivery acknowledgement.
  memory: oomEvidenceSchema.optional().catch(undefined),
  ts: string(),
  cpu: number(),
  cpu_steal_percent: number().optional(),
  scheduled_lag_ms: number().optional(),
  mem_used: number(),
  mem_total: number(),
  // A bad optional filesystem sample must not reject the telemetry batch.
  rootfs: filesystemObservationSchema.optional().catch(undefined),
  home: filesystemObservationSchema.optional().catch(undefined),
  control_cpu_usage_usec: number().optional(),
  control_cpu_nr_throttled: number().optional(),
  control_cpu_throttled_usec: number().optional(),
  workload_cpu_usage_usec: number().optional(),
  workload_cpu_nr_throttled: number().optional(),
  workload_cpu_throttled_usec: number().optional(),
});

export const runnerStartupPathSchema = zEnum([
  ...sandboxStartupPathSchema.options,
  "workspace",
]);

export type RunnerStartupPath = zInfer<typeof runnerStartupPathSchema>;

const runnerPreSpawnConcurrencyBucketSchema = zEnum([
  "1",
  "2",
  "3_4",
  "5_8",
  "9_plus",
]);

export type RunnerPreSpawnConcurrencyBucket = zInfer<
  typeof runnerPreSpawnConcurrencyBucketSchema
>;

const runnerResourceBudgetUtilizationBucketSchema = zEnum([
  "0_25",
  "26_50",
  "51_75",
  "76_100",
  "over_100",
]);

export type RunnerResourceBudgetUtilizationBucket = zInfer<
  typeof runnerResourceBudgetUtilizationBucketSchema
>;

const runnerResourceBudgetLeaseCountBucketSchema = zEnum([
  "0",
  "1",
  "2",
  "3_4",
  "5_8",
  "9_plus",
]);

export type RunnerResourceBudgetLeaseCountBucket = zInfer<
  typeof runnerResourceBudgetLeaseCountBucketSchema
>;

// Decimal text preserves a declared u64 response length beyond JS safe integers.
const archiveSizeBytesSchema = string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/u);

const archiveSizeMismatchSchema = object({
  expected_bytes: archiveSizeBytesSchema,
  response_bytes: archiveSizeBytesSchema,
  source_kind: zEnum(["storage", "artifact"]),
  source_index: number().int().nonnegative(),
  content_encoding: zEnum(["absent", "identity", "gzip", "other"]),
});

export type ArchiveSizeMismatch = zInfer<typeof archiveSizeMismatchSchema>;

const archiveConnectionAttemptSchema = object({
  started: number().int().min(0).max(255),
  succeeded: number().int().min(0).max(255),
  failed: number().int().min(0).max(255),
  dropped: number().int().min(0).max(255),
  active_at_headers: number().int().min(0).max(255),
  terminal_duration_ms: number().int().min(0).max(4_294_967_295),
  saturated: boolean(),
});

export type ArchiveConnectionAttempt = zInfer<
  typeof archiveConnectionAttemptSchema
>;

const storageBatchEvidenceIntegerSchema = number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Sandbox operation schema for internal sandbox operations (init, storage, cli, finalization, cleanup)
 */
const sandboxOperationSchema = object({
  ts: string(),
  action_type: string(),
  duration_ms: number(),
  success: boolean(),
  error: string().optional(),
  outcome: string().max(64).optional(),
  reason: string().max(64).optional(),
  archive_size_mismatch: archiveSizeMismatchSchema.optional(),
  archive_connection_attempt: archiveConnectionAttemptSchema.optional(),
  dns_readiness_attempt: number().int().min(1).max(3).optional(),
  dns_readiness_final_attempt: boolean().optional(),
  dns_readiness_guest_duration_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  dns_readiness_host_residual_ms: number().int().nonnegative().optional(),
  dns_readiness_timing: zEnum([
    "paired",
    "unavailable",
    "inconsistent",
  ]).optional(),
  storage_batch_guest_duration_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_outer_residual_ms: number().int().nonnegative().optional(),
  storage_batch_admission_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_request_setup_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_frame_builder_wait_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_frame_encode_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_writer_wait_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_frame_write_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_response_wait_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_result_decode_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_resource_log_ms: number()
    .int()
    .min(0)
    .max(4_294_967_295)
    .optional(),
  storage_batch_host_timing: zEnum([
    "complete",
    "partial",
    "unavailable",
  ]).optional(),
  storage_batch_guest_timing: zEnum([
    "complete",
    "partial",
    "unavailable",
  ]).optional(),
  storage_batch_resources: zEnum([
    "complete",
    "partial",
    "unavailable",
  ]).optional(),
  storage_batch_guest_request_ownership_us:
    storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_guest_worker_wait_us:
    storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_guest_response_prepare_us:
    storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_containment_wall_us:
    storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_resource_collection_us:
    storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_cpu_usage_us: storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_cpu_throttled_us: storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_memory_peak_bytes: storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_memory_events_oom: storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_memory_events_oom_kill:
    storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_memory_events_oom_group_kill:
    storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_pids_events_max: storageBatchEvidenceIntegerSchema.optional(),
  storage_batch_payload_size_bucket: zEnum([
    "none",
    "up_to_4_kib",
    "4_to_16_kib",
    "16_to_64_kib",
    "64_to_256_kib",
    "256_kib_to_1_mib",
    "1_to_4_mib",
    "4_to_15_mib",
  ]).optional(),
  storage_batch_timing: zEnum([
    "paired",
    "unavailable",
    "inconsistent",
  ]).optional(),
  runner_startup_path: runnerStartupPathSchema.optional(),
  is_first_run: boolean().optional(),
  reuse_key: string().optional(),
  run_id: uuid().optional(),
  cache_key: string().max(4096).optional(),
  profile_name: string().max(4096).optional(),
  image_generation: string().max(4096).optional(),
  allocated_bytes: number().int().nonnegative().optional(),
  handoff_path: string().max(64).optional(),
  runner_id: uuid().optional(),
  runner_heartbeat_generation: number().int().nonnegative().optional(),
  inventory_loaded: boolean().optional(),
  inventory_observed_states: number().int().nonnegative().optional(),
  inventory_output_states: number().int().nonnegative().optional(),
  inventory_omitted_states: number().int().nonnegative().optional(),
  home_reuse_result: homeReuseResultSchema.optional(),
  sandbox_reuse_result: sandboxReuseResultSchema.optional(),
  runner_pre_spawn_concurrency_bucket:
    runnerPreSpawnConcurrencyBucketSchema.optional(),
  runner_resource_budget_vcpu_utilization_bucket:
    runnerResourceBudgetUtilizationBucketSchema.optional(),
  runner_resource_budget_memory_utilization_bucket:
    runnerResourceBudgetUtilizationBucketSchema.optional(),
  runner_resource_budget_lease_count_bucket:
    runnerResourceBudgetLeaseCountBucketSchema.optional(),
});

/**
 * Webhook telemetry contract for /api/webhooks/agent/telemetry
 */
export const webhookTelemetryContract = c.router({
  /**
   * POST /api/webhooks/agent/telemetry
   * Receive sandbox telemetry or authenticated Runner operation-only batches.
   * Runless requests cannot carry system logs, metrics, network logs or OOM evidence.
   */
  send: {
    method: "POST",
    path: "/api/webhooks/agent/telemetry",
    headers: authHeadersSchema,
    body: object({
      runId: string().min(1, "runId is required").optional(),
      runnerHostname: runnerHostnameSchema.optional(),
      runnerVersion: runnerVersionSchema.optional(),
      systemLog: string().optional(),
      oomEvidence: oomEvidenceSchema.optional(),
      sandboxId: uuid().optional(),
      metrics: array(metricDataSchema).optional(),
      networkLogs: array(networkLogEntrySchema).optional(),
      sandboxOperations: array(sandboxOperationSchema).optional(),
    }),
    responses: {
      200: object({
        success: boolean(),
        id: string().optional(),
        oomEvidenceVersion: literal(1).optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive telemetry data from sandbox",
  },
});

// ============================================================================
// Direct Upload Contracts (Webhook endpoints for sandbox)
// ============================================================================

/**
 * Webhook storage prepare contract for /api/webhooks/agent/storages/prepare
 *
 * Sandbox version of storage prepare endpoint.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 */
export const webhookStoragesPrepareContract = c.router({
  prepare: {
    method: "POST",
    path: "/api/webhooks/agent/storages/prepare",
    headers: authHeadersSchema,
    body: object({
      runId: string().min(1, "runId is required"), // Required for webhook auth
      /**
       * Canonical Storage identity authorized against the run's writeback
       * mounts.
       */
      storageId: uuid(),
      files: storageManifestFilesSchema,
      parentVersionId: string().optional(),
      /** Legacy request field; a registered version cannot be re-uploaded. */
      force: boolean().optional(),
      baseVersion: string().optional(),
      changes: storageChangesSchema.optional(),
    }),
    responses: {
      200: object({
        versionId: string(),
        existing: boolean(),
        uploads: object({
          archive: presignedUploadSchema,
          manifest: presignedUploadSchema,
        }).optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare for direct S3 upload from sandbox",
  },
});

/**
 * Webhook storage commit contract for /api/webhooks/agent/storages/commit
 *
 * Sandbox version of storage commit endpoint.
 * Uses JWT sandbox token authentication and verifies runId matches token.
 */
export const webhookStoragesCommitContract = c.router({
  commit: {
    method: "POST",
    path: "/api/webhooks/agent/storages/commit",
    headers: authHeadersSchema,
    body: object({
      runId: string().min(1, "runId is required"), // Required for webhook auth
      /**
       * Canonical Storage identity authorized against the run's writeback
       * mounts.
       */
      storageId: uuid(),
      versionId: string().min(1, "Version ID is required"),
      parentVersionId: string().optional(),
      files: storageManifestFilesSchema,
      message: string().optional(),
    }),
    responses: {
      200: object({
        success: literal(true),
        versionId: string(),
        storageName: string(),
        size: number(),
        fileCount: number(),
        deduplicated: boolean().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Commit uploaded storage from sandbox",
  },
});

export type WebhookEventsContract = typeof webhookEventsContract;
export type WebhookClerkContract = typeof webhookClerkContract;
export type WebhookGithubContract = typeof webhookGithubContract;
export type WebhookGmailContract = typeof webhookGmailContract;
export type WebhookGoogleFormsContract = typeof webhookGoogleFormsContract;
export type WebhookGoogleCalendarContract =
  typeof webhookGoogleCalendarContract;
export type WebhookGoogleWorkspaceEventsContract =
  typeof webhookGoogleWorkspaceEventsContract;
export type WebhookStripeContract = typeof webhookStripeContract;
export type WebhookStripeConnectContract = typeof webhookStripeConnectContract;
export type WebhookWorkflowAutomationContract =
  typeof webhookWorkflowAutomationContract;
export type WebhookBuiltInGenerationFalContract =
  typeof webhookBuiltInGenerationFalContract;
export type WebhookFirewallAuthContract = typeof webhookFirewallAuthContract;
export type WebhookCompleteContract = typeof webhookCompleteContract;
export type WebhookHeartbeatContract = typeof webhookHeartbeatContract;
export type WebhookTelemetryContract = typeof webhookTelemetryContract;
export type WebhookStoragesPrepareContract =
  typeof webhookStoragesPrepareContract;
export type WebhookStoragesCommitContract =
  typeof webhookStoragesCommitContract;

/**
 * Webhook usage event contract for /api/webhooks/agent/usage-event
 *
 * Receives billing usage records from the sandbox for persistence in the
 * `usage_event` ledger. Reporters send `{ runId, events }` batches, and the
 * API prices their quantities from the server-side pricing table.
 */
const webhookUsageEventItemSchema = object({
  idempotencyKey: uuid(),
  kind: zEnum(["connector", "model", "image"]),
  // Runtime model identities share agent_runs.model_runtime_model's 255 limit.
  provider: string().min(1).max(255),
  category: string().min(1).max(100),
  quantity: number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const webhookUsageEventContract = c.router({
  send: {
    method: "POST",
    path: "/api/webhooks/agent/usage-event",
    headers: authHeadersSchema,
    body: object({
      runId: string().min(1, "runId is required"),
      events: array(
        union([webhookUsageEventItemSchema, xResourceUsageEventSchema]),
      )
        .min(1)
        .max(100),
    })
      .strict()
      .superRefine((body, ctx) => {
        let resourceCount = 0;
        let hasResourceObservation = false;
        for (const event of body.events) {
          if ("protocol" in event) {
            hasResourceObservation = true;
            resourceCount += event.resources.length;
          }
        }
        if (resourceCount > X_RESOURCE_USAGE_MAX_IDS) {
          ctx.addIssue({
            code: "custom",
            path: ["events"],
            message: "At most 1000 resource identities are allowed per batch",
          });
        }
        if (hasResourceObservation && !uuid().safeParse(body.runId).success) {
          ctx.addIssue({
            code: "custom",
            path: ["runId"],
            message: "Resource observations require a UUID run ID",
          });
        }
      }),
    responses: {
      200: object({
        success: boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Receive billing usage event data from sandbox",
  },
});

export type WebhookUsageEventContract = typeof webhookUsageEventContract;
