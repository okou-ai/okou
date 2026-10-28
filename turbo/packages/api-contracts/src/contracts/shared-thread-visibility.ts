import { array, enum as zEnum, object, string, uuid } from "zod";
import type { infer as zInfer } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const sharedThreadAudienceSchema = zEnum([
  "private",
  "organization",
  "public",
]);
export type SharedThreadAudience = zInfer<typeof sharedThreadAudienceSchema>;

const statusSchema = object({
  id: uuid(),
  audience: sharedThreadAudienceSchema,
  revision: uuid().nullable(),
  organization: object({ id: string(), name: string() }),
});
export type SharedThreadVisibility = zInfer<typeof statusSchema>;

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
};
const c = initContract();
export const sharedThreadVisibilityContract = c.router({
  // A distinct endpoint prevents older APIs from ignoring an audience field
  // and silently creating a public snapshot during propagation or rollback.
  create: {
    method: "POST",
    path: "/api/chat-threads/:threadId/shared-threads/visibility",
    headers: authHeadersSchema,
    pathParams: object({ threadId: uuid() }),
    body: object({
      eventIds: array(uuid()).min(1),
      id: uuid().optional(),
      audience: sharedThreadAudienceSchema,
    }),
    responses: { 201: object({ id: uuid() }), 413: apiErrorSchema, ...errors },
    summary:
      "Create a conversation snapshot with an explicit visibility policy",
  },
  get: {
    method: "GET",
    path: "/api/shared-threads/:id/visibility",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: { 200: statusSchema, ...errors },
    summary: "Read an owned conversation snapshot's visibility",
  },
  update: {
    method: "PUT",
    path: "/api/shared-threads/:id/visibility",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: object({
      audience: sharedThreadAudienceSchema,
      expectedRevision: uuid().nullable(),
    }),
    responses: { 200: statusSchema, ...errors },
    summary:
      "Change who can read an owned conversation snapshot and its resources",
  },
});
