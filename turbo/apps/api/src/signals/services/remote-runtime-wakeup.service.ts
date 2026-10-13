import type { RemoteAccessProtocol } from "@okouai/api-contracts/contracts/chat-remote-access";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { db$ } from "../external/db";
import {
  publishSshInvalidationToRunnerGroup,
  publishVncInvalidationToRunnerGroup,
} from "../external/realtime";
import { settle } from "../utils";

const L = logger("RemoteRuntimeWakeup");

export type RemoteInvalidationScope = {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId?: string;
} & (
  | { readonly connectionId: string | null; readonly connectionIds?: never }
  | { readonly connectionIds: readonly string[]; readonly connectionId?: never }
);

/** Best-effort post-commit eviction. Deleted hosts must not filter out Runs. */
export const publishRemoteRunnerInvalidation$ = command(
  async (
    { get },
    scope: RemoteInvalidationScope,
    protocol: RemoteAccessProtocol,
  ): Promise<void> => {
    const connectionIds = scope.connectionIds ?? [scope.connectionId];
    if (connectionIds.length === 0) {
      return;
    }
    const db = get(db$);
    const discovery = await settle(
      db
        .select({ runId: agentRuns.id, runnerGroup: agentRuns.runnerGroup })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, scope.orgId),
            eq(agentRuns.userId, scope.userId),
            eq(agentRuns.status, "running"),
            isNotNull(agentRuns.runnerGroup),
            scope.chatThreadId === undefined
              ? undefined
              : eq(agentRuns.chatThreadId, scope.chatThreadId),
          ),
        ),
    );
    if (!discovery.ok) {
      L.warn("Failed to discover remote invalidation recipients", {
        ...scope,
        protocol,
        error: discovery.error,
      });
      return;
    }
    for (let offset = 0; offset < discovery.value.length; offset += 16) {
      await Promise.all(
        discovery.value.slice(offset, offset + 16).map(async (run) => {
          if (run.runnerGroup === null) {
            return;
          }
          for (const connectionId of connectionIds) {
            const notification = { runId: run.runId, connectionId };
            const published = await settle(
              protocol === "ssh"
                ? publishSshInvalidationToRunnerGroup(
                    run.runnerGroup,
                    notification,
                  )
                : publishVncInvalidationToRunnerGroup(
                    run.runnerGroup,
                    notification,
                  ),
            );
            if (!published.ok) {
              L.warn("Failed to publish remote invalidation", {
                ...scope,
                protocol,
                runId: run.runId,
                error: published.error,
              });
            }
          }
        }),
      );
    }
  },
);
