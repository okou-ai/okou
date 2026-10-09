import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { chatEventCommandResultSchema } from "./chat-event-append.service";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { runTimeBudgetEventIdForRun } from "./assistant-event-id";
import { chatEventInsertSql } from "./chat-event.service";
import { notifyRunningChatRunOfPendingInput$ } from "./chat-thread-queue-drain.service";
import { createUserMessageDocument } from "./chat-user-message.service";

const RUN_TIME_BUDGET_LIMIT_MS = 120 * 60 * 1000;
const RUN_TIME_BUDGET_REMAINING_MS = 5 * 60 * 1000;
const RUN_TIME_BUDGET_STEER_AT_MS =
  RUN_TIME_BUDGET_LIMIT_MS - RUN_TIME_BUDGET_REMAINING_MS;
/**
 * A run leaves the window as soon as the runner terminates it at the hard
 * limit, so the scan only ever sees runs inside a five-minute band.
 */
const RUN_TIME_BUDGET_SCAN_LIMIT = 100;

const RUN_TIME_BUDGET_MESSAGE = `This runner has a hard maximum runtime of 2 hours. The current run has been active for 115 minutes, leaving approximately 5 minutes before it is terminated.

A normal completion provides a reliable handoff for the next run. The handoff includes completed work, current state, verification performed, remaining work, and blockers.

Use the remaining time to leave the task in a resumable state and finish this turn normally.`;

interface RunTimeBudgetCandidate {
  readonly runId: string;
  readonly chatThreadId: string;
}

const loadRunTimeBudgetCandidates$ = command(
  async (
    { get },
    startedBefore: Date,
    signal: AbortSignal,
  ): Promise<readonly RunTimeBudgetCandidate[]> => {
    const db = get(db$);

    const rows = await db
      .select({
        runId: agentRuns.id,
        chatThreadId: chatThreads.id,
      })
      .from(agentRuns)
      .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
      .where(
        and(
          eq(agentRuns.status, "running"),
          lte(agentRuns.startedAt, startedBefore),
          isNotNull(agentRuns.triggerSource),
        ),
      )
      .orderBy(agentRuns.startedAt)
      .limit(RUN_TIME_BUDGET_SCAN_LIMIT);
    signal.throwIfAborted();
    return rows;
  },
);

/**
 * Insert the steer once per run. The event id is derived from the run id, so a
 * later scan of the same run conflicts on it instead of steering twice.
 */
const persistRunTimeBudgetInput$ = command(
  async (
    { set },
    args: {
      readonly candidate: RunTimeBudgetCandidate;
      readonly startedBefore: Date;
      readonly createdAt: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0133; new non-billing transactions are prohibited.
    const inserted = await db.transaction(async (tx) => {
      // The run row lock and running recheck serialize against completion and
      // timeout, which expire pending budget input before the run ends.
      const [run] = await tx
        .select({
          chatThreadId: agentRuns.chatThreadId,
          agentId: agents.id,
        })
        .from(agentRuns)
        .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(
          and(
            eq(agentRuns.id, args.candidate.runId),
            eq(agentRuns.status, "running"),
            eq(agentRuns.chatThreadId, args.candidate.chatThreadId),
            lte(agentRuns.startedAt, args.startedBefore),
            isNotNull(agentRuns.triggerSource),
          ),
        )
        .for("update", { of: agentRuns })
        .limit(1);
      if (!run?.chatThreadId) {
        return false;
      }

      const inserted =
        parseRawRows(
          chatEventCommandResultSchema,
          await tx.execute(
            chatEventInsertSql(
              {
                id: runTimeBudgetEventIdForRun(args.candidate.runId),
                chatThreadId: run.chatThreadId,
                eventType: "input.budget",
                runId: null,
                userMessage: createUserMessageDocument({
                  text: RUN_TIME_BUDGET_MESSAGE,
                }),
                agentRunContext: {
                  sourceRunId: args.candidate.runId,
                  sourceChatThreadId: run.chatThreadId,
                  sourceAgentId: run.agentId,
                },
                createdAt: args.createdAt,
              },
              "id",
            ),
          ),
        )[0] ?? null;
      return inserted !== null;
    });
    signal.throwIfAborted();
    return inserted;
  },
);

const steerOwnedRunsNearTimeBudget$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<{ readonly scanned: number; readonly steered: number }> => {
    const createdAt = nowDate();
    const startedBefore = new Date(
      createdAt.getTime() - RUN_TIME_BUDGET_STEER_AT_MS,
    );
    const candidates = await set(
      loadRunTimeBudgetCandidates$,
      startedBefore,
      signal,
    );
    signal.throwIfAborted();

    let steered = 0;
    for (const candidate of candidates) {
      if (
        await set(
          persistRunTimeBudgetInput$,
          {
            candidate,
            startedBefore,
            createdAt,
          },
          signal,
        )
      ) {
        steered += 1;
      }
      signal.throwIfAborted();
      await set(
        notifyRunningChatRunOfPendingInput$,
        candidate.chatThreadId,
        signal,
      );
      signal.throwIfAborted();
    }

    return { scanned: candidates.length, steered };
  },
);

/**
 * Steer every chat run that reached its time budget. A run stays a candidate
 * until it ends, so an unclaimed steer is re-announced to the runner on the
 * next scan.
 */
export const steerRunsNearTimeBudget$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await set(steerOwnedRunsNearTimeBudget$, signal);
  },
);
