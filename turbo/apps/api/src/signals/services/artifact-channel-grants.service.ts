import { command } from "ccstate";
import type { ArtifactChannelRecipient } from "./artifact-channel-access.service";
import type { ChannelSharingResource } from "./artifact-channel-resource.service";
import { shareFileArtifact$ } from "./artifact-file-sharing.service";
import { shareHostedSite$ } from "./hosted-site-sharing.service";
import { consumeHostedSiteSharingQuota$ } from "./hosted-site-sharing-quota.service";
import { settle } from "../utils";

export const grantArtifactChannelMembers$ = command(
  async (
    { set },
    args: {
      readonly resource: ChannelSharingResource;
      readonly recipients: readonly ArtifactChannelRecipient[];
      readonly unresolved: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const outboxIds: string[] = [];
    let processed = 0;
    let attempted = 0;
    let limited =
      args.recipients.length > 0 &&
      (await set(
        consumeHostedSiteSharingQuota$,
        {
          userId: args.resource.userId,
          orgId: args.resource.orgId,
          kind: "channel-share",
        },
        signal,
      )) !== null;
    const unresolved = [...args.unresolved];
    for (const recipient of args.recipients) {
      if (limited) {
        break;
      }
      const retryAfter = await set(
        consumeHostedSiteSharingQuota$,
        {
          userId: args.resource.userId,
          orgId: args.resource.orgId,
          kind: "channel-recipient",
          email: recipient.email,
        },
        signal,
      );
      if (retryAfter !== null) {
        limited = true;
        break;
      }
      attempted++;
      const shared = await settle(
        args.resource.kind === "site"
          ? set(
              shareHostedSite$,
              {
                siteId: args.resource.id,
                userId: args.resource.userId,
                orgId: args.resource.orgId,
                email: recipient.email,
                recipient: recipient.recipient,
              },
              signal,
            )
          : set(
              shareFileArtifact$,
              {
                resource: args.resource,
                email: recipient.email,
                recipient: recipient.recipient,
              },
              signal,
            ),
        signal,
      );
      if (!shared.ok || shared.value.status !== "ok") {
        unresolved.push(recipient.memberId);
        continue;
      }
      processed++;
      outboxIds.push(shared.value.outboxId);
    }
    return {
      processed,
      unresolved,
      remaining: limited ? args.recipients.length - attempted : 0,
      outboxIds,
    };
  },
);
