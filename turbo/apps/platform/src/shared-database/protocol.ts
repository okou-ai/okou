import {
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { ApiError } from "../lib/api-error.ts";
import { SharedDatabaseHttpError } from "./http-error.ts";
import { computedKeySchema } from "./computed-key.ts";
import {
  sharedDatabaseDataKeySchema,
  sharedDatabaseQuerySchema,
} from "./data-key.ts";

const requestIdSchema = string().min(1);

export const sharedDatabaseRealtimeScopeSchema = zEnum([
  "credential",
  "org",
  "user",
  "run-output",
]);

export type SharedDatabaseRealtimeScope = zInfer<
  typeof sharedDatabaseRealtimeScopeSchema
>;

export const sharedDatabaseRealtimeMessageSchema = object({
  name: string(),
  data: zUnknown(),
});

export type SharedDatabaseRealtimeMessage = zInfer<
  typeof sharedDatabaseRealtimeMessageSchema
>;

const sharedDatabaseErrorSchema = object({
  name: string(),
  message: string(),
  status: number().int().optional(),
  code: string().optional(),
}).strict();

type SerializedSharedDatabaseError = zInfer<typeof sharedDatabaseErrorSchema>;

const registerTabMessageSchema = object({
  type: literal("register-tab"),
}).strict();

const heartbeatMessageSchema = object({ type: literal("heartbeat") }).strict();

const tabVisibilityMessageSchema = object({
  type: literal("tab-visibility"),
  visibility: zEnum(["visible", "hidden"]),
}).strict();

const queryRequestSchema = object({
  type: literal("query"),
  requestId: requestIdSchema,
  query: sharedDatabaseQuerySchema,
}).strict();

const getComputedRequestSchema = object({
  type: literal("get-computed"),
  requestId: requestIdSchema,
  computedKey: computedKeySchema,
  refresh: boolean().optional(),
}).strict();

const tokenResultMessageSchema = object({
  type: literal("token-result"),
  requestId: requestIdSchema,
  token: string().min(1).nullable(),
}).strict();

const tokenErrorMessageSchema = object({
  type: literal("token-error"),
  requestId: requestIdSchema,
  error: sharedDatabaseErrorSchema,
}).strict();

const reloadComputedMessageSchema = object({
  type: literal("reload-computed"),
  computedKey: computedKeySchema,
}).strict();

const disconnectRequestSchema = object({
  type: literal("disconnect"),
}).strict();

// Channel access belongs to the authenticated Worker identity and Ably token.
// Event names are filters within those channels, not a transport registry.
const realtimeSubscribeRequestSchema = object({
  type: literal("realtime-subscribe"),
  subscriptionId: requestIdSchema,
  scope: sharedDatabaseRealtimeScopeSchema,
  topic: string().min(1),
})
  .strict()
  .refine(
    ({ scope, topic }) => {
      return scope !== "run-output" || uuid().safeParse(topic).success;
    },
    { message: "Run-output subscriptions require a run UUID" },
  );

const realtimeUnsubscribeRequestSchema = object({
  type: literal("realtime-unsubscribe"),
  subscriptionId: requestIdSchema,
}).strict();

export const sharedDatabaseClientMessageSchema = discriminatedUnion("type", [
  registerTabMessageSchema,
  heartbeatMessageSchema,
  tabVisibilityMessageSchema,
  queryRequestSchema,
  getComputedRequestSchema,
  tokenResultMessageSchema,
  tokenErrorMessageSchema,
  disconnectRequestSchema,
  realtimeSubscribeRequestSchema,
  realtimeUnsubscribeRequestSchema,
]);

export type SharedDatabaseClientMessage = zInfer<
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

const resultMessageSchema = object({
  type: literal("result"),
  requestId: requestIdSchema,
  value: zUnknown(),
}).strict();

const errorMessageSchema = object({
  type: literal("error"),
  requestId: requestIdSchema,
  error: sharedDatabaseErrorSchema,
}).strict();

const invalidateMessageSchema = object({
  type: literal("invalidate"),
  dataKey: sharedDatabaseDataKeySchema,
}).strict();

const getTokenRequestSchema = object({
  type: literal("get-token"),
  requestId: requestIdSchema,
}).strict();

export const sharedDatabaseWorkerUnavailableReasonSchema = zEnum([
  "force-upgrade-required",
  "indexeddb-version-changed",
]);

export type SharedDatabaseWorkerUnavailableReason = zInfer<
  typeof sharedDatabaseWorkerUnavailableReasonSchema
>;

const workerUnavailableMessageSchema = object({
  type: literal("worker-unavailable"),
  reason: sharedDatabaseWorkerUnavailableReasonSchema,
}).strict();

const chatThreadReadCursorUpdatedMessageSchema = object({
  type: literal("chat-thread-read-cursor-updated"),
  payload: zUnknown(),
}).strict();

const realtimeSubscribedMessageSchema = object({
  type: literal("realtime-subscribed"),
  subscriptionId: requestIdSchema,
}).strict();

/**
 * Ably reported a continuity gap for this subscription. The Worker owns the
 * channel, so it is the only side that sees `ChannelStateChange.resumed`; the
 * tab reacts exactly as it would to an unseen event on the topic.
 */
const realtimeResyncMessageSchema = object({
  type: literal("realtime-resync"),
  subscriptionId: requestIdSchema,
}).strict();

const realtimeEventMessageSchema = object({
  type: literal("realtime-event"),
  subscriptionId: requestIdSchema,
  message: sharedDatabaseRealtimeMessageSchema,
}).strict();

const realtimeSubscriptionErrorMessageSchema = object({
  type: literal("realtime-subscription-error"),
  subscriptionId: requestIdSchema,
  error: sharedDatabaseErrorSchema,
}).strict();

export const sharedDatabaseWorkerMessageSchema = discriminatedUnion("type", [
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

export type SharedDatabaseWorkerMessage = zInfer<
  typeof sharedDatabaseWorkerMessageSchema
>;
