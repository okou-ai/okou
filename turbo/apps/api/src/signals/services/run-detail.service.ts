import { computed, type Computed } from "ccstate";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import {
  runStatusSchema,
  type AgentEventsResponse,
  type NetworkLogsResponse,
  type RunEvent,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db$ } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";
import { escapeAplString } from "../../lib/axiom-apl";
import {
  buildAgentEventPaginationFilters,
  buildTimeCursorProjection,
  buildTimePaginationFilters,
  buildTimePaginationOrder,
  filterTimedAxiomRecords,
  nextSequenceCursor,
  nextTimeCursor,
  sequenceCursorValue,
  timeCursorBoundary,
} from "./log-pagination";
import { sanitizeAxiomNetworkEvents } from "./network-log-sanitizer";
import { normalizeRunContextSnapshot } from "./run-context-snapshot.service";
import {
  publicBuiltInBalanceEvent,
  publicBuiltInBalanceNetworkLog,
} from "./run-balance-presentation";

const RUN_CONTEXT_QUERY_PADDING_MS = 60 * 60 * 1000;

interface NetworkLogsParams {
  runId: string;
  userId: string;
  orgId: string;
  since?: number;
  sinceTime?: number;
  cursor?: string;
  limit: number;
  order: "asc" | "desc";
}

type RunContextResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "no-snapshot" }
  | { readonly kind: "ok"; readonly context: RunContextResponse };

export function runContext(
  runId: string,
  userId: string,
  orgId: string,
): Computed<Promise<RunContextResult>> {
  return computed(async (get): Promise<RunContextResult> => {
    const db = get(db$);

    const owned = await (async () => {
      const [run] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.userId, userId),
            eq(agentRuns.orgId, orgId),
          ),
        )
        .limit(1);
      return run !== undefined;
    })();
    if (!owned) {
      return { kind: "not-found" };
    }

    // Get run metadata for vars
    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        vars: agentRuns.vars,
        secretNames: agentRuns.secretNames,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return { kind: "not-found" };
    }

    const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (sanitizedRunId !== runId) {
      return { kind: "not-found" };
    }

    const dataset = getDatasetName("run-context");
    const apl = `['${dataset}']
| where runId == "${sanitizedRunId}"
| limit 1`;

    // The snapshot timestamp is captured immediately before the run row is
    // inserted. Pad both sides to tolerate timing skew while keeping the scan
    // bounded around this run.
    const createdAtMs = run.createdAt.getTime();
    const results = (await get(
      queryAxiom(apl, {
        // Late-ingested snapshots must not be hidden by a cached empty result.
        noCache: true,
        startTime: new Date(
          createdAtMs - RUN_CONTEXT_QUERY_PADDING_MS,
        ).toISOString(),
        endTime: new Date(
          createdAtMs + RUN_CONTEXT_QUERY_PADDING_MS,
        ).toISOString(),
      }),
    )) as Record<string, unknown>[];
    const snapshot = results[0];

    if (!snapshot) {
      return { kind: "no-snapshot" };
    }
    const normalizedSnapshot = normalizeRunContextSnapshot(snapshot);

    return {
      kind: "ok",
      context: {
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt ?? null,
        runId,
        sessionId: normalizedSnapshot.sessionId,
        cliAgentType: normalizedSnapshot.cliAgentType ?? undefined,
        secretNames: (run.secretNames as string[]) ?? [],
        vars: (run.vars as Record<string, string> | undefined) ?? null,
        environment: normalizedSnapshot.environment,
        firewalls: normalizedSnapshot.firewalls,
        networkPolicies: normalizedSnapshot.networkPolicies,
        storageMounts: normalizedSnapshot.storageMounts,
        featureFlags: normalizedSnapshot.featureFlags,
      },
    };
  });
}

interface AgentEventsParams {
  runId: string;
  userId: string;
  orgId: string;
  since?: number;
  sinceTime?: number;
  cursor?: string;
  limit: number;
  order: "asc" | "desc";
}

const axiomAgentEventSchema = z.object({
  _time: z.string(),
  sequenceNumber: z.number().int(),
  eventType: z.string(),
  eventData: z.record(z.string(), z.unknown()),
});

export function runAgentEvents(
  params: AgentEventsParams,
): Computed<Promise<AgentEventsResponse | null>> {
  return computed(async (get): Promise<AgentEventsResponse | null> => {
    const db = get(db$);

    // Verify ownership and get the run metadata needed by the Activity reader.
    const [run] = await db
      .select({
        id: agentRuns.id,
        createdAt: agentRuns.createdAt,
        status: agentRuns.status,
        lastEventSequence: agentRuns.lastEventSequence,
        modelProvider: agentRuns.modelProvider,
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

    if (!run) {
      return null;
    }

    const { limit, order } = params;
    const previousCursorValue = sequenceCursorValue(params.cursor, order);

    const dataset = getDatasetName("agent-run-events");
    const sequenceFilter = buildAgentEventPaginationFilters({
      ...params,
      sinceTime: undefined,
    });
    const timeFilter = buildTimePaginationFilters({
      sinceTime: params.sinceTime,
      order,
    });
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
| where _time >= datetime("${run.createdAt.toISOString()}")
${sequenceFilter}
| project _time, sequenceNumber, eventType, eventData
| summarize arg_min(_time, eventType, eventData) by sequenceNumber
${timeFilter}
| order by sequenceNumber ${order}
| limit ${limit + 1}`;

    const events = (
      await get(queryAxiom<unknown>(apl, { noCache: true, format: "tabular" }))
    ).map((event) => {
      return axiomAgentEventSchema.parse(event);
    });

    const pageHasMore = events.length > limit;
    const resultEvents = pageHasMore ? events.slice(0, limit) : events;
    const nextCursor = nextSequenceCursor(
      resultEvents,
      pageHasMore,
      order,
      previousCursorValue,
    );
    const hasMore = nextCursor !== null;

    return {
      events: resultEvents.map((e) => {
        return {
          sequenceNumber: e.sequenceNumber,
          eventType: e.eventType,
          eventData: publicBuiltInBalanceEvent(
            e.eventData,
            run.modelProvider,
            e.eventType,
          ),
          createdAt: e._time,
        } satisfies RunEvent;
      }),
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      status: runStatusSchema.parse(run.status),
      lastEventSequence: run.lastEventSequence,
    };
  });
}

export function runNetworkLogs(
  params: NetworkLogsParams,
): Computed<Promise<NetworkLogsResponse | null>> {
  return computed(async (get): Promise<NetworkLogsResponse | null> => {
    const db = get(db$);

    const [run] = await db
      .select({ modelProvider: agentRuns.modelProvider })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);
    if (!run) {
      return null;
    }

    const { limit, order } = params;
    const previousCursorBoundary = timeCursorBoundary(params.cursor, order);

    const dataset = getDatasetName("sandbox-telemetry-network");
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${buildTimePaginationFilters(params)}
${buildTimePaginationOrder(order)}
${buildTimeCursorProjection()}
| limit ${limit + 1}`;

    const events = (
      await get(
        queryAxiom(
          apl,
          previousCursorBoundary
            ? {
                cursor: previousCursorBoundary.tieBreaker,
                noCache: true,
              }
            : { noCache: true },
        ),
      )
    ).slice();

    const pageHasMore = events.length > limit;
    const records = pageHasMore ? events.slice(0, limit) : events;
    const networkLogs = sanitizeAxiomNetworkEvents(records).map((entry) => {
      return publicBuiltInBalanceNetworkLog(entry, run.modelProvider);
    });
    const timedRecords = filterTimedAxiomRecords(records);
    const nextCursor = nextTimeCursor(
      timedRecords,
      pageHasMore,
      order,
      previousCursorBoundary,
    );
    const hasMore = nextCursor !== null;

    return {
      networkLogs,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  });
}
