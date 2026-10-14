import { vncConnectionObservationSchema } from "@okouai/api-contracts/contracts/vnc-connection-observations";
import type { RunnerVncObservationRequest } from "@okouai/api-contracts/contracts/runner-vnc";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/runtime/agent-session";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { vncConnectionObservations } from "@okouai/db/schema/vnc-connection-observation";
import { and, asc, eq, exists, isNull, lt, lte, or, sql } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { command, computed, type Computed } from "ccstate";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { vncCreationTimestamp } from "./remote-connection-creation-timestamp.utils";
import { db$, writeDb$ } from "../external/db";
import {
  runThreadSshAccess,
  runThreadVncAccess,
} from "./run-thread-remote-access.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
type ObservationInput = RunnerVncObservationRequest & {
  readonly runId: string;
};
const kdcSsh = alias(sshConnections, "observed_vnc_kdc_ssh");

export function createVncConnectionObservations(owner$: Computed<Owner>) {
  return computed(async (get) => {
    const owner = get(owner$);
    const rows = await get(db$)
      .select({
        connectionId: vncConnectionObservations.connectionId,
        connectionCreatedAt: vncCreationTimestamp,
        generation: vncConnectionObservations.generation,
        observedAt: vncConnectionObservations.observedAt,
        failureReason: vncConnectionObservations.failureReason,
      })
      .from(vncConnections)
      .innerJoin(
        vncConnectionObservations,
        and(
          eq(vncConnectionObservations.connectionId, vncConnections.id),
          eq(vncConnectionObservations.generation, vncConnections.generation),
          eq(
            vncConnectionObservations.connectionCreatedAt,
            vncConnections.createdAt,
          ),
        ),
      )
      .leftJoin(
        sshConnections,
        and(
          eq(sshConnections.id, vncConnections.sshConnectionId),
          eq(sshConnections.orgId, vncConnections.orgId),
          eq(sshConnections.userId, vncConnections.userId),
        ),
      )
      .leftJoin(
        kdcSsh,
        and(
          eq(kdcSsh.id, vncConnections.kdcSshConnectionId),
          eq(kdcSsh.orgId, vncConnections.orgId),
          eq(kdcSsh.userId, vncConnections.userId),
        ),
      )
      .where(
        and(
          eq(vncConnections.orgId, owner.orgId),
          eq(vncConnections.userId, owner.userId),
          or(
            and(
              eq(vncConnections.transportType, "direct"),
              isNull(vncConnectionObservations.sshGeneration),
            ),
            and(
              eq(vncConnections.transportType, "ssh"),
              eq(
                vncConnectionObservations.sshGeneration,
                sshConnections.generation,
              ),
            ),
          ),
          or(
            and(
              isNull(vncConnections.kdcSshConnectionId),
              isNull(vncConnectionObservations.kdcSshGeneration),
            ),
            eq(vncConnectionObservations.kdcSshGeneration, kdcSsh.generation),
          ),
        ),
      )
      .orderBy(asc(vncConnections.id));
    return rows.map((row) => {
      return vncConnectionObservationSchema.parse({
        ...row,
        observedAt: row.observedAt.toISOString(),
      });
    });
  });
}

/** Metadata publication only; the route checks membership, feature and runtime policy first. */
function observationWriteSource(
  input: ObservationInput,
  owner: Owner,
  observedAt: Date,
) {
  const query = new QueryBuilder();
  const transport = input.expectedTransport;
  const kdc = input.expectedKdcTransport;
  const sshGeneration = transport.type === "ssh" ? transport.generation : null;
  const kdcSshGeneration = kdc?.type === "ssh" ? kdc.generation : null;
  return query
    .select({
      connectionId: vncConnections.id,
      generation: vncConnections.generation,
      connectionCreatedAt: sql`${vncConnections.createdAt}`
        .mapWith(vncConnectionObservations.connectionCreatedAt)
        .as("connection_created_at"),
      observedAt: sql`${observedAt.toISOString()}::timestamptz`
        .mapWith(vncConnectionObservations.observedAt)
        .as("observed_at"),
      failureReason: sql`${input.failureReason}::text`
        .mapWith(
          nullableDriverValueDecoder(vncConnectionObservations.failureReason),
        )
        .as("failure_reason"),
      sshGeneration: sql`${sshGeneration}::integer`
        .mapWith(
          nullableDriverValueDecoder(vncConnectionObservations.sshGeneration),
        )
        .as("ssh_generation"),
      kdcSshGeneration: sql`${kdcSshGeneration}::integer`
        .mapWith(
          nullableDriverValueDecoder(
            vncConnectionObservations.kdcSshGeneration,
          ),
        )
        .as("kdc_ssh_generation"),
    })
    .from(vncConnections)
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.orgId, vncConnections.orgId),
        eq(agentRuns.userId, vncConnections.userId),
      ),
    )
    .innerJoin(
      agentSessions,
      and(
        eq(agentSessions.id, agentRuns.sessionId),
        eq(agentSessions.orgId, agentRuns.orgId),
        eq(agentSessions.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentSessions.agentId),
        eq(agents.orgId, agentRuns.orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, agentRuns.userId)),
      ),
    )
    .where(
      and(
        eq(vncConnections.id, input.connectionId),
        eq(vncConnections.orgId, owner.orgId),
        eq(vncConnections.userId, owner.userId),
        eq(vncConnections.generation, input.expectedGeneration),
        eq(
          vncConnections.createdAt,
          sql`${input.expectedCreatedAt}::timestamp`,
        ),
        eq(agentRuns.id, input.runId),
        eq(agentRuns.status, "running"),
        eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
        eq(
          agentRuns.runnerHeartbeatGeneration,
          input.runnerIdentity.heartbeatGeneration,
        ),
        runThreadVncAccess(),
        transportObservationAuthority(input, owner),
      ),
    );
}

function transportObservationAuthority(input: ObservationInput, owner: Owner) {
  const query = new QueryBuilder();
  const transport = input.expectedTransport;
  const kdc = input.expectedKdcTransport;
  return and(
    eq(vncConnections.transportType, transport.type),
    transport.type === "ssh"
      ? exists(
          query
            .select({ id: sshConnections.id })
            .from(sshConnections)
            .where(
              and(
                eq(sshConnections.id, transport.connectionId),
                eq(sshConnections.id, vncConnections.sshConnectionId),
                eq(sshConnections.orgId, owner.orgId),
                eq(sshConnections.userId, owner.userId),
                eq(sshConnections.generation, transport.generation),
                runThreadSshAccess(),
              ),
            ),
        )
      : undefined,
    input.expectedCredentialRevision !== undefined
      ? exists(
          query
            .select({ id: vncCredentials.id })
            .from(vncCredentials)
            .where(
              and(
                eq(vncCredentials.id, vncConnections.credentialId),
                eq(vncCredentials.orgId, owner.orgId),
                eq(vncCredentials.userId, owner.userId),
                eq(vncCredentials.revision, input.expectedCredentialRevision),
              ),
            ),
        )
      : undefined,
    kdc !== undefined
      ? eq(vncConnections.kdcTransportType, kdc.type)
      : undefined,
    kdc?.type === "ssh"
      ? exists(
          query
            .select({ id: kdcSsh.id })
            .from(kdcSsh)
            .where(
              and(
                eq(kdcSsh.id, kdc.connectionId),
                eq(kdcSsh.id, vncConnections.kdcSshConnectionId),
                eq(kdcSsh.orgId, owner.orgId),
                eq(kdcSsh.userId, owner.userId),
                eq(kdcSsh.generation, kdc.generation),
                runThreadSshAccess(kdcSsh),
              ),
            ),
        )
      : undefined,
  );
}

export const recordVncConnectionObservation$ = command(
  async (
    { set },
    input: ObservationInput,
    owner: Owner,
    signal: AbortSignal,
  ) => {
    const observedAt = new Date(input.observedAt);
    if (observedAt.getTime() > nowDate().getTime() + 60_000) {
      return { outcome: "ignored" as const };
    }
    const db = set(writeDb$);
    const transport = input.expectedTransport;
    const kdc = input.expectedKdcTransport;
    const sshGeneration =
      transport.type === "ssh" ? transport.generation : null;
    const kdcSshGeneration = kdc?.type === "ssh" ? kdc.generation : null;
    const written = await db
      .insert(vncConnectionObservations)
      .select(observationWriteSource(input, owner, observedAt))
      .onConflictDoUpdate({
        target: vncConnectionObservations.connectionId,
        set: {
          connectionCreatedAt: input.expectedCreatedAt,
          generation: input.expectedGeneration,
          observedAt,
          failureReason: input.failureReason,
          sshGeneration,
          kdcSshGeneration,
        },
        // An old-generation statement may finish after a new-generation writer.
        setWhere: or(
          lt(
            vncConnectionObservations.connectionCreatedAt,
            sql`${input.expectedCreatedAt}::timestamp`,
          ),
          and(
            eq(
              vncConnectionObservations.connectionCreatedAt,
              sql`${input.expectedCreatedAt}::timestamp`,
            ),
            or(
              lt(
                vncConnectionObservations.generation,
                input.expectedGeneration,
              ),
              and(
                eq(
                  vncConnectionObservations.generation,
                  input.expectedGeneration,
                ),
                sshGeneration === null
                  ? isNull(vncConnectionObservations.sshGeneration)
                  : lte(vncConnectionObservations.sshGeneration, sshGeneration),
                kdcSshGeneration === null
                  ? isNull(vncConnectionObservations.kdcSshGeneration)
                  : lte(
                      vncConnectionObservations.kdcSshGeneration,
                      kdcSshGeneration,
                    ),
                or(
                  sshGeneration !== null
                    ? lt(vncConnectionObservations.sshGeneration, sshGeneration)
                    : undefined,
                  kdcSshGeneration !== null
                    ? lt(
                        vncConnectionObservations.kdcSshGeneration,
                        kdcSshGeneration,
                      )
                    : undefined,
                  lt(vncConnectionObservations.observedAt, observedAt),
                ),
              ),
            ),
          ),
        ),
      })
      .returning({ id: vncConnectionObservations.connectionId });
    signal.throwIfAborted();
    return {
      outcome:
        written.length > 0 ? ("recorded" as const) : ("ignored" as const),
    };
  },
);
