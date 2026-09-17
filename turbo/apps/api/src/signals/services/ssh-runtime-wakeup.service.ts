import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { and, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";
import { publishSshInvalidationToRunnerGroup } from "../external/realtime";
import { settle } from "../utils";

import { publishSshClientInvalidation } from "./ssh-client-invalidation.service";

const L = logger("SshRuntimeWakeup");

type SshInvalidationScope = {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId?: string;
} & (
  | { readonly connectionId: string | null; readonly connectionIds?: never }
  | { readonly connectionIds: readonly string[]; readonly connectionId?: never }
);

/** Best-effort post-commit eviction. Deleted grants/connections must not filter out Runs. */
export async function publishSshRuntimeInvalidation(
  db: ReadonlyDb,
  scope: SshInvalidationScope,
): Promise<void> {
  await publishSshClientInvalidation(scope);
  const connectionIds = scope.connectionIds ?? [scope.connectionId];
  if (connectionIds.length === 0) {
    return;
  }
  const discovery = await settle(
    db
      .select({ runId: agentRuns.id, runnerGroup: agentRuns.runnerGroup })
      .from(agentRuns)
      .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
      .where(
        and(
          eq(agentRuns.orgId, scope.orgId),
          eq(agentRuns.userId, scope.userId),
          eq(agentRuns.status, "running"),
          isNotNull(agentRuns.runnerGroup),
          scope.agentId === undefined
            ? undefined
            : eq(agentSessions.agentId, scope.agentId),
        ),
      ),
  );
  if (!discovery.ok) {
    L.warn("Failed to discover SSH invalidation recipients", {
      ...scope,
      error: discovery.error,
    });
    return;
  }
  // Bound parallel publication to the affected active Runs.
  for (let offset = 0; offset < discovery.value.length; offset += 16) {
    await Promise.all(
      discovery.value.slice(offset, offset + 16).map(async (run) => {
        if (run.runnerGroup === null) {
          return;
        }
        for (const connectionId of connectionIds) {
          const published = await settle(
            publishSshInvalidationToRunnerGroup(run.runnerGroup, {
              runId: run.runId,
              connectionId,
            }),
          );
          if (!published.ok) {
            L.warn("Failed to publish SSH invalidation", {
              ...scope,
              runId: run.runId,
              error: published.error,
            });
          }
        }
      }),
    );
  }
}
