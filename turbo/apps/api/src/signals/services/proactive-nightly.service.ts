import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { proactiveNightlyCycles } from "@okouai/db/schema/proactive-nightly-cycle";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { runResultSchema } from "@okouai/api-contracts/contracts/runs";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import { loadProactiveWorkflowsEligibility$ } from "./proactive-workflows-eligibility.service";
import { proactiveWorkflowOwnerEnabledSql } from "./proactive-workflow-owner";
import {
  proactiveReviewDate,
  type ProactiveNightlyKind,
  type ProactiveNightlyOccurrence,
} from "./proactive-nightly-schedule";
import { calculateNextRun } from "./time-automation";

const log = logger("ProactiveNightly");
const learningClaim = alias(chatEvents, "learning_claim");

type NightlyAdmission =
  | { readonly kind: "ready"; readonly occurrence: ProactiveNightlyOccurrence }
  | { readonly kind: "wait" }
  | {
      readonly kind: "skip";
      readonly occurrence: ProactiveNightlyOccurrence;
      readonly reason: string;
    };

/** Reads the exact scheduled Learning event, never an unrelated manual Run. */
export const prepareProactiveNightlyAdmission$ = command(
  async (
    { get, set },
    args: {
      readonly automation: AutomationRow;
      readonly kind: ProactiveNightlyKind;
      readonly at: Date;
    },
    signal: AbortSignal,
  ): Promise<NightlyAdmission> => {
    const { automation, kind, at } = args;
    const scheduledAt = automation.nextRunAt;
    if (scheduledAt === null) {
      return { kind: "wait" };
    }
    const owner = { orgId: automation.orgId, userId: automation.ownerUserId };
    const eligibility = await set(
      loadProactiveWorkflowsEligibility$,
      owner,
      signal,
    );
    if (!eligibility[kind].active || eligibility.timezone === null) {
      return { kind: "wait" };
    }
    const occurrence: ProactiveNightlyOccurrence = {
      kind,
      reviewDate: proactiveReviewDate(scheduledAt, automation.timezone),
      timezone: automation.timezone,
      scheduledAt,
      learningEnabled: eligibility.learning.enabled,
      learningEventId: null,
      learningMemoryVersion: null,
    };
    // Bound the paired wait before the morning without holding a model Run.
    const budgetHours = kind === "learning" ? 4 : 3;
    if (at.getTime() >= scheduledAt.getTime() + budgetHours * 60 * 60 * 1000) {
      return {
        kind: "skip",
        occurrence,
        reason: "Nightly review deadline expired",
      };
    }
    if (kind === "learning" || !eligibility.learning.enabled) {
      return { kind: "ready", occurrence };
    }
    const [learning] = await get(db$)
      .select({
        eventId: learningClaim.id,
        status: agentRuns.status,
        result: agentRuns.result,
      })
      .from(proactiveNightlyCycles)
      .leftJoin(
        learningClaim,
        and(
          eq(learningClaim.revokesEventId, proactiveNightlyCycles.eventId),
          eq(learningClaim.eventType, "input.prompt"),
        ),
      )
      .leftJoin(agentRuns, eq(agentRuns.id, learningClaim.runId))
      .where(
        and(
          eq(proactiveNightlyCycles.orgId, owner.orgId),
          eq(proactiveNightlyCycles.userId, owner.userId),
          eq(proactiveNightlyCycles.kind, "learning"),
          eq(proactiveNightlyCycles.reviewDate, occurrence.reviewDate),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !learning ||
      learning.eventId === null ||
      learning.status === null ||
      learning.status === "pending" ||
      learning.status === "running"
    ) {
      return { kind: "wait" };
    }
    if (learning.status !== "completed") {
      return {
        kind: "skip",
        occurrence,
        reason: "Paired Learning did not complete successfully",
      };
    }
    const result =
      learning.result === null ? null : runResultSchema.parse(learning.result);
    const memoryVersion = result?.storageOutputs?.find((output) => {
      return output.name === MEMORY_ARTIFACT_NAME;
    })?.version;
    if (memoryVersion === undefined) {
      return {
        kind: "skip",
        occurrence,
        reason: "Learning has no acknowledged memory output",
      };
    }
    const [published] = await get(db$)
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .innerJoin(storages, eq(storages.id, storageVersions.storageId))
      .where(
        and(
          eq(storages.orgId, owner.orgId),
          eq(storages.userId, owner.userId),
          eq(storages.name, MEMORY_ARTIFACT_NAME),
          eq(storageVersions.id, memoryVersion),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!published) {
      return {
        kind: "skip",
        occurrence,
        reason: "Learning memory version is not published",
      };
    }
    return {
      kind: "ready",
      occurrence: {
        ...occurrence,
        learningEventId: learning.eventId,
        learningMemoryVersion: memoryVersion,
      },
    };
  },
);

/** An expired/failed pair advances once without fabricating a Chat or Run. */
export const skipProactiveNightlyOccurrence$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly agentId: string;
      readonly occurrence: ProactiveNightlyOccurrence;
      readonly reason: string;
    },
    signal: AbortSignal,
  ) => {
    const { automation, occurrence } = args;
    if (automation.cronExpression === null) {
      throw new Error("Nightly workflow is missing its cron schedule");
    }
    const database = set(writeDb$);
    const at = nowDate();
    const next = calculateNextRun(
      automation.cronExpression,
      automation.timezone,
      at,
    );
    const accepted = database
      .update(workflowAutomations)
      .set({ nextRunAt: next, updatedAt: at })
      .where(
        and(
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.nextRunAt, occurrence.scheduledAt),
          proactiveWorkflowOwnerEnabledSql(
            { orgId: automation.orgId, userId: automation.ownerUserId },
            args.agentId,
            occurrence.kind,
          ),
        ),
      )
      .returning({ id: workflowAutomations.id });
    const skipped = (
      await database.execute(sql`WITH skipped_nightly_anchor AS (${accepted.getSQL()})
      INSERT INTO proactive_nightly_cycles
        (org_id, user_id, kind, review_date, timezone, scheduled_at, automation_id, skipped_reason)
      SELECT ${automation.orgId}, ${automation.ownerUserId}, ${occurrence.kind},
        ${occurrence.reviewDate}::date, ${occurrence.timezone}, ${occurrence.scheduledAt}::timestamp,
        id, ${args.reason} FROM skipped_nightly_anchor
      ON CONFLICT (org_id, user_id, review_date, kind) DO NOTHING`)
    ).rowCount;
    signal.throwIfAborted();
    if (skipped) {
      log.debug("Nightly occurrence skipped", {
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        kind: occurrence.kind,
        reviewDate: occurrence.reviewDate,
        reason: args.reason,
      });
    }
  },
);
