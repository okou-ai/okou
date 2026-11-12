import { randomUUID } from "node:crypto";
import { normalizeBuildCommitSha } from "../../lib/build-info";
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
  | "thread_selection"
  | "followup_validation"
  | "attachments"
  | "model_capture"
  | "publication";

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
      readonly spanKind?: "parent" | "nested";
    },
  ): void {
    safeSync(() => {
      if (!this.closed) {
        this.records.push({
          actionType: `chat_enqueue_${stage}`,
          durationMs: Math.max(0, durationMs),
          timestamp: new Date(observation?.finishedAt ?? now()).toISOString(),
          success,
          dimensions: { span_kind: observation?.spanKind ?? "nested" },
        });
      }
    });
  }

  committed(finishedAt: number): void {
    this.record(
      "request_to_commit",
      finishedAt - this.requestReceivedAt,
      true,
      { finishedAt, spanKind: "parent" },
    );
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

  async observeResponse<T extends { readonly status: number }>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    // Own cancellation until the terminal batch has been enqueued, then
    // propagate the exact original response or thrown value.
    const response = await settleIncludingAbort(operation);
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
      { finishedAt, spanKind: "parent" },
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

export async function measureChatEnqueue<T>(
  timing: ChatEnqueueTimingCollector | undefined,
  stage: EnqueueStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  return timing ? await timing.measure(stage, operation) : await operation();
}
