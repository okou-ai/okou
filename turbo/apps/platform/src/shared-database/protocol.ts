import { z } from "zod";
import { ApiError } from "../lib/api-error.ts";
import { SharedDatabaseHttpError } from "./http-error.ts";
import { computedKeySchema } from "./computed-key.ts";
import {
  sharedDatabaseDataKeySchema,
  sharedDatabaseQuerySchema,
} from "./data-key.ts";

const requestIdSchema = z.string().min(1);

export const sharedDatabaseRealtimeScopeSchema = z.enum([
  "credential",
  "org",
  "user",
  "run-output",
]);

export type SharedDatabaseRealtimeScope = z.infer<
  typeof sharedDatabaseRealtimeScopeSchema
>;

export const sharedDatabaseRealtimeMessageSchema = z.object({
  name: z.string(),
  data: z.unknown(),
});

export type SharedDatabaseRealtimeMessage = z.infer<
  typeof sharedDatabaseRealtimeMessageSchema
>;

const sharedDatabaseErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    status: z.number().int().optional(),
    code: z.string().optional(),
  })
  .strict();

type SerializedSharedDatabaseError = z.infer<typeof sharedDatabaseErrorSchema>;

const registerTabMessageSchema = z
  .object({ type: z.literal("register-tab") })
  .strict();

const heartbeatMessageSchema = z
  .object({ type: z.literal("heartbeat") })
  .strict();

const queryRequestSchema = z
  .object({
    type: z.literal("query"),
    requestId: requestIdSchema,
    query: sharedDatabaseQuerySchema,
  })
  .strict();

const getComputedRequestSchema = z
  .object({
    type: z.literal("get-computed"),
    requestId: requestIdSchema,
    computedKey: computedKeySchema,
  })
  .strict();

const tokenResultMessageSchema = z
  .object({
    type: z.literal("token-result"),
    requestId: requestIdSchema,
    token: z.string().min(1).nullable(),
  })
  .strict();

const tokenErrorMessageSchema = z
  .object({
    type: z.literal("token-error"),
    requestId: requestIdSchema,
    error: sharedDatabaseErrorSchema,
  })
  .strict();

const reloadComputedMessageSchema = z
  .object({
    type: z.literal("reload-computed"),
    computedKey: computedKeySchema,
  })
  .strict();

const disconnectRequestSchema = z
  .object({ type: z.literal("disconnect") })
  .strict();

// Channel access belongs to the authenticated Worker identity and Ably token.
// Event names are filters within those channels, not a transport registry.
const realtimeSubscribeRequestSchema = z
  .object({
    type: z.literal("realtime-subscribe"),
    subscriptionId: requestIdSchema,
    scope: sharedDatabaseRealtimeScopeSchema,
    topic: z.string().min(1),
  })
  .strict()
  .refine(
    ({ scope, topic }) => {
      return scope !== "run-output" || z.uuid().safeParse(topic).success;
    },
    { message: "Run-output subscriptions require a run UUID" },
  );

const realtimeUnsubscribeRequestSchema = z
  .object({
    type: z.literal("realtime-unsubscribe"),
    subscriptionId: requestIdSchema,
  })
  .strict();

export const sharedDatabaseClientMessageSchema = z.discriminatedUnion("type", [
  registerTabMessageSchema,
  heartbeatMessageSchema,
  queryRequestSchema,
  getComputedRequestSchema,
  tokenResultMessageSchema,
  tokenErrorMessageSchema,
  disconnectRequestSchema,
  realtimeSubscribeRequestSchema,
  realtimeUnsubscribeRequestSchema,
]);

export type SharedDatabaseClientMessage = z.infer<
  typeof sharedDatabaseClientMessageSchema
>;

export function redactSharedDatabaseClientMessageForLog(
  message: SharedDatabaseClientMessage,
): SharedDatabaseClientMessage {
  if (message.type !== "token-result" || message.token === null) {
    return message;
  }
  return { ...message, token: "[redacted]" };
}

export function serializeSharedDatabaseError(
  error: unknown,
): SerializedSharedDatabaseError {
  if (error instanceof ApiError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      code: error.code,
    };
  }
  if (error instanceof SharedDatabaseHttpError) {
    return { name: error.name, message: error.message, status: error.status };
  }
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  return { name: Error.name, message: String(error) };
}

export function deserializeSharedDatabaseError(
  error: SerializedSharedDatabaseError,
): Error {
  if (error.name === "SharedDatabaseHttpError" && error.status !== undefined) {
    return new SharedDatabaseHttpError(error.status);
  }
  if (
    error.name === "ApiError" &&
    error.status !== undefined &&
    error.code !== undefined
  ) {
    return new ApiError(error.message, error.code, error.status);
  }
  const result = new Error(error.message);
  result.name = error.name;
  return result;
}

const resultMessageSchema = z
  .object({
    type: z.literal("result"),
    requestId: requestIdSchema,
    value: z.unknown(),
  })
  .strict();

const errorMessageSchema = z
  .object({
    type: z.literal("error"),
    requestId: requestIdSchema,
    error: sharedDatabaseErrorSchema,
  })
  .strict();

const invalidateMessageSchema = z
  .object({
    type: z.literal("invalidate"),
    dataKey: sharedDatabaseDataKeySchema,
  })
  .strict();

const getTokenRequestSchema = z
  .object({
    type: z.literal("get-token"),
    requestId: requestIdSchema,
  })
  .strict();

export const sharedDatabaseWorkerUnavailableReasonSchema = z.enum([
  "force-upgrade-required",
  "indexeddb-version-changed",
]);

export type SharedDatabaseWorkerUnavailableReason = z.infer<
  typeof sharedDatabaseWorkerUnavailableReasonSchema
>;

const workerUnavailableMessageSchema = z
  .object({
    type: z.literal("worker-unavailable"),
    reason: sharedDatabaseWorkerUnavailableReasonSchema,
  })
  .strict();

const chatThreadReadCursorUpdatedMessageSchema = z
  .object({
    type: z.literal("chat-thread-read-cursor-updated"),
    payload: z.unknown(),
  })
  .strict();

const realtimeSubscribedMessageSchema = z
  .object({
    type: z.literal("realtime-subscribed"),
    subscriptionId: requestIdSchema,
  })
  .strict();

/**
 * Ably reported a continuity gap for this subscription. The Worker owns the
 * channel, so it is the only side that sees `ChannelStateChange.resumed`; the
 * tab reacts exactly as it would to an unseen event on the topic.
 */
const realtimeResyncMessageSchema = z
  .object({
    type: z.literal("realtime-resync"),
    subscriptionId: requestIdSchema,
  })
  .strict();

const realtimeEventMessageSchema = z
  .object({
    type: z.literal("realtime-event"),
    subscriptionId: requestIdSchema,
    message: sharedDatabaseRealtimeMessageSchema,
  })
  .strict();

const realtimeSubscriptionErrorMessageSchema = z
  .object({
    type: z.literal("realtime-subscription-error"),
    subscriptionId: requestIdSchema,
    error: sharedDatabaseErrorSchema,
  })
  .strict();

export const sharedDatabaseWorkerMessageSchema = z.discriminatedUnion("type", [
  resultMessageSchema,
  errorMessageSchema,
  invalidateMessageSchema,
  getTokenRequestSchema,
  workerUnavailableMessageSchema,
  reloadComputedMessageSchema,
  chatThreadReadCursorUpdatedMessageSchema,
  realtimeSubscribedMessageSchema,
  realtimeResyncMessageSchema,
  realtimeEventMessageSchema,
  realtimeSubscriptionErrorMessageSchema,
]);

export type SharedDatabaseWorkerMessage = z.infer<
  typeof sharedDatabaseWorkerMessageSchema
>;
