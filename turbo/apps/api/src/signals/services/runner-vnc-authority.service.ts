import type {
  RunnerVncAuthority,
  RunnerVncResolveRequest,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentVncAccess } from "@okouai/db/schema/agent-vnc-access";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "../external/db";
import type { VncTransaction } from "./vnc-configuration.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export type RunnerVncInput = Pick<
  RunnerVncResolveRequest,
  "connectionId" | "runnerIdentity"
> & { readonly runId: string };

/** Always use the primary database, including after transaction lock waits. */
export async function currentRunnerVncAuthority(
  db: Pick<Db, "select">,
  input: RunnerVncInput,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({
      id: vncConnections.id,
      instanceId: vncConnections.instanceId,
      generation: vncConnections.generation,
      grantId: agentVncAccess.id,
      agentId: agents.id,
      sessionId: agentSessions.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      credentialId: vncCredentials.id,
      host: vncConnections.host,
      port: vncConnections.port,
      securityType: vncConnections.securityType,
      trustMode: vncConnections.trustMode,
      caBundle: vncConnections.caBundle,
      authMethod: vncCredentials.authMethod,
      encryptedPassword: vncCredentials.encryptedPassword,
    })
    .from(agentRuns)
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
    .innerJoin(
      agentVncAccess,
      and(
        eq(agentVncAccess.agentId, agents.id),
        eq(agentVncAccess.orgId, agentRuns.orgId),
        eq(agentVncAccess.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      vncConnections,
      and(
        eq(vncConnections.id, input.connectionId),
        eq(vncConnections.orgId, agentRuns.orgId),
        eq(vncConnections.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      vncCredentials,
      and(
        eq(vncCredentials.id, vncConnections.credentialId),
        eq(vncCredentials.orgId, agentRuns.orgId),
        eq(vncCredentials.userId, agentRuns.userId),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.status, "running"),
        eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
        eq(
          agentRuns.runnerHeartbeatGeneration,
          input.runnerIdentity.heartbeatGeneration,
        ),
      ),
    );
  signal.throwIfAborted();
  if (!row) {
    return null;
  }
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    row.orgId,
    row.userId,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext)) {
    return null;
  }
  if (row.authMethod !== "vnc_password" || row.securityType !== "x509_vnc") {
    throw new Error("VNC configuration has an unsupported stored profile");
  }
  return row;
}

export type CurrentRunnerVncAuthority = NonNullable<
  Awaited<ReturnType<typeof currentRunnerVncAuthority>>
>;

export function runnerVncAuthorityStamp(
  row: CurrentRunnerVncAuthority,
): RunnerVncAuthority {
  return {
    instanceId: row.instanceId,
    generation: row.generation,
    grantId: row.grantId,
  };
}

export function matchesRunnerVncAuthority(
  row: RunnerVncAuthority,
  expected: RunnerVncAuthority,
): boolean {
  return (
    row.instanceId === expected.instanceId &&
    row.generation === expected.generation &&
    row.grantId === expected.grantId
  );
}

/** Match Agent lifecycle's parent lock order; joined rowmarks do not promise it. */
export async function lockRunnerVncAuthority(
  tx: VncTransaction,
  initial: CurrentRunnerVncAuthority,
  input: RunnerVncInput,
  signal: AbortSignal,
) {
  const [connection] = await tx
    .select({ id: vncConnections.id })
    .from(vncConnections)
    .where(
      and(
        eq(vncConnections.id, initial.id),
        eq(vncConnections.instanceId, initial.instanceId),
        eq(vncConnections.orgId, initial.orgId),
        eq(vncConnections.userId, initial.userId),
      ),
    )
    .for("update");
  if (!connection) {
    return null;
  }
  await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, initial.agentId))
    .for("share");
  await tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.id, initial.sessionId))
    .for("share");
  await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.id, input.runId))
    .for("share");
  await tx
    .select({ id: agentVncAccess.id })
    .from(agentVncAccess)
    .where(eq(agentVncAccess.id, initial.grantId))
    .for("share");
  await tx
    .select({ id: vncCredentials.id })
    .from(vncCredentials)
    .where(eq(vncCredentials.id, initial.credentialId))
    .for("share");
  const current = await currentRunnerVncAuthority(tx, input, signal);
  // References may have changed before the locks. Never authorize unlocked parents.
  return current &&
    current.agentId === initial.agentId &&
    current.sessionId === initial.sessionId &&
    current.credentialId === initial.credentialId &&
    current.grantId === initial.grantId
    ? current
    : null;
}
