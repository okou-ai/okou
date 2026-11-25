import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db$ } from "../external/db";

/**
 * Official schedules run at the platform's expense, so an occurrence is served
 * only when its owner started a Run in the same workspace within this window.
 */
const OFFICIAL_SCHEDULE_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60_000;

// A member starts these Runs from a chat surface. Automation, Agent, webhook
// and test Runs do not show that the member is still using Okou.
const MANUAL_RUN_TRIGGER_SOURCES = [
  "web",
  "slack",
  "discord",
  "wechat",
  "teams",
  "feishu",
  "lark",
  "email",
  "telegram",
  "agentphone",
  "github",
] as const satisfies readonly TriggerSource[];

export const officialScheduleOwnerIsActive$ = command(
  async (
    { get },
    owner: { readonly orgId: string; readonly userId: string },
    at: Date,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [manualRun] = await get(db$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.orgId, owner.orgId),
          inArray(agentRuns.triggerSource, [...MANUAL_RUN_TRIGGER_SOURCES]),
          gte(
            agentRuns.createdAt,
            new Date(at.getTime() - OFFICIAL_SCHEDULE_ACTIVITY_WINDOW_MS),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return manualRun !== undefined;
  },
);
