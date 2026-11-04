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
import {
  networkLogActionSchema,
  modelCatalogCacheStatusSchema,
  modelCatalogCacheBypassReasonSchema,
  modelCatalogCacheUpstreamEncodingSchema,
  modelCatalogPrefetchRoleSchema,
  modelCatalogCacheMillisecondsSchema,
  modelCatalogCacheEvictionCountSchema,
  networkLogEntrySchema,
  runningTaskSchema,
  concurrencyMemberUsageSchema,
  concurrencyInfoSchema,
  queueResponseSchema,
} from "../validators/runs";

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
 * Network logs response schema
 */
const networkLogsResponseSchema = object({
  networkLogs: array(networkLogEntrySchema),
  hasMore: boolean(),
  nextCursor: string().nullable().optional(),
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
