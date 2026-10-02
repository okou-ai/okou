import { z } from "zod";
import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  piMemoryStage1Days,
  piMemoryStage1Selections,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import type { ChatThreadSessionResolutionAction } from "./chat-session-continuity.service";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { nowDate } from "../../lib/time";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { getPiMemoryStage1AdmissionPrerequisiteSkipReason } from "./pi-memory-stage1-candidate.service";
import {
  pendingLaunchInsertSql,
  pendingLaunchUpdateSql,
} from "./pending-launch-sql";

interface Binding {
  readonly chatThreadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRunId: string;
  readonly action: ChatThreadSessionResolutionAction;
}
export interface PendingLaunchTailInput {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly runCreatedAt: Date;
  readonly snapshot: AgentRunLaunchSnapshot;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
  readonly bindingThreadId: string | undefined;
  readonly action: ChatThreadSessionResolutionAction | undefined;
  readonly requestMemory: boolean;
  readonly needsBinding: boolean;
  readonly binding: Binding | undefined;
}
const tailRecordSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("memory-flags"),
    userId: z.string(),
    switches: z.record(z.string(), z.boolean()),
  }),
  z.object({ phase: z.literal("memory-owner"), id: z.string() }),
  z.object({ phase: z.literal("memory-day"), requested: z.boolean() }),
  z.object({
    phase: z.literal("binding-read"),
    agentSessionId: z.string().nullable(),
  }),
]);
export const pendingLaunchTailRowSchema = z.union([
  tailRecordSchema,
  z.object({ id: z.string() }),
]);
type Record = z.output<typeof pendingLaunchTailRowSchema>;
interface TailStatement {
  readonly kind: "statement";
  readonly phase:
    | "memory-flags"
    | "memory-owner"
    | "memory-day"
    | "memory-clear"
    | "binding-read"
    | "binding-write";
  readonly sql: SQL;
  readonly previousSessionId: string | null;
}
type PendingLaunchTailProgress =
  | TailStatement
  | { readonly kind: "done"; readonly binding: Binding | undefined };

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
        : snapshot.schemaVersion === 3 && snapshot.framework === "pi",
    triggerSource: input.triggerSource,
    chatThreadId: input.chatThreadId,
    completedAt: input.runCreatedAt,
    idleDelayMs: 6 * 60 * 60 * 1000,
  });
  if (!input.requestMemory || reason || !input.chatThreadId) {
    return bindingRead(input);
  }
  return {
    kind: "statement",
    phase: "memory-flags",
    previousSessionId: null,
    sql: sql`SELECT 'memory-flags' AS phase, ${userFeatureSwitches.userId} AS "userId", ${userFeatureSwitches.switches} AS switches
      FROM ${userFeatureSwitches} WHERE ${userFeatureSwitchRowCondition(input.orgId, input.userId)}`,
  };
}

function bindingRead(input: PendingLaunchTailInput): PendingLaunchTailProgress {
  if (!input.needsBinding || !input.bindingThreadId) {
    return { kind: "done", binding: input.binding };
  }
  return {
    kind: "statement",
    phase: "binding-read",
    previousSessionId: null,
    sql: sql`SELECT 'binding-read' AS phase, ${chatThreads.agentSessionId} AS "agentSessionId" FROM ${chatThreads}
      WHERE ${eq(chatThreads.id, input.bindingThreadId)} LIMIT 1`,
  };
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
    previousSessionId: null,
    sql: sql`WITH requested AS (${insert} ON CONFLICT (${sql.identifier(piMemoryStage1Days.userId.name)}) DO UPDATE SET
      org_id = ${sql.param(input.orgId, piMemoryStage1Days.orgId)}, trigger_thread_id = ${sql.param(threadId, piMemoryStage1Days.triggerThreadId)},
      day = ${sql.param(day, piMemoryStage1Days.day)}, requested_at = ${sql.param(requestedAt, piMemoryStage1Days.requestedAt)}, consumed_at = NULL
      WHERE ${lt(piMemoryStage1Days.day, day)} RETURNING ${piMemoryStage1Days.userId})
    SELECT 'memory-day' AS phase, EXISTS (SELECT 1 FROM requested) AS requested`,
  };
}

function advanceMemoryFlags(
  input: PendingLaunchTailInput,
  rows: readonly Record[],
): PendingLaunchTailProgress {
  const flags = rows.filter((row) => {
    return "phase" in row && row.phase === "memory-flags";
  });
  const context = featureSwitchContextFromRows(
    input.orgId,
    input.userId,
    flags,
  );
  if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
    return bindingRead(input);
  }
  const threadId = input.chatThreadId;
  if (!threadId) {
    throw new Error("Memory ownership requires a captured thread");
  }
  return {
    kind: "statement",
    phase: "memory-owner",
    previousSessionId: null,
    sql: sql`SELECT 'memory-owner' AS phase, ${chatThreads.id} AS id FROM ${chatThreads}
      INNER JOIN ${agents} ON ${eq(agents.id, chatThreads.agentId)} WHERE ${and(eq(chatThreads.id, threadId), eq(chatThreads.userId, input.userId), eq(agents.orgId, input.orgId))} LIMIT 1`,
  };
}

function advanceBindingRead(
  input: PendingLaunchTailInput,
  row: Record | undefined,
): PendingLaunchTailProgress {
  if (!row) {
    throw new Error("Chat thread not found while persisting session binding");
  }
  if (!("phase" in row) || row.phase !== "binding-read") {
    throw new Error("Unexpected session binding snapshot");
  }
  const threadId = input.bindingThreadId;
  if (!threadId) {
    throw new Error("Pending session binding requires a chat thread");
  }
  return {
    kind: "statement",
    phase: "binding-write",
    previousSessionId: row.agentSessionId,
    sql: pendingLaunchUpdateSql(
      chatThreads,
      { agentSessionId: input.sessionId, agentSessionRunId: input.runId },
      eq(chatThreads.id, threadId),
      ["id"],
    ),
  };
}

export function advancePendingLaunchTail(
  input: PendingLaunchTailInput,
  step: TailStatement,
  rows: readonly Record[],
): PendingLaunchTailProgress {
  switch (step.phase) {
    case "memory-flags": {
      return advanceMemoryFlags(input, rows);
    }
    case "memory-owner": {
      return rows.length === 0 ? bindingRead(input) : requestDay(input);
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
        : bindingRead(input);
    }
    case "memory-clear": {
      return bindingRead(input);
    }
    case "binding-read": {
      return advanceBindingRead(input, rows[0]);
    }
    case "binding-write": {
      const row = rows[0];
      if (!row || "phase" in row) {
        throw new Error("Failed to persist chat thread session binding");
      }
      const action =
        input.action ??
        (step.previousSessionId === null
          ? "initialized"
          : step.previousSessionId === input.sessionId
            ? "reused"
            : "rotated");
      return {
        kind: "done",
        binding: {
          chatThreadId: row.id,
          agentSessionId: input.sessionId,
          agentSessionRunId: input.runId,
          action,
        },
      };
    }
  }
}
