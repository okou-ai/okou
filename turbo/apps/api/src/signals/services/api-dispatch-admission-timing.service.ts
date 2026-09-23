import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { exclusiveDurationBreakdown } from "@okouai/core/exclusive-duration";

import { env } from "../../lib/env";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { logger } from "../../lib/log";
import { monotonicNow, nowDate } from "../../lib/time";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { settleIncludingAbort } from "../utils";

export type AdmissionLockLeaf =
  | "official_workflow"
  | "thread_session"
  | "compute_session"
  | "maintenance"
  | "subscription"
  | "concurrency"
  | "queue_first"
  | "persistence"
  | "maintenance_binding"
  | "usage_allowance"
  | "pi_memory_schedule";

export type AdmissionAttemptOutcome =
  | "pending"
  | "queued"
  | "rejected"
  | "thread_session_snapshot_stale"
  | "queue_first_claim_lost"
  | "queue_payload_required"
  | "rolled_back";

interface AdmissionTimingRecord {
  readonly actionType: string;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly leaf?: AdmissionLockLeaf;
}

interface AdmissionAttemptTimingArgs {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly triggerSource?: TriggerSource;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly commitInvocation: number;
  readonly transactionAttempt: number;
}

const L = logger("ApiDispatchAdmissionTiming");

function boundedAttempt(attempt: number): string {
  return attempt <= 3 ? String(attempt) : "4_plus";
}

export class AdmissionAttemptTiming {
  private readonly startedAt: number;
  private readonly records: AdmissionTimingRecord[] = [];
  private heldStartedAt: number | undefined;
  private callbackFinishedAt: number | undefined;
  private leafDurationMs = 0;
  private finished = false;
  private transactionStartedRecorded = false;

  constructor(
    private readonly args: AdmissionAttemptTimingArgs,
    private readonly nowMs: () => number = monotonicNow,
  ) {
    this.startedAt = this.nowMs();
  }

  transactionStarted(): void {
    this.transactionStartedRecorded = true;
    this.record(
      "api_dispatch_admission_transaction_setup",
      this.nowMs() - this.startedAt,
    );
  }

  lockAcquired(): void {
    this.heldStartedAt = this.nowMs();
  }

  async measureLeaf<T>(
    leaf: AdmissionLockLeaf,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = this.nowMs();
    return await (async () => {
      return await operation();
    })().finally(() => {
      const durationMs = Math.max(0, this.nowMs() - startedAt);
      this.leafDurationMs += durationMs;
      this.record("api_dispatch_admission_lock_leaf", durationMs, leaf);
    });
  }

  callbackFinished(): void {
    this.callbackFinishedAt = this.nowMs();
  }

  async finish(outcome: AdmissionAttemptOutcome): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const finishedAt = this.nowMs();
    if (!this.transactionStartedRecorded) {
      this.record(
        "api_dispatch_admission_transaction_setup",
        Math.max(0, finishedAt - this.startedAt),
      );
    }
    if (this.heldStartedAt !== undefined) {
      const breakdown = exclusiveDurationBreakdown({
        startedAtMs: this.heldStartedAt,
        finishedAtMs: finishedAt,
        leafDurationMs: this.leafDurationMs,
        ...(this.callbackFinishedAt !== undefined
          ? { callbackFinishedAtMs: this.callbackFinishedAt }
          : {}),
      });
      this.record(
        "api_dispatch_admission_lock_attempt_held",
        breakdown.totalMs,
      );
      this.record(
        "api_dispatch_admission_lock_completion_tail",
        breakdown.completionMs,
      );
      this.record("api_dispatch_admission_lock_residual", breakdown.residualMs);
      this.record("api_dispatch_admission_lock_overlap", breakdown.overlapMs);
    }

    const emission = await settleIncludingAbort(() => {
      const persisted = outcome === "pending" || outcome === "queued";
      const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
      const dimensions = {
        ...this.args.dimensions,
        runner_group: this.args.runnerGroup,
        profile: this.args.profile,
        dispatch_path: "direct",
        span_kind: "nested",
        commit_invocation: boundedAttempt(this.args.commitInvocation),
        transaction_attempt: boundedAttempt(this.args.transactionAttempt),
        admission_outcome: outcome,
        run_persisted: persisted ? "true" : "false",
        query_count_coverage: "unavailable",
        row_count_coverage: "unavailable",
        ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
        ...(this.args.triggerSource
          ? { trigger_source: this.args.triggerSource }
          : {}),
      };
      recordSandboxOperations(
        this.records.map((record) => {
          return {
            sandboxType: "runner" as const,
            actionType: record.actionType,
            durationMs: record.durationMs,
            success: true,
            runId: this.args.runId,
            timestamp: record.timestamp,
            dimensions: {
              ...dimensions,
              ...(record.leaf ? { admission_leaf: record.leaf } : {}),
            },
          };
        }),
      );
    });
    if (!emission.ok) {
      L.warn("Failed to record admission attempt timing", {
        error: emission.error,
      });
    }
  }

  private record(
    actionType: string,
    durationMs: number,
    leaf?: AdmissionLockLeaf,
  ): void {
    this.records.push({
      actionType,
      durationMs,
      timestamp: nowDate().toISOString(),
      ...(leaf ? { leaf } : {}),
    });
  }
}
