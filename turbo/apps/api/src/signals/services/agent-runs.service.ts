import { computed, type Computed } from "ccstate";
import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
import { isOrgTier, type OrgTier } from "@okouai/api-contracts/contracts/orgs";
import {
  ALL_RUN_STATUSES,
  type ConcurrencyMemberUsage,
  type GetRunResponse,
  type QueueResponse,
  type RunStatus,
  type RunsListResponse,
} from "@okouai/api-contracts/contracts/runs";
import {
  sandboxReuseResultSchema,
  type SandboxReuseResult,
  workspaceReuseResultSchema,
  type WorkspaceReuseResult,
} from "@okouai/api-contracts/contracts/runner-primitives";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { now } from "../../lib/time";
import { readPiLangfuseServerConfig } from "../../lib/pi-langfuse-debug";
import { db$, type Db } from "../external/db";
import {
  sandboxCapacityPredicate,
  readPiInferenceLifecycle,
} from "./pi-inference-lifecycle.service";
import {
  activePaidConcurrencySlots,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const RECENT_RUNS_FOR_ETA = 10;
const PROMPT_TRUNCATE_LENGTH = 200;
const runDurationMillisecondsDecoder = zodDriverValueDecoder(
  z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .transform((value) => {
      return Number(value);
    })
    .pipe(z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)),
);
type ReadDb = Pick<Db, "select">;
type QueueItem = QueueResponse["queue"][number];
type RunningTaskItem = QueueResponse["runningTasks"][number];

type RunListResult =
  | { readonly kind: "ok"; readonly body: RunsListResponse }
  | { readonly kind: "bad-request"; readonly message: string };

interface QueuedRunRow {
  readonly id: string;
  readonly runUserId: string;
  readonly createdAt: Date;
  readonly agentName: string | null;
  readonly agentDisplayName: string | null;
  readonly prompt: string;
  readonly triggerSource: string | null;
  readonly continuedFromSessionId: string | null;
}

interface RunningRunRow {
  readonly id: string;
  readonly runUserId: string;
  readonly startedAt: Date | null;
  readonly agentName: string | null;
  readonly agentDisplayName: string | null;
}

function truncatePrompt(prompt: string): string {
  return prompt.length > PROMPT_TRUNCATE_LENGTH
    ? `${prompt.slice(0, PROMPT_TRUNCATE_LENGTH)}...`
    : prompt;
}

function effectiveConcurrencyLimit(
  baseLimit: number,
  paidSlots: number,
): number {
  const cappedBaseLimit = cappedBaseConcurrencyLimit(baseLimit);
  const displayedBaseLimit = Number.isFinite(cappedBaseLimit)
    ? cappedBaseLimit
    : baseLimit;
  return totalConcurrencyLimit({
    baseLimit: displayedBaseLimit,
    paidSlots,
  });
}

async function activeMemberUsage(
  db: ReadDb,
  orgId: string,
): Promise<ConcurrencyMemberUsage[]> {
  const staleThreshold = new Date(now() - PENDING_RUN_TTL_MS);
  const active = count();
  const rows = await db
    .select({
      userId: agentRuns.userId,
      name: userCache.name,
      email: userCache.email,
      active,
    })
    .from(agentRuns)
    .leftJoin(userCache, eq(agentRuns.userId, userCache.userId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        sandboxCapacityPredicate(db, orgId, staleThreshold),
      ),
    )
    .groupBy(agentRuns.userId, userCache.name, userCache.email)
    .orderBy(desc(active), asc(agentRuns.userId));

  return rows.map((row) => {
    return {
      userId: row.userId,
      displayName: row.name?.trim() || row.email || "unknown",
      active: Number(row.active),
    };
  });
}

function queuedRunRows(db: ReadDb, orgId: string): Promise<QueuedRunRow[]> {
  return db
    .select({
      id: agentRuns.id,
      runUserId: agentRuns.userId,
      createdAt: agentRuns.createdAt,
      agentName: agents.name,
      agentDisplayName: agents.displayName,
      prompt: agentRuns.prompt,
      triggerSource: agentRuns.triggerSource,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
    })
    .from(agentRuns)
    .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .leftJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "queued")))
    .orderBy(asc(agentRuns.createdAt));
}

function runningRunRows(db: ReadDb, orgId: string): Promise<RunningRunRow[]> {
  return db
    .select({
      id: agentRuns.id,
      runUserId: agentRuns.userId,
      startedAt: agentRuns.startedAt,
      agentName: agents.name,
      agentDisplayName: agents.displayName,
    })
    .from(agentRuns)
    .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .leftJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "running")))
    .orderBy(asc(agentRuns.startedAt));
}

async function estimatedTimePerRun(
  db: ReadDb,
  orgId: string,
): Promise<number | null> {
  const recentRuns = db
    .select({
      durationMs:
        sql`EXTRACT(EPOCH FROM (${agentRuns.completedAt} - ${agentRuns.startedAt})) * 1000`
          .mapWith(runDurationMillisecondsDecoder)
          .as("duration_ms"),
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "completed"),
        isNotNull(agentRuns.completedAt),
        isNotNull(agentRuns.startedAt),
      ),
    )
    .orderBy(desc(agentRuns.completedAt))
    .limit(RECENT_RUNS_FOR_ETA)
    .as("recent_runs");
  const [etaResult] = await db
    .select({
      avgMs: avg(recentRuns.durationMs).mapWith(
        nullableDriverValueDecoder(runDurationMillisecondsDecoder),
      ),
    })
    .from(recentRuns);
  const averageMs = etaResult?.avgMs;
  return averageMs === null || averageMs === undefined
    ? null
    : Math.round(averageMs);
}

async function userEmailMap(
  db: ReadDb,
  queuedRuns: readonly QueuedRunRow[],
  runningRuns: readonly RunningRunRow[],
): Promise<ReadonlyMap<string, string>> {
  const userIds = [
    ...new Set([
      ...queuedRuns.map((run) => {
        return run.runUserId;
      }),
      ...runningRuns.map((run) => {
        return run.runUserId;
      }),
    ]),
  ];
  const rows =
    userIds.length > 0
      ? await db
          .select({ userId: userCache.userId, email: userCache.email })
          .from(userCache)
          .where(inArray(userCache.userId, userIds))
      : [];
  return new Map(
    rows.map((row) => {
      return [row.userId, row.email] as const;
    }),
  );
}

function queueItem(
  run: QueuedRunRow,
  index: number,
  userId: string,
  emails: ReadonlyMap<string, string>,
): QueueItem {
  const isOwner = run.runUserId === userId;
  const triggerSource =
    run.triggerSource === null
      ? null
      : triggerSourceSchema.parse(run.triggerSource);
  return {
    position: index + 1,
    agentName: isOwner ? (run.agentName ?? "unknown") : null,
    agentDisplayName: isOwner ? (run.agentDisplayName ?? null) : null,
    userEmail: isOwner ? (emails.get(run.runUserId) ?? "unknown") : null,
    createdAt: run.createdAt.toISOString(),
    isOwner,
    runId: isOwner ? run.id : null,
    prompt: isOwner ? truncatePrompt(run.prompt) : null,
    triggerSource: isOwner ? triggerSource : null,
    sessionLink:
      isOwner && run.continuedFromSessionId
        ? `/chat/${run.continuedFromSessionId}`
        : null,
  };
}

function runningTaskItem(
  run: RunningRunRow,
  userId: string,
  emails: ReadonlyMap<string, string>,
): RunningTaskItem {
  const isOwner = run.runUserId === userId;
  return {
    runId: isOwner ? run.id : null,
    agentName: run.agentName ?? "unknown",
    agentDisplayName: run.agentDisplayName ?? null,
    userEmail: emails.get(run.runUserId) ?? "unknown",
    startedAt: run.startedAt?.toISOString() ?? null,
    isOwner,
  };
}

export function agentRunById(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<GetRunResponse | null>> {
  return computed(async (get): Promise<GetRunResponse | null> => {
    const [run] = await get(db$)
      .select({
        id: agentRuns.id,
        launchSnapshot: agentRuns.launchSnapshot,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        vars: agentRuns.vars,
        sandboxId: agentRuns.sandboxId,
        result: agentRuns.result,
        error: agentRuns.error,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        langfuseTraceEnabled: agentRuns.langfuseTraceEnabled,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!run) {
      return null;
    }

    await readPiInferenceLifecycle(get(db$), run.id, run.launchSnapshot);

    const langfuseConfig = run.langfuseTraceEnabled
      ? readPiLangfuseServerConfig()
      : undefined;
    return {
      runId: run.id,
      status: run.status as RunStatus,
      prompt: run.prompt,
      appendSystemPrompt: run.appendSystemPrompt,
      vars:
        run.vars === null ? undefined : (run.vars as Record<string, string>),
      sandboxId: run.sandboxId || undefined,
      result:
        run.result === null
          ? undefined
          : (run.result as GetRunResponse["result"]),
      error: run.error || undefined,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      ...(langfuseConfig
        ? {
            langfuseTraceUrl: `${langfuseConfig.baseUrl}/project/${encodeURIComponent(langfuseConfig.projectId)}/traces/${run.id.replaceAll("-", "")}`,
          }
        : {}),
    };
  });
}

export function agentRunList(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}): Computed<Promise<RunListResult>> {
  return computed(async (get): Promise<RunListResult> => {
    const statusValues = args.status
      ? args.status.split(",").map((status) => {
          return status.trim();
        })
      : ["queued", "pending", "running"];

    for (const status of statusValues) {
      if (!ALL_RUN_STATUSES.includes(status as RunStatus)) {
        return {
          kind: "bad-request",
          message: `Invalid status: ${status}. Valid values: ${ALL_RUN_STATUSES.join(", ")}`,
        };
      }
    }

    const conditions = [
      eq(agentRuns.userId, args.userId),
      eq(agentRuns.orgId, args.orgId),
      inArray(agentRuns.status, statusValues as RunStatus[]),
    ];

    if (args.agent) {
      conditions.push(eq(agents.name, args.agent));
    }

    if (args.since) {
      const sinceDate = new Date(args.since);
      if (Number.isNaN(sinceDate.getTime())) {
        return {
          kind: "bad-request",
          message: "Invalid since timestamp format",
        };
      }
      conditions.push(gte(agentRuns.createdAt, sinceDate));
    }

    if (args.until) {
      const untilDate = new Date(args.until);
      if (Number.isNaN(untilDate.getTime())) {
        return {
          kind: "bad-request",
          message: "Invalid until timestamp format",
        };
      }
      conditions.push(lte(agentRuns.createdAt, untilDate));
    }

    const rows = await get(db$)
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        composeName: agents.name,
      })
      .from(agentRuns)
      .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .leftJoin(agents, eq(agentSessions.agentId, agents.id))
      .where(and(...conditions))
      .orderBy(desc(agentRuns.createdAt))
      .limit(args.limit);

    return {
      kind: "ok",
      body: {
        runs: rows.map((run) => {
          return {
            id: run.id,
            agentName: run.composeName ?? "unknown",
            status: run.status as RunStatus,
            prompt: run.prompt,
            appendSystemPrompt: run.appendSystemPrompt,
            createdAt: run.createdAt.toISOString(),
            startedAt: run.startedAt?.toISOString() ?? null,
          };
        }),
      },
    };
  });
}

export function agentRunRunner(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): Computed<
  Promise<{
    readonly sandboxReuseResult: SandboxReuseResult | null;
    readonly workspaceReuseResult: WorkspaceReuseResult | null;
    readonly runnerHostname: string | null;
    readonly runnerVersion: string | null;
    readonly runnerId: string | null;
    readonly runnerHeartbeatGeneration: number | null;
  } | null>
> {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select({
        sandboxReuseResult: agentRuns.sandboxReuseResult,
        workspaceReuseResult: agentRuns.workspaceReuseResult,
        runnerHostname: agentRuns.runnerHostname,
        runnerVersion: agentRuns.runnerVersion,
        runnerId: agentRuns.runnerId,
        runnerHeartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    const sandboxResult = sandboxReuseResultSchema.safeParse(
      row.sandboxReuseResult,
    );
    const workspaceResult = workspaceReuseResultSchema.safeParse(
      row.workspaceReuseResult,
    );
    return {
      sandboxReuseResult: sandboxResult.success ? sandboxResult.data : null,
      workspaceReuseResult: workspaceResult.success
        ? workspaceResult.data
        : null,
      runnerHostname: row.runnerHostname,
      runnerVersion: row.runnerVersion,
      runnerId: row.runnerId,
      runnerHeartbeatGeneration: row.runnerHeartbeatGeneration,
    };
  });
}

export function organizationTier(orgId: string): Computed<Promise<OrgTier>> {
  return computed(async (get): Promise<OrgTier> => {
    const [row] = await get(db$)
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    if (isOrgTier(row?.tier)) {
      return row.tier;
    }
    return "pro-suspend";
  });
}

export function agentRunQueueStatus(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly orgTier: OrgTier;
}): Computed<Promise<QueueResponse>> {
  return computed(async (get): Promise<QueueResponse> => {
    const db = get(db$);
    const [
      memberUsage,
      queuedRuns,
      runningRuns,
      estimatedTime,
      paidSlots,
      capabilities,
    ] = await Promise.all([
      activeMemberUsage(db, args.orgId),
      queuedRunRows(db, args.orgId),
      runningRunRows(db, args.orgId),
      estimatedTimePerRun(db, args.orgId),
      activePaidConcurrencySlots(db, args.orgId),
      loadOrgPlanCapabilities(db, args.orgId),
    ]);
    const limit = effectiveConcurrencyLimit(
      capabilities?.baseConcurrencyLimit ?? 0,
      paidSlots,
    );
    const active = memberUsage.reduce((total, member) => {
      return total + member.active;
    }, 0);
    const emails = await userEmailMap(db, queuedRuns, runningRuns);

    return {
      concurrency: {
        tier: args.orgTier,
        limit,
        active,
        available: limit === 0 ? -1 : Math.max(0, limit - active),
        memberUsage,
      },
      queue: queuedRuns.map((run, index) => {
        return queueItem(run, index, args.userId, emails);
      }),
      runningTasks: runningRuns.map((run) => {
        return runningTaskItem(run, args.userId, emails);
      }),
      estimatedTimePerRun: estimatedTime,
    };
  });
}
