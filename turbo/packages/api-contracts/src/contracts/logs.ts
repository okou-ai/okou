import {
  array,
  boolean,
  coerce,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import {
  initContract,
  authHeadersSchema,
  timestampQueryNumberSchema,
} from "./base";
import { apiErrorSchema } from "./errors";
import { triggerSourceSchema } from "../validators/logs";

export { triggerSourceSchema } from "../validators/logs";

/**
 * Cursor-based pagination schema with total pages
 */
export const paginationSchema = object({
  hasMore: boolean(),
  nextCursor: string().nullable(),
  totalPages: number(),
});

export type Pagination = zInfer<typeof paginationSchema>;

/**
 * Common query parameters for list endpoints
 */
const listQuerySchema = object({
  cursor: string().optional(),
  limit: coerce.number().int().min(1).max(100).default(20),
});

const c = initContract();

/**
 * Run status enum for logs
 */
const logStatusSchema = zEnum([
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
]);

export type TriggerSource = zInfer<typeof triggerSourceSchema>;

/**
 * Log entry in list response - includes basic fields for list display
 */
const logEntrySchema = object({
  id: uuid(),
  sessionId: string().nullable(),
  agentId: string().nullable(),
  displayName: string().nullable(),
  framework: string().nullable(),
  triggerSource: triggerSourceSchema.nullable(),
  status: logStatusSchema,
  /** Prompt text the run was launched with. Used as a row description. */
  prompt: string(),
  createdAt: string(),
  startedAt: string().nullable(),
  completedAt: string().nullable(),
});

/**
 * Available filter values returned by the list endpoint.
 * agents contains canonical agent IDs.
 */
const logsFiltersSchema = object({
  statuses: array(logStatusSchema),
  sources: array(triggerSourceSchema),
  agents: array(string()),
});

export type LogsFilters = zInfer<typeof logsFiltersSchema>;

/**
 * Logs list response schema with pagination
 */
const logsListResponseSchema = object({
  data: array(logEntrySchema),
  pagination: paginationSchema,
  filters: logsFiltersSchema,
});

/**
 * Log detail response schema
 */
const logDetailSchema = object({
  id: uuid(),
  sessionId: string().nullable(),
  agentId: string().nullable(),
  displayName: string().nullable(),
  framework: string().nullable(),
  modelProvider: string().nullable(),
  selectedModel: string().nullable(),
  modelRuntimeProvider: string().nullable().optional(),
  modelRuntimeModel: string().nullable().optional(),
  triggerSource: triggerSourceSchema.nullable(),
  status: logStatusSchema,
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  error: string().nullable(),
  createdAt: string(),
  startedAt: string().nullable(),
  completedAt: string().nullable(),
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
      search: string().optional(),
      agentId: string().uuid().optional(),
      name: string().optional(),
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
    pathParams: object({
      id: string().uuid("Invalid log ID"),
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
export type LogStatus = zInfer<typeof logStatusSchema>;
export type LogEntry = zInfer<typeof logEntrySchema>;
export type LogsListResponse = zInfer<typeof logsListResponseSchema>;
export type LogDetail = zInfer<typeof logDetailSchema>;
