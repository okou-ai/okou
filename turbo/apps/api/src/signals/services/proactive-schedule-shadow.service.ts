import type { ProactiveTask } from "@okouai/api-contracts/contracts/proactive";
import { isValidTimeZone } from "@okouai/core/timezone";
import {
  legacyProactiveSchedules,
  proactiveSchedules,
} from "@okouai/db/schema/proactive-schedule";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { monotonicNow, now } from "../../lib/time";
import { db$ } from "../external/db";
import { recordApiOperationTimings } from "../external/sandbox-op-log";
import {
  hourlySuggestionsCron,
  morningBriefCronExpression,
} from "./official-workflow-owner-schedule";
import { proactiveNightlyCron } from "./proactive-nightly-schedule";
import { scheduleExpired } from "./schedule-expiry-policy";
import { calculateNextRun } from "./time-automation";

const log = logger("ProactiveSchedules");
const minuteMs = 60_000;
const cadence = {
  "morning-brief": morningBriefCronExpression,
  suggestions: hourlySuggestionsCron,
  learning: proactiveNightlyCron,
} satisfies Record<ProactiveTask, typeof hourlySuggestionsCron>;

function emptyCounts() {
  return {
    bothDue: 0,
    automationOnly: 0,
    proactiveOnly: 0,
    paused: 0,
    awaitingAnchor: 0,
    missingTimezone: 0,
    invalidTimezone: 0,
    deferred: 0,
    overdue: 0,
    expired: 0,
  };
}

type Schedule = Pick<
  typeof legacyProactiveSchedules.$inferSelect,
  | "orgId"
  | "userId"
  | "task"
  | "intendedEnabled"
  | "enabled"
  | "installed"
  | "memberTimezone"
  | "reconciliationStatus"
  | "nextRunAt"
  | "deferredAnchorAt"
  | "deferredUntil"
>;

interface HandoffRow {
  readonly schedule: Schedule | null;
  readonly copiedTask: ProactiveTask | null;
  readonly settingsChanged: boolean;
  readonly cursorChanged: boolean;
}

type Counts = ReturnType<typeof emptyCounts>;
type Difference = {
  orgId: string;
  userId: string;
  task: ProactiveTask;
  source: "automation" | "proactive";
  scheduledAt: string;
};

/** Build each distinct calendar only once per tick, including across owners. */
function calendarForMinute(start: number) {
  const matches = new Map<string, boolean>();
  const timezones = new Map<string, boolean>();
  return (
    row: Schedule,
  ):
    | "due"
    | "later"
    | "paused"
    | "missingTimezone"
    | "invalidTimezone"
    | "awaitingAnchor" => {
    if (
      !row.intendedEnabled ||
      (row.installed &&
        (!row.enabled || row.reconciliationStatus !== "current"))
    ) {
      return "paused";
    }
    const timezone = row.task === "suggestions" ? "UTC" : row.memberTimezone;
    if (!timezone) {
      return "missingTimezone";
    }
    if (row.installed && !row.nextRunAt) {
      return "awaitingAnchor";
    }

    let valid = timezones.get(timezone);
    if (valid === undefined) {
      valid = isValidTimeZone(timezone);
      timezones.set(timezone, valid);
    }
    if (!valid) {
      return "invalidTimezone";
    }
    const expression = cadence[row.task](row);
    const key = `${timezone}/${expression}`;
    let due = matches.get(key);
    if (due === undefined) {
      // Start before the previous local night. Croner moves a nonexistent 02:xx
      // into the spring-forward hour; searching from 03:xx on that day misses it.
      const hours = row.task === "suggestions" ? 1 : 36;
      let next = calculateNextRun(
        expression,
        timezone,
        new Date(start - hours * 60 * minuteMs),
      );
      while (next && next.getTime() < start) {
        next = calculateNextRun(expression, timezone, next);
      }
      due = next?.getTime() === start;
      matches.set(key, due);
    }
    return due ? "due" : "later";
  };
}

function outstandingSlot(row: Schedule, minute: Date) {
  const anchor = row.nextRunAt;
  if (
    !anchor ||
    !row.enabled ||
    row.reconciliationStatus !== "current" ||
    anchor.getTime() >= minute.getTime() + minuteMs
  ) {
    return null;
  }
  if (
    row.deferredAnchorAt?.getTime() === anchor.getTime() &&
    row.deferredUntil &&
    row.deferredUntil > minute
  ) {
    return "deferred";
  }
  if (anchor >= minute) {
    return null;
  }
  return row.task === "morning-brief" && scheduleExpired(anchor, minute)
    ? "expired"
    : "overdue";
}

function compareSlot(
  row: Schedule,
  minute: Date,
  calendar: ReturnType<typeof calendarForMinute>,
  counts: Counts,
  differences: Difference[],
) {
  const held = outstandingSlot(row, minute);
  if (held) {
    counts[held]++;
    return;
  }
  const anchor = row.nextRunAt;
  const legacyDue =
    row.enabled &&
    row.reconciliationStatus === "current" &&
    anchor !== null &&
    anchor >= minute &&
    anchor.getTime() < minute.getTime() + minuteMs;
  const proposal = calendar(row);
  if (proposal !== "due" && proposal !== "later") {
    counts[proposal]++;
  }
  if (
    legacyDue &&
    proposal === "due" &&
    anchor.getTime() === minute.getTime()
  ) {
    counts.bothDue++;
    return;
  }
  function record(source: Difference["source"], scheduledAt: Date) {
    if (differences.length < 20) {
      differences.push({
        orgId: row.orgId,
        userId: row.userId,
        task: row.task,
        source,
        scheduledAt: scheduledAt.toISOString(),
      });
    }
  }
  if (legacyDue) {
    counts.automationOnly++;
    record("automation", anchor);
  }
  if (proposal === "due") {
    counts.proactiveOnly++;
    record("proactive", minute);
  }
}

/**
 * Forecast the next full UTC minute from one database snapshot, before either
 * cron can consume it. A held/cleared legacy cursor stays held. A pending
 * opt-in without an installation can expose a missing legacy occurrence.
 * Final Run admission (membership, activity, concurrency) happens after a slot
 * is due and is not exercised by this read-only comparison.
 */
function compareUpcoming(rows: readonly HandoffRow[], at: number) {
  const start = (Math.floor(at / minuteMs) + 1) * minuteMs;
  const minute = new Date(start);
  const calendar = calendarForMinute(start);
  const tasks = {
    "morning-brief": emptyCounts(),
    suggestions: emptyCounts(),
    learning: emptyCounts(),
  };
  const copy = { added: 0, removed: 0, changedSettings: 0, changedCursor: 0 };
  const differences: Difference[] = [];
  for (const {
    schedule: row,
    copiedTask,
    settingsChanged,
    cursorChanged,
  } of rows) {
    if (!row) {
      copy.removed++;
      continue;
    }
    if (!copiedTask) {
      copy.added++;
    } else {
      if (settingsChanged) {
        copy.changedSettings++;
      }
      if (cursorChanged) {
        copy.changedCursor++;
      }
    }
    compareSlot(row, minute, calendar, tasks[row.task], differences);
  }
  return { minute: minute.toISOString(), tasks, copy, differences };
}

export const compareProactiveSchedules$ = command(
  async ({ get }, signal: AbortSignal) => {
    const started = monotonicNow();
    const at = now();
    const source = legacyProactiveSchedules;
    const copied = proactiveSchedules;
    // Both sides of a membership removal or a new opt-in must be visible. The
    // frozen copy is compared separately from the calendar forecast: legacy
    // completions and settings edits legitimately advance it between releases.
    const rows = await get(db$)
      .select({
        schedule: {
          orgId: source.orgId,
          userId: source.userId,
          task: source.task,
          intendedEnabled: source.intendedEnabled,
          enabled: source.enabled,
          installed: source.installed,
          memberTimezone: source.memberTimezone,
          reconciliationStatus: source.reconciliationStatus,
          nextRunAt: source.nextRunAt,
          deferredAnchorAt: source.deferredAnchorAt,
          deferredUntil: source.deferredUntil,
        },
        copiedTask: copied.task,
        settingsChanged:
          sql`ROW(${source.intendedEnabled}, ${source.enabled}, ${source.timezone},
      ${source.chatThreadId}, ${source.reconciliationStatus}) IS DISTINCT FROM
      ROW(${copied.intendedEnabled}, ${copied.enabled}, ${copied.timezone},
      ${copied.chatThreadId}, ${copied.reconciliationStatus})`.mapWith(
            pgBooleanDecoder,
          ),
        cursorChanged:
          sql`ROW(${source.nextRunAt}, ${source.lastRunAt}, ${source.lastRunId},
      ${source.consecutiveFailures}, ${source.deferredAnchorAt}, ${source.deferredUntil}, ${source.deferredReason})
      IS DISTINCT FROM ROW(${copied.nextRunAt}, ${copied.lastRunAt}, ${copied.lastRunId},
      ${copied.consecutiveFailures}, ${copied.deferredAnchorAt}, ${copied.deferredUntil}, ${copied.deferredReason})`.mapWith(
            pgBooleanDecoder,
          ),
      })
      .from(source)
      .fullJoin(
        copied,
        and(
          eq(source.orgId, copied.orgId),
          eq(source.userId, copied.userId),
          eq(source.task, copied.task),
        ),
      )
      .orderBy(source.orgId, source.userId, source.task);
    signal.throwIfAborted();
    const report = compareUpcoming(rows, at);
    recordApiOperationTimings([
      {
        actionType: "proactive_schedule_comparison",
        durationMs: monotonicNow() - started,
        success: true,
        dimensions: {
          minute: report.minute,
          tasks: report.tasks,
          copy: report.copy,
        },
      },
    ]);
    if (report.differences.length > 0) {
      log.warn("Upcoming proactive schedules differ", {
        minute: report.minute,
        differences: report.differences,
      });
    }
    return report;
  },
);
