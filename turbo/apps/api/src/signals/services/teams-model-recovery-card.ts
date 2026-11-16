import type { TeamsAdaptiveCard } from "../external/teams-bot-client";
import { MODEL_RECOVERY_ACTION } from "./integration-model-recovery.service";

export function teamsModelRecoveryCard(
  text: string,
  eventId: string,
  footerText?: string,
): TeamsAdaptiveCard {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", text, wrap: true },
      ...(footerText
        ? [{ type: "TextBlock", text: footerText, isSubtle: true, wrap: true }]
        : []),
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Switch model",
        data: {
          msteams: { type: "task/fetch" },
          action: MODEL_RECOVERY_ACTION,
          eventId,
        },
      },
    ],
  };
}
