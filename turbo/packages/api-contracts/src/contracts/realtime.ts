import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { runnerGroupSchema } from "./runner-primitives";

const c = initContract();

/** Transient text only. Durable chat events remain the source of truth. */
export const sessionOutputDeltaSchema = z.object({
  threadId: z.uuid(),
  runId: z.uuid(),
  eventId: z.uuid(),
  runEventId: z.string().min(1),
  createdAt: z.iso.datetime(),
  chunkIndex: z.number().int().nonnegative(),
  delta: z.string(),
});

export type SessionOutputDelta = z.infer<typeof sessionOutputDeltaSchema>;

export function sessionOutputChannelName(
  userId: string,
  orgId: string,
  runId: string,
): string {
  return `run-output:${userId}:${orgId}:${runId}`;
}

export const connectorChangedPayloadSchema = z.object({
  connectorSlug: connectorSlugSchema,
});

export type ConnectorChangedPayload = z.infer<
  typeof connectorChangedPayloadSchema
>;

export const browserSessionChangedPayloadSchema = z
  .object({
    threadId: z.uuid(),
  })
  .strict();

export type BrowserSessionChangedPayload = z.infer<
  typeof browserSessionChangedPayloadSchema
>;

/**
 * Preference keys that can flip as part of a `userPreferenceChanged` push.
 * Consumers subscribe and reload the corresponding resource when its key is
 * present in the payload's `kinds`.
 */
export const userPreferenceKinds = [
  "defaultModel",
  "defaultVideoModel",
  "defaultImageModel",
] as const;

export type UserPreferenceKind = (typeof userPreferenceKinds)[number];

const USER_PREFERENCE_KIND_SET: ReadonlySet<string> = new Set(
  userPreferenceKinds,
);

function isUserPreferenceKind(kind: string): kind is UserPreferenceKind {
  return USER_PREFERENCE_KIND_SET.has(kind);
}

/**
 * Unknown kinds are dropped instead of failing the payload. A strict enum makes
 * `kinds` unextendable: a browser tab running a bundle from before a kind was
 * added would reject the whole push and silently stop honoring the kinds it
 * does understand. Old web clients stay open for ~2 days
 * (`docs/fallback.md` §7), so every future kind addition needs this.
 *
 * This does not retroactively fix bundles already in browsers — see the
 * `defaultVideoModel` and `defaultImageModel` notes in
 * `user-model-preference.ts`.
 */
export const userPreferenceChangedPayloadSchema = z.object({
  kinds: z.array(z.string()).transform((kinds) => {
    return kinds.filter(isUserPreferenceKind);
  }),
});

export type UserPreferenceChangedPayload = z.infer<
  typeof userPreferenceChangedPayloadSchema
>;

/**
 * Ably token request schema (matches Ably SDK's TokenRequest type)
 */
export const ablyTokenRequestSchema = z.object({
  keyName: z.string(),
  ttl: z.number().optional(),
  timestamp: z.number(),
  capability: z.string(),
  clientId: z.string().optional(),
  nonce: z.string(),
  mac: z.string(),
});

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
    body: z.object({
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
    body: z.object({}),
    responses: {
      200: ablyTokenRequestSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get Ably token for platform push notifications",
  },
});

export type PlatformRealtimeTokenContract =
  typeof platformRealtimeTokenContract;
