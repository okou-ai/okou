import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runStatusSchema } from "./runs";

/** Successful observation JSON is bounded to 2 KiB, independently of input size. */
export const CHAT_INPUT_STATUS_MAX_RESPONSE_BYTES = 2048;

const eventCoordinateSchema = z
  .object({
    eventId: z.uuid(),
    seqId: z.number().int().positive(),
    createdAt: z.iso.datetime(),
  })
  .strict();

const observationShape = {
  threadId: z.uuid(),
  /** The original accepted input, never replaced by its consuming event ID. */
  eventId: z.uuid(),
  input: eventCoordinateSchema.nullable(),
  replacement: eventCoordinateSchema.nullable(),
};

export const chatInputStatusResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...observationShape,
      status: z.literal("consumed"),
      /** Canonical consumption reference, usable with the existing cancel API. */
      runId: z.uuid(),
      /** Null means the authorized Run is unavailable; no outcome is inferred. */
      run: z
        .object({
          status: runStatusSchema,
          createdAt: z.iso.datetime(),
          startedAt: z.iso.datetime().nullable(),
          completedAt: z.iso.datetime().nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...observationShape,
      status: z.enum(["queued", "rejected", "revoked", "unavailable"]),
      runId: z.null(),
      run: z.null(),
    })
    .strict(),
]);

export type ChatInputStatusResponse = z.infer<
  typeof chatInputStatusResponseSchema
>;

const c = initContract();
export const chatInputStatusContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:threadId/inputs/:eventId/status",
    headers: authHeadersSchema,
    pathParams: z
      .object({
        threadId: z.uuid().toLowerCase(),
        eventId: z.uuid().toLowerCase(),
      })
      .strict(),
    responses: {
      200: chatInputStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Read one original input's retained metadata and consuming Run outcome",
    description:
      "Read-only, body-free observation of one original accepted input. Uses one indexed metadata statement after authorization checks; reads at most one thread, input, replacement and Run, without archive downloads. Successful JSON is at most 2 KiB. Use the MCP send eventId or native clientEventId. Native callers omitting clientEventId must obtain the original input ID once from raw history; createdAt alone is not unique. A retained replacement can establish consumption even when the original row is no longer retained. unavailable means retained metadata cannot establish the input; it does not prove queued, missing or any Run outcome. Archived-only evidence remains accessible through the existing event snapshot/raw history operations. Multiple inputs may share one Run. A null run exposes no outcome; use only the matching run.status to confirm completed, failed, timeout or cancelled.",
  },
});
