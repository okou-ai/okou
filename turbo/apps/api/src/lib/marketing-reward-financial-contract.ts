import {
  marketingRewardIntentSchema,
  type MarketingRewardIntent,
} from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import type { MarketingRewardSourceEvent } from "./marketing-reward-events";

/** Validate the approved financial contract against App's immutable source proof. */
export function marketingRewardIntentMatchesSource(
  intent: MarketingRewardIntent,
  event: MarketingRewardSourceEvent,
) {
  const terms = automaticRewardTerms(event);
  if (!terms) {
    return false;
  }
  const expected = marketingRewardIntentSchema.parse({
    version: 1,
    id: intent.id,
    environment: event.environment,
    policy: "get-started-v1",
    sourceEventId: event.id.toLowerCase(),
    ...terms,
    orgId: event.orgId,
    actorUserId: event.userId,
    completedAt: event.occurredAt,
  });
  return (
    JSON.stringify(expected) ===
    JSON.stringify({
      ...intent,
      sourceEventId: intent.sourceEventId.toLowerCase(),
    })
  );
}

type RewardTerms = Pick<
  MarketingRewardIntent,
  | "questKey"
  | "sourceKey"
  | "rewardKey"
  | "rewardAmount"
  | "rewardTarget"
  | "beneficiaryUserId"
>;

function automaticRewardTerms(
  event: MarketingRewardSourceEvent,
): RewardTerms | null {
  const personal = {
    beneficiaryUserId: event.userId,
    rewardTarget: "user" as const,
  };
  switch (event.type) {
    case "checkin.requested": {
      const day = event.occurredAt.slice(0, 10);
      return {
        ...personal,
        questKey: "checkin",
        sourceKey: day,
        rewardKey: `checkin:${event.userId}:${day}`,
        rewardAmount: 100,
      };
    }
    case "connector.oauth-authorized": {
      const sourceKey =
        event.connector.kind === "custom"
          ? "custom"
          : `builtin:${event.connector.connectorSlug}`;
      return {
        ...personal,
        questKey: "connector",
        sourceKey,
        rewardKey: `connector:${event.userId}:${sourceKey}`,
        rewardAmount: 100,
      };
    }
    case "slack.oauth-authorized": {
      return {
        questKey: "slack",
        sourceKey: event.workspaceId,
        rewardKey: `slack:${event.workspaceId}`,
        rewardAmount: 2000,
        rewardTarget: "org",
        beneficiaryUserId: null,
      };
    }
    case "imessage.identity-linked": {
      return {
        ...personal,
        questKey: "imessage",
        sourceKey: "agentphone-link",
        rewardKey: `imessage:${event.userId}:agentphone-link`,
        rewardAmount: 1000,
      };
    }
    case "workflow.run-completed": {
      return {
        questKey: "workflow",
        sourceKey: event.sourceEventId,
        rewardKey: `workflow:${event.creatorUserId}`,
        rewardAmount: 1000,
        rewardTarget: "user",
        beneficiaryUserId: event.creatorUserId,
      };
    }
    case "invitation.accepted": {
      return event.userId === event.inviteeUserId
        ? null
        : {
            ...personal,
            questKey: "invite",
            sourceKey: event.sourceKey,
            rewardKey: `invite:${event.inviteeUserId}`,
            rewardAmount: 100,
          };
    }
    case "invitation.attributed":
    case "invitation.revoked":
    case "workflow.input-queued":
    case "workflow.run-created": {
      return null;
    }
  }
}
