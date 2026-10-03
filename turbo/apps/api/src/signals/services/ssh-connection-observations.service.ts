import { sshConnectionObservationSchema } from "@okouai/api-contracts/contracts/ssh-connection-observations";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshConnectionObservations } from "@okouai/db/schema/ssh-connection-observation";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";

export const listSshConnectionObservations$ = command(
  async ({ set }, orgId: string, userId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        connectionId: sshConnectionObservations.connectionId,
        generation: sshConnectionObservations.generation,
        observedAt: sshConnectionObservations.observedAt,
        failureReason: sshConnectionObservations.failureReason,
      })
      .from(sshConnections)
      .innerJoin(
        sshConnectionObservations,
        and(
          eq(sshConnectionObservations.connectionId, sshConnections.id),
          eq(sshConnectionObservations.generation, sshConnections.generation),
        ),
      )
      .leftJoin(
        tailscaleConfigs,
        and(
          eq(tailscaleConfigs.id, sshConnections.tailscaleConfigId),
          eq(tailscaleConfigs.orgId, orgId),
          or(
            eq(tailscaleConfigs.scope, "organization"),
            and(
              eq(tailscaleConfigs.scope, "personal"),
              eq(tailscaleConfigs.userId, userId),
            ),
          ),
        ),
      )
      .where(
        and(
          eq(sshConnections.orgId, orgId),
          eq(sshConnections.userId, userId),
          or(
            and(
              isNull(sshConnections.tailscaleConfigId),
              isNull(sshConnectionObservations.tailscaleConfigId),
            ),
            and(
              eq(tailscaleConfigs.enabled, true),
              eq(
                sshConnectionObservations.tailscaleConfigId,
                tailscaleConfigs.id,
              ),
              eq(
                sshConnectionObservations.tailscaleConfigGeneration,
                tailscaleConfigs.generation,
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(sshConnections.id));
    signal.throwIfAborted();
    return rows.map((row) => {
      return sshConnectionObservationSchema.parse({
        ...row,
        observedAt: row.observedAt.toISOString(),
      });
    });
  },
);
