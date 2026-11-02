import { command } from "ccstate";
import { runBuiltInAdmissions } from "@okouai/db/schema/run-built-in-admission";
import { and, eq, sql } from "drizzle-orm";
import { discriminatedUnion, literal, object, uuid } from "zod";

import { writeDb$ } from "../external/db";
import { nowDate, nowDateSql } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { settle } from "../utils";

const RUN_BUILT_IN_MAX_IN_FLIGHT = 3;
const RUN_BUILT_IN_MAX_STARTED = 50;
const RUN_BUILT_IN_ADMISSION_TTL_MS = 30 * 60 * 1000;

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
  RunBuiltInAdmission | RunBuiltInAdmissionError | null;

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

const admissionRowSchema = object({
  result: discriminatedUnion("outcome", [
    object({ outcome: literal("admitted"), id: uuid() }),
    object({ outcome: literal("concurrency_limit") }),
    object({ outcome: literal("usage_limit") }),
  ]),
});

export const startRunBuiltInAdmission$ = command(
  async (
    { set },
    args: {
      readonly runId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<RunBuiltInAdmissionResult> => {
    if (!args.runId) {
      return null;
    }
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const query = sql`SELECT public.start_run_built_in_admission(
      ${args.runId}::uuid, ${nowDateSql(sql`NULL::timestamp`)},
      ${RUN_BUILT_IN_MAX_IN_FLIGHT}, ${RUN_BUILT_IN_MAX_STARTED},
      ${RUN_BUILT_IN_ADMISSION_TTL_MS}
    ) AS result`;
    const rowSchema = admissionRowSchema;
    let postCommitAbort = false;
    const execution = await settle(
      (async () => {
        return parseRawRows(rowSchema, await writeDb.execute(query));
      })(),
    );
    if (signal.aborted) {
      postCommitAbort = true;
    }
    if (!execution.ok) {
      throw new Error(
        `Run built-in admission SQL execution failed (${safeSqlStateCode(execution.error) ?? "unknown"})`,
      );
    }
    const [row] = execution.value;
    if (!row) {
      throw new Error("Run built-in admission returned no outcome");
    }
    const result = row.result;
    if (postCommitAbort) {
      // The submitted atomic attempt has committed. Release its concurrency
      // slot before reporting cancellation; retain the attempted-start count.
      if (result.outcome === "admitted") {
        await set(completeRunBuiltInAdmission$, {
          admission: { id: result.id },
          status: "failed",
        });
      }
      signal.throwIfAborted();
    }
    if (result.outcome === "concurrency_limit") {
      return runConcurrencyLimit();
    }
    if (result.outcome === "usage_limit") {
      return runUsageLimit();
    }
    return { id: result.id };
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
