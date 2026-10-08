import { createHash } from "node:crypto";
import { and, eq, isNull, getTableColumns, sql } from "drizzle-orm";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";

import { nowDate } from "../../lib/time";
import { pgTextDecoder } from "../../lib/db-structured-result";

import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { settle } from "../utils";
import {
  createClerkReadContext,
  isClerkResourceNotFound,
  type ClerkClient,
} from "../external/clerk";

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface ComputerUseSessionIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
}

export type ComputerUseHostAuthority =
  | { readonly hostToken: string }
  | (ComputerUseSessionIdentity & {
      readonly hostId: string;
      readonly connectionGeneration: number;
    });

export function computerUseHostAuthorityCondition(
  authority: ComputerUseHostAuthority,
) {
  return and(
    isNull(computerUseHosts.revokedAt),
    "hostToken" in authority
      ? eq(computerUseHosts.tokenHash, hashSecret(authority.hostToken))
      : and(
          eq(computerUseHosts.id, authority.hostId),
          eq(computerUseHosts.userId, authority.userId),
          eq(computerUseHosts.orgId, authority.orgId),
          eq(computerUseHosts.sessionId, authority.sessionId),
          eq(
            computerUseHosts.connectionGeneration,
            authority.connectionGeneration,
          ),
          isNull(computerUseHosts.tokenHash),
          eq(computerUseHosts.status, "online"),
        ),
  );
}

export async function verifyComputerUseSession(
  clerk: ClerkClient,
  identity: ComputerUseSessionIdentity,
  signal: AbortSignal,
): Promise<boolean> {
  const context = createClerkReadContext();
  const sessionRead = await settle(
    clerk.sessions.getSession(identity.sessionId, context, signal),
    signal,
  );
  if (!sessionRead.ok) {
    if (isClerkResourceNotFound(sessionRead.error)) {
      return false;
    }
    throw sessionRead.error;
  }
  const session = sessionRead.value;
  if (
    session.id !== identity.sessionId ||
    session.userId !== identity.userId ||
    session.status !== "active"
  ) {
    return false;
  }
  const membershipRead = await settle(
    clerk.organizations.getOrganizationMembershipList(
      { organizationId: identity.orgId, userId: [identity.userId], limit: 1 },
      context,
      signal,
    ),
    signal,
  );
  if (!membershipRead.ok) {
    if (isClerkResourceNotFound(membershipRead.error)) {
      return false;
    }
    throw membershipRead.error;
  }
  return membershipRead.value.data.some((membership) => {
    return membership.publicUserData?.userId === identity.userId;
  });
}

export async function resolveComputerUseHost(
  db: Db,
  clerk: ClerkClient,
  authority: ComputerUseHostAuthority,
  signal: AbortSignal,
) {
  const condition = computerUseHostAuthorityCondition(authority);
  const [host] = await db
    .select({
      ...getTableColumns(computerUseHosts),
      rowVersion: sql`${computerUseHosts}.xmin::text`.mapWith(pgTextDecoder),
    })
    .from(computerUseHosts)
    .where(condition)
    .limit(1);
  signal.throwIfAborted();
  if (!host || "hostToken" in authority) {
    return host ?? null;
  }
  const now = nowDate();
  if (
    host.sessionValidatedAt &&
    now.getTime() - host.sessionValidatedAt.getTime() < 30_000
  ) {
    return host;
  }
  if (!(await verifyComputerUseSession(clerk, authority, signal))) {
    const [stopped] = await db
      .update(computerUseHosts)
      .set({ status: "offline", updatedAt: now })
      .where(condition)
      .returning({ userId: computerUseHosts.userId });
    signal.throwIfAborted();
    if (stopped) {
      await publishUserSignal([stopped.userId], "computerUseHostsChanged");
    }
    return null;
  }
  // Stamp the beginning of validation, so a slow provider read never extends
  // the freshness window. A stopped/replaced connection cannot be revived.
  const [validated] = await db
    .update(computerUseHosts)
    .set({ sessionValidatedAt: now })
    .where(condition)
    .returning({
      ...getTableColumns(computerUseHosts),
      rowVersion: sql`${computerUseHosts}.xmin::text`.mapWith(pgTextDecoder),
    });
  signal.throwIfAborted();
  return validated ?? null;
}
