import { array, iso, number, object, string, uuid } from "zod";
import { connectorSlugSchema } from "../contracts/connector-identity";

/** Transient text only. Durable chat events remain the source of truth. */
export const sessionOutputDeltaSchema = object({
  threadId: uuid(),
  runId: uuid(),
  eventId: uuid(),
  runEventId: string().min(1),
  createdAt: iso.datetime(),
  chunkIndex: number().int().nonnegative(),
  delta: string(),
});

export function sessionOutputChannelName(
  userId: string,
  orgId: string,
  runId: string,
): string {
  return `run-output:${userId}:${orgId}:${runId}`;
}

export function foregroundChannelName(userId: string, orgId: string): string {
  return `user-org-foreground:${userId}:${orgId}`;
}

export const connectorChangedPayloadSchema = object({
  connectorSlug: connectorSlugSchema,
});

export const walletChangedPayloadSchema = object({
  orgId: string().min(1),
});

export const browserSessionChangedPayloadSchema = object({
  threadId: uuid(),
}).strict();

/**
 * Preference keys that can flip as part of a `userPreferenceChanged` push.
 * Consumers subscribe and reload the corresponding resource when its key is
 * present in the payload's `kinds`.
 */
export const userPreferenceKinds = [
  "defaultModel",
  "defaultImageModel",
  "cloudBrowserEnabledByDefault",
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
 */
export const userPreferenceChangedPayloadSchema = object({
  kinds: array(string()).transform((kinds) => {
    return kinds.filter(isUserPreferenceKind);
  }),
});
