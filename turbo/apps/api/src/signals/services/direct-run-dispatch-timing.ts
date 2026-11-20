import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import {
  withPgPoolAcquisitionCapture,
  withPgQueryExecutionCapture,
  type PgPoolAcquisitionCapture,
  type PgQueryExecutionCapture,
} from "../../lib/db-instrumentation";
import { env } from "../../lib/env";
import { monotonicNow, now } from "../../lib/time";
import type { postRunnerDispatch } from "../external/runner-ingress";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { safeSync } from "../utils";
import type { DirectRunTarget } from "./direct-run-ownership.service";

type AttemptKind = "first" | "retry" | "reroute";
type PreflightOutcome =
  | "interrupted"
  | "body-too-large"
  | "owner-not-selected"
  | "stopped"
  | "expired"
  | "post-started";

export class DispatchQueryTiming {
  private readonly pool: PgPoolAcquisitionCapture = { acquisitions: [] };
  private readonly client: PgQueryExecutionCapture = { executions: [] };
  private elapsedMs: number | undefined;

  async measure<T>(query: () => Promise<T>): Promise<T> {
    const started = monotonicNow();
    return await withPgPoolAcquisitionCapture(this.pool, () => {
      return withPgQueryExecutionCapture(this.client, query);
    }).finally(() => {
      this.elapsedMs = monotonicNow() - started;
    });
  }

  fields(prefix: "owner_assignment" | "state_read") {
    const acquisition = this.pool.acquisitions.at(0);
    const call = this.client.executions.at(0);
    return {
      [`${prefix}_ms`]: this.elapsedMs,
      ...(this.pool.acquisitions.length === 1 && acquisition
        ? {
            [`${prefix}_pool_acquire_ms`]: acquisition.durationMs,
            [`${prefix}_pool_acquire_path`]: acquisition.path,
          }
        : {}),
      ...(this.client.executions.length === 1 && call
        ? { [`${prefix}_client_call_ms`]: call.durationMs }
        : {}),
    };
  }
}

class DispatchAttemptTiming {
  readonly stateRead = new DispatchQueryTiming();
  ownerAssignment?: DispatchQueryTiming;
  snapshotMs?: number;
  postOutcome?: Awaited<ReturnType<typeof postRunnerDispatch>>;
  private readonly startedAt = now();
  private readonly started = monotonicNow();
  private postStartedAt?: number;
  private elapsedMs?: number;
  private outcome: PreflightOutcome = "interrupted";

  constructor(
    readonly ordinal: number,
    readonly kind: AttemptKind,
    readonly target: Pick<DirectRunTarget, "runnerId" | "heartbeatGeneration">,
  ) {}

  finish(outcome: PreflightOutcome): void {
    this.outcome = outcome;
    this.elapsedMs = monotonicNow() - this.started;
    if (outcome === "post-started") {
      this.postStartedAt = now();
    }
  }

  operation(runId: string, finished: number, aborted: boolean) {
    return {
      sandboxType: "runner" as const,
      actionType: "api_dispatch_runner_preflight",
      durationMs: this.elapsedMs ?? finished - this.started,
      success: this.outcome === "post-started",
      timestamp: new Date(this.startedAt).toISOString(),
      runId,
      dimensions: {
        api_version: getBuildVersion(),
        api_commit_sha:
          normalizeBuildCommitSha(env("GIT_COMMIT_SHA")) ?? undefined,
        dispatch_attempt_ordinal: this.ordinal,
        dispatch_attempt_kind: this.kind,
        runner_id: this.target.runnerId,
        heartbeat_generation: this.target.heartbeatGeneration,
        preflight_outcome: this.outcome,
        post_started_at_unix_ms: this.postStartedAt,
        dispatch_outcome:
          this.postStartedAt === undefined
            ? undefined
            : (this.postOutcome ?? (aborted ? "aborted" : "error")),
        context_snapshot_ms: this.snapshotMs,
        ...this.ownerAssignment?.fields("owner_assignment"),
        ...this.stateRead.fields("state_read"),
      },
    };
  }
}

export class DirectRunDispatchTiming {
  private readonly attempts: DispatchAttemptTiming[] = [];

  start(
    target: Pick<DirectRunTarget, "runnerId" | "heartbeatGeneration">,
    kind: AttemptKind,
  ): DispatchAttemptTiming {
    const attempt = new DispatchAttemptTiming(
      this.attempts.length + 1,
      kind,
      target,
    );
    this.attempts.push(attempt);
    return attempt;
  }

  record(runId: string, aborted: boolean): void {
    safeSync(() => {
      const finished = monotonicNow();
      recordSandboxOperations(
        this.attempts.map((attempt) => {
          return attempt.operation(runId, finished, aborted);
        }),
      );
    });
  }
}
