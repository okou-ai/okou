import type { RunnerVncResolveRequest } from "@okouai/api-contracts/contracts/runner-vnc";
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
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

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
  const [row] = await db
    .select({
      generation: vncConnections.generation,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
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
