import { z } from "zod";
import {
  initContract,
  authHeadersSchema,
  timestampQueryNumberSchema,
} from "./base";
import { apiErrorSchema } from "./errors";

/**
 * Cursor-based pagination schema with total pages
 */
export const paginationSchema = z.object({
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  totalPages: z.number(),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Common query parameters for list endpoints
 */
const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const c = initContract();

/**
 * Run status enum for logs
 */
const logStatusSchema = z.enum([
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

/**
 * Trigger source enum — how the run was initiated
 */
export const triggerSourceSchema = z.enum([
  "web",
  "slack",
  "discord",
  "wechat",
  "teams",
  "feishu",
  "lark",
  "email",
  "telegram",
  "agentphone",
  "github",
  "test",
  "agent",
  "webhook",
  "automation-schedule",
  "automation-event",
]);

export type TriggerSource = z.infer<typeof triggerSourceSchema>;

/**
 * Log entry in list response - includes basic fields for list display
 */
const logEntrySchema = z.object({
  id: z.uuid(),
  sessionId: z.string().nullable(),
  agentId: z.string().nullable(),
  displayName: z.string().nullable(),
  framework: z.string().nullable(),
  triggerSource: triggerSourceSchema.nullable(),
  status: logStatusSchema,
  /** Prompt text the run was launched with. Used as a row description. */
  prompt: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/**
 * Available filter values returned by the list endpoint.
 * agents contains canonical agent IDs.
 */
const logsFiltersSchema = z.object({
  statuses: z.array(logStatusSchema),
  sources: z.array(triggerSourceSchema),
  agents: z.array(z.string()),
});

export type LogsFilters = z.infer<typeof logsFiltersSchema>;

/**
 * Logs list response schema with pagination
 */
const logsListResponseSchema = z.object({
  data: z.array(logEntrySchema),
  pagination: paginationSchema,
  filters: logsFiltersSchema,
});

/**
 * Log detail response schema
 */
const logDetailSchema = z.object({
  id: z.uuid(),
  sessionId: z.string().nullable(),
  agentId: z.string().nullable(),
  displayName: z.string().nullable(),
  framework: z.string().nullable(),
  modelProvider: z.string().nullable(),
  selectedModel: z.string().nullable(),
  modelRuntimeProvider: z.string().nullable().optional(),
  modelRuntimeModel: z.string().nullable().optional(),
  triggerSource: triggerSourceSchema.nullable(),
  status: logStatusSchema,
  prompt: z.string(),
  appendSystemPrompt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/**
 * Logs list contract
 * GET /api/logs
 */
export const logsListContract = c.router({
  list: {
    method: "GET",
    path: "/api/logs",
    headers: authHeadersSchema,
    query: listQuerySchema.extend({
      search: z.string().optional(),
      agentId: z.string().uuid().optional(),
      name: z.string().optional(),
      since: timestampQueryNumberSchema.optional(),

      status: logStatusSchema.optional(),
      triggerSource: triggerSourceSchema.optional(),
    }),
    responses: {
      200: logsListResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List agent run logs with pagination",
  },
});

/**
 * Logs by ID contract
 * GET /api/logs/:id
 */
export const logsByIdContract = c.router({
  getById: {
    method: "GET",
    path: "/api/logs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid("Invalid log ID"),
    }),
    responses: {
      200: logDetailSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get agent run log details by ID",
  },
});

// Contract type exports
export type LogsListContract = typeof logsListContract;
export type LogsByIdContract = typeof logsByIdContract;

// Schema exports for reuse
export {
  logStatusSchema,
  logEntrySchema,
  logsListResponseSchema,
  logDetailSchema,
};

// Inferred type exports
export type LogStatus = z.infer<typeof logStatusSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type LogsListResponse = z.infer<typeof logsListResponseSchema>;
export type LogDetail = z.infer<typeof logDetailSchema>;
