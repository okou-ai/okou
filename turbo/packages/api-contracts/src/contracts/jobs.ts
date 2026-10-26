import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  intersection,
  iso,
  literal,
  object,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  null as zNull,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { connectorSlugSchema } from "./connector-identity";

const id = uuid().toLowerCase();
export const jobStatusSchema = zEnum([
  "active",
  "waiting_decision",
  "waiting_authorization",
  "completed",
  "archived",
]);
export const jobAuthorizationSchema = object({
  id,
  agentId: id,
  action: string().trim().min(1).max(4000),
  connector: connectorSlugSchema,
  permission: string().min(1).max(128),
});
export const jobWorkSchema = object({
  progress: string().max(16000),
  explanation: string().max(4000),
  authorization: jobAuthorizationSchema.nullable(),
  processedInputIds: array(id),
  currentResultId: id.nullable(),
});
const resultContent = object({
  id,
  text: string().trim().min(1).max(65536),
  references: array(
    object({
      title: string().trim().min(1).max(200),
      url: url().refine((value) => {
        return value.startsWith("https://");
      }, "Use an HTTPS URL"),
    }),
  ).max(20),
});
export const jobResultSchema = resultContent.extend({
  publishedAt: iso.datetime(),
});
export const jobInputCreateSchema = discriminatedUnion("kind", [
  object({
    id,
    kind: literal("reply"),
    text: string().trim().min(1).max(16000),
  }),
  object({
    id,
    kind: literal("authorization"),
    requestId: id,
    outcome: zEnum(["granted", "declined"]),
    text: string().max(4000),
  }),
]);
const userJobInputSchema = intersection(
  jobInputCreateSchema,
  object({
    authorUserId: string().min(1),
    createdAt: iso.datetime(),
  }),
);
export const jobObservationCreateSchema = object({
  id,
  text: string().trim().min(1).max(16000),
  sourceReferences: array(string().trim().min(1).max(2000)).min(1).max(20),
  sourceVersion: string().trim().min(1).max(2000),
});
export const jobObservationSchema = jobObservationCreateSchema.extend({
  kind: literal("observation"),
  authorUserId: zNull(),
  agentId: id,
  runId: id,
  createdAt: iso.datetime(),
});
export const jobInputSchema = union([userJobInputSchema, jobObservationSchema]);
export const jobCreateSchema = object({
  id,
  title: string().trim().min(1).max(160),
  objective: string().trim().min(1).max(16000),
  sourceReferences: array(string().max(2000)).max(20).default([]),
});
export const jobSnapshotSchema = object({
  status: jobStatusSchema,
  work: jobWorkSchema,
});
export const jobUpdateSchema = object({
  expected: jobSnapshotSchema,
  status: jobStatusSchema.exclude(["archived"]),
  work: jobWorkSchema,
  result: resultContent.optional(),
}).superRefine((value, context) => {
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
  hasPendingInput: boolean(),
  hasUnseenResult: boolean(),
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
});
export const jobSchema = jobSummarySchema.extend({
  authorizationRequests: array(jobAuthorizationSchema),
  inputs: array(jobInputSchema),
  results: array(jobResultSchema),
  viewedResultIds: array(id),
});
export const jobListQuerySchema = object({
  filter: zEnum(["home", "history", "archived", "runnable", "all"]).default(
    "home",
  ),
  after: id.optional(),
  limit: coerce.number().int().min(1).max(100).default(50),
});
export type JobStatus = zInfer<typeof jobStatusSchema>;
export type JobWork = zInfer<typeof jobWorkSchema>;
export type JobInput = zInfer<typeof jobInputSchema>;
export type JobAuthorizationRequest = zInfer<typeof jobAuthorizationSchema>;
export type JobResult = zInfer<typeof jobResultSchema>;
export type JobCreate = zInfer<typeof jobCreateSchema>;
export type JobUpdate = zInfer<typeof jobUpdateSchema>;
export type JobInputCreate = zInfer<typeof jobInputCreateSchema>;
export type JobObservationCreate = zInfer<typeof jobObservationCreateSchema>;
export type Job = zInfer<typeof jobSchema>;
export type JobSummary = zInfer<typeof jobSummarySchema>;
export type JobListQuery = zInfer<typeof jobListQuerySchema>;

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
};
const pathParams = object({ id });
const resource = {
  headers: authHeadersSchema,
  pathParams,
  responses: { 200: jobSchema, ...errors },
};
export const jobsContract = c.router({
  identity: {
    method: "POST",
    path: "/api/jobs/identity",
    headers: authHeadersSchema,
    body: object({ key: string().trim().min(1).max(2048) }),
    responses: { 200: object({ id }), ...errors },
    summary:
      "Derive an owner-scoped stable identity for one source and next action",
  },
  list: {
    method: "GET",
    path: "/api/jobs",
    headers: authHeadersSchema,
    query: jobListQuerySchema,
    responses: {
      200: object({
        jobs: array(jobSummarySchema),
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
  observe: {
    method: "POST",
    path: "/api/jobs/:id/observations",
    ...resource,
    body: jobObservationCreateSchema,
    summary:
      "Planning: append verified source context without impersonating a user",
  },
  viewed: {
    method: "POST",
    path: "/api/jobs/:id/viewed",
    ...resource,
    body: object({ resultId: id }),
    summary: "Acknowledge the Result actually displayed",
  },
  archive: {
    method: "POST",
    path: "/api/jobs/:id/archive",
    ...resource,
    body: object({}),
    summary: "Archive a Task and stop its advancement",
  },
});
