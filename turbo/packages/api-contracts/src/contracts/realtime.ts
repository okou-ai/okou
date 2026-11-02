import {
  literal,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { runnerGroupSchema } from "./runner-primitives";
import {
  browserSessionChangedPayloadSchema,
  sessionOutputDeltaSchema,
  walletChangedPayloadSchema,
  connectorChangedPayloadSchema,
  userPreferenceChangedPayloadSchema,
} from "../validators/realtime";
export {
  sessionOutputChannelName,
  browserSessionChangedPayloadSchema,
  sessionOutputDeltaSchema,
  walletChangedPayloadSchema,
  connectorChangedPayloadSchema,
  userPreferenceChangedPayloadSchema,
  type UserPreferenceKind,
  userPreferenceKinds,
  foregroundChannelName,
} from "../validators/realtime";

const c = initContract();

export type SessionOutputDelta = zInfer<typeof sessionOutputDeltaSchema>;

export const computerUseCommandsChangedEvent = "commandsChanged";
export const computerUseCommandResultChangedEvent = "resultChanged";

/** One command's result; unrelated user and host events are outside this scope. */
export function computerUseCommandResultChannelName(
  userId: string,
  orgId: string,
  commandId: string,
): string {
  return `computer-use-result:${userId}:${orgId}:${commandId}`;
}

export function computerUseHostChannelScope(
  userId: string,
  orgId: string,
): string {
  return `computer-use-host:${userId}:${orgId}`;
}

export function computerUseHostChannelName(
  userId: string,
  orgId: string,
  hostId: string,
  connectionGeneration: number,
): string {
  return `${computerUseHostChannelScope(userId, orgId)}:${hostId}:${connectionGeneration}`;
}

export const computerUseCommandNotificationsSchema = object({
  channelName: string().min(1),
  eventName: literal(computerUseCommandsChangedEvent),
});

export type ConnectorChangedPayload = zInfer<
  typeof connectorChangedPayloadSchema
>;

export type WalletChangedPayload = zInfer<typeof walletChangedPayloadSchema>;

export const composerAgentConnectorsChangedPayloadSchema = object({
  agentId: uuid(),
}).strict();

export type BrowserSessionChangedPayload = zInfer<
  typeof browserSessionChangedPayloadSchema
>;

export type UserPreferenceChangedPayload = zInfer<
  typeof userPreferenceChangedPayloadSchema
>;

/**
 * Ably token request schema (matches Ably SDK's TokenRequest type)
 */
export const ablyTokenRequestSchema = object({
  keyName: string(),
  ttl: number().optional(),
  timestamp: number(),
  capability: string(),
  clientId: string().optional(),
  nonce: string(),
  mac: string(),
});

export const realtimeSubscriptionSchema = object({
  channelName: string(),
  eventName: string(),
  tokenRequest: ablyTokenRequestSchema,
});

export type RealtimeSubscription = zInfer<typeof realtimeSubscriptionSchema>;

/**
 * Runner realtime token contract for /api/runners/realtime/token
 */
export const runnerRealtimeTokenContract = c.router({
  /**
   * POST /api/runners/realtime/token
   * Get an Ably token to subscribe to a runner group's job notification channel
   */
  create: {
    method: "POST",
    path: "/api/runners/realtime/token",
    headers: authHeadersSchema,
    body: object({
      group: runnerGroupSchema,
    }),
    responses: {
      200: ablyTokenRequestSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get Ably token for runner group job notifications",
  },
});

export type RunnerRealtimeTokenContract = typeof runnerRealtimeTokenContract;

/**
 * Platform realtime token contract for /api/realtime/token
 * Used by the frontend to get an Ably token for subscribing to user- and active-org-scoped push signals.
 */
export const platformRealtimeTokenContract = c.router({
  /**
   * POST /api/realtime/token
   * Get an Ably token for the authenticated user and active organization
   */
  create: {
    method: "POST",
    path: "/api/realtime/token",
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      // The client SDK exchanges this signed, single-use request with Ably.
      200: ablyTokenRequestSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get Ably token for platform push notifications",
  },
});

export type PlatformRealtimeTokenContract =
  typeof platformRealtimeTokenContract;
