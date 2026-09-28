import { vncHostSchema } from "@okouai/api-contracts/contracts/vnc-access";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentVncAccess } from "@okouai/db/schema/agent-vnc-access";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  shareVncCleanupScopes,
  type VncOwner,
} from "./vnc-owner-lifecycle.service";
import {
  runThreadExists,
  runThreadSshAccess,
  runThreadVncAccess,
} from "./run-thread-remote-access.service";

interface AgentAccessScope extends VncOwner {
  readonly agentId: string;
}

function visibleAgent(owner: AgentAccessScope) {
  return and(
    eq(agents.id, owner.agentId),
    eq(agents.orgId, owner.orgId),
    visibleJoinedAgentCondition(owner.userId),
  );
}

function ownedGrant(owner: AgentAccessScope) {
  return and(
    eq(agentVncAccess.agentId, owner.agentId),
    eq(agentVncAccess.orgId, owner.orgId),
    eq(agentVncAccess.userId, owner.userId),
  );
}

export async function getAgentVncAccess(
  db: ReadonlyDb,
  owner: AgentAccessScope,
) {
  const [row] = await db
    .select({ grant: agentVncAccess.agentId })
    .from(agents)
    .leftJoin(agentVncAccess, ownedGrant(owner))
    .where(visibleAgent(owner));
  return row ? { enabled: row.grant !== null } : null;
}

export async function updateAgentVncAccess(
  db: Db,
  owner: AgentAccessScope,
  enabled: boolean,
  signal: AbortSignal,
) {
  return await db.transaction(async (tx) => {
    await shareVncCleanupScopes(tx, owner);
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(visibleAgent(owner))
      .for("update");
    const featureContext = await loadUserFeatureSwitchContext(
      tx,
      owner.orgId,
      owner.userId,
    );
    signal.throwIfAborted();
    if (
      !agent ||
      !isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext)
    ) {
      return null;
    }
    if (enabled) {
      await tx.insert(agentVncAccess).values(owner).onConflictDoNothing();
    } else {
      await tx.delete(agentVncAccess).where(ownedGrant(owner));
    }
    signal.throwIfAborted();
    return { enabled };
  });
}

export async function listRunVncHosts(
  db: ReadonlyDb,
  owner: VncOwner & { readonly runId: string },
  signal: AbortSignal,
) {
  // The left joins preserve an authorized empty inventory in the same snapshot.
  const rows = await db
    .select({
      id: vncConnections.id,
      transportType: vncConnections.transportType,
      sshNeedsRebind: sshConnections.needsRebind,
      sshAllowed: runThreadSshAccess(db),
      displayName: vncConnections.displayName,
      host: vncConnections.host,
      port: vncConnections.port,
      authMethod: vncCredentials.authMethod,
      securityType: vncConnections.securityType,
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
        visibleJoinedAgentCondition(owner.userId),
      ),
    )
    .leftJoin(
      vncConnections,
      and(
        eq(vncConnections.orgId, agentRuns.orgId),
        eq(vncConnections.userId, agentRuns.userId),
        runThreadVncAccess(db),
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
    .leftJoin(
      vncCredentials,
      and(
        eq(vncCredentials.id, vncConnections.credentialId),
        eq(vncCredentials.orgId, owner.orgId),
        eq(vncCredentials.userId, owner.userId),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, owner.runId),
        eq(agentRuns.orgId, owner.orgId),
        eq(agentRuns.userId, owner.userId),
        eq(agentRuns.status, "running"),
        runThreadExists(db),
      ),
    )
    .orderBy(asc(vncConnections.displayName), asc(vncConnections.id));
  signal.throwIfAborted();
  if (rows.length === 0) {
    return null;
  }
  return {
    hosts: rows.flatMap((row) => {
      if (row.id === null) {
        return [];
      }
      if (row.transportType === "ssh" && !row.sshAllowed) {
        return [];
      }
      // The owner-scoped FK and transport check require this join to exist.
      if (row.transportType === "ssh" && row.sshNeedsRebind === null) {
        throw new Error("VNC SSH connection reference is missing");
      }
      return [
        vncHostSchema.parse({
          id: row.id,
          displayName: row.displayName,
          host: row.host,
          port: row.port,
          authMethod: row.authMethod,
          securityType: row.securityType,
          availability:
            row.transportType === "ssh" && row.sshNeedsRebind
              ? { status: "blocked", reason: "needs_rebind" }
              : { status: "ready" },
        }),
      ];
    }),
  };
}
