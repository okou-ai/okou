import { command } from "ccstate";
import { runBuiltInAdmissions } from "@okouai/db/schema/run-built-in-admission";
import { and, count, eq, lte, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";

const RUN_BUILT_IN_MAX_IN_FLIGHT = 3;
const RUN_BUILT_IN_MAX_STARTED = 50;
const RUN_BUILT_IN_ADMISSION_TTL_MS = 30 * 60 * 1000;

type RunBuiltInGenerationKind =
  | "image"
  | "video"
  | "presentation"
  | "website"
  | "voice";

export interface RunBuiltInAdmission {
  readonly id: string;
}

interface RunBuiltInAdmissionErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

type RunBuiltInAdmissionError = {
  readonly status: 429;
  readonly body: RunBuiltInAdmissionErrorBody;
};

type RunBuiltInAdmissionResult =
  | RunBuiltInAdmission
  | RunBuiltInAdmissionError
  | null;

export function isRunBuiltInAdmissionError(
  result: RunBuiltInAdmissionResult,
): result is RunBuiltInAdmissionError {
  return result !== null && "status" in result;
}

function runConcurrencyLimit(): RunBuiltInAdmissionError {
  return {
    status: 429,
    body: {
      error: {
        message: `This run already has ${String(RUN_BUILT_IN_MAX_IN_FLIGHT)} built-in generations in progress, which is the limit. Keep at most ${String(RUN_BUILT_IN_MAX_IN_FLIGHT)} in flight and start the next one only after an earlier one finishes.`,
        code: "BUILT_IN_RUN_CONCURRENCY_LIMIT",
      },
    },
  };
}

function runUsageLimit(): RunBuiltInAdmissionError {
  return {
    status: 429,
    body: {
      error: {
        message:
          "This run has reached the built-in generation limit. Start a new run to continue.",
        code: "BUILT_IN_RUN_USAGE_LIMIT",
      },
    },
  };
}

export const startRunBuiltInAdmission$ = command(
  async (
    { set },
    args: {
      readonly runId: string | undefined;
      readonly kind: RunBuiltInGenerationKind;
    },
    signal: AbortSignal,
  ): Promise<RunBuiltInAdmissionResult> => {
    if (!args.runId) {
      return null;
    }

    const runId = args.runId;
    const writeDb = set(writeDb$);
    return await writeDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('run_builtin_' || ${runId}))`,
      );

      const now = nowDate();
      await tx
        .update(runBuiltInAdmissions)
        .set({ status: "expired", completedAt: now, updatedAt: now })
        .where(
          and(
            eq(runBuiltInAdmissions.runId, runId),
            eq(runBuiltInAdmissions.status, "active"),
            lte(runBuiltInAdmissions.expiresAt, now),
          ),
        );

      const [activeResult] = await tx
        .select({ total: count() })
        .from(runBuiltInAdmissions)
        .where(
          and(
            eq(runBuiltInAdmissions.runId, runId),
            eq(runBuiltInAdmissions.status, "active"),
          ),
        );
      signal.throwIfAborted();
      if (Number(activeResult?.total ?? 0) >= RUN_BUILT_IN_MAX_IN_FLIGHT) {
        return runConcurrencyLimit();
      }

      const [startedResult] = await tx
        .select({ total: count() })
        .from(runBuiltInAdmissions)
        .where(eq(runBuiltInAdmissions.runId, runId));
      signal.throwIfAborted();
      if (Number(startedResult?.total ?? 0) >= RUN_BUILT_IN_MAX_STARTED) {
        return runUsageLimit();
      }

      const expiresAt = new Date(now.getTime() + RUN_BUILT_IN_ADMISSION_TTL_MS);
      const [row] = await tx
        .insert(runBuiltInAdmissions)
        .values({
          runId,
          kind: args.kind,
          status: "active",
          expiresAt,
        })
        .returning({ id: runBuiltInAdmissions.id });
      signal.throwIfAborted();
      if (!row) {
        throw new Error("run built-in admission insert returned no row");
      }

      return row;
    });
  },
);

export const completeRunBuiltInAdmission$ = command(
  async (
    { set },
    args: {
      readonly admission: RunBuiltInAdmission | null;
      readonly status: "completed" | "failed";
    },
  ): Promise<void> => {
    if (!args.admission) {
      return;
    }

    const now = nowDate();
    await set(writeDb$)
      .update(runBuiltInAdmissions)
      .set({
        status: args.status,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(runBuiltInAdmissions.id, args.admission.id),
          eq(runBuiltInAdmissions.status, "active"),
        ),
      );
  },
);
