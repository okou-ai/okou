import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerState } from "@okouai/db/schema/runner-state";
import { runnerWssTickets } from "@okouai/db/schema/runner-wss-ticket";
import { command } from "ccstate";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  or,
} from "drizzle-orm";

import { wssOriginFromRunnerHostname } from "../../lib/runner-wss-target-config";

// Three missed 10-second routine heartbeats. Host-local WSS ingress service
// status filters only new ticket issuance, NOT public WSS health or redemption:
// #37027 must independently check live local-run ownership.
const WSS_RUNNER_FRESH_MS = 30_000;
const MAX_CLOCK_LEAD_MS = 5000;

/** An attribution-derived target, not evidence of live public ingress. */
export interface RunnerWssTarget {
  readonly runId: string;
  readonly runnerId: string;
  readonly publicOrigin: string;
  /** A local ingress service observation is not public WSS verification. */
  readonly ingressVerification: "not-observed";
  readonly observedMode: "running" | "draining";
  readonly observedAt: Date;
}

interface RunnerWssTargetQueryArgs {
  readonly runId: string;
  readonly owner: { readonly orgId: string; readonly userId: string };
  readonly now: Date;
  /** Local ingress service availability filters issuance, not redemption. */
  readonly purpose: "issue" | "consume";
}

function liveWssConditions(now: Date) {
  return and(
    eq(agentRuns.status, "running"),
    like(agentRuns.runnerGroup, "vm0/%"),
    inArray(runnerState.mode, ["running", "draining"]),
    gt(runnerState.lastSeenAt, new Date(now.getTime() - WSS_RUNNER_FRESH_MS)),
    lte(runnerState.lastSeenAt, new Date(now.getTime() + MAX_CLOCK_LEAD_MS)),
  );
}

function targetSelection() {
  return {
    runId: agentRuns.id,
    runnerId: agentRuns.runnerId,
    runnerHostname: agentRuns.runnerHostname,
    mode: runnerState.mode,
    lastSeenAt: runnerState.lastSeenAt,
  };
}
const activeRunJoin = and(
  eq(activeAgentRuns.runId, agentRuns.id),
  eq(activeAgentRuns.userId, agentRuns.userId),
  eq(activeAgentRuns.orgId, agentRuns.orgId),
);
const runnerStateJoin = and(
  eq(runnerState.runnerId, agentRuns.runnerId),
  eq(runnerState.runnerGroup, agentRuns.runnerGroup),
);

/** Bounded consumed-ticket lookup joined to current writer-backed Run authority. */
export function buildRunnerWssAuthorizationQuery(args: {
  readonly runnerId: string;
  readonly now: Date;
  readonly authorizations: readonly {
    readonly runId: string;
    readonly digest: string;
  }[];
}) {
  return {
    selection: {
      ...targetSelection(),
      digest: runnerWssTickets.digest,
      origin: runnerWssTickets.origin,
    },
    activeRunJoin,
    runnerStateJoin,
    ticketJoin: and(
      eq(runnerWssTickets.runId, agentRuns.id),
      eq(runnerWssTickets.orgId, agentRuns.orgId),
      eq(runnerWssTickets.userId, agentRuns.userId),
      eq(runnerWssTickets.runnerId, agentRuns.runnerId),
    ),
    where: and(
      liveWssConditions(args.now),
      eq(agentRuns.runnerId, args.runnerId),
      isNotNull(runnerWssTickets.consumedAt),
      isNull(runnerWssTickets.revokedAt),
      or(
        ...args.authorizations.map((entry) => {
          return and(
            eq(agentRuns.id, entry.runId),
            eq(runnerWssTickets.digest, entry.digest),
          );
        }),
      ),
    ),
  };
}

/** Pure query pieces; the owning command executes the SELECT on its connection. */
export function buildRunnerWssTargetQuery(args: RunnerWssTargetQueryArgs) {
  // The sole writer stores status and lastSeenAt in the same ordered heartbeat
  // upsert; missing or untrusted observations clear status. The lastSeenAt
  // bounds below therefore also bound the age of a positive observation.
  const ingressServiceAvailability =
    args.purpose === "issue"
      ? eq(runnerState.wssIngressServiceActive, true)
      : undefined;
  return {
    selection: targetSelection(),
    activeRunJoin,
    runnerStateJoin,
    where: and(
      eq(agentRuns.id, args.runId),
      eq(agentRuns.orgId, args.owner.orgId),
      eq(agentRuns.userId, args.owner.userId),
      liveWssConditions(args.now),
      ingressServiceAvailability,
    ),
  };
}

interface RunnerWssTargetRow {
  readonly runId: (typeof agentRuns.$inferSelect)["id"];
  readonly runnerId: (typeof agentRuns.$inferSelect)["runnerId"];
  readonly runnerHostname: (typeof agentRuns.$inferSelect)["runnerHostname"];
  readonly mode: (typeof runnerState.$inferSelect)["mode"];
  readonly lastSeenAt: (typeof runnerState.$inferSelect)["lastSeenAt"];
}

export function runnerWssTargetFromRow(
  row: RunnerWssTargetRow | undefined,
): RunnerWssTarget | null {
  if (
    !row ||
    !row.runnerId ||
    !row.runnerHostname ||
    (row.mode !== "running" && row.mode !== "draining")
  ) {
    return null;
  }

  const publicOrigin = wssOriginFromRunnerHostname(row.runnerHostname);
  if (!publicOrigin) {
    return null;
  }

  return {
    runId: row.runId,
    runnerId: row.runnerId,
    publicOrigin,
    ingressVerification: "not-observed",
    observedMode: row.mode,
    observedAt: row.lastSeenAt,
  };
}
