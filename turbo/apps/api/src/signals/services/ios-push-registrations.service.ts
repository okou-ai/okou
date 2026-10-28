import { command } from "ccstate";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { iosPushRegistrations } from "@okouai/db/schema/ios-push-registration";
import { writeDb$ } from "../external/db";
import {
  clerk$,
  createClerkReadContext,
  isClerkResourceNotFound,
} from "../external/clerk";
import { now } from "../../lib/time";
import { settle } from "../utils";

export const isActiveIosPushSession$ = command(
  async (
    { get },
    identity: {
      readonly userId: string;
      readonly sessionId: string;
      readonly orgId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await settle(
      get(clerk$).sessions.getSession(
        identity.sessionId,
        createClerkReadContext(),
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return false;
      }
      throw result.error;
    }
    const active =
      result.value.id === identity.sessionId &&
      result.value.userId === identity.userId &&
      result.value.status === "active" &&
      result.value.expireAt > now();
    if (!active || !identity.orgId) {
      return active;
    }
    const memberships = await settle(
      get(clerk$).organizations.getOrganizationMembershipList(
        { organizationId: identity.orgId, userId: [identity.userId], limit: 1 },
        createClerkReadContext(),
        signal,
      ),
      signal,
    );
    if (!memberships.ok) {
      if (isClerkResourceNotFound(memberships.error)) {
        return false;
      }
      throw memberships.error;
    }
    return memberships.value.data.some((membership) => {
      return membership.publicUserData?.userId === identity.userId;
    });
  },
);

export const updateIosPushRegistration$ = command(
  async (
    { set },
    binding: {
      readonly installationId: string;
      readonly revision: number;
      readonly userId: string;
      readonly sessionId: string;
      readonly deviceToken: string;
      readonly environment: "production" | "sandbox";
      readonly enabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const registrations = await set(writeDb$)
      .insert(iosPushRegistrations)
      .values(binding)
      .onConflictDoUpdate({
        target: iosPushRegistrations.installationId,
        set: binding.enabled
          ? {
              ...binding,
              updatedAt: sql`now()`,
              // Re-registration after a background launch must retain this user's acknowledgement.
              badgeClearedRevision: sql`CASE
                WHEN ${iosPushRegistrations.userId} = ${binding.userId}
                  AND ${iosPushRegistrations.badgeClearedRevision} = ${iosPushRegistrations.revision}
                THEN ${binding.revision}::bigint
                ELSE NULL
              END`,
            }
          : {
              enabled: false,
              revision: binding.revision,
              updatedAt: sql`now()`,
            },
        // A disable from the previous account must never disable a rebound installation.
        setWhere: and(
          binding.enabled
            ? undefined
            : and(
                eq(iosPushRegistrations.userId, binding.userId),
                eq(iosPushRegistrations.sessionId, binding.sessionId),
              ),
          or(
            lt(iosPushRegistrations.revision, binding.revision),
            and(
              eq(iosPushRegistrations.revision, binding.revision),
              eq(iosPushRegistrations.userId, binding.userId),
              eq(iosPushRegistrations.sessionId, binding.sessionId),
              binding.enabled
                ? eq(iosPushRegistrations.deviceToken, binding.deviceToken)
                : undefined,
              binding.enabled
                ? eq(iosPushRegistrations.environment, binding.environment)
                : undefined,
              eq(iosPushRegistrations.enabled, binding.enabled),
            ),
          ),
        ),
      })
      .returning({ id: iosPushRegistrations.installationId });
    signal.throwIfAborted();
    return registrations.length > 0;
  },
);
