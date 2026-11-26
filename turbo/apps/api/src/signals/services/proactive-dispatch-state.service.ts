import { parseRawRows } from "../../lib/db-raw-rows";
import { boolean, object, string } from "zod";
import { revokeStaleProactiveInputs$ } from "./proactive-queued-input.service";
import type {
  ProactivePreference,
  ProactiveTask,
} from "@okouai/api-contracts/contracts/proactive";
import { isValidTimeZone } from "@okouai/core/timezone";
import { proactiveSchedules } from "@okouai/db/schema/proactive-schedule";
import { command } from "ccstate";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  hourlySuggestionsCron,
  morningBriefCronExpression,
} from "./official-workflow-owner-schedule";
import { proactiveNightlyCron } from "./proactive-nightly-schedule";
import {
  loadProactivePreferences$,
  type ProactiveWorkflowOwner,
} from "./proactive-workflows-eligibility.service";
import { calculateNextRun } from "./time-automation";

const cadence = Object.freeze({
  "morning-brief": morningBriefCronExpression,
  suggestions: hourlySuggestionsCron,
  learning: proactiveNightlyCron,
});

export function nextProactiveSlot(
  owner: ProactiveWorkflowOwner,
  task: ProactiveTask,
  timezone: string | null,
  from: Date,
) {
  const zone = task === "suggestions" ? "UTC" : timezone;
  return zone && isValidTimeZone(zone)
    ? calculateNextRun(cadence[task](owner), zone, from)
    : null;
}

export function scheduleOwner(owner: ProactiveWorkflowOwner) {
  return and(
    eq(proactiveSchedules.orgId, owner.orgId),
    eq(proactiveSchedules.userId, owner.userId),
  );
}

/** A repeated choice preserves pauses, outstanding obligations and the original cursor. */
interface SchedulePreference {
  readonly owner: ProactiveWorkflowOwner;
  readonly tasks: readonly ProactiveTask[];
  readonly enabled: boolean;
  readonly timezone: string | null;
  readonly preserveChoice?: boolean;
}
function upsertSchedulesSql(
  {
    owner,
    tasks,
    enabled,
    timezone,
    preserveChoice = false,
  }: SchedulePreference,
  gate: SQL,
) {
  const at = nowDate();
  const entries = tasks.map((task) => {
    const zone = task === "suggestions" ? "UTC" : timezone;
    const next = enabled ? nextProactiveSlot(owner, task, zone, at) : null;
    return sql`(${task}::text,${zone}::text,${next?.toISOString() ?? null}::timestamp)`;
  });
  return sql`INSERT INTO proactive_schedules AS s (org_id,user_id,task,intended_enabled,enabled,timezone,next_run_at,consecutive_failures,reconciliation_status,preference_revision)
    SELECT ${owner.orgId},${owner.userId},v.task,${enabled},v.next_run_at IS NOT NULL,v.timezone,v.next_run_at,0,'current',1
    FROM (VALUES ${sql.join(entries, sql`,`)}) v(task,timezone,next_run_at) WHERE ${gate}
    ON CONFLICT (org_id,user_id,task) DO UPDATE SET intended_enabled=excluded.intended_enabled,enabled=excluded.enabled,timezone=excluded.timezone,
      next_run_at=excluded.next_run_at,consecutive_failures=0,deferred_anchor_at=NULL,deferred_until=NULL,deferred_reason=NULL,
      reconciliation_status='current',preference_revision=s.preference_revision+1
    WHERE (NOT ${preserveChoice} OR s.intended_enabled=excluded.intended_enabled) AND
      ((s.intended_enabled,s.timezone) IS DISTINCT FROM (excluded.intended_enabled,excluded.timezone) OR (s.reconciliation_status IS NULL AND excluded.enabled))`;
}

export const setStandalonePreferences$ = command(
  async ({ set }, preference: SchedulePreference, signal: AbortSignal) => {
    const { owner, tasks, enabled, timezone, preserveChoice } = preference;
    const morning = tasks.includes("morning-brief");
    // Lock the metadata used for this calendar choice. A later timezone update reconciles after this write.
    const member = sql`SELECT timezone,proactive_suggestions_enabled FROM org_members_metadata
      WHERE org_id=${owner.orgId} AND user_id=${owner.userId} FOR SHARE`;
    const sameTimezone = sql`(SELECT timezone FROM member) IS NOT DISTINCT FROM ${timezone}::text`;
    const choice = morning
      ? preserveChoice
        ? sql`EXISTS (SELECT 1 FROM proactive_schedules WHERE org_id=${owner.orgId} AND user_id=${owner.userId} AND task='morning-brief' AND intended_enabled)`
        : sql`true`
      : sql`EXISTS (SELECT 1 FROM member WHERE coalesce(proactive_suggestions_enabled,false)=${enabled})`;
    const schedule = upsertSchedulesSql(
      preference,
      sql`(SELECT eligible FROM observed)`,
    );
    const [observation] = parseRawRows(
      object({ eligible: boolean() }),
      await set(writeDb$)
        .execute(sql`WITH member AS MATERIALIZED (${member}), observed AS MATERIALIZED (SELECT (${sameTimezone} AND ${choice}) AS eligible),
      saved AS (${schedule} RETURNING task) SELECT eligible FROM observed`),
    );
    signal.throwIfAborted();
    if (!observation?.eligible) {
      return false;
    }
    await set(revokeStaleProactiveInputs$, owner, signal);
    signal.throwIfAborted();
    return true;
  },
);

/** The preference, both schedule revisions and optional Feed choice change in one commit. */
export const saveStandaloneSuggestions$ = command(
  async (
    { set },
    owner: ProactiveWorkflowOwner,
    enabled: boolean,
    withFeed: boolean,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    for (;;) {
      const { timezone } = await set(loadProactivePreferences$, owner, signal);
      const schedule = upsertSchedulesSql(
        { owner, tasks: ["suggestions", "learning"], enabled, timezone },
        sql`EXISTS (SELECT 1 FROM saved)`,
      );
      const saved = parseRawRows(
        object({ user_id: string() }),
        await db.execute(sql`WITH saved AS (
      INSERT INTO org_members_metadata AS m (org_id,user_id,proactive_suggestions_enabled)
      VALUES (${owner.orgId},${owner.userId},${enabled}) ON CONFLICT (org_id,user_id) DO UPDATE
      SET proactive_suggestions_enabled=excluded.proactive_suggestions_enabled,updated_at=timezone('UTC',now())
      WHERE m.timezone IS NOT DISTINCT FROM ${timezone}::text RETURNING org_id,user_id
    ), schedules AS (${schedule}), feed AS (
      INSERT INTO feed_preferences AS f (org_id,user_id,suggestions)
        SELECT org_id,user_id,${enabled} FROM saved WHERE ${withFeed}
        ON CONFLICT (org_id,user_id) DO UPDATE SET suggestions=excluded.suggestions
    ) SELECT user_id FROM saved`),
      );
      signal.throwIfAborted();
      if (saved.length) {
        signal.throwIfAborted();
        await set(revokeStaleProactiveInputs$, owner, signal);
        return;
      }
      // A concurrent timezone update won. Recompute the calendar from its stored value.
    }
  },
);

export const standalonePreference$ = command(
  async (
    { set },
    owner: ProactiveWorkflowOwner,
    feature: "morning-brief" | "suggestions",
    signal: AbortSignal,
  ): Promise<ProactivePreference> => {
    const schedules = await set(writeDb$)
      .select()
      .from(proactiveSchedules)
      .where(
        and(
          scheduleOwner(owner),
          inArray(
            proactiveSchedules.task,
            feature === "suggestions"
              ? ["suggestions", "learning"]
              : ["morning-brief"],
          ),
        ),
      );
    signal.throwIfAborted();
    const saved = await set(loadProactivePreferences$, owner, signal);
    const enabled =
      feature === "suggestions"
        ? saved.suggestions
        : schedules.some((row) => {
            return row.intendedEnabled;
          });
    const unavailableReason =
      enabled && !saved.timezone ? "missing-timezone" : null;
    return {
      enabled,
      unavailableReason,
      status: !enabled
        ? "paused"
        : schedules.some((row) => {
              return (
                row.consecutiveFailures > 0 ||
                row.reconciliationStatus === "failed"
              );
            })
          ? "error"
          : !unavailableReason &&
              schedules.length === (feature === "suggestions" ? 2 : 1) &&
              schedules.every((row) => {
                return row.enabled && row.reconciliationStatus === "current";
              })
            ? "enabled"
            : "preparing",
    };
  },
);
