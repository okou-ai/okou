import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { remoteDevices } from "@okouai/db/schema/remote-device";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  and,
  eq,
  exists,
  gt,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDateSql } from "../../lib/time";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

export interface RemoteDeviceOwner {
  readonly orgId: string;
  readonly userId: string;
}

interface SqlOwner {
  readonly orgId: string | SQLWrapper;
  readonly userId: string | SQLWrapper;
}

const key = FeatureSwitchKey.RemoteDevices;

export function remoteDeviceMode(owner: SqlOwner) {
  const fallback = isFeatureEnabled(key, {
    orgId: typeof owner.orgId === "string" ? owner.orgId : undefined,
    userId: typeof owner.userId === "string" ? owner.userId : undefined,
  });
  return sql`COALESCE((
    SELECT (${userFeatureSwitches.switches} ->> ${key})::boolean
    FROM ${userFeatureSwitches}
    WHERE ${userFeatureSwitches.orgId} = ${owner.orgId}
      AND ${userFeatureSwitches.userId} = ${owner.userId}
  ), ${fallback})`.mapWith(pgBooleanDecoder);
}

export const remoteDeviceMode$ = command(
  async ({ set }, owner: RemoteDeviceOwner, signal: AbortSignal) => {
    return isFeatureEnabled(
      key,
      await set(
        loadUserFeatureSwitchContext$,
        owner.orgId,
        owner.userId,
        signal,
      ),
    );
  },
);

export function remoteDeviceStatementTime() {
  return nowDateSql(sql`(statement_timestamp() AT TIME ZONE 'UTC')`);
}

export function remoteDeviceAllowed(
  channel: SqlOwner & { readonly remoteDeviceId: SQLWrapper },
) {
  return exists(
    new QueryBuilder()
      .select({ id: remoteDevices.id })
      .from(remoteDevices)
      .where(
        and(
          eq(remoteDevices.id, channel.remoteDeviceId),
          eq(remoteDevices.orgId, channel.orgId),
          eq(remoteDevices.userId, channel.userId),
          eq(remoteDevices.accessAllowed, true),
          or(
            isNull(remoteDevices.accessExpiresAt),
            gt(remoteDevices.accessExpiresAt, remoteDeviceStatementTime()),
          ),
        ),
      ),
  );
}

export function remoteDeviceRunActive(
  owner: SqlOwner,
  runId: string | SQLWrapper,
  threadId?: string,
) {
  return exists(
    new QueryBuilder()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.orgId, agentRuns.orgId),
          eq(chatThreads.userId, agentRuns.userId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.status, "running"),
          threadId ? eq(chatThreads.id, threadId) : undefined,
        ),
      ),
  );
}
