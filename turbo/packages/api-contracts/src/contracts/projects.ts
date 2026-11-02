import {
  array,
  boolean,
  coerce,
  enum as zEnum,
  number,
  object,
  union,
  url,
  uuid,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { chatThreadSnapshotProjectionSchema } from "../validators/chat-threads";

import {
  projectSchema,
  projectEventSchema,
  projectSnapshotArchiveSchema,
} from "../validators/projects";
export {
  projectSchema,
  projectEventSchema,
  projectSnapshotArchiveSchema,
  projectEventQueryResultSchema,
} from "../validators/projects";
export type { Project, ProjectEvent } from "../validators/projects";
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
};
const c = initContract();
export const projectsContract = c.router({
  list: {
    method: "GET",
    path: "/api/projects",
    headers: authHeadersSchema,
    responses: { 200: object({ projects: array(projectSchema) }), ...errors },
  },
  get: {
    method: "GET",
    path: "/api/projects/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: { 200: projectSchema, ...errors },
  },
  create: {
    method: "POST",
    path: "/api/projects",
    headers: authHeadersSchema,
    body: object({
      id: uuid(),
      eventId: uuid(),
      name: projectSchema.shape.name,
      fromThreadId: uuid().optional(),
    }).strict(),
    responses: { 201: projectSchema, ...errors },
  },
  update: {
    method: "PATCH",
    path: "/api/projects/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: object({ eventId: uuid(), name: projectSchema.shape.name }).strict(),
    responses: { 200: projectSchema, ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/projects/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: object({ eventId: uuid() }).strict(),
    responses: { 204: c.noBody(), ...errors },
  },
  membership: {
    method: "PUT",
    path: "/api/chat-threads/:id/project",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: object({ eventId: uuid(), projectId: uuid().nullable() }).strict(),
    responses: {
      200: object({ threadId: uuid(), projectId: uuid().nullable() }),
      ...errors,
    },
  },
  threads: {
    method: "GET",
    path: "/api/projects/:id/threads",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    query: object({
      after: uuid().optional(),
      limit: coerce.number().int().min(1).max(100).default(100),
      archived: zEnum(["all", "true", "false"]).default("all"),
      agentId: uuid().optional(),
    }),
    responses: {
      200: object({
        threads: array(chatThreadSnapshotProjectionSchema),
        nextAfter: uuid().nullable(),
      }),
      ...errors,
    },
  },
  snapshot: {
    method: "GET",
    path: "/api/projects/snapshot",
    headers: authHeadersSchema,
    responses: {
      200: union([
        projectSnapshotArchiveSchema,
        object({
          url: url(),
          latestEventId: uuid().nullable(),
          latestSeqId: number().int().nonnegative(),
        }),
      ]),
      ...errors,
    },
  },
  events: {
    method: "GET",
    path: "/api/projects/events",
    headers: authHeadersSchema,
    query: object({
      sinceSeqId: coerce.number().int().nonnegative().default(0),
    }),
    responses: {
      200: object({ events: array(projectEventSchema), hasMore: boolean() }),
      410: apiErrorSchema,
      ...errors,
    },
  },
});
