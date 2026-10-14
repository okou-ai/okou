import { z } from "zod";
import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  piMemoryStage1Days,
  piMemoryStage1Selections,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { nowDate } from "../../lib/time";
import { getPiMemoryStage1AdmissionPrerequisiteSkipReason } from "./pi-memory-stage1-admission-plan";
import { pendingLaunchInsertSql } from "./pending-launch-sql";

export interface PendingLaunchTailInput {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly runCreatedAt: Date;
  readonly snapshot: AgentRunLaunchSnapshot;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
  readonly requestMemory: boolean;
  readonly threadAgentId: string | null;
  readonly threadBindingFencesOwnership: boolean;
}
const tailRecordSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("memory-owner"), id: z.string() }),
  z.object({ phase: z.literal("memory-day"), requested: z.boolean() }),
]);
export const pendingLaunchTailRowSchema = z.union([
  tailRecordSchema,
  z.object({ id: z.string() }),
]);
type Record = z.output<typeof pendingLaunchTailRowSchema>;
interface TailStatement {
  readonly kind: "statement";
  readonly phase: "memory-owner" | "memory-day" | "memory-clear";
  readonly sql: SQL;
}
type PendingLaunchTailProgress = TailStatement | { readonly kind: "done" };

/** Only facts of the successful inserted Run are needed, not a second Run read. */
export function pendingLaunchTailStart(
  input: PendingLaunchTailInput,
): PendingLaunchTailProgress {
  const snapshot = input.snapshot;
  const reason = getPiMemoryStage1AdmissionPrerequisiteSkipReason({
    runId: input.runId,
    orgId: input.orgId,
    userId: input.userId,
    status: "completed",
    framework: snapshot.framework,
    generationEnabled:
      snapshot.schemaVersion === 2
        ? snapshot.piMemoryGenerationEnabled
        : (snapshot.schemaVersion === 3 || snapshot.schemaVersion === 5) &&
          snapshot.framework === "pi",
    triggerSource: input.triggerSource,
    chatThreadId: input.chatThreadId,
    completedAt: input.runCreatedAt,
    idleDelayMs: 6 * 60 * 60 * 1000,
  });
  if (!input.requestMemory || reason || !input.chatThreadId) {
    return { kind: "done" };
  }
  // The atomic binding CAS fences ownership before this launch can commit.
  return input.threadBindingFencesOwnership
    ? requestDay(input)
    : memoryOwner(input);
}

function requestDay(input: PendingLaunchTailInput): TailStatement {
  const threadId = input.chatThreadId;
  if (!threadId) {
    throw new Error("Memory day request requires a captured thread");
  }
  const requestedAt = nowDate();
  const day = requestedAt.toISOString().slice(0, 10);
  const insert = pendingLaunchInsertSql(piMemoryStage1Days, [
    {
      userId: input.userId,
      orgId: input.orgId,
      triggerThreadId: threadId,
      day,
      requestedAt,
    },
  ]);
  return {
    kind: "statement",
    phase: "memory-day",
    sql: sql`WITH requested AS (${insert} ON CONFLICT (${sql.identifier(piMemoryStage1Days.userId.name)}) DO UPDATE SET
      org_id = ${sql.param(input.orgId, piMemoryStage1Days.orgId)}, trigger_thread_id = ${sql.param(threadId, piMemoryStage1Days.triggerThreadId)},
      day = ${sql.param(day, piMemoryStage1Days.day)}, requested_at = ${sql.param(requestedAt, piMemoryStage1Days.requestedAt)}, consumed_at = NULL
      WHERE ${lt(piMemoryStage1Days.day, day)} RETURNING ${piMemoryStage1Days.userId})
    SELECT 'memory-day' AS phase, EXISTS (SELECT 1 FROM requested) AS requested`,
  };
}

function memoryOwner(input: PendingLaunchTailInput): PendingLaunchTailProgress {
  const threadId = input.chatThreadId;
  const agentId = input.threadAgentId;
  if (!threadId || !agentId) {
    throw new Error("Memory ownership requires a captured thread and Agent");
  }
  return {
    kind: "statement",
    phase: "memory-owner",
    sql: sql`SELECT 'memory-owner' AS phase, ${chatThreads.id} AS id FROM ${chatThreads}
      WHERE ${and(eq(chatThreads.id, threadId), eq(chatThreads.userId, input.userId), eq(chatThreads.agentId, agentId))} LIMIT 1`,
  };
}

export function advancePendingLaunchTail(
  input: PendingLaunchTailInput,
  step: TailStatement,
  rows: readonly Record[],
): PendingLaunchTailProgress {
  switch (step.phase) {
    case "memory-owner": {
      return rows.length === 0 ? { kind: "done" } : requestDay(input);
    }
    case "memory-day": {
      const row = rows[0];
      if (!row || !("phase" in row) || row.phase !== "memory-day") {
        throw new Error("Unexpected memory day publication result");
      }
      // Use the next statement's snapshot after waiting on the day row: an
      // earlier selector may have committed selections while our upsert waited.
      return row.requested
        ? {
            ...step,
            phase: "memory-clear",
            sql: sql`DELETE FROM ${piMemoryStage1Selections} WHERE ${eq(piMemoryStage1Selections.userId, input.userId)}`,
          }
        : { kind: "done" };
    }
    case "memory-clear": {
      return { kind: "done" };
    }
  }
}
