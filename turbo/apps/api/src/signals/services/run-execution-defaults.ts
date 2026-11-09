import { env } from "../../lib/env";

/** Product-owned Claude restrictions, applied when Claim prepares execution. */
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
  readonly agentId: string | null;
  readonly chatThreadId: string | null;
}): Record<string, string> {
  const values: Record<string, string> = {};
  if (run.agentId !== null && run.chatThreadId !== null) {
    values.OKOU_APP_URL = env("APP_URL");
  }
  if (run.agentId !== null) {
    values.OKOU_AGENT_ID = run.agentId;
  }
  if (run.chatThreadId !== null) {
    // The in-sandbox CLI binds new automations to this admitted Thread.
    values.OKOU_CHAT_THREAD_ID = run.chatThreadId;
  }
  return values;
}
