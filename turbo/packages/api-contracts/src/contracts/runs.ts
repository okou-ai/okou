import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  literal,
  number,
  object,
  preprocess,
  record,
  string,
  uuid,
  enum as zEnum,
  ZodIssueCode,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { timestampQueryNumberSchema } from "./base";
import { firewallPoliciesSchema } from "@okouai/connectors/firewall-contracts";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "./model-providers";
import { triggerSourceSchema } from "./logs";
import { orgTierSchema } from "./orgs";

export type DirectRunModelProviderType = Exclude<ModelProviderType, "built-in">;

const directRunModelProviderTypeSchema = modelProviderTypeSchema.refine(
  (type) => {
    return type !== "built-in";
  },
  { message: "built-in model provider is only supported by agent runs" },
);

export const claudeToolEntrySchema = string()
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
export const eventSequenceNumberSchema = number()
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
const runStatusSchema = zEnum(ALL_RUN_STATUSES);

/**
 * Unified run request schema - supports all run modes via optional parameters
 */
const unifiedRunRequestSchema = object({
  agentId: string().optional(),
  vars: record(string(), string()).optional(),
  secrets: record(string(), string()).optional(),
  volumeVersions: record(string(), string()).optional(),

  // Additional volumes passed directly at run time (bypass compose)
  additionalVolumes: array(
    object({
      name: string(),
      version: string().optional(),
      mountPath: string(),
    }),
  ).optional(),

  // Preview evaluation escape hatch: bypass preview mock CLIs and use the
  // real agent runtime.
  realAgentInPreview: boolean().optional(),

  // Capture HTTP header names, selected safe header values, request bodies, and response bodies
  // in network logs
  captureNetworkBodies: boolean().optional(),

  // Required
  prompt: string().min(1, "Missing prompt"),

  // Optional system prompt to append to the agent's system prompt
  appendSystemPrompt: string().optional(),

  // Optional list of tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools: array(claudeToolEntrySchema).optional(),

  // Optional list of tools to make available in Claude CLI (passed as --tools)
  tools: array(claudeToolEntrySchema).optional(),

  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings: string().optional(),

  triggerSource: triggerSourceSchema.optional(),

  // Per-permission policies (e.g., { "github": { "actions:read": "allow" } })
  permissionPolicies: firewallPoliciesSchema.optional(),

  // Internal: pin provider type for direct CLI runs used by E2E.
  // The built-in provider is intentionally excluded here because direct CLI
  // runs do not enforce built-in-provider credits.
  modelProviderType: directRunModelProviderTypeSchema.optional(),
}).strict();

/**
 * Create run response schema
 */
const createRunResponseSchema = object({
  runId: string(),
  status: runStatusSchema,
  sandboxId: string().optional(),
  output: string().optional(),
  error: string().optional(),
  executionTimeMs: number().optional(),
  createdAt: string().optional(),
});

/**
 * Get run response schema
 */
const getRunResponseSchema = object({
  runId: string(),
  status: runStatusSchema,
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  vars: record(string(), string()).optional(),
  sandboxId: string().optional(),
  result: object({
    output: string().optional(),
    executionTimeMs: number().optional(),
  })
    .passthrough()
    .optional(),
  error: string().optional(),
  createdAt: string(),
  startedAt: string().optional(),
  completedAt: string().optional(),
  /** Stored run identity. Never a current route projection. */
  source: object({
    providerType: modelProviderTypeSchema.nullable(),
    runtimeProviderType: modelProviderTypeSchema.nullable(),
    model: string().nullable(),
    credentialScope: modelProviderCredentialScopeSchema.nullable(),
    account: discriminatedUnion("status", [
      object({ status: literal("unknown") }),
      object({ status: literal("unavailable") }),
      object({ status: literal("connected"), id: uuid() }),
    ]),
  }),
});

/**
 * Run event schema
 */
const runEventSchema = object({
  sequenceNumber: eventSequenceNumberSchema,
  eventType: string(),
  eventData: zUnknown(),
  createdAt: string(),
});

/**
 * Published writeback versions retained as exact Run completion retry evidence.
 */
export const runStorageOutputSchema = object({
  name: string(),
  version: string(),
  mountPath: string(),
  missingRootPolicy: zEnum(["fail", "preserveParentVersion"]).optional(),
});

/** Completion outputs, including those saved after failure/cancellation recovery. */
const runResultSchema = object({
  // Only writeback outputs are persisted. Read-only versions belong to launch mounts.
  storageOutputs: array(runStorageOutputSchema).optional(),
  framework: zEnum(["pi", "claude-code", "codex"]).optional(),
  frameworkSessionId: string().optional(),
});

/**
 * Run state schema for the current lifecycle event contract.
 */
const runStateSchema = object({
  status: runStatusSchema,
  result: runResultSchema.optional(),
  error: string().optional(),
  lastEventSequence: eventSequenceNumberSchema.optional(),
});

/**
 * Run list item schema
 */
const runListItemSchema = object({
  id: string(),
  agentName: string(),
  status: runStatusSchema,
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  createdAt: string(),
  startedAt: string().nullable(),
});

/**
 * Runs list response schema
 */
const runsListResponseSchema = object({
  runs: array(runListItemSchema),
});

/**
 * Cancel run response schema
 */
const cancelRunResponseSchema = object({
  id: string(),
  status: literal("cancelled"),
  message: string(),
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

const safeIntegerQueryNumberSchema = preprocess(
  rejectBlankQueryNumber,
  coerce.number().refine(Number.isSafeInteger, {
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
  return object({
    since: logSinceQuerySchema(options.cursorKind).optional(),
    sinceTime: timestampQueryNumberSchema.optional(),
    cursor: string().min(1).optional(),
    limit: preprocess(
      rejectBlankQueryNumber,
      coerce
        .number()
        .int()
        .min(1)
        .max(options.maxLimit ?? 100),
    ).default(options.defaultLimit ?? 5),
    order: zEnum(["asc", "desc"]).default(options.defaultOrder ?? "desc"),
  }).superRefine((query, ctx) => {
    if (!query.cursor) {
      return;
    }

    const cursor = parseLogCursor(query.cursor);
    if (!cursor) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        path: ["cursor"],
        message: "Cursor is malformed",
      });
      return;
    }

    if (cursor.kind !== options.cursorKind) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        path: ["cursor"],
        message: `Cursor must be a ${options.cursorKind} cursor`,
      });
    }

    if (cursor.order !== query.order) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        path: ["cursor"],
        message: "Cursor order must match query order",
      });
    }

    if (sequenceCursorOutOfRange(cursor)) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        path: ["cursor"],
        message: "Sequence cursor is out of range",
      });
    }
  });
}

/**
 * Agent events response schema
 */
const agentEventsResponseSchema = object({
  events: array(runEventSchema),
  hasMore: boolean(),
  nextCursor: string().nullable().optional(),
  status: runStatusSchema,
  lastEventSequence: eventSequenceNumberSchema.nullable(),
});

/**
 * Network log action semantics:
 * ALLOW means the request was allowed to continue.
 * DENY means network policy denied the request.
 * BLOCK means platform/proxy/auth/preconditions blocked the request locally.
 */
const networkLogActionSchema = zEnum(["ALLOW", "DENY", "BLOCK"]);

const modelCatalogCacheStatusSchema = zEnum([
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

const modelCatalogCacheBypassReasonSchema = zEnum([
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

const modelCatalogCacheUpstreamEncodingSchema = zEnum(["identity", "br"]);

const modelCatalogPrefetchRoleSchema = zEnum([
  "producer",
  "completed_consumer",
  "inflight_consumer",
]);

const modelCatalogCacheMillisecondsSchema = number()
  .int()
  .min(0)
  .max(2_147_483_647);

const modelCatalogCacheEvictionCountSchema = number().int().min(0).max(32);

/**
 * Network log entry schema.
 * [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
 */
const networkLogEntrySchema = object({
  timestamp: string(),
  type: string().optional(),
  action: networkLogActionSchema.optional(),
  host: string().optional(),
  port: number().optional(),
  method: string().optional(),
  url: string().optional(),
  url_truncated: boolean().optional(),
  url_original_char_count: number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  status: number().optional(),
  latency_ms: number().optional(),
  request_size: number().optional(),
  response_size: number().optional(),
  browser_user_agent: boolean().optional(),
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
  dns_event: string().optional(),
  dns_query_type: string().optional(),
  dns_result: string().optional(),
  dns_serial: string().optional(),
  firewall_base: string().optional(),
  firewall_name: string().optional(),
  firewall_permission: string().optional(),
  firewall_rule_match: string().optional(),
  firewall_params: record(string(), string()).optional(),
  firewall_billable: boolean().optional(),
  firewall_error: string().optional(),
  upstream_binding_reason: string().optional(),
  upstream_binding_trusted_host: string().optional(),
  upstream_binding_request_host: string().optional(),
  upstream_binding_request_port: number().optional(),
  upstream_binding_server_connected: boolean().optional(),
  upstream_binding_server_address: string().optional(),
  upstream_binding_server_peername: string().optional(),
  upstream_binding_server_sockname: string().optional(),
  upstream_binding_client_sockname: string().optional(),
  upstream_binding_server_id: string().optional(),
  upstream_binding_client_id: string().optional(),
  upstream_binding_direct_binding_present: boolean().optional(),
  upstream_binding_direct_binding_host: string().optional(),
  upstream_binding_direct_binding_port: number().optional(),
  upstream_binding_direct_binding_kinds: string().optional(),
  upstream_binding_client_binding_count: number().optional(),
  upstream_binding_client_binding_match: boolean().optional(),
  upstream_binding_client_binding_endpoint_match: boolean().optional(),
  upstream_binding_client_binding_hosts: string().optional(),
  connector_diagnostic_slug: string().optional(),
  connector_diagnostic_reason: string().optional(),
  connector_diagnostic_env_names: array(string()).optional(),
  connector_diagnostic_base: string().optional(),
  connector_route_reason: string().optional(),
  connector_route_candidates: array(string()).optional(),
  auth_resolved_secrets: array(string()).optional(),
  auth_refreshed_connectors: array(string()).optional(),
  auth_refreshed_secrets: array(string()).optional(),
  auth_cache_hit: boolean().optional(),
  auth_url_rewrite: boolean().optional(),
  error: string().optional(),
  // Capture-only fields (opt-in via captureNetworkBodies). Header maps are
  // default-redacted, sanitized, and independently bounded to 512 fields / 32
  // KiB; see crates/runner/mitm-addon/src/body_capture.py for the contract.
  // *_headers_truncated describes only an incomplete serialized header map.
  // Body strings are bounded capture results; *_body_encoding distinguishes
  // UTF-8, base64, and binary outcomes, while *_body_truncated describes an
  // incomplete or suppressed capture. Empty bodies have no body or encoding.
  request_headers: record(string(), string()).optional(),
  request_headers_truncated: boolean().optional(),
  request_body: string().optional(),
  request_body_encoding: zEnum(["utf-8", "base64", "binary"]).optional(),
  request_body_truncated: boolean().optional(),
  response_headers: record(string(), string()).optional(),
  response_headers_truncated: boolean().optional(),
  response_body: string().optional(),
  response_body_encoding: zEnum(["utf-8", "base64", "binary"]).optional(),
  response_body_truncated: boolean().optional(),
});

/**
 * Network logs response schema
 */
const networkLogsResponseSchema = object({
  networkLogs: array(networkLogEntrySchema),
  hasMore: boolean(),
  nextCursor: string().nullable().optional(),
});

/**
 * Running task schema — shows currently executing runs
 */
const runningTaskSchema = object({
  runId: string().nullable(),
  agentName: string(),
  agentDisplayName: string().nullable(),
  userEmail: string(),
  startedAt: string().nullable(),
  isOwner: boolean(),
});

/**
 * Concurrency info schema
 */
const concurrencyMemberUsageSchema = object({
  userId: string(),
  displayName: string(),
  active: number(),
});

const concurrencyInfoSchema = object({
  tier: orgTierSchema,
  limit: number(),
  active: number(),
  available: number(),
  memberUsage: array(concurrencyMemberUsageSchema),
});

/**
 * Queue response schema
 */
const queueResponseSchema = object({
  concurrency: concurrencyInfoSchema,
  runningTasks: array(runningTaskSchema),
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
  runningTaskSchema,
  concurrencyMemberUsageSchema,
  concurrencyInfoSchema,
  queueResponseSchema,
};

// Export inferred types for consumers
export type RunStatus = zInfer<typeof runStatusSchema>;
export type RunResult = zInfer<typeof runResultSchema>;
export type RunState = zInfer<typeof runStateSchema>;
export type RunEvent = zInfer<typeof runEventSchema>;
export type CreateRunResponse = zInfer<typeof createRunResponseSchema>;
export type GetRunResponse = zInfer<typeof getRunResponseSchema>;
export type RunListItem = zInfer<typeof runListItemSchema>;
export type RunsListResponse = zInfer<typeof runsListResponseSchema>;
export type CancelRunResponse = zInfer<typeof cancelRunResponseSchema>;
export type AgentEventsResponse = zInfer<typeof agentEventsResponseSchema>;
export type NetworkLogAction = zInfer<typeof networkLogActionSchema>;
export type NetworkLogEntry = zInfer<typeof networkLogEntrySchema>;
export type NetworkLogsResponse = zInfer<typeof networkLogsResponseSchema>;
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
export type RunningTask = zInfer<typeof runningTaskSchema>;
export type ConcurrencyMemberUsage = zInfer<
  typeof concurrencyMemberUsageSchema
>;
export type ConcurrencyInfo = zInfer<typeof concurrencyInfoSchema>;
export type QueueResponse = zInfer<typeof queueResponseSchema>;
