import { computed, type Computed } from "ccstate";
import { formatRunBalanceError } from "@okouai/api-contracts/contracts/run-balance-errors";
import {
  triggerSourceSchema,
  type LogDetail,
  type LogEntry,
  type LogStatus,
  type LogsFilters,
  type TriggerSource,
} from "@okouai/api-contracts/contracts/logs";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { conversations } from "@okouai/db/schema/conversation";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";

import { db$, type Db } from "../external/db";
import { logDetailRunSelection } from "./log-detail-run-selection";
import { runContextCliAgentType } from "./run-context-framework.service";

type ServiceDb = Pick<Db, "select" | "selectDistinct">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeTriggerSource(
  source: string | null | undefined,
): TriggerSource | null {
  const parsed = triggerSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

function buildCursorCondition(cursor: string): SQL | null {
  const separatorIndex = cursor.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex >= cursor.length - 1) {
    return null;
  }

  const cursorTime = cursor.slice(0, separatorIndex);
  const cursorId = cursor.slice(separatorIndex + 1);
  const cursorDate = new Date(cursorTime);
  if (!Number.isFinite(cursorDate.getTime()) || !UUID_PATTERN.test(cursorId)) {
    return null;
  }

  return or(
    lt(agentRuns.createdAt, cursorDate),
    and(eq(agentRuns.createdAt, cursorDate), lt(agentRuns.id, cursorId)),
  )!;
}

interface LogsListParams {
  userId: string;
  orgId: string;
  cursor?: string;
  limit?: number;
  search?: string;
  agentId?: string;
  name?: string;
  since?: number;
  status?: LogStatus;
  triggerSource?: TriggerSource;
}

function buildAgentFilterConditions(params: {
  agentId?: string;
  name?: string;
  search?: string;
}): SQL[] {
  const conditions: SQL[] = [];

  if (params.agentId) {
    conditions.push(eq(agents.id, params.agentId));
  } else if (params.name) {
    conditions.push(eq(agents.name, params.name));
  } else if (params.search) {
    conditions.push(ilike(agents.name, `%${params.search}%`));
  }

  return conditions;
}

interface LogsListData {
  data: LogEntry[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    totalPages: number;
  };
  filters: LogsFilters;
}

export function logsList(
  params: LogsListParams,
): Computed<Promise<LogsListData>> {
  return computed(async (get): Promise<LogsListData> => {
    const db = get(db$);
    const limit = params.limit ?? 20;

    const conditions: SQL[] = [
      eq(agentRuns.userId, params.userId),
      eq(agentRuns.orgId, params.orgId),
    ];

    if (params.cursor) {
      const cursorCondition = buildCursorCondition(params.cursor);
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    conditions.push(...buildAgentFilterConditions(params));

    if (params.since !== undefined) {
      conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
    }
    if (params.status) {
      conditions.push(eq(agentRuns.status, params.status));
    }
    if (params.triggerSource) {
      conditions.push(eq(agentRuns.triggerSource, params.triggerSource));
    }

    const whereClause = and(...conditions);

    // Main query, count, and filters in parallel
    const [rows, totalCount, filters] = await Promise.all([
      db
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          prompt: agentRuns.prompt,
          createdAt: agentRuns.createdAt,
          startedAt: agentRuns.startedAt,
          completedAt: agentRuns.completedAt,
          triggerSource: agentRuns.triggerSource,
          agentId: agents.id,
          launchSnapshot: agentRuns.launchSnapshot,
          displayName: agents.displayName,
          cliAgentSessionId: conversations.cliAgentSessionId,
        })
        .from(agentRuns)
        .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
        .leftJoin(agents, eq(agentSessions.agentId, agents.id))
        .leftJoin(conversations, eq(agentRuns.id, conversations.runId))
        .where(whereClause)
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(limit + 1),
      getLogsTotalCount(db, params),
      getAvailableFilters(db, params.userId, params.orgId),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1]!;
      nextCursor = `${lastItem.createdAt.toISOString()}|${lastItem.id}`;
    }

    return {
      data: data.map((run) => {
        return {
          id: run.id,
          sessionId: run.cliAgentSessionId ?? null,
          agentId: run.agentId ?? null,
          displayName: run.displayName ?? null,
          framework: run.launchSnapshot?.framework ?? null,
          triggerSource: normalizeTriggerSource(run.triggerSource),
          status: run.status as LogStatus,
          prompt: run.prompt,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
        };
      }),
      pagination: {
        hasMore,
        nextCursor,
        totalPages,
      },
      filters,
    };
  });
}

async function getLogsTotalCount(
  db: ServiceDb,
  params: LogsListParams,
): Promise<number> {
  const conditions: SQL[] = [
    eq(agentRuns.userId, params.userId),
    eq(agentRuns.orgId, params.orgId),
  ];

  conditions.push(...buildAgentFilterConditions(params));

  if (params.since !== undefined) {
    conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
  }
  if (params.status) {
    conditions.push(eq(agentRuns.status, params.status));
  }
  if (params.triggerSource) {
    conditions.push(eq(agentRuns.triggerSource, params.triggerSource));
  }

  const [result] = await db
    .select({ count: count() })
    .from(agentRuns)
    .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .leftJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(and(...conditions));

  return result?.count ?? 0;
}

async function getAvailableFilters(
  db: ServiceDb,
  userId: string,
  orgId: string,
): Promise<LogsFilters> {
  const baseConditions = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
  ];

  const [statusRows, sourceRows, agentRows] = await Promise.all([
    db
      .selectDistinct({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(...baseConditions)),
    db
      .selectDistinct({ triggerSource: agentRuns.triggerSource })
      .from(agentRuns)
      .where(and(...baseConditions, isNotNull(agentRuns.triggerSource))),
    db
      .selectDistinct({ agentId: agents.id })
      .from(agentRuns)
      .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .leftJoin(agents, eq(agentSessions.agentId, agents.id))
      .where(and(...baseConditions, isNotNull(agents.id))),
  ]);

  const statuses = statusRows
    .map((r) => {
      return r.status;
    })
    .filter((s): s is LogStatus => {
      return [
        "queued",
        "pending",
        "running",
        "completed",
        "failed",
        "timeout",
        "cancelled",
      ].includes(s as string);
    });

  const sources = sourceRows
    .map((r) => {
      return r.triggerSource;
    })
    .filter((s): s is TriggerSource => {
      return triggerSourceSchema.safeParse(s).success;
    });

  const agentIds = agentRows
    .map((r) => {
      return r.agentId;
    })
    .filter((agentId): agentId is string => {
      return agentId !== null;
    });

  return { statuses, sources, agents: agentIds };
}

interface LogDetailParams {
  runId: string;
  userId: string;
  orgId: string;
}

interface RunResult {
  checkpointId?: string;
  agentSessionId?: string;
  conversationId?: string;
  artifact?: Record<string, string>;
  volumes?: Record<string, string>;
}

function extractArtifact(runResult: RunResult | null): {
  name: string | null;
  version: string | null;
} {
  if (!runResult?.artifact) {
    return { name: null, version: null };
  }

  const name = Object.keys(runResult.artifact)[0] ?? null;
  const version = name ? (runResult.artifact[name] ?? null) : null;
  return { name, version };
}

export function logDetail(
  params: LogDetailParams,
): Computed<Promise<LogDetail | null>> {
  return computed(async (get): Promise<LogDetail | null> => {
    const db = get(db$);

    const [result] = await db
      .select({
        run: logDetailRunSelection(),
        agentId: agents.id,
        agentDisplayName: agents.displayName,
        triggerSource: agentRuns.triggerSource,
        modelProvider: agentRuns.modelProvider,
        selectedModel: agentRuns.selectedModel,
        modelRuntimeProvider: agentRuns.modelRuntimeProvider,
        modelRuntimeModel: agentRuns.modelRuntimeModel,
      })
      .from(agentRuns)
      .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .leftJoin(agents, eq(agentSessions.agentId, agents.id))
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);

    if (!result) {
      return null;
    }

    const {
      run,
      agentId,
      agentDisplayName,
      triggerSource,
      modelProvider,
      selectedModel,
      modelRuntimeProvider,
      modelRuntimeModel,
    } = result;
    const runResult = run.result as RunResult | null;
    const agentSessionId = runResult?.agentSessionId ?? null;
    const framework =
      (await get(runContextCliAgentType(params.runId))) ??
      run.launchSnapshot?.framework ??
      null;

    return {
      id: run.id,
      sessionId: agentSessionId,
      agentId,
      displayName: agentDisplayName ?? null,
      framework,
      modelProvider: isBuiltInModelProviderType(modelProvider)
        ? "built-in"
        : (modelProvider ?? null),
      selectedModel: selectedModel ?? null,
      modelRuntimeProvider: modelRuntimeProvider ?? null,
      modelRuntimeModel: modelRuntimeModel ?? null,
      triggerSource: normalizeTriggerSource(triggerSource),
      status: run.status as LogStatus,
      prompt: run.prompt,
      appendSystemPrompt: run.appendSystemPrompt ?? null,
      error: run.error
        ? (formatRunBalanceError({
            failureReason: run.failureReason,
            modelProvider,
          }) ?? run.error)
        : null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      artifact: extractArtifact(runResult),
    };
  });
}
