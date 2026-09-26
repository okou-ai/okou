import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerState } from "@okouai/db/schema/runner-state";
import { and, eq, gt, inArray, like, lte } from "drizzle-orm";

import { env } from "../../lib/env";
import { supportsMandatoryWssListener } from "../../lib/runner-wss-target-config";
import type { ReadonlyDb } from "../external/db";

// Three missed 10-second routine heartbeats. A snapshot is NOT a socket or
// browser-ingress health proof: #37027 must check live local-run ownership.
const WSS_RUNNER_FRESH_MS = 30_000;
const MAX_CLOCK_LEAD_MS = 5000;

/** A configured target, not evidence that DNS/Caddy/TLS is currently reachable. */
export interface RunnerWssTarget {
  readonly runId: string;
  readonly runnerId: string;
  readonly publicOrigin: string;
  /** This service does not inspect DNS, browser TLS, Caddy or the listener. */
  readonly ingressVerification: "not-observed";
  readonly claimedVersion: string;
  readonly observedMode: "running" | "draining";
  readonly observedAt: Date;
}

/**
 * The caller supplies an already authenticated owner. This is deliberately an
 * internal read-only service, not an HTTP discovery endpoint or ticket issuer.
 * Null includes unauthorized and ineligible runs; DB outages propagate.
 */
export async function resolveRunnerWssTarget(
  db: ReadonlyDb,
  args: {
    readonly runId: string;
    readonly owner: { readonly orgId: string; readonly userId: string };
    readonly now: Date;
  },
): Promise<RunnerWssTarget | null> {
  const origins = env("OKOU_WSS_HOST_ORIGINS");
  const minimumVersion = env("OKOU_WSS_MIN_RUNNER_VERSION");
  if (!origins || !minimumVersion) {
    return null;
  }

  const [row] = await db
    .select({
      runId: agentRuns.id,
      runnerId: agentRuns.runnerId,
      runnerHostname: agentRuns.runnerHostname,
      runnerVersion: agentRuns.runnerVersion,
      mode: runnerState.mode,
      lastSeenAt: runnerState.lastSeenAt,
    })
    .from(agentRuns)
    .innerJoin(
      activeAgentRuns,
      and(
        eq(activeAgentRuns.runId, agentRuns.id),
        eq(activeAgentRuns.userId, agentRuns.userId),
        eq(activeAgentRuns.orgId, agentRuns.orgId),
      ),
    )
    .innerJoin(
      runnerState,
      and(
        eq(runnerState.runnerId, agentRuns.runnerId),
        eq(runnerState.runnerGroup, agentRuns.runnerGroup),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.owner.orgId),
        eq(agentRuns.userId, args.owner.userId),
        eq(agentRuns.status, "running"),
        like(agentRuns.runnerGroup, "vm0/%"),
        inArray(runnerState.mode, ["running", "draining"]),
        gt(
          runnerState.lastSeenAt,
          new Date(args.now.getTime() - WSS_RUNNER_FRESH_MS),
        ),
        lte(
          runnerState.lastSeenAt,
          new Date(args.now.getTime() + MAX_CLOCK_LEAD_MS),
        ),
      ),
    );

  if (
    !row ||
    !row.runnerId ||
    !row.runnerHostname ||
    !row.runnerVersion ||
    (row.mode !== "running" && row.mode !== "draining") ||
    !supportsMandatoryWssListener(row.runnerVersion, minimumVersion)
  ) {
    return null;
  }

  const host = origins.find((entry) => {
    return entry.inventoryHostname === row.runnerHostname;
  });
  if (!host) {
    return null;
  }

  return {
    runId: row.runId,
    runnerId: row.runnerId,
    publicOrigin: host.publicOrigin,
    ingressVerification: "not-observed",
    claimedVersion: row.runnerVersion,
    observedMode: row.mode,
    observedAt: row.lastSeenAt,
  };
}
