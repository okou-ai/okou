import { randomUUID } from "node:crypto";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import {
  withPgPoolAcquisitionCapture,
  withPgQueryExecutionCapture,
  withPgOperationObserver,
  type PgPoolAcquisitionCapture,
  type PgQueryExecutionCapture,
} from "../../lib/db-instrumentation";
import { env } from "../../lib/env";
import { monotonicNow, now } from "../../lib/time";
import type { AuthTokenType } from "../../types/auth";
import { recordApiOperationTimings } from "../external/sandbox-op-log";
import { safeSync, settleIncludingAbort } from "../utils";

type EnqueueStage =
  | "route_prelude"
  | "auth"
  | "body"
  | "references"
  | "suggestion_validation"
  | "suggestion_access"
  | "mcp_attribution"
  | "context_ready"
  | "authorization"
  | "catalog_ready"
  | "model_ready"
  | "thread_selection"
  | "followup_validation"
  | "replacement_target_read"
  | "attachments"
  | "model_capture"
  | "event_prepare"
  | "publication_prepare"
  | "publication"
  | "publication_sql"
  | "private_asset_owners_batch"
  | "thread_read"
  | "source_run"
  | "org_member_read"
  | "global_model_read";

type TimingRecord = Parameters<typeof recordApiOperationTimings>[0][number];

/** One HTTP request owns these observations, including sends that create no Run. */
export class ChatEnqueueTimingCollector {
  readonly observationId = randomUUID();
  private readonly records: TimingRecord[] = [];
  private readonly authStartedAt = monotonicNow();
  private authFinished = false;
  private closed = false;
  private kind: "normal" | "recall" | "interrupt" | "unparsed" = "unparsed";
  private authType: AuthTokenType | undefined;
  private threadKind: "new" | "existing" | undefined;
  private outcome: "accepted" | "replayed" = "accepted";

  constructor(private readonly requestReceivedAt: number) {
    const startedAt = now();
    this.record("route_prelude", startedAt - requestReceivedAt, true, {
      finishedAt: startedAt,
    });
  }

  setKind(kind: typeof this.kind): void {
    this.kind = kind;
  }

  setSendContext(authType: AuthTokenType, hasThread: boolean): void {
    this.authType = authType;
    this.threadKind = hasThread ? "existing" : "new";
  }

  setOutcome(outcome: typeof this.outcome): void {
    this.outcome = outcome;
  }

  recordAuth(success: boolean): void {
    if (this.authFinished) {
      return;
    }
    this.authFinished = true;
    this.record("auth", monotonicNow() - this.authStartedAt, success);
  }

  private record(
    stage: EnqueueStage | "request_to_commit" | "request_total",
    durationMs: number,
    success: boolean,
    observation?: {
      readonly finishedAt?: number;
      readonly dimensions?: Readonly<Record<string, string | number>>;
      readonly suffix?:
        "_pool_acquire" | "_sql_call" | "_application_remainder";
    },
  ): void {
    safeSync(() => {
      // Optional early reads can settle after a rejected request. They keep
      // their original owner but cannot append to an already-published batch.
      if (!this.closed) {
        this.records.push({
          actionType: `chat_enqueue_${stage}${observation?.suffix ?? ""}`,
          durationMs: Math.max(0, durationMs),
          timestamp: new Date(observation?.finishedAt ?? now()).toISOString(),
          success,
          dimensions: { span_kind: "nested", ...observation?.dimensions },
        });
      }
    });
  }

  committed(finishedAt: number): void {
    this.record(
      "request_to_commit",
      finishedAt - this.requestReceivedAt,
      true,
      { finishedAt, dimensions: { span_kind: "parent" } },
    );
  }

  measureSync<T>(stage: EnqueueStage, operation: () => T): T {
    const startedAt = monotonicNow();
    const result = safeSync(operation);
    this.record(stage, monotonicNow() - startedAt, "ok" in result);
    if ("error" in result) {
      throw result.error;
    }
    return result.ok;
  }

  async measure<T>(
    stage: EnqueueStage,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = monotonicNow();
    let success = false;
    return await (async () => {
      const value = await operation();
      success = true;
      return value;
    })().finally(() => {
      this.record(stage, monotonicNow() - startedAt, success);
    });
  }

  async measureDatabase<T>(
    stage: EnqueueStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pool: PgPoolAcquisitionCapture = { acquisitions: [] };
    const query: PgQueryExecutionCapture = { executions: [] };
    const startedAt = monotonicNow();
    let success = false;
    return await (async () => {
      const value = await withPgPoolAcquisitionCapture(pool, async () => {
        return await withPgQueryExecutionCapture(query, operation);
      });
      success = true;
      return value;
    })().finally(() => {
      safeSync(() => {
        const durationMs = monotonicNow() - startedAt;
        const finishedAt = now();
        const dimensions = {
          db_pool_capture: captureKind(pool.acquisitions.length),
          db_query_capture: captureKind(query.executions.length),
          db_pool_acquire_count: pool.acquisitions.length,
          db_query_execution_count: query.executions.length,
        };
        this.record(stage, durationMs, success, { finishedAt, dimensions });
        const [acquisition] = pool.acquisitions;
        const [execution] = query.executions;
        if (pool.acquisitions.length === 1 && acquisition) {
          this.record(stage, acquisition.durationMs, success, {
            finishedAt: acquisition.finishedAt,
            dimensions: {
              ...dimensions,
              db_pool_acquire_path: acquisition.path,
            },
            suffix: "_pool_acquire",
          });
        }
        if (query.executions.length === 1 && execution) {
          // This is network/driver client-call wall, not server-only SQL time.
          this.record(stage, execution.durationMs, success, {
            finishedAt: execution.finishedAt,
            dimensions,
            suffix: "_sql_call",
          });
        }
        if (
          pool.acquisitions.length === 1 &&
          query.executions.length === 1 &&
          acquisition &&
          execution &&
          durationMs >= acquisition.durationMs + execution.durationMs
        ) {
          // Outside the captured PG work; this can include other I/O, not just CPU.
          this.record(
            stage,
            durationMs - acquisition.durationMs - execution.durationMs,
            success,
            { finishedAt, dimensions, suffix: "_application_remainder" },
          );
        }
      });
    });
  }

  async observeResponse<T extends { readonly status: number }>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    // Own cancellation until the terminal batch has been enqueued, then
    // propagate the exact original response or thrown value.
    const response = await settleIncludingAbort(() => {
      return withPgOperationObserver((name, read) => {
        return name === "org_member_read" || name === "global_model_read"
          ? this.measureDatabase(name, read)
          : read();
      }, operation);
    });
    await this.flush(
      response.ok ? response.value.status : undefined,
      signal.aborted,
    );
    if (!response.ok) {
      throw response.error;
    }
    return response.value;
  }

  private async flush(
    status: number | undefined,
    cancelled: boolean,
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    this.recordAuth(false);
    const finishedAt = now();
    this.record(
      "request_total",
      finishedAt - this.requestReceivedAt,
      status !== undefined && status < 400 && !cancelled,
      { finishedAt, dimensions: { span_kind: "parent" } },
    );
    this.closed = true;
    const records = this.records.splice(0);
    // The sink may throw AbortError independently of the caller's cancellation.
    // It must never replace the original response or original thrown value.
    await settleIncludingAbort(() => {
      const commit = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
      recordApiOperationTimings(
        records.map((record) => {
          return {
            ...record,
            dimensions: {
              ...record.dimensions,
              enqueue_observation_id: this.observationId,
              enqueue_kind: this.kind,
              ...(this.authType ? { enqueue_auth_type: this.authType } : {}),
              ...(this.threadKind
                ? { enqueue_thread_kind: this.threadKind }
                : {}),
              enqueue_outcome: cancelled
                ? "cancelled"
                : status === undefined || status >= 500
                  ? "error"
                  : status >= 400
                    ? "rejected"
                    : this.outcome === "replayed"
                      ? "replayed"
                      : "accepted",
              ...(status === undefined ? {} : { http_status: status }),
              ...(commit ? { api_commit_sha: commit } : {}),
            },
          };
        }),
      );
    });
  }
}

function captureKind(count: number): "missing" | "single" | "multiple" {
  return count === 0 ? "missing" : count === 1 ? "single" : "multiple";
}

export async function measureChatEnqueue<T>(
  timing: ChatEnqueueTimingCollector | undefined,
  stage: EnqueueStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  return timing ? await timing.measure(stage, operation) : await operation();
}

export async function measureChatEnqueueDatabase<T>(
  timing: ChatEnqueueTimingCollector | undefined,
  stage: EnqueueStage,
  operation: () => Promise<T>,
): Promise<T> {
  return timing
    ? await timing.measureDatabase(stage, operation)
    : await operation();
}
