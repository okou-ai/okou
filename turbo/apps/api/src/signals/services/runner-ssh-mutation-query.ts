import type { RunnerSshResolveRequest } from "@okouai/api-contracts/contracts/runner-ssh";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import {
  sshConnections,
  sshConnectionNeedsRebind,
} from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { and, eq, exists, getTableColumns, not, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { runThreadSshAccess } from "./run-thread-remote-access.service";

type RunnerSshMutationInput = RunnerSshResolveRequest & {
  readonly runId: string;
};
export interface RunnerSshHostIdentity {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}
function hostQueries(initial: RunnerSshHostIdentity) {
  const qb = new QueryBuilder();
  const owner = and(
    eq(sshConnections.id, initial.id),
    eq(sshConnections.orgId, initial.orgId),
    eq(sshConnections.userId, initial.userId),
  );
  const observed = qb.$with("observed_runner_ssh_host").as(
    qb
      .select({
        id: sshConnections.id,
        version: sql`${sshConnections}.xmin::text`
          .mapWith(pgTextDecoder)
          .as("observed_host_version"),
      })
      .from(sshConnections)
      .where(owner),
  );
  const host = qb.$with("locked_runner_ssh_host").as(
    qb
      .select({
        ...getTableColumns(sshConnections),
        needsRebind: sql`${sshConnectionNeedsRebind}`
          .mapWith(sshConnections.legacyNeedsRebind)
          .as("derived_needs_rebind"),
        version: sql`${sshConnections}.xmin::text`
          .mapWith(pgTextDecoder)
          .as("locked_host_version"),
      })
      .from(sshConnections)
      .where(and(owner, exists(qb.select({ id: observed.id }).from(observed))))
      .for("update"),
  );
  return { observed, host };
}
function authorityPredicate(
  input: RunnerSshMutationInput,
  { host, observed }: ReturnType<typeof hostQueries>,
) {
  return and(
    eq(agentRuns.id, input.runId),
    eq(agentRuns.status, "running"),
    eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
    eq(
      agentRuns.runnerHeartbeatGeneration,
      input.runnerIdentity.heartbeatGeneration,
    ),
    runThreadSshAccess(host),
    eq(
      host.version,
      new QueryBuilder().select({ version: observed.version }).from(observed),
    ),
  );
}
function authorityQuery(
  input: RunnerSshMutationInput,
  queries: ReturnType<typeof hostQueries>,
) {
  const qb = new QueryBuilder();
  const { host } = queries;
  return qb.$with("current_runner_ssh_authority").as(
    qb
      .select({
        id: host.id,
        generation: host.generation,
        algorithm: host.learnedHostKeyAlgorithm,
        fingerprint: host.learnedHostKeyFingerprint,
        transport: host.transport,
        needsRebind: sql`${host.needsRebind}`
          .mapWith(sshConnections.legacyNeedsRebind)
          .as("authority_needs_rebind"),
        accessId: host.cloudflareAccessId,
        tailscaleId: host.tailscaleId,
        orgId: host.orgId,
        userId: host.userId,
        accessConfigId: sql`${cloudflareAccessConfigs.id}`
          .mapWith(nullableDriverValueDecoder(cloudflareAccessConfigs.id))
          .as("current_access_config_id"),
        accessGeneration: sql`${cloudflareAccessConfigs.generation}`
          .mapWith(
            nullableDriverValueDecoder(cloudflareAccessConfigs.generation),
          )
          .as("current_access_generation"),
        tailscaleConfigId: sql`${tailscaleConfigs.id}`
          .mapWith(nullableDriverValueDecoder(tailscaleConfigs.id))
          .as("current_tailscale_config_id"),
        tailscaleGeneration: sql`${tailscaleConfigs.generation}`
          .mapWith(nullableDriverValueDecoder(tailscaleConfigs.generation))
          .as("current_tailscale_generation"),
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
          or(
            eq(agents.visibility, "public"),
            eq(agents.owner, agentRuns.userId),
          ),
        ),
      )
      .innerJoin(
        host,
        and(
          eq(host.id, input.connectionId),
          eq(host.orgId, agentRuns.orgId),
          eq(host.userId, agentRuns.userId),
        ),
      )
      .innerJoin(
        sshCredentials,
        and(
          eq(sshCredentials.id, host.credentialId),
          eq(sshCredentials.orgId, agentRuns.orgId),
          eq(sshCredentials.userId, agentRuns.userId),
        ),
      )
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentSessions.agentId),
        ),
      )
      .leftJoin(
        cloudflareAccessConfigs,
        and(
          eq(cloudflareAccessConfigs.id, host.cloudflareAccessId),
          eq(cloudflareAccessConfigs.orgId, agentRuns.orgId),
          or(
            eq(cloudflareAccessConfigs.scope, "organization"),
            and(
              eq(cloudflareAccessConfigs.scope, "personal"),
              eq(cloudflareAccessConfigs.userId, agentRuns.userId),
            ),
          ),
        ),
      )
      .leftJoin(
        tailscaleConfigs,
        and(
          eq(tailscaleConfigs.id, host.tailscaleId),
          eq(tailscaleConfigs.orgId, agentRuns.orgId),
          or(
            eq(tailscaleConfigs.scope, "organization"),
            and(
              eq(tailscaleConfigs.scope, "personal"),
              eq(tailscaleConfigs.userId, agentRuns.userId),
            ),
          ),
        ),
      )
      .where(authorityPredicate(input, queries))
      .for("share", {
        of: [agentRuns, agentSessions, agents, sshCredentials],
      }),
  );
}

// Only sessionless builders leave this module. The retained Run SHARE fence
// also protects its chat lifetime through the existing ON DELETE SET NULL FK;
// thread deletion fences attached Runs first, so do not add a thread-first lock.
// Host drift is known-unwritten. Every serving/rollback SSH override and
// observation writer must stamp that tuple before its dependent write. A mixed
// unstamped cohort does not establish freshness; floors/notices do not drain it.
export function createRunnerSshMutationReads(
  input: RunnerSshMutationInput,
  initial: RunnerSshHostIdentity,
) {
  const qb = new QueryBuilder();
  const { host, observed } = hostQueries(initial);
  const current = authorityQuery(input, { host, observed });
  const access = qb.$with("locked_runner_access_authority").as(
    qb
      .select({ id: cloudflareAccessConfigs.id })
      .from(cloudflareAccessConfigs)
      .innerJoin(current, eq(cloudflareAccessConfigs.id, current.accessId))
      .where(
        and(
          eq(current.transport, "cloudflare_access"),
          eq(cloudflareAccessConfigs.orgId, current.orgId),
          eq(cloudflareAccessConfigs.generation, current.accessGeneration),
          or(
            eq(cloudflareAccessConfigs.scope, "organization"),
            and(
              eq(cloudflareAccessConfigs.scope, "personal"),
              eq(cloudflareAccessConfigs.userId, current.userId),
            ),
          ),
        ),
      )
      .for("share", { of: cloudflareAccessConfigs }),
  );
  const tailscale = qb.$with("locked_runner_tailscale_authority").as(
    qb
      .select({ id: tailscaleConfigs.id })
      .from(tailscaleConfigs)
      .innerJoin(current, eq(tailscaleConfigs.id, current.tailscaleId))
      .where(
        and(
          eq(current.transport, "tailscale"),
          eq(tailscaleConfigs.orgId, current.orgId),
          eq(tailscaleConfigs.generation, current.tailscaleGeneration),
          or(
            eq(tailscaleConfigs.scope, "organization"),
            and(
              eq(tailscaleConfigs.scope, "personal"),
              eq(tailscaleConfigs.userId, current.userId),
            ),
          ),
        ),
      )
      .for("share", { of: tailscaleConfigs }),
  );
  const eligible = qb.$with("eligible_runner_ssh_authority").as(
    qb
      .select({ id: current.id, generation: current.generation })
      .from(current)
      .where(
        and(
          not(current.needsRebind),
          or(
            eq(current.transport, "direct"),
            and(
              eq(current.transport, "cloudflare_access"),
              exists(qb.select({ id: access.id }).from(access)),
            ),
            and(
              eq(current.transport, "tailscale"),
              exists(qb.select({ id: tailscale.id }).from(tailscale)),
            ),
          ),
        ),
      ),
  );
  const fields = {
    id: current.id,
    generation: current.generation,
    algorithm: current.algorithm,
    fingerprint: current.fingerprint,
    transport: current.transport,
    needsRebind: current.needsRebind,
    accessId: current.accessId,
    tailscaleId: current.tailscaleId,
    accessConfigId: current.accessConfigId,
    tailscaleConfigId: current.tailscaleConfigId,
  };
  return {
    observed,
    host,
    current,
    eligible,
    fields,
    ctes: [observed, host, current, access, tailscale, eligible],
  };
}
