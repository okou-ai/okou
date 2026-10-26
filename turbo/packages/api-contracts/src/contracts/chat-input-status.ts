import {
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  uuid,
  enum as zEnum,
  null as zNull,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

/** Successful observation JSON is bounded to 2 KiB, independently of input size. */
export const CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES = 2048;

const eventCoordinateSchema = object({
  eventId: uuid(),
  seqId: number().int().positive(),
  createdAt: iso.datetime(),
}).strict();

const observationShape = {
  threadId: uuid(),
  /** The original accepted input, never replaced by its consuming event ID. */
  eventId: uuid(),
  input: eventCoordinateSchema.nullable(),
  replacement: eventCoordinateSchema.nullable(),
};

export const chatInputStatusResponseSchema = discriminatedUnion("status", [
  object({
    ...observationShape,
    status: literal("consumed"),
    /** Canonical consumption reference, usable with the existing cancel API. */
    runId: uuid(),
    /** Consumption is established, but no retained Chat terminal event was found. */
    terminal: zNull(),
  }).strict(),
  object({
    ...observationShape,
    status: zEnum(["completed", "failed", "cancelled"]),
    runId: uuid(),
    /** Chat terminal event coordinates, not execution lifecycle timestamps. */
    terminal: eventCoordinateSchema,
  }).strict(),
  object({
    ...observationShape,
    status: zEnum(["queued", "rejected", "revoked", "unavailable"]),
    runId: zNull(),
    terminal: zNull(),
  }).strict(),
]);

export type ChatInputStatusResponse = zInfer<
  typeof chatInputStatusResponseSchema
>;

const c = initContract();
export const chatInputStatusContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:threadId/inputs/:eventId/status",
    headers: authHeadersSchema,
    pathParams: object({
      threadId: uuid().toLowerCase(),
      eventId: uuid().toLowerCase(),
    }).strict(),
    responses: {
      200: chatInputStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Read one original input's retained Chat disposition and terminal evidence",
    description:
      "Read-only, body-free observation of one original accepted input from retained Chat events. Does not look up execution records, download archives or paginate history. Successful JSON is at most 2 KiB. Use the MCP send eventId or native clientEventId. Native callers omitting clientEventId must obtain the original input ID once from raw history; createdAt alone is not unique. A retained replacement can establish the input's disposition even when its original row is unavailable. queued, rejected and revoked describe the input's retained disposition. consumed confirms consumption only; it does not confirm that execution is still active. completed, failed and cancelled require the same consuming runId's run.completed, run.failed or run.cancelled event in this thread. Multiple inputs may share that runId, which remains a correlation reference after execution-record deletion. terminal contains Chat event coordinates, not execution creation/start/completion times; Chat failures do not expose a separate timeout status. unavailable means retained metadata cannot establish the input; it never proves queued or completed. For archived evidence use the separate snapshot/raw-history operations.",
  },
});
