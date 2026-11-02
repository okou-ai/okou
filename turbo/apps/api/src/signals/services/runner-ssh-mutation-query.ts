import type { RunnerSshResolveRequest } from "@okouai/api-contracts/contracts/runner-ssh";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import {
  sshConnections,
  sshConnectionNeedsRebind,
} from "@okouai/db/runtime/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { and, eq, exists, getTableColumns, not, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { runThreadSshAccess } from "./run-thread-remote-access.service";

type RunnerSshMutationInput = RunnerSshResolveRequest & {
  readonly runId: string;
};
export interface RunnerSshHostIdentity {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly createdAt: string;
}
function hostQueries(initial: RunnerSshHostIdentity) {
  const qb = new QueryBuilder();
  const owner = and(
    eq(sshConnections.id, initial.id),
    eq(sshConnections.orgId, initial.orgId),
    eq(sshConnections.userId, initial.userId),
    eq(sshConnections.createdAt, sql`${initial.createdAt}::timestamp`),
  );
  const host = qb.$with("authorized_runner_ssh_host").as(
    qb
      .select({
        ...getTableColumns(sshConnections),
        needsRebind: sql`${sshConnectionNeedsRebind}`
          .mapWith(pgBooleanDecoder)
          .as("derived_needs_rebind"),
      })
      .from(sshConnections)
      .where(owner),
  );
  return { host };
}
function authorityPredicate(
  input: RunnerSshMutationInput,
  { host }: ReturnType<typeof hostQueries>,
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
        createdAt: host.createdAt,
        algorithm: host.learnedHostKeyAlgorithm,
        fingerprint: host.learnedHostKeyFingerprint,
        connectionMode: host.connectionMode,
        needsRebind: sql`${host.needsRebind}`
          .mapWith(pgBooleanDecoder)
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
        agents,
        and(
          eq(agents.id, agentRuns.agentId),
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
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentRuns.agentId),
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
      .where(
        and(
          authorityPredicate(input, queries),
          or(
            eq(host.connectionMode, "tailscale_ssh"),
            exists(
              qb
                .select({ id: sshCredentials.id })
                .from(sshCredentials)
                .where(
                  and(
                    eq(sshCredentials.id, host.credentialId),
                    eq(sshCredentials.orgId, host.orgId),
                    eq(sshCredentials.userId, host.userId),
                  ),
                ),
            ),
          ),
        ),
      ),
  );
}

// Authorization is evaluated by the mutation statement's snapshot. Revocation
// denies later requests; admitted in-flight work may complete. Generation and
// Host incarnation are business identities, not a cross-writer lock protocol.
export function createRunnerSshMutationReads(
  input: RunnerSshMutationInput,
  initial: RunnerSshHostIdentity,
) {
  const qb = new QueryBuilder();
  const { host } = hostQueries(initial);
  const current = authorityQuery(input, { host });
  const access = qb.$with("runner_access_authority").as(
    qb
      .select({ id: cloudflareAccessConfigs.id })
      .from(cloudflareAccessConfigs)
      .innerJoin(current, eq(cloudflareAccessConfigs.id, current.accessId))
      .where(
        and(
          eq(current.connectionMode, "cloudflare_access"),
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
      ),
  );
  const tailscale = qb.$with("runner_tailscale_authority").as(
    qb
      .select({ id: tailscaleConfigs.id })
      .from(tailscaleConfigs)
      .innerJoin(current, eq(tailscaleConfigs.id, current.tailscaleId))
      .where(
        and(
          or(
            eq(current.connectionMode, "tailscale"),
            eq(current.connectionMode, "tailscale_ssh"),
          ),
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
      ),
  );
  const eligible = qb.$with("eligible_runner_ssh_authority").as(
    qb
      .select({
        id: current.id,
        generation: current.generation,
        createdAt: current.createdAt,
      })
      .from(current)
      .where(
        and(
          not(current.needsRebind),
          or(
            eq(current.connectionMode, "direct"),
            and(
              eq(current.connectionMode, "cloudflare_access"),
              exists(qb.select({ id: access.id }).from(access)),
            ),
            and(
              or(
                eq(current.connectionMode, "tailscale"),
                eq(current.connectionMode, "tailscale_ssh"),
              ),
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
    connectionMode: current.connectionMode,
    needsRebind: current.needsRebind,
    accessId: current.accessId,
    tailscaleId: current.tailscaleId,
    accessConfigId: current.accessConfigId,
    tailscaleConfigId: current.tailscaleConfigId,
  };
  return {
    host,
    current,
    eligible,
    fields,
    ctes: [host, current, access, tailscale, eligible],
  };
}
