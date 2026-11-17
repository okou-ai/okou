import {
  sendTeamsReaction,
  sendTeamsTypingActivity,
} from "../external/teams-bot-client";
import { bestEffort } from "../utils";

const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";

export async function sendTeamsRunStartIndicator(
  args: {
    readonly activity: {
      readonly activityId: string | null;
      readonly serviceUrl: string;
      readonly conversationId: string;
      readonly tenantId: string;
      readonly conversationType: string | null;
    };
  },
  signal: AbortSignal,
): Promise<void> {
  const activityId = args.activity.activityId;
  let indicator:
    | ReturnType<typeof sendTeamsTypingActivity>
    | ReturnType<typeof sendTeamsReaction>;
  if (args.activity.conversationType === "personal" || !activityId) {
    indicator = sendTeamsTypingActivity(
      {
        serviceUrl: args.activity.serviceUrl,
        conversationId: args.activity.conversationId,
        tenantId: args.activity.tenantId,
      },
      signal,
    );
  } else {
    indicator = sendTeamsReaction(
      {
        serviceUrl: args.activity.serviceUrl,
        conversationId: args.activity.conversationId,
        activityId,
        tenantId: args.activity.tenantId,
        reactionType: TEAMS_THINKING_REACTION_TYPE,
      },
      signal,
    );
  }
  await bestEffort(indicator, signal);
}
