import type { RemoteAccessProtocol } from "@okouai/api-contracts/contracts/chat-remote-access";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/runtime/agent-session";
import { command } from "ccstate";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";

import { logger } from "../../lib/log";
import { db$ } from "../external/db";
import {
  publishSshInvalidationToRunnerGroup,
  publishVncInvalidationToRunnerGroup,
} from "../external/realtime";
import { settle } from "../utils";

const L = logger("RemoteRuntimeWakeup");

type Recipient = {
  readonly runId: string;
  readonly runnerGroup: string | null;
};

type VncLifecycleScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "owner"; readonly orgId: string; readonly userId: string }
  | {
      readonly kind: "agent";
      readonly orgId: string;
      readonly agentId: string;
      readonly ownerId: string;
    };

async function publishInvalidations(
  recipients: readonly Recipient[],
  connectionIds: readonly (string | null)[],
  protocol: RemoteAccessProtocol,
): Promise<void> {
  for (let offset = 0; offset < recipients.length; offset += 16) {
    await Promise.all(
      recipients.slice(offset, offset + 16).map(async (run) => {
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
              protocol,
              runId: run.runId,
              connectionId,
              error: published.error,
            });
          }
        }
      }),
    );
  }
}

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
    await publishInvalidations(discovery.value, connectionIds, protocol);
  },
);

/** Owner erasure or loss of agent access retires only matching VNC Runs. */
export const publishVncLifecycleInvalidation$ = command(
  async (
    { get },
    scope: VncLifecycleScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const discovery = await settle(
      db
        .select({ runId: agentRuns.id, runnerGroup: agentRuns.runnerGroup })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.status, "running"),
            isNotNull(agentRuns.runnerGroup),
            scope.kind === "user"
              ? undefined
              : eq(agentRuns.orgId, scope.orgId),
            scope.kind === "user" || scope.kind === "owner"
              ? eq(agentRuns.userId, scope.userId)
              : undefined,
            scope.kind === "agent"
              ? ne(agentRuns.userId, scope.ownerId)
              : undefined,
            scope.kind === "agent"
              ? inArray(
                  agentRuns.sessionId,
                  db
                    .select({ id: agentSessions.id })
                    .from(agentSessions)
                    .where(
                      and(
                        eq(agentSessions.orgId, scope.orgId),
                        eq(agentSessions.agentId, scope.agentId),
                      ),
                    ),
                )
              : undefined,
          ),
        ),
    );
    signal.throwIfAborted();
    if (!discovery.ok) {
      L.warn("Failed to discover VNC lifecycle invalidation recipients", {
        ...scope,
        error: discovery.error,
      });
      return;
    }
    await publishInvalidations(discovery.value, [null], "vnc");
    signal.throwIfAborted();
  },
);
