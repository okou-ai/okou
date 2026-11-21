import { env } from "../../lib/env";

/** Product-owned Claude restrictions applied to execution preparation. */
export const DEFAULT_DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
  "Skill(loop)",
  "Skill(loop *)",
] as const;

/** Only platform values with a verified Run/configuration source. */
export function runPlatformEnvironment(run: {
  readonly chatThreadId: string;
}): Record<string, string> {
  return {
    OKOU_APP_URL: env("APP_URL"),
    // The in-sandbox CLI binds new automations to this admitted Thread.
    OKOU_CHAT_THREAD_ID: run.chatThreadId,
  };
}
