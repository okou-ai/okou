import { computed, type Computed } from "ccstate";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import {
  runStatusSchema,
  type AgentEventsResponse,
  type NetworkLogsResponse,
  type RunEvent,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq } from "drizzle-orm";

import { db$, type Db } from "../external/db";
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

type ServiceDb = Pick<Db, "select">;

const RUN_CONTEXT_QUERY_PADDING_MS = 60 * 60 * 1000;

async function verifyRunOwnership(
  db: ServiceDb,
  runId: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
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
}

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

    const owned = await verifyRunOwnership(db, runId, userId, orgId);
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
        volumes: normalizedSnapshot.volumes,
        artifact: normalizedSnapshot.artifact,
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

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

function publicAgentEventData(
  eventData: Record<string, unknown>,
): Record<string, unknown> {
  const { memoryCitation: _citation, ...event } = eventData;
  const message =
    typeof event.message === "object" && event.message !== null
      ? (event.message as Record<string, unknown>)
      : null;
  const content = message?.content;
  const publicMessage = message
    ? {
        ...Object.fromEntries(
          Object.entries(message).filter(([key]) => {
            return key !== "memoryCitation";
          }),
        ),
        ...(Array.isArray(content)
          ? {
              content: content.map((block) => {
                if (typeof block !== "object" || block === null) {
                  return block;
                }
                const record = block as Record<string, unknown>;
                if (record.type === "text" && typeof record.text === "string") {
                  return {
                    ...record,
                    text: visiblePiMemoryCitationText(record.text),
                  };
                }
                return block;
              }),
            }
          : {}),
      }
    : null;
  const nested =
    typeof event.eventData === "object" && event.eventData !== null
      ? (event.eventData as Record<string, unknown>)
      : null;
  return {
    ...event,
    ...(publicMessage ? { message: publicMessage } : {}),
    ...(typeof event.result === "string"
      ? { result: visiblePiMemoryCitationText(event.result) }
      : {}),
    ...(nested && typeof nested.result === "string"
      ? {
          eventData: {
            ...nested,
            result: visiblePiMemoryCitationText(nested.result),
          },
        }
      : {}),
  };
}

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
    const paginationFilter = buildAgentEventPaginationFilters(params);
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
| where _time >= datetime("${run.createdAt.toISOString()}")
${paginationFilter}
| order by sequenceNumber ${order}
| limit ${limit + 1}`;

    const events = (
      await get(queryAxiom<AxiomAgentEvent>(apl, { noCache: true }))
    ).slice();

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
          eventData: publicAgentEventData(
            publicBuiltInBalanceEvent(
              e.eventData,
              run.modelProvider,
              e.eventType,
            ),
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
