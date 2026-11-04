import { command } from "ccstate";
import { and, eq, isNull, getTableColumns, sql } from "drizzle-orm";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";

import { nowDate } from "../../lib/time";
import { pgTextDecoder } from "../../lib/db-structured-result";

import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { verifyClerkComputerUseSession } from "../external/clerk";

export interface ComputerUseSessionIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
}

export type ComputerUseHostAuthority = ComputerUseSessionIdentity & {
  readonly hostId: string;
  readonly connectionGeneration: number;
};

export function computerUseHostAuthorityCondition(
  authority: ComputerUseHostAuthority,
) {
  return and(
    isNull(computerUseHosts.revokedAt),
    eq(computerUseHosts.id, authority.hostId),
    eq(computerUseHosts.userId, authority.userId),
    eq(computerUseHosts.orgId, authority.orgId),
    eq(computerUseHosts.sessionId, authority.sessionId),
    eq(computerUseHosts.connectionGeneration, authority.connectionGeneration),
    eq(computerUseHosts.status, "online"),
  );
}

export const resolveComputerUseHost$ = command(
  async (
    { get, set },
    authority: ComputerUseHostAuthority,
    signal: AbortSignal,
  ) => {
    const condition = computerUseHostAuthorityCondition(authority);
    const [host] = await get(db$)
      .select({
        ...getTableColumns(computerUseHosts),
        rowVersion: sql`${computerUseHosts}.xmin::text`.mapWith(pgTextDecoder),
      })
      .from(computerUseHosts)
      .where(condition)
      .limit(1);
    signal.throwIfAborted();
    if (!host) {
      return null;
    }
    const now = nowDate();
    if (
      host.sessionValidatedAt &&
      now.getTime() - host.sessionValidatedAt.getTime() < 30_000
    ) {
      return host;
    }
    if (!(await verifyClerkComputerUseSession(authority, signal))) {
      const [stopped] = await set(writeDb$)
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
    const [validated] = await set(writeDb$)
      .update(computerUseHosts)
      .set({ sessionValidatedAt: now })
      .where(condition)
      .returning({
        ...getTableColumns(computerUseHosts),
        rowVersion: sql`${computerUseHosts}.xmin::text`.mapWith(pgTextDecoder),
      });
    signal.throwIfAborted();
    return validated ?? null;
  },
);
