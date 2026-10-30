import { performance } from "node:perf_hooks";
import type {
  PgPoolAcquisitionCapture,
  PgQueryExecutionCapture,
} from "../../lib/db-instrumentation";
import { nowDate } from "../../lib/time";
import { safeSync } from "../utils";

type ReusePhase = "holder_select" | "discovery_persist" | "holder_reselect";
type ObservationFields = Readonly<Record<string, string | number>>;

interface ReusePhaseObservation {
  readonly phase: ReusePhase;
  readonly durationMs: number;
  readonly success: boolean;
  readonly timestamp: string;
  readonly fields: ObservationFields;
}

interface RunnerReusePhaseCapture {
  readonly pool: PgPoolAcquisitionCapture;
  readonly queries: PgQueryExecutionCapture;
  readonly startedAt: number;
  success: boolean;
}

function captureKind(count: number): "missing" | "single" | "multiple" {
  return count === 0 ? "missing" : count === 1 ? "single" : "multiple";
}

/** Notification-owned observations; poll does not allocate or emit them. */
export class RunnerReusePreferenceTiming {
  private readonly observations: ReusePhaseObservation[] = [];

  start(): RunnerReusePhaseCapture {
    return {
      pool: { acquisitions: [] },
      queries: { executions: [] },
      startedAt: performance.now(),
      success: false,
    };
  }

  record(phase: ReusePhase, capture: RunnerReusePhaseCapture): void {
    // Observation bookkeeping must not replace the operation's result/error.
    safeSync(() => {
      const { pool, queries, startedAt, success } = capture;
      const durationMs = performance.now() - startedAt;
      const acquisition =
        pool.acquisitions.length === 1 ? pool.acquisitions[0] : undefined;
      const query =
        queries.executions.length === 1 ? queries.executions[0] : undefined;
      const fields: Record<string, string | number> = {
        db_pool_capture: captureKind(pool.acquisitions.length),
        db_query_capture: captureKind(queries.executions.length),
      };
      if (acquisition) {
        fields.db_pool_acquire_ms = acquisition.durationMs;
        fields.db_pool_acquire_path = acquisition.path;
      }
      if (query) {
        // This client wall includes network, server execution/locks, driver
        // decoding and scheduling. It is not server SQL time or network RTT.
        fields.db_client_call_ms = query.durationMs;
      }
      if (acquisition && query) {
        const childMs = acquisition.durationMs + query.durationMs;
        if (durationMs >= childMs) {
          // Elapsed application remainder can include scheduling, not just CPU.
          fields.application_remainder_ms = durationMs - childMs;
        }
      }
      this.observations.push({
        phase,
        durationMs,
        success,
        timestamp: nowDate().toISOString(),
        fields,
      });
    });
  }

  operations(args: {
    readonly runId: string;
    readonly dimensions: Readonly<Record<string, string>>;
  }) {
    // One initial select, one persistence call and at most one reselect. Keep
    // registration in the caller's existing post-publication batch.
    return this.observations.map((observation) => {
      return {
        sandboxType: "runner" as const,
        actionType: `runner_notification_reuse_${observation.phase}`,
        durationMs: observation.durationMs,
        success: observation.success,
        timestamp: observation.timestamp,
        runId: args.runId,
        dimensions: { ...args.dimensions, ...observation.fields },
      };
    });
  }
}
