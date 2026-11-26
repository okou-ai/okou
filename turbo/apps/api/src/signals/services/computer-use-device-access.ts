import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { and, eq, exists, isNull, sql, type SQLWrapper } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  remoteDeviceAllowed,
  remoteDeviceMode,
  remoteDeviceRunActive,
} from "./remote-device-access";

export function computerUseHostDeviceAllowed(
  owner: {
    readonly orgId: string | SQLWrapper;
    readonly userId: string | SQLWrapper;
  },
  hostId: string | SQLWrapper,
) {
  return exists(
    new QueryBuilder()
      .select({ id: computerUseHosts.id })
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.id, hostId),
          eq(computerUseHosts.orgId, owner.orgId),
          eq(computerUseHosts.userId, owner.userId),
          isNull(computerUseHosts.revokedAt),
          remoteDeviceAllowed(computerUseHosts),
        ),
      ),
  );
}

export function computerUseRunCommandAllowed(command: {
  readonly runId: SQLWrapper;
  readonly hostId: SQLWrapper;
  readonly orgId: SQLWrapper;
  readonly userId: SQLWrapper;
}) {
  return sql`CASE WHEN ${command.runId} IS NULL THEN TRUE
    WHEN ${remoteDeviceMode(command)}
    THEN ${remoteDeviceRunActive(command, sql`${command.runId}::uuid`)}
      AND ${computerUseHostDeviceAllowed(command, command.hostId)}
    ELSE TRUE END`;
}
