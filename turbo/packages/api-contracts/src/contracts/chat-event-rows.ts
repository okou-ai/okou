import { z } from "zod";
import { chatEventContextTypeSchema, chatEventTypeSchema } from "./chat-events";
import { runFailureReasonTokenSchema } from "./run-failure-reasons";

const requiredJsonValueSchema = z.unknown().refine((value) => {
  return value !== undefined;
}, "Expected a JSON value");

/** Canonical payload envelope for a raw chat-event row. */
const chatEventRowPayloadSchema = z
  .object({
    content: z.string().optional(),
    userMessage: requiredJsonValueSchema.optional(),
    error: z.string().optional(),
    usage: requiredJsonValueSchema.optional(),
  })
  .strict();

const chatEventRowBaseShape = {
  id: z.string(),
  chatThreadId: z.string(),
  runId: z.string().nullable(),
  revokesEventId: z.string().nullable(),
  contextType: chatEventContextTypeSchema.nullable(),
  contextId: z.string().nullable(),
  runEventSequenceNumber: z.number().int().nullable(),
  runEventId: z.string().nullable(),
  /** Strictly increasing within a thread; it may start above 1 and have gaps. */
  seqId: z.number().int(),
  createdAt: z.iso.datetime(),
};

const chatEventRowBaseSchema = z
  .object({
    ...chatEventRowBaseShape,
    payload: chatEventRowPayloadSchema.nullable(),
  })
  .strict();

const failedChatEventRowSchema = chatEventRowBaseSchema
  .extend({
    eventType: z.literal("run.failed"),
    failureReason: runFailureReasonTokenSchema.optional(),
  })
  .strict();

const INPUT_CHAT_EVENT_ROW_TYPES = [
  "input.prompt",
  "input.automation",
  "input.budget",
  "input.rejected",
] as const;

/** Input rows always record the surface that produced them. */
const inputChatEventRowSchema = chatEventRowBaseSchema
  .extend({
    eventType: chatEventTypeSchema.extract(INPUT_CHAT_EVENT_ROW_TYPES),
    contextType: chatEventContextTypeSchema,
    failureReason: z.never().optional(),
  })
  .strict();

const otherChatEventRowSchema = chatEventRowBaseSchema
  .extend({
    eventType: chatEventTypeSchema.exclude([
      ...INPUT_CHAT_EVENT_ROW_TYPES,
      "run.failed",
    ]),
    failureReason: z.never().optional(),
  })
  .strict();

/**
 * One canonical chat_events row and the strict output.tool-free outer wire
 * shape emitted by the Snapshot and Raw Event endpoints.
 */
export const chatEventRowSchema = z.discriminatedUnion("eventType", [
  failedChatEventRowSchema,
  inputChatEventRowSchema,
  otherChatEventRowSchema,
]);

export type ChatEventRow = z.infer<typeof chatEventRowSchema>;
