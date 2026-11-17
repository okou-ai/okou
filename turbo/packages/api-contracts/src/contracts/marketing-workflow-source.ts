import {
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";

/** Current facts only, never a financial receipt or a replacement for retained completion proof. */
export const marketingWorkflowSourceObservationSchema = object({
  version: literal(1),
  environment: zEnum(["production", "preview", "development"]),
  observedAt: iso.datetime(),
  source: object({
    eventId: uuid(),
    type: zEnum([
      "workflow.input-queued",
      "workflow.run-created",
      "workflow.run-completed",
    ]),
    occurredAt: iso.datetime(),
    orgId: string().min(1).max(256),
    actorUserId: string().min(1).max(256),
    creatorUserId: string().min(1).max(256),
    workflowId: uuid(),
    inputEventId: uuid(),
    runId: uuid().nullable(),
  }).strict(),
  observation: discriminatedUnion("kind", [
    object({ kind: literal("queued") }).strict(),
    object({ kind: literal("replaced") }).strict(),
    object({ kind: literal("unavailable") }).strict(),
    object({
      kind: literal("run"),
      runId: uuid(),
      status: runStatusSchema,
      completedAt: iso.datetime().nullable(),
    }).strict(),
  ]),
}).strict();

export const marketingWorkflowSourceContract = initContract().router({
  observe: {
    method: "GET",
    path: "/api/internal/marketing/get-started/workflow-sources/:eventId",
    headers: authHeadersSchema,
    pathParams: object({ eventId: uuid() }),
    responses: {
      200: marketingWorkflowSourceObservationSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Read current Workflow source facts using a dedicated read-only service capability",
  },
});
