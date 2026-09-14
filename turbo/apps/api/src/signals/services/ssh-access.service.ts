import { sshHostSchema } from "@okouai/api-contracts/contracts/ssh-access";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentSshAccess } from "@okouai/db/schema/agent-ssh-access";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { and, asc, eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { publishSshRuntimeInvalidation } from "./ssh-runtime-wakeup.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
interface AgentAccessScope extends Owner {
  readonly agentId: string;
}

export async function isSshAccessAvailable(
  db: ReadonlyDb,
  owner: Owner,
  signal: AbortSignal,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    owner.orgId,
    owner.userId,
  );
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.SshAccess, context);
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
    eq(agentSshAccess.agentId, owner.agentId),
    eq(agentSshAccess.orgId, owner.orgId),
    eq(agentSshAccess.userId, owner.userId),
  );
}

export async function getAgentSshAccess(
  db: ReadonlyDb,
  owner: AgentAccessScope,
) {
  const [row] = await db
    .select({ grant: agentSshAccess.agentId })
    .from(agents)
    .leftJoin(agentSshAccess, ownedGrant(owner))
    .where(visibleAgent(owner));
  return row ? { enabled: row.grant !== null } : null;
}

export async function updateAgentSshAccess(
  db: Db,
  owner: AgentAccessScope,
  enabled: boolean,
  signal: AbortSignal,
) {
  const result = await db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(visibleAgent(owner))
      .for("update");
    signal.throwIfAborted();
    if (!agent) {
      return null;
    }
    if (enabled) {
      await tx.insert(agentSshAccess).values(owner).onConflictDoNothing();
    } else {
      await tx.delete(agentSshAccess).where(ownedGrant(owner));
    }
    signal.throwIfAborted();
    return { enabled };
  });
  if (result) {
    // The grant may already be deleted. Discover recipients through owner Runs.
    await publishSshRuntimeInvalidation(db, { ...owner, connectionId: null });
  }
  signal.throwIfAborted();
  return result;
}

function runSshHostRows(
  db: ReadonlyDb,
  owner: Owner & { readonly runId: string },
) {
  // A left join preserves the authorized empty inventory in the same snapshot.
  return db
    .select({
      id: sshConnections.id,
      displayName: sshConnections.displayName,
      host: sshConnections.host,
      port: sshConnections.port,
      username: sshCredentials.username,
      algorithm: sshConnections.learnedHostKeyAlgorithm,
      fingerprint: sshConnections.learnedHostKeyFingerprint,
      accessId: sshConnections.cloudflareAccessId,
      accessConfigId: cloudflareAccessConfigs.id,
      accessEnabled: cloudflareAccessConfigs.enabled,
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
    .innerJoin(
      agentSshAccess,
      and(
        eq(agentSshAccess.agentId, agents.id),
        eq(agentSshAccess.orgId, agentRuns.orgId),
        eq(agentSshAccess.userId, agentRuns.userId),
      ),
    )
    .leftJoin(
      sshConnections,
      and(
        eq(sshConnections.orgId, agentRuns.orgId),
        eq(sshConnections.userId, agentRuns.userId),
      ),
    )
    .leftJoin(
      sshCredentials,
      and(
        eq(sshCredentials.id, sshConnections.credentialId),
        eq(sshCredentials.orgId, owner.orgId),
        eq(sshCredentials.userId, owner.userId),
      ),
    )
    .leftJoin(
      cloudflareAccessConfigs,
      and(
        eq(cloudflareAccessConfigs.id, sshConnections.cloudflareAccessId),
        eq(cloudflareAccessConfigs.orgId, owner.orgId),
        eq(cloudflareAccessConfigs.userId, owner.userId),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, owner.runId),
        eq(agentRuns.orgId, owner.orgId),
        eq(agentRuns.userId, owner.userId),
        eq(agentRuns.status, "running"),
      ),
    )
    .orderBy(asc(sshConnections.displayName), asc(sshConnections.id));
}

export async function listRunSshHosts(
  db: ReadonlyDb,
  owner: Owner & { readonly runId: string },
  signal: AbortSignal,
) {
  const rows = await runSshHostRows(db, owner);
  if (rows.length === 0) {
    return null;
  }
  const hasProtectedHosts = rows.some((row) => {
    return row.accessId !== null;
  });
  const accessEnabled =
    hasProtectedHosts &&
    isFeatureEnabled(
      FeatureSwitchKey.CloudflareAccess,
      await loadUserFeatureSwitchContext(db, owner.orgId, owner.userId),
    );
  signal.throwIfAborted();
  return {
    hosts: rows.flatMap((row) => {
      if (row.id === null) {
        return [];
      }
      if (row.accessId !== null) {
        if (row.accessConfigId === null) {
          throw new Error("SSH Cloudflare Access configuration is missing");
        }
        if (!accessEnabled || !row.accessEnabled) {
          return [];
        }
      }
      return [
        sshHostSchema.parse({
          id: row.id,
          displayName: row.displayName,
          host: row.host,
          port: row.port,
          username: row.username,
          learnedHostKey:
            row.algorithm === null && row.fingerprint === null
              ? null
              : { algorithm: row.algorithm, fingerprint: row.fingerprint },
        }),
      ];
    }),
  };
}
