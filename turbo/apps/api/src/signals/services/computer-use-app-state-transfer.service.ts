import { createHmac } from "node:crypto";
import { command } from "ccstate";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  DIRECT_APP_STATE_CAPABILITY,
  appStateRunnerSchema,
} from "@okouai/api-contracts/contracts/computer-use";
import { isCanonicalRunnerHostname } from "@okouai/api-contracts/contracts/runner-dispatch";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { computerUseCommands } from "@okouai/db/schema/computer-use-host";
import { number } from "zod";
import { env } from "../../lib/env";
import { nowDateSql } from "../../lib/time";
import { db$ } from "../external/db";

const storedAppStateTransferSchema = appStateRunnerSchema.extend({
  hostGeneration: number().int().nonnegative(),
});

/** Both the Mac claim and the Runner's last check before releasing bytes use this grant. */
export const currentAppStateTransfer$ = command(
  async ({ get }, runId: string, commandId: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        payload: computerUseCommands.payload,
        hostId: computerUseHosts.id,
        hostGeneration: computerUseHosts.connectionGeneration,
        runnerId: agentRuns.runnerId,
        heartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
        hostname: agentRuns.runnerHostname,
        createdAt: computerUseCommands.createdAt,
        timeoutMs: computerUseCommands.timeoutMs,
        status: computerUseCommands.status,
      })
      .from(computerUseCommands)
      .innerJoin(
        agentRuns,
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.userId, computerUseCommands.userId),
          eq(agentRuns.orgId, computerUseCommands.orgId),
        ),
      )
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.orgId, agentRuns.orgId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.computerUseHostId, computerUseCommands.hostId),
        ),
      )
      .innerJoin(
        computerUseHosts,
        and(
          eq(computerUseHosts.id, computerUseCommands.hostId),
          eq(computerUseHosts.orgId, computerUseCommands.orgId),
          eq(computerUseHosts.userId, computerUseCommands.userId),
        ),
      )
      .where(
        and(
          eq(computerUseCommands.id, commandId),
          eq(computerUseCommands.runId, runId),
          eq(agentRuns.status, "running"),
          eq(computerUseCommands.kind, "app.state"),
          inArray(computerUseCommands.status, ["queued", "running"]),
          or(
            eq(computerUseCommands.status, "queued"),
            eq(
              computerUseCommands.claimedConnectionGeneration,
              computerUseHosts.connectionGeneration,
            ),
          ),
          eq(computerUseHosts.status, "online"),
          isNull(computerUseHosts.revokedAt),
          sql`${computerUseCommands.createdAt} + ${computerUseCommands.timeoutMs} * interval '1 millisecond' > ${nowDateSql()}`,
        ),
      );
    signal.throwIfAborted();
    const selected = storedAppStateTransferSchema.safeParse(
      row?.payload.directAppState,
    );
    if (
      !row ||
      !selected.success ||
      !row.hostname ||
      !isCanonicalRunnerHostname(row.hostname) ||
      selected.data.runnerId !== row.runnerId ||
      selected.data.heartbeatGeneration !== row.heartbeatGeneration ||
      selected.data.hostGeneration !== row.hostGeneration
    ) {
      return null;
    }
    return {
      ...selected.data,
      hostId: row.hostId,
      hostname: row.hostname,
      claimed: row.status === "running",
      expiresAt: row.createdAt.getTime() + row.timeoutMs,
    };
  },
);

export function signAppStateUpload(
  target: NonNullable<
    Awaited<ReturnType<typeof currentAppStateTransfer$.write>>
  >,
  runId: string,
  commandId: string,
) {
  const path = `/runners/${target.runnerId}/sandbox/runs/${runId}/app-state/${commandId}`;
  const signature = createHmac(
    "sha256",
    OFFICIAL_RUNNER_TOKEN_PREFIX + env("OFFICIAL_RUNNER_SECRET"),
  )
    .update(
      [
        "computer-use-app-state-v1",
        target.hostname,
        target.heartbeatGeneration,
        path,
        target.hostId,
        target.expiresAt,
      ].join("\n"),
    )
    .digest("hex");
  return {
    url: `https://${target.hostname}${path}`,
    token: `${target.hostId}.${target.expiresAt}.${signature}`,
  };
}

/** Decide once, using the CLI's assigned Runner and the authorized Mac's advertisement. */
export const selectAppStateTransfer$ = command(
  async (
    { get, set },
    owner: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
      readonly targetHostId?: string;
    },
    host:
      | Pick<
          typeof computerUseHosts.$inferSelect,
          "id" | "connectionGeneration" | "supportedCapabilities"
        >
      | undefined,
    receiver: {
      readonly runnerId: string;
      readonly heartbeatGeneration: number;
    },
    signal: AbortSignal,
  ) => {
    if (
      !owner.runId ||
      !host ||
      owner.targetHostId !== host.id ||
      !host.supportedCapabilities.includes(DIRECT_APP_STATE_CAPABILITY)
    ) {
      return null;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      owner.orgId,
      owner.userId,
      signal,
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.ComputerUseAppStateDirectTransfer,
        features,
      )
    ) {
      return null;
    }
    const [run] = await get(db$)
      .select({ hostname: agentRuns.runnerHostname })
      .from(agentRuns)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.computerUseHostId, host.id),
          eq(chatThreads.orgId, owner.orgId),
          eq(chatThreads.userId, owner.userId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, owner.runId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.status, "running"),
          eq(agentRuns.runnerId, receiver.runnerId),
          eq(agentRuns.runnerHeartbeatGeneration, receiver.heartbeatGeneration),
        ),
      );
    signal.throwIfAborted();
    return run?.hostname && isCanonicalRunnerHostname(run.hostname)
      ? {
          runnerId: receiver.runnerId,
          heartbeatGeneration: receiver.heartbeatGeneration,
          hostGeneration: host.connectionGeneration,
        }
      : null;
  },
);
