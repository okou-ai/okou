import { computed, type Computed } from "ccstate";
import { publicRunFailureReason } from "../../lib/run-failure";
import {
  triggerSourceSchema,
  type LogDetail,
  type LogEntry,
  type LogStatus,
  type LogsFilters,
  type TriggerSource,
} from "@okouai/api-contracts/contracts/logs";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-provider-types";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  and,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";

import { db$ } from "../external/db";
import { logDetailRunSelection } from "./log-detail-run-selection";
import { runContextObservation } from "./run-context-observation.service";
import { tapError } from "../utils";

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
  since?: number;
  status?: LogStatus;
  triggerSource?: TriggerSource;
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

function logsListRunSelection() {
  return {
    id: agentRuns.id,
    status: agentRuns.status,
    prompt: agentRuns.prompt,
    createdAt: agentRuns.createdAt,
    startedAt: agentRuns.startedAt,
    completedAt: agentRuns.completedAt,
    triggerSource: agentRuns.triggerSource,
    launchSnapshot: agentRuns.launchSnapshot,
    cliAgentSessionId: agentRuns.frameworkSessionId,
  };
}

function toLogsFilters(
  statusRows: readonly Pick<typeof agentRuns.$inferSelect, "status">[],
  sourceRows: readonly Pick<typeof agentRuns.$inferSelect, "triggerSource">[],
): LogsFilters {
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

  return { statuses, sources, agents: [] };
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
        .select(logsListRunSelection())
        .from(agentRuns)
        .where(whereClause)
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(limit + 1),
      (async (): Promise<number> => {
        const conditions: SQL[] = [
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ];

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
          .where(and(...conditions));

        return result?.count ?? 0;
      })(),
      (async (userId: string, orgId: string): Promise<LogsFilters> => {
        const baseConditions = [
          eq(agentRuns.userId, userId),
          eq(agentRuns.orgId, orgId),
        ];

        const [statusRows, sourceRows] = await Promise.all([
          db
            .selectDistinct({ status: agentRuns.status })
            .from(agentRuns)
            .where(and(...baseConditions)),
          db
            .selectDistinct({ triggerSource: agentRuns.triggerSource })
            .from(agentRuns)
            .where(and(...baseConditions, isNotNull(agentRuns.triggerSource))),
        ]);

        return toLogsFilters(statusRows, sourceRows);
      })(params.userId, params.orgId),
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
          agentId: null,
          displayName: null,
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

interface LogDetailParams {
  runId: string;
  userId: string;
  orgId: string;
}

export function logDetail(
  params: LogDetailParams,
): Computed<Promise<LogDetail | null>> {
  const detail$ = computed(async (get) => {
    const db = get(db$);

    const [result] = await db
      .select({
        run: logDetailRunSelection(),
        triggerSource: agentRuns.triggerSource,
        modelProvider: agentRuns.modelProvider,
        selectedModel: agentRuns.selectedModel,
        modelRuntimeProvider: agentRuns.modelRuntimeProvider,
        modelRuntimeModel: agentRuns.modelRuntimeModel,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);

    return result ?? null;
  });
  const run$ = computed(async (get) => {
    return (await get(detail$))?.run ?? null;
  });
  const snapshot$ = runContextObservation({ runId: params.runId, run: run$ });

  return computed(async (get): Promise<LogDetail | null> => {
    const result = await get(detail$);
    if (!result) {
      return null;
    }

    const {
      run,
      triggerSource,
      modelProvider,
      selectedModel,
      modelRuntimeProvider,
      modelRuntimeModel,
    } = result;
    const snapshot = await tapError(get(snapshot$));
    const framework =
      snapshot?.cliAgentType ?? run.launchSnapshot?.framework ?? null;

    return {
      id: run.id,
      sessionId: run.frameworkSessionId,
      agentId: null,
      displayName: null,
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
      appendSystemPrompt: snapshot?.appendSystemPrompt ?? null,
      failureReason: publicRunFailureReason(
        run.status,
        run.failureReason,
        modelProvider,
      ),
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  });
}
