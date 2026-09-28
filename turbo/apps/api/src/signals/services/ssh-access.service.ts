import { sshHostSchema } from "@okouai/api-contracts/contracts/ssh-access";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { and, asc, eq, or } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import {
  runThreadExists,
  runThreadSshAccess,
} from "./run-thread-remote-access.service";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
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
      needsRebind: sshConnections.needsRebind,
      accessConfigId: cloudflareAccessConfigs.id,
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
      sshConnections,
      and(
        eq(sshConnections.orgId, agentRuns.orgId),
        eq(sshConnections.userId, agentRuns.userId),
        runThreadSshAccess(db),
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
        or(
          eq(cloudflareAccessConfigs.scope, "organization"),
          and(
            eq(cloudflareAccessConfigs.scope, "personal"),
            eq(cloudflareAccessConfigs.userId, owner.userId),
          ),
        ),
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
  signal.throwIfAborted();
  return {
    hosts: rows.flatMap((row) => {
      if (row.id === null) {
        return [];
      }
      if (!row.needsRebind && row.accessId !== null) {
        if (row.accessConfigId === null) {
          throw new Error("SSH Cloudflare Access is missing");
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
          availability: row.needsRebind
            ? { status: "blocked", reason: "needs_rebind" }
            : { status: "ready" },
        }),
      ];
    }),
  };
}
