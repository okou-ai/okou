import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  phoneUseDevices as devices,
  phoneUseGrants as grants,
  phoneUseOperations as operations,
} from "@okouai/db/schema/phone-use";
import { and, eq, exists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { phoneOperationGenerationMatches } from "./phone-use-operation-generation";
import {
  remoteDeviceAllowed,
  remoteDeviceMode,
  remoteDeviceRunActive,
} from "./remote-device-access";

type Device = typeof devices.$inferSelect;

export function phoneOperationDeviceAuthority(
  device: Device,
  requireAccess: boolean,
  threadId?: string,
) {
  const qb = new QueryBuilder();
  const legacy = exists(
    qb
      .select({ id: grants.id })
      .from(grants)
      .innerJoin(
        agentRuns,
        and(
          eq(agentRuns.id, operations.runId),
          eq(agentRuns.chatThreadId, grants.threadId),
          eq(agentRuns.status, "running"),
          eq(agentRuns.orgId, device.orgId),
          eq(agentRuns.userId, device.userId),
        ),
      )
      .where(
        and(
          phoneOperationGenerationMatches(device.generation),
          eq(grants.id, operations.grantId),
          eq(grants.deviceId, device.id),
          eq(grants.deviceGeneration, device.generation),
          eq(grants.orgId, device.orgId),
          eq(grants.userId, device.userId),
          threadId ? eq(grants.threadId, threadId) : undefined,
        ),
      ),
  );
  const deviceRun = and(
    eq(operations.grantId, device.id),
    eq(operations.deviceGeneration, device.generation),
    eq(operations.orgId, device.orgId),
    eq(operations.userId, device.userId),
    remoteDeviceRunActive(device, operations.runId, threadId),
  );
  if (!requireAccess) {
    return sql`CASE WHEN ${operations.grantId} = ${operations.deviceId} THEN ${deviceRun} ELSE ${legacy} END`;
  }
  return sql`CASE
    WHEN ${operations.grantId} = ${operations.deviceId}
    THEN ${deviceRun} AND ${phoneDeviceAvailable(device, true)}
    ELSE NOT ${remoteDeviceMode(device)} AND ${legacy} END`;
}

export function phoneDeviceAvailable(device: Device, requireAccess: boolean) {
  return exists(
    new QueryBuilder()
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          eq(devices.id, device.id),
          eq(devices.orgId, device.orgId),
          eq(devices.userId, device.userId),
          eq(devices.generation, device.generation),
          requireAccess
            ? and(
                eq(devices.ready, true),
                remoteDeviceMode(device),
                remoteDeviceAllowed(devices),
              )
            : undefined,
        ),
      ),
  );
}
