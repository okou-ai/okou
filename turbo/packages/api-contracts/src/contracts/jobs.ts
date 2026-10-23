import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { connectorSlugSchema } from "./connector-identity";

const id = z.uuid().toLowerCase();
export const jobStatusSchema = z.enum([
  "active",
  "waiting_decision",
  "waiting_authorization",
  "completed",
  "archived",
]);
export const jobAuthorizationSchema = z.object({
  id,
  agentId: id,
  action: z.string().trim().min(1).max(4000),
  connector: connectorSlugSchema,
  permission: z.string().min(1).max(128),
});
export const jobWorkSchema = z.object({
  progress: z.string().max(16000),
  explanation: z.string().max(4000),
  authorization: jobAuthorizationSchema.nullable(),
  processedInputIds: z.array(id),
  currentResultId: id.nullable(),
});
const resultContent = z.object({
  id,
  text: z.string().trim().min(1).max(65536),
  references: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        url: z.url().refine((value) => {
          return value.startsWith("https://");
        }, "Use an HTTPS URL"),
      }),
    )
    .max(20),
});
export const jobResultSchema = resultContent.extend({
  publishedAt: z.iso.datetime(),
});
export const jobInputCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    id,
    kind: z.literal("reply"),
    text: z.string().trim().min(1).max(16000),
  }),
  z.object({
    id,
    kind: z.literal("authorization"),
    requestId: id,
    outcome: z.enum(["granted", "declined"]),
    text: z.string().max(4000),
  }),
]);
export const jobInputSchema = z.intersection(
  jobInputCreateSchema,
  z.object({
    authorUserId: z.string().min(1),
    createdAt: z.iso.datetime(),
  }),
);
export const jobCreateSchema = z.object({
  id,
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(16000),
  sourceReferences: z.array(z.string().max(2000)).max(20).default([]),
});
export const jobSnapshotSchema = z.object({
  status: jobStatusSchema,
  work: jobWorkSchema,
});
export const jobUpdateSchema = z
  .object({
    expected: jobSnapshotSchema,
    status: jobStatusSchema.exclude(["archived"]),
    work: jobWorkSchema,
    result: resultContent.optional(),
  })
  .superRefine((value, context) => {
    if (value.result && value.work.currentResultId !== value.result.id) {
      context.addIssue({
        code: "custom",
        path: ["work", "currentResultId"],
        message: "Publish and select the same Result atomically",
      });
    }
    if (value.status.startsWith("waiting_") && !value.work.explanation.trim()) {
      context.addIssue({
        code: "custom",
        path: ["work", "explanation"],
        message: "Explain the input needed",
      });
    }
    if (
      value.status === "waiting_authorization" &&
      value.work.authorization === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["work", "authorization"],
        message: "Identify the exact permission and action",
      });
    }
    if (value.status === "completed" && value.work.currentResultId === null) {
      context.addIssue({
        code: "custom",
        path: ["work", "currentResultId"],
        message: "Completion requires a Result",
      });
    }
  });
export const jobSummarySchema = jobCreateSchema.extend({
  status: jobStatusSchema,
  work: jobWorkSchema,
  hasPendingInput: z.boolean(),
  hasUnseenResult: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const jobSchema = jobSummarySchema.extend({
  authorizationRequests: z.array(jobAuthorizationSchema),
  inputs: z.array(jobInputSchema),
  results: z.array(jobResultSchema),
  viewedResultIds: z.array(id),
});
export const jobListQuerySchema = z.object({
  filter: z
    .enum(["home", "history", "archived", "runnable", "all"])
    .default("home"),
  after: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobWork = z.infer<typeof jobWorkSchema>;
export type JobInput = z.infer<typeof jobInputSchema>;
export type JobAuthorizationRequest = z.infer<typeof jobAuthorizationSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;
export type JobCreate = z.infer<typeof jobCreateSchema>;
export type JobUpdate = z.infer<typeof jobUpdateSchema>;
export type JobInputCreate = z.infer<typeof jobInputCreateSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type JobListQuery = z.infer<typeof jobListQuerySchema>;

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
};
const pathParams = z.object({ id });
const resource = {
  headers: authHeadersSchema,
  pathParams,
  responses: { 200: jobSchema, ...errors },
};
export const jobsContract = c.router({
  list: {
    method: "GET",
    path: "/api/jobs",
    headers: authHeadersSchema,
    query: jobListQuerySchema,
    responses: {
      200: z.object({
        jobs: z.array(jobSummarySchema),
        nextAfter: id.nullable(),
      }),
      ...errors,
    },
    summary: "List explicitly entrusted Tasks",
  },
  get: {
    method: "GET",
    path: "/api/jobs/:id",
    ...resource,
    summary: "Read a Task and its stored inputs and Results",
  },
  create: {
    method: "POST",
    path: "/api/jobs",
    headers: authHeadersSchema,
    body: jobCreateSchema,
    responses: { 200: jobSchema, ...errors },
    summary: "Create an explicitly delegated Task",
  },
  update: {
    method: "PATCH",
    path: "/api/jobs/:id",
    ...resource,
    body: jobUpdateSchema,
    summary: "Conditionally update Task progress and publish a Result",
  },
  input: {
    method: "POST",
    path: "/api/jobs/:id/inputs",
    ...resource,
    body: jobInputCreateSchema,
    summary: "Save user input for the next Task evaluation",
  },
  viewed: {
    method: "POST",
    path: "/api/jobs/:id/viewed",
    ...resource,
    body: z.object({ resultId: id }),
    summary: "Acknowledge the Result actually displayed",
  },
  archive: {
    method: "POST",
    path: "/api/jobs/:id/archive",
    ...resource,
    body: z.object({}),
    summary: "Archive a Task and stop its advancement",
  },
});
