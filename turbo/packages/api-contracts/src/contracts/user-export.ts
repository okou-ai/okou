import {
  boolean,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  undefined as zUndefined,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const exportJobStatusSchema = zEnum([
  "pending",
  "running",
  "completed",
  "failed",
]);

const userExportJobSchema = object({
  id: uuid(),
  status: exportJobStatusSchema,
  createdAt: string(),
  completedAt: string().nullable(),
  expiresAt: string().nullable(),
  downloadUrl: url().nullable(),
  error: string().nullable(),
});

const userExportStatusResponseSchema = object({
  job: userExportJobSchema.nullable(),
  canExport: boolean(),
  nextExportAt: string().nullable(),
});

const userExportStartResponseSchema = object({
  jobId: uuid(),
  status: zEnum(["pending", "running"]),
});

export const userExportContract = c.router({
  get: {
    method: "GET",
    path: "/api/user/export",
    headers: authHeadersSchema,
    responses: {
      200: userExportStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get current user export status",
  },
  post: {
    method: "POST",
    path: "/api/user/export",
    headers: authHeadersSchema,
    body: zUndefined(),
    responses: {
      202: userExportStartResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Start a user data export",
  },
});

export type UserExportContract = typeof userExportContract;
export type UserExportStatusResponse = zInfer<
  typeof userExportStatusResponseSchema
>;
export type UserExportJob = zInfer<typeof userExportJobSchema>;
export type UserExportStartResponse = zInfer<
  typeof userExportStartResponseSchema
>;
