import type { RunnerVncResolveRequest } from "@okouai/api-contracts/contracts/runner-vnc";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentSshAccess } from "@okouai/db/schema/agent-ssh-access";
import { agentVncAccess } from "@okouai/db/schema/agent-vnc-access";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, eq, isNotNull, or } from "drizzle-orm";
import type { Db } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  runThreadSshAccess,
  runThreadVncAccess,
  runUsesThreadRemoteAccess,
} from "./run-thread-remote-access.service";

type RunnerVncInput = Pick<
  RunnerVncResolveRequest,
  "connectionId" | "runnerIdentity"
> & { readonly runId: string };

/** Always read current authorization from the primary database. */
export async function currentRunnerVncAuthority(
  db: Pick<Db, "select">,
  input: RunnerVncInput,
  signal: AbortSignal,
) {
  const threadMode = await runUsesThreadRemoteAccess(db, input.runId, signal);
  const [row] = await db
    .select({
      generation: vncConnections.generation,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      host: vncConnections.host,
      port: vncConnections.port,
      transportType: vncConnections.transportType,
      sshConnectionId: vncConnections.sshConnectionId,
      sshGeneration: sshConnections.generation,
      sshGrantAgentId: agentSshAccess.agentId,
      sshAllowed: runThreadSshAccess(db),
      x509ServerName: vncConnections.x509ServerName,
      securityType: vncConnections.securityType,
      trustMode: vncConnections.trustMode,
      caBundle: vncConnections.caBundle,
      authMethod: vncConnections.authMethod,
      username: vncCredentials.username,
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
    .leftJoin(
      agentVncAccess,
      and(
        eq(agentVncAccess.agentId, agents.id),
        eq(agentVncAccess.orgId, agentRuns.orgId),
        eq(agentVncAccess.userId, agentRuns.userId),
      ),
    )
    .leftJoin(
      agentSshAccess,
      and(
        eq(agentSshAccess.agentId, agents.id),
        eq(agentSshAccess.orgId, agentRuns.orgId),
        eq(agentSshAccess.userId, agentRuns.userId),
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
    .leftJoin(
      sshConnections,
      and(
        eq(sshConnections.id, vncConnections.sshConnectionId),
        eq(sshConnections.orgId, agentRuns.orgId),
        eq(sshConnections.userId, agentRuns.userId),
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
        threadMode ? runThreadVncAccess(db) : isNotNull(agentVncAccess.agentId),
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
  return { ...row, threadMode };
}
