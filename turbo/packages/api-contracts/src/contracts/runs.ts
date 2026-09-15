import { z } from "zod";
import { timestampQueryNumberSchema } from "./base";
import { firewallPoliciesSchema } from "@okouai/connectors/firewall-contracts";
import {
  modelProviderWriteTypeSchema,
  type ModelProviderWriteType,
} from "./model-providers";
import { triggerSourceSchema } from "./logs";
import { orgTierSchema } from "./orgs";

export type DirectRunModelProviderType = Exclude<
  ModelProviderWriteType,
  "built-in"
>;

const directRunModelProviderTypeSchema = modelProviderWriteTypeSchema.refine(
  (type) => {
    return type !== "built-in";
  },
  { message: "built-in model provider is only supported by agent runs" },
);

export const claudeToolEntrySchema = z
  .string()
  .refine(
    (tool) => {
      return tool.trim().length > 0;
    },
    {
      message: "Claude tool name must not be empty",
    },
  )
  .refine(
    (tool) => {
      return !tool.includes(",");
    },
    {
      message: "Claude tool name must not contain commas",
    },
  )
  .refine(
    (tool) => {
      return !tool.trimStart().startsWith("-");
    },
    {
      message: "Claude tool name must not start with a hyphen",
    },
  );

// Stored in Postgres `integer` columns. Keep request validation aligned with
// the DB range so malformed sandbox payloads fail as 400s instead of DB errors.
export const MAX_EVENT_SEQUENCE_NUMBER = 2_147_483_647;
export const eventSequenceNumberSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_EVENT_SEQUENCE_NUMBER);

/**
 * All valid run status values
 */
export const ALL_RUN_STATUSES = [
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;

/**
 * Run status enum
 */
const runStatusSchema = z.enum(ALL_RUN_STATUSES);

/**
 * Unified run request schema - supports all run modes via optional parameters
 */
const unifiedRunRequestSchema = z
  .object({
    // High-level shortcut for continuing an existing session.
    sessionId: z.string().optional(),

    // Base parameters (can be used directly or overridden after shortcut expansion)
    agentId: z.string().optional(),
    conversationId: z.string().optional(),
    // Multi-mount artifacts, each with its own mountPath.
    artifacts: z
      .array(
        z.object({
          name: z.string(),
          version: z.string().optional(),
          mountPath: z.string(),
        }),
      )
      .optional(),
    vars: z.record(z.string(), z.string()).optional(),
    secrets: z.record(z.string(), z.string()).optional(),
    volumeVersions: z.record(z.string(), z.string()).optional(),

    // Additional volumes passed directly at run time (bypass compose)
    additionalVolumes: z
      .array(
        z.object({
          name: z.string(),
          version: z.string().optional(),
          mountPath: z.string(),
        }),
      )
      .optional(),

    // Preview evaluation escape hatch: bypass preview mock CLIs and use the
    // real agent runtime.
    realAgentInPreview: z.boolean().optional(),

    // Capture HTTP header names, selected safe header values, request bodies, and response bodies
    // in network logs
    captureNetworkBodies: z.boolean().optional(),

    // Required
    prompt: z.string().min(1, "Missing prompt"),

    // Optional system prompt to append to the agent's system prompt
    appendSystemPrompt: z.string().optional(),

    // Optional list of tools to disable in Claude CLI (passed as --disallowed-tools)
    disallowedTools: z.array(claudeToolEntrySchema).optional(),

    // Optional list of tools to make available in Claude CLI (passed as --tools)
    tools: z.array(claudeToolEntrySchema).optional(),

    // Settings JSON to pass to Claude CLI (passed as --settings)
    settings: z.string().optional(),

    // Supported new work; the logs schema also decodes retained Goal history.
    triggerSource: triggerSourceSchema.exclude(["goal"]).optional(),

    // Per-permission policies (e.g., { "github": { "actions:read": "allow" } })
    permissionPolicies: firewallPoliciesSchema.optional(),

    // Internal: pin provider type for direct CLI runs used by E2E.
    // The built-in provider is intentionally excluded here because direct CLI
    // runs do not enforce built-in-provider credits.
    modelProviderType: directRunModelProviderTypeSchema.optional(),
  })
  .strict();

/**
 * Create run response schema
 */
const createRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  sandboxId: z.string().optional(),
  // Agent session id — eagerly created at run insertion, always present.
  sessionId: z.string().uuid(),
  output: z.string().optional(),
  error: z.string().optional(),
  executionTimeMs: z.number().optional(),
  createdAt: z.string().optional(),
});

/**
 * Get run response schema
 */
const getRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  vars: z.record(z.string(), z.string()).optional(),
  sandboxId: z.string().optional(),
  result: z
    .object({
      output: z.string().optional(),
      executionTimeMs: z.number().optional(),
      agentSessionId: z.string().optional(),
      checkpointId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .passthrough()
    .optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  /** Omitted when tracing was disabled for this run or by older APIs. */
  langfuseTraceUrl: z.url().optional(),
});

/**
 * Run event schema
 */
const runEventSchema = z.object({
  sequenceNumber: eventSequenceNumberSchema,
  eventType: z.string(),
  eventData: z.unknown(),
  createdAt: z.string(),
});

/**
 * Run result schema (present when status = 'completed')
 */
const runResultSchema = z.object({
  checkpointId: z.string(),
  agentSessionId: z.string(),
  conversationId: z.string(),
  artifact: z.record(z.string(), z.string()).optional(), // optional when run has no artifact
  volumes: z.record(z.string(), z.string()).optional(),
});

/**
 * Run state schema for the current lifecycle event contract.
 */
const runStateSchema = z.object({
  status: runStatusSchema,
  result: runResultSchema.optional(),
  error: z.string().optional(),
  lastEventSequence: eventSequenceNumberSchema.optional(),
});

/**
 * Run list item schema
 */
const runListItemSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  status: runStatusSchema,
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
});

/**
 * Runs list response schema
 */
const runsListResponseSchema = z.object({
  runs: z.array(runListItemSchema),
});

/**
 * Cancel run response schema
 */
const cancelRunResponseSchema = z.object({
  id: z.string(),
  status: z.literal("cancelled"),
  message: z.string(),
});

type LogPaginationCursorKind = "sequence" | "time";
type LogPaginationOrder = "asc" | "desc";

interface LogPaginationQueryOptions {
  readonly cursorKind: LogPaginationCursorKind;
  readonly maxLimit?: number;
  readonly defaultLimit?: number;
  readonly defaultOrder?: LogPaginationOrder;
}

const ISO_UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function rejectBlankQueryNumber(value: unknown): unknown {
  if (typeof value === "string" && value.trim().length === 0) {
    return Number.NaN;
  }

  return value;
}

const safeIntegerQueryNumberSchema = z.preprocess(
  rejectBlankQueryNumber,
  z.coerce.number().refine(Number.isSafeInteger, {
    message: "Value must be a safe integer",
  }),
);

const sequenceQueryNumberSchema = safeIntegerQueryNumberSchema
  .refine(
    (value) => {
      return value >= -1;
    },
    { message: "Sequence cursor must be at least -1" },
  )
  .refine(
    (value) => {
      return value <= MAX_EVENT_SEQUENCE_NUMBER;
    },
    { message: "Sequence cursor is out of range" },
  );

function logSinceQuerySchema(cursorKind: LogPaginationCursorKind) {
  return cursorKind === "time"
    ? timestampQueryNumberSchema
    : sequenceQueryNumberSchema;
}

function exactUtcTimestamp(value: string): string | null {
  const match = ISO_UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const [, yearPart, monthPart, dayPart, hourPart, minutePart, secondPart] =
    match;
  if (
    yearPart === undefined ||
    monthPart === undefined ||
    dayPart === undefined ||
    hourPart === undefined ||
    minutePart === undefined ||
    secondPart === undefined
  ) {
    return null;
  }

  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
    ? value
    : null;
}

function timeCursorTimestampValue(rawValue: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    return null;
  }
  return exactUtcTimestamp(decoded);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function timeCursorTieBreakerValue(rawValue: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    return null;
  }

  if (decoded.length === 0 || decoded.length > 2048) {
    return null;
  }

  return hasControlCharacter(decoded) ? null : decoded;
}

type ParsedLogCursor =
  | {
      readonly kind: "sequence";
      readonly order: LogPaginationOrder;
      readonly value: number;
    }
  | {
      readonly kind: "time";
      readonly order: LogPaginationOrder;
      readonly timestamp: string;
      readonly tieBreaker: string;
    };

function parseLogCursor(cursor: string): ParsedLogCursor | null {
  const timeMatch = /^time:(asc|desc):([^:]+):(.+)$/.exec(cursor);
  if (timeMatch) {
    const order = timeMatch[1];
    const rawTimestamp = timeMatch[2];
    const rawTieBreaker = timeMatch[3];
    if (
      (order !== "asc" && order !== "desc") ||
      rawTimestamp === undefined ||
      rawTieBreaker === undefined
    ) {
      return null;
    }

    const timestamp = timeCursorTimestampValue(rawTimestamp);
    const tieBreaker = timeCursorTieBreakerValue(rawTieBreaker);
    return timestamp === null || tieBreaker === null
      ? null
      : { kind: "time", order, timestamp, tieBreaker };
  }

  const sequenceMatch = /^sequence:(asc|desc):(-?\d+)$/.exec(cursor);
  if (!sequenceMatch) {
    return null;
  }

  const order = sequenceMatch[1];
  const rawValue = sequenceMatch[2];
  if ((order !== "asc" && order !== "desc") || rawValue === undefined) {
    return null;
  }

  if (!/^-?\d+$/.test(rawValue)) {
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    return null;
  }

  return { kind: "sequence", order, value };
}

function sequenceCursorOutOfRange(cursor: ParsedLogCursor): boolean {
  return (
    cursor.kind === "sequence" &&
    (cursor.value < -1 || cursor.value > MAX_EVENT_SEQUENCE_NUMBER)
  );
}

export function createLogPaginationQuerySchema(
  options: LogPaginationQueryOptions,
) {
  return z
    .object({
      since: logSinceQuerySchema(options.cursorKind).optional(),
      sinceTime: timestampQueryNumberSchema.optional(),
      cursor: z.string().min(1).optional(),
      limit: z
        .preprocess(
          rejectBlankQueryNumber,
          z.coerce
            .number()
            .int()
            .min(1)
            .max(options.maxLimit ?? 100),
        )
        .default(options.defaultLimit ?? 5),
      order: z.enum(["asc", "desc"]).default(options.defaultOrder ?? "desc"),
    })
    .superRefine((query, ctx) => {
      if (!query.cursor) {
        return;
      }

      const cursor = parseLogCursor(query.cursor);
      if (!cursor) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cursor"],
          message: "Cursor is malformed",
        });
        return;
      }

      if (cursor.kind !== options.cursorKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cursor"],
          message: `Cursor must be a ${options.cursorKind} cursor`,
        });
      }

      if (cursor.order !== query.order) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cursor"],
          message: "Cursor order must match query order",
        });
      }

      if (sequenceCursorOutOfRange(cursor)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cursor"],
          message: "Sequence cursor is out of range",
        });
      }
    });
}

/**
 * Agent events response schema
 */
const agentEventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable().optional(),
  status: runStatusSchema,
  lastEventSequence: eventSequenceNumberSchema.nullable(),
});

/**
 * Network log action semantics:
 * ALLOW means the request was allowed to continue.
 * DENY means network policy denied the request.
 * BLOCK means platform/proxy/auth/preconditions blocked the request locally.
 */
const networkLogActionSchema = z.enum(["ALLOW", "DENY", "BLOCK"]);

const modelCatalogCacheStatusSchema = z.enum([
  "model_catalog_bypass",
  "model_catalog_fresh_hit",
  "model_catalog_cold_stored",
  "model_catalog_cold_not_stored",
  "model_catalog_revalidated_304",
  "model_catalog_revalidated_200_same",
  "model_catalog_revalidated_200_changed",
  "model_catalog_revalidation_not_stored",
  "model_catalog_etag_confirmed",
  "model_catalog_etag_invalidated",
]);

const modelCatalogCacheBypassReasonSchema = z.enum([
  "request_url",
  "request_method",
  "request_framing",
  "request_body",
  "request_streaming",
  "request_conditions",
  "request_cache_control",
  "request_encoding",
  "request_identity",
  "request_capacity",
  "response_status",
  "response_encoding",
  "response_content_type",
  "response_cache_control",
  "response_vary",
  "response_etag",
  "response_size",
  "response_stream",
  "response_body",
  "response_json",
  "response_shape",
  "response_missing",
  "concurrent_change",
  "transport_error",
]);

const modelCatalogCacheUpstreamEncodingSchema = z.enum(["identity", "br"]);

const modelCatalogPrefetchRoleSchema = z.enum([
  "producer",
  "completed_consumer",
  "inflight_consumer",
]);

const modelCatalogCacheMillisecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647);

const modelCatalogCacheEvictionCountSchema = z.number().int().min(0).max(32);

/**
 * Network log entry schema.
 * [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
 */
const networkLogEntrySchema = z.object({
  timestamp: z.string(),
  type: z.string().optional(),
  action: networkLogActionSchema.optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  method: z.string().optional(),
  url: z.string().optional(),
  url_truncated: z.boolean().optional(),
  url_original_char_count: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  status: z.number().optional(),
  latency_ms: z.number().optional(),
  request_size: z.number().optional(),
  response_size: z.number().optional(),
  browser_user_agent: z.boolean().optional(),
  model_catalog_cache_status: modelCatalogCacheStatusSchema.optional(),
  model_catalog_cache_upstream_encoding:
    modelCatalogCacheUpstreamEncodingSchema.optional(),
  model_catalog_cache_bypass_reason:
    modelCatalogCacheBypassReasonSchema.optional(),
  model_catalog_cache_entry_age_ms:
    modelCatalogCacheMillisecondsSchema.optional(),
  model_catalog_cache_validation_latency_ms:
    modelCatalogCacheMillisecondsSchema.optional(),
  model_catalog_cache_eviction_count:
    modelCatalogCacheEvictionCountSchema.optional(),
  model_catalog_prefetch_role: modelCatalogPrefetchRoleSchema.optional(),
  dns_event: z.string().optional(),
  dns_query_type: z.string().optional(),
  dns_result: z.string().optional(),
  dns_serial: z.string().optional(),
  firewall_base: z.string().optional(),
  firewall_name: z.string().optional(),
  firewall_permission: z.string().optional(),
  firewall_rule_match: z.string().optional(),
  firewall_params: z.record(z.string(), z.string()).optional(),
  firewall_billable: z.boolean().optional(),
  firewall_error: z.string().optional(),
  upstream_binding_reason: z.string().optional(),
  upstream_binding_trusted_host: z.string().optional(),
  upstream_binding_request_host: z.string().optional(),
  upstream_binding_request_port: z.number().optional(),
  upstream_binding_server_connected: z.boolean().optional(),
  upstream_binding_server_address: z.string().optional(),
  upstream_binding_server_peername: z.string().optional(),
  upstream_binding_server_sockname: z.string().optional(),
  upstream_binding_client_sockname: z.string().optional(),
  upstream_binding_server_id: z.string().optional(),
  upstream_binding_client_id: z.string().optional(),
  upstream_binding_direct_binding_present: z.boolean().optional(),
  upstream_binding_direct_binding_host: z.string().optional(),
  upstream_binding_direct_binding_port: z.number().optional(),
  upstream_binding_direct_binding_kinds: z.string().optional(),
  upstream_binding_client_binding_count: z.number().optional(),
  upstream_binding_client_binding_match: z.boolean().optional(),
  upstream_binding_client_binding_endpoint_match: z.boolean().optional(),
  upstream_binding_client_binding_hosts: z.string().optional(),
  connector_diagnostic_slug: z.string().optional(),
  connector_diagnostic_reason: z.string().optional(),
  connector_diagnostic_env_names: z.array(z.string()).optional(),
  connector_diagnostic_base: z.string().optional(),
  connector_route_reason: z.string().optional(),
  connector_route_candidates: z.array(z.string()).optional(),
  auth_resolved_secrets: z.array(z.string()).optional(),
  auth_refreshed_connectors: z.array(z.string()).optional(),
  auth_refreshed_secrets: z.array(z.string()).optional(),
  auth_cache_hit: z.boolean().optional(),
  auth_url_rewrite: z.boolean().optional(),
  error: z.string().optional(),
  // Capture-only fields (opt-in via captureNetworkBodies). Header maps are
  // default-redacted, sanitized, and independently bounded to 512 fields / 32
  // KiB; see crates/runner/mitm-addon/src/body_capture.py for the contract.
  // *_headers_truncated describes only an incomplete serialized header map.
  // Body strings are bounded capture results; *_body_encoding distinguishes
  // UTF-8, base64, and binary outcomes, while *_body_truncated describes an
  // incomplete or suppressed capture. Empty bodies have no body or encoding.
  request_headers: z.record(z.string(), z.string()).optional(),
  request_headers_truncated: z.boolean().optional(),
  request_body: z.string().optional(),
  request_body_encoding: z.enum(["utf-8", "base64", "binary"]).optional(),
  request_body_truncated: z.boolean().optional(),
  response_headers: z.record(z.string(), z.string()).optional(),
  response_headers_truncated: z.boolean().optional(),
  response_body: z.string().optional(),
  response_body_encoding: z.enum(["utf-8", "base64", "binary"]).optional(),
  response_body_truncated: z.boolean().optional(),
});

/**
 * Network logs response schema
 */
const networkLogsResponseSchema = z.object({
  networkLogs: z.array(networkLogEntrySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable().optional(),
});

/**
 * Queue entry schema — own entries have real data, others have null for private fields
 * Ownership is detected via runId: non-null = own entry, null = other user's entry
 */
const queueEntrySchema = z.object({
  position: z.number(),
  agentName: z.string().nullable(),
  agentDisplayName: z.string().nullable(),
  userEmail: z.string().nullable(),
  createdAt: z.string(),
  isOwner: z.boolean(),
  runId: z.string().nullable(),
  prompt: z.string().nullable(),
  triggerSource: triggerSourceSchema.nullable(),
  sessionLink: z.string().nullable(),
});

/**
 * Running task schema — shows currently executing runs
 */
const runningTaskSchema = z.object({
  runId: z.string().nullable(),
  agentName: z.string(),
  agentDisplayName: z.string().nullable(),
  userEmail: z.string(),
  startedAt: z.string().nullable(),
  isOwner: z.boolean(),
});

/**
 * Concurrency info schema
 */
const concurrencyMemberUsageSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  active: z.number(),
});

const concurrencyInfoSchema = z.object({
  tier: orgTierSchema,
  limit: z.number(),
  active: z.number(),
  available: z.number(),
  memberUsage: z.array(concurrencyMemberUsageSchema),
});

/**
 * Queue response schema
 */
const queueResponseSchema = z.object({
  concurrency: concurrencyInfoSchema,
  queue: z.array(queueEntrySchema),
  runningTasks: z.array(runningTaskSchema),
  estimatedTimePerRun: z.number().nullable(),
});

// Export schemas for reuse
export {
  runStatusSchema,
  directRunModelProviderTypeSchema,
  unifiedRunRequestSchema,
  createRunResponseSchema,
  getRunResponseSchema,
  runListItemSchema,
  runsListResponseSchema,
  cancelRunResponseSchema,
  runEventSchema,
  runResultSchema,
  runStateSchema,
  agentEventsResponseSchema,
  networkLogActionSchema,
  modelCatalogCacheStatusSchema,
  modelCatalogCacheBypassReasonSchema,
  modelCatalogCacheUpstreamEncodingSchema,
  modelCatalogPrefetchRoleSchema,
  modelCatalogCacheMillisecondsSchema,
  modelCatalogCacheEvictionCountSchema,
  networkLogEntrySchema,
  networkLogsResponseSchema,
  queueEntrySchema,
  runningTaskSchema,
  concurrencyMemberUsageSchema,
  concurrencyInfoSchema,
  queueResponseSchema,
};

// Export inferred types for consumers
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;
export type GetRunResponse = z.infer<typeof getRunResponseSchema>;
export type RunListItem = z.infer<typeof runListItemSchema>;
export type RunsListResponse = z.infer<typeof runsListResponseSchema>;
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;
export type AgentEventsResponse = z.infer<typeof agentEventsResponseSchema>;
export type NetworkLogAction = z.infer<typeof networkLogActionSchema>;
export type NetworkLogEntry = z.infer<typeof networkLogEntrySchema>;
export type NetworkLogsResponse = z.infer<typeof networkLogsResponseSchema>;
/**
 * Axiom raw network event — the shape returned by `queryAxiom` for network logs.
 * Uses `_time` (Axiom's timestamp field) instead of `timestamp`, and includes
 * `runId`/`userId` used for Axiom filtering.
 */
export type AxiomNetworkEvent = Omit<NetworkLogEntry, "timestamp"> & {
  _time: string;
  runId: string;
  userId: string;
};
export type QueueEntry = z.infer<typeof queueEntrySchema>;
export type RunningTask = z.infer<typeof runningTaskSchema>;
export type ConcurrencyMemberUsage = z.infer<
  typeof concurrencyMemberUsageSchema
>;
export type ConcurrencyInfo = z.infer<typeof concurrencyInfoSchema>;
export type QueueResponse = z.infer<typeof queueResponseSchema>;
