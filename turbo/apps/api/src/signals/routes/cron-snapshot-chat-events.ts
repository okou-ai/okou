import { cronSnapshotChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { trace } from "@opentelemetry/api";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import type { RouteEntry } from "../route-entry";
import { snapshotChatEvents$ } from "../services/cron-snapshot-chat-events.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const CHAT_EVENT_SNAPSHOT_COMPLETION_DATASET = "web-logs";
const CHAT_EVENT_SNAPSHOT_COMPLETION_CONTEXT = "api:cron:snapshot-chat-events";

interface ChatEventSnapshotCompletionCounters {
  readonly snapshots: number;
  readonly archivedEvents: number;
  readonly selectedCandidates: number;
  readonly processedCandidates: number;
  readonly deferredCandidates: number;
  readonly skippedUnreadableHeads: number;
  readonly skippedUndecodableHeads: number;
  readonly skippedIncompleteHeads: number;
  readonly skippedFailedHeads: number;
  readonly skippedTimedOutHeads: number;
  readonly oldestCandidateAgeMs: number;
  readonly scanCursorAdvanced: boolean;
  readonly scanWrapped: boolean;
  readonly duplicateEventIdConflictThreads: number;
  readonly duplicateEventIdConflicts: number;
  readonly duplicateEventIdsRemapped: number;
  readonly duplicateEventReferencesRemapped: number;
  readonly r2ObjectsScanned: number;
  readonly r2ObjectsMeasured: number;
  readonly r2ObjectsDeleted: number;
  readonly r2BytesMeasured: number;
  readonly r2BytesDeleted: number;
  readonly r2GcShardsScanned: number;
  readonly r2GcSubpartitionedShards: number;
  readonly r2GcPagesScanned: number;
  readonly r2GcDeferred: boolean;
  readonly r2GcFailed: boolean;
  readonly r2GcCycleCompleted: boolean;
}

function recordChatEventSnapshotCompleted(
  counters: ChatEventSnapshotCompletionCounters,
): void {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  ingestToAxiom(getDatasetName(CHAT_EVENT_SNAPSHOT_COMPLETION_DATASET), [
    {
      _time: nowDate().toISOString(),
      level: "info",
      message: "Completed chat event snapshot",
      source: "api",
      type: "chat_event_snapshot_completed",
      context: CHAT_EVENT_SNAPSHOT_COMPLETION_CONTEXT,
      ...(traceId ? { trace_id: traceId } : {}),
      snapshots: counters.snapshots,
      archivedEvents: counters.archivedEvents,
      selectedCandidates: counters.selectedCandidates,
      processedCandidates: counters.processedCandidates,
      deferredCandidates: counters.deferredCandidates,
      skippedUnreadableHeads: counters.skippedUnreadableHeads,
      skippedUndecodableHeads: counters.skippedUndecodableHeads,
      skippedIncompleteHeads: counters.skippedIncompleteHeads,
      skippedFailedHeads: counters.skippedFailedHeads,
      skippedTimedOutHeads: counters.skippedTimedOutHeads,
      oldestCandidateAgeMs: counters.oldestCandidateAgeMs,
      scanCursorAdvanced: counters.scanCursorAdvanced,
      scanWrapped: counters.scanWrapped,
      duplicateEventIdConflictThreads: counters.duplicateEventIdConflictThreads,
      duplicateEventIdConflicts: counters.duplicateEventIdConflicts,
      duplicateEventIdsRemapped: counters.duplicateEventIdsRemapped,
      duplicateEventReferencesRemapped:
        counters.duplicateEventReferencesRemapped,
      r2ObjectsScanned: counters.r2ObjectsScanned,
      r2ObjectsMeasured: counters.r2ObjectsMeasured,
      r2ObjectsDeleted: counters.r2ObjectsDeleted,
      r2BytesMeasured: counters.r2BytesMeasured,
      r2BytesDeleted: counters.r2BytesDeleted,
      r2GcShardsScanned: counters.r2GcShardsScanned,
      r2GcSubpartitionedShards: counters.r2GcSubpartitionedShards,
      r2GcPagesScanned: counters.r2GcPagesScanned,
      r2GcDeferred: counters.r2GcDeferred,
      r2GcFailed: counters.r2GcFailed,
      r2GcCycleCompleted: counters.r2GcCycleCompleted,
    },
  ]);
}

const snapshotChatEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(snapshotChatEvents$, signal);
    signal.throwIfAborted();
    recordChatEventSnapshotCompleted(result);
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronSnapshotChatEventsRoutes: readonly RouteEntry[] = [
  {
    route: cronSnapshotChatEventsContract.snapshot,
    handler: snapshotChatEventsRoute$,
  },
];
