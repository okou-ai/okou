import { enum as zEnum } from "zod";

/**
 * Trigger source enum — how the run was initiated
 */
export const triggerSourceSchema = zEnum([
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
  "test",
  "agent",
  "webhook",
  "automation-schedule",
  "automation-event",
]);
