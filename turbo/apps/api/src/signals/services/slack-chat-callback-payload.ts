import { object, string } from "zod";

export interface SlackDeliveryTarget {
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly routeThreadTs?: string;
}

export const slackChatCallbackPayloadSchema = object({
  workspaceId: string().optional(),
  channelId: string(),
  threadTs: string(),
  routeThreadTs: string().optional(),
  chatEventId: string(),
});

export function slackChatDeliveryFields(
  target: SlackDeliveryTarget,
  chatEventId: string,
) {
  return {
    internalKind: "slack:chat" as const,
    chatEventId,
    payload: { ...target, chatEventId },
  };
}
