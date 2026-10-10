import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { exclusiveDurationBreakdown } from "@okouai/core/exclusive-duration";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import {
  withPgPoolAcquisitionCapture,
  type PgPoolAcquisitionCapture,
  type PgPoolAcquisition,
} from "../../lib/db-instrumentation";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { monotonicNow, nowDate } from "../../lib/time";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { settleIncludingAbort } from "../utils";

export type AdmissionLockLeaf =
  | "official_workflow"
  | "thread_session"
  | "maintenance"
  | "subscription"
  | "concurrency"
  | "queue_first"
  | "persistence"
  | "maintenance_binding";

export type AdmissionAttemptOutcome =
  "pending" | "rejected" | "queue_first_claim_lost" | "rolled_back";

interface AdmissionTimingRecord {
  readonly actionType: string;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly leaf?: AdmissionLockLeaf;
  readonly poolAcquirePath?: PgPoolAcquisition["path"];
}

interface AdmissionAttemptTimingArgs {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly triggerSource?: TriggerSource;
  readonly dimensions: Readonly<Record<string, string>>;
}

const L = logger("ApiDispatchAdmissionTiming");

export class AdmissionAttemptTiming {
  private readonly startedAt: number;
  private readonly records: AdmissionTimingRecord[] = [];
  private heldStartedAt: number | undefined;
  private callbackFinishedAt: number | undefined;
  private leafDurationMs = 0;
  private finished = false;
  private transactionStartedRecorded = false;
  private readonly poolCapture: PgPoolAcquisitionCapture = {
    acquisitions: [],
  };

  constructor(
    private readonly args: AdmissionAttemptTimingArgs,
    private readonly nowMs: () => number = monotonicNow,
  ) {
    this.startedAt = this.nowMs();
  }

  transactionStarted(): void {
    // The callback starts after acquisition and BEGIN; this setup parent is
    // broader than the separately observed pool-acquisition interval.
    this.transactionStartedRecorded = true;
    this.record(
      "api_dispatch_admission_transaction_setup",
      this.nowMs() - this.startedAt,
    );
  }

  async capturePoolAcquisition<T>(operation: () => Promise<T>): Promise<T> {
    return await withPgPoolAcquisitionCapture(this.poolCapture, operation);
  }

  /**
   * Start of final admission after transaction setup and any Official credit
   * plan acquisition. No org advisory lock is taken; the existing
   * `admission_lock_*` series names are kept.
   */
  admissionStarted(): void {
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
    const [acquisition] = this.poolCapture.acquisitions;
    if (this.poolCapture.acquisitions.length === 1 && acquisition) {
      this.records.push({
        actionType: "api_dispatch_admission_pool_acquire",
        durationMs: acquisition.durationMs,
        timestamp: new Date(acquisition.finishedAt).toISOString(),
        poolAcquirePath: acquisition.path,
      });
    }
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
      // Completion spans callback finish through transaction/command return:
      // COMMIT, release and application bookkeeping, not server-only COMMIT.
      this.record("api_dispatch_admission_lock_residual", breakdown.residualMs);
      this.record("api_dispatch_admission_lock_overlap", breakdown.overlapMs);
    }

    const emission = await settleIncludingAbort(() => {
      const persisted = outcome === "pending";
      const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
      const dimensions = {
        ...this.args.dimensions,
        runner_group: this.args.runnerGroup,
        profile: this.args.profile,
        dispatch_path: "direct",
        span_kind: "nested",
        admission_outcome: outcome,
        run_persisted: persisted ? "true" : "false",
        query_count_coverage: "unavailable",
        row_count_coverage: "unavailable",
        db_pool_capture:
          this.poolCapture.acquisitions.length === 1
            ? "single"
            : this.poolCapture.acquisitions.length === 0
              ? "missing"
              : "multiple",
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
              ...(record.poolAcquirePath
                ? { db_pool_acquire_path: record.poolAcquirePath }
                : {}),
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
