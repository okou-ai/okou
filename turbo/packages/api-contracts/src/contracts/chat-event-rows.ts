import {
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  string,
  never as zNever,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { chatEventContextTypeSchema, chatEventTypeSchema } from "./chat-events";
import { runFailureReasonTokenSchema } from "./run-failure-reasons";

const requiredJsonValueSchema = zUnknown().refine((value) => {
  return value !== undefined;
}, "Expected a JSON value");

/** Canonical payload envelope for a raw chat-event row. */
const chatEventRowPayloadSchema = object({
  content: string().optional(),
  userMessage: requiredJsonValueSchema.optional(),
  error: string().optional(),
  usage: requiredJsonValueSchema.optional(),
}).strict();

const chatEventRowBaseShape = {
  id: string(),
  chatThreadId: string(),
  runId: string().nullable(),
  revokesEventId: string().nullable(),
  contextType: chatEventContextTypeSchema.nullable(),
  contextId: string().nullable(),
  runEventSequenceNumber: number().int().nullable(),
  runEventId: string().nullable(),
  /** Strictly increasing within a thread; it may start above 1 and have gaps. */
  seqId: number().int(),
  createdAt: iso.datetime(),
};

const chatEventRowBaseSchema = object({
  ...chatEventRowBaseShape,
  payload: chatEventRowPayloadSchema.nullable(),
}).strict();

const failedChatEventRowSchema = chatEventRowBaseSchema
  .extend({
    eventType: literal("run.failed"),
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
    failureReason: zNever().optional(),
  })
  .strict();

const otherChatEventRowSchema = chatEventRowBaseSchema
  .extend({
    eventType: chatEventTypeSchema.exclude([
      ...INPUT_CHAT_EVENT_ROW_TYPES,
      "run.failed",
    ]),
    failureReason: zNever().optional(),
  })
  .strict();

/**
 * One canonical chat_events row and the strict output.tool-free outer wire
 * shape emitted by the Snapshot and Raw Event endpoints.
 */
export const chatEventRowSchema = discriminatedUnion("eventType", [
  failedChatEventRowSchema,
  inputChatEventRowSchema,
  otherChatEventRowSchema,
]);

export type ChatEventRow = zInfer<typeof chatEventRowSchema>;
