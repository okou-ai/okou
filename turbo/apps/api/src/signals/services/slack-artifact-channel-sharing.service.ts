import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import {
  array,
  literal,
  object,
  string,
  url as zUrl,
  enum as zEnum,
} from "zod";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { HostedSiteShareAccount } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { hostedSiteShareEmailSchema } from "@okouai/api-contracts/validators/hosted-site-sharing";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import {
  signSlackArtifactShare,
  verifySlackArtifactShare,
  slackArtifactSharingBlocks,
  SLACK_ARTIFACT_SHARE_ACTIONS,
  type SlackArtifactShareState,
} from "../../lib/slack-artifact-sharing";
import { db$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import {
  createSlackClient,
  type SlackUserInfo,
} from "../external/slack-message-client";
import { settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  ownedSlackSharingResource$,
  resolveSlackSharingResource$,
  type SlackSharingResource,
} from "./slack-artifact-sharing-resource.service";
import { shareFileArtifact$ } from "./artifact-file-sharing.service";
import { shareHostedSite$ } from "./hosted-site-sharing.service";
import { consumeHostedSiteSharingQuota$ } from "./hosted-site-sharing-quota.service";
import { updateArtifactShare$ } from "./artifact-shares.service";
import { updateHostedSiteVisibility$ } from "./hosted-site-access.service";

interface SlackActor {
  readonly workspaceId: string;
  readonly slackUserId: string;
}

const slackActor$ = command(
  async ({ get }, actor: SlackActor, signal: AbortSignal) => {
    const [connection] = await get(db$)
      .select()
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, actor.workspaceId),
          eq(slackOrgConnections.slackUserId, actor.slackUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return null;
    }
    const user = await findClerkUser(get(clerk$), connection.userId, signal);
    if (!user || user.banned) {
      return null;
    }
    const [installation] = await get(db$)
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, actor.workspaceId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation?.orgId || !installation.botScopes) {
      return null;
    }
    const scopes = array(string()).parse(JSON.parse(installation.botScopes));
    if (
      ![
        "chat:write",
        "channels:read",
        "groups:read",
        "users:read",
        "users:read.email",
      ].every((scope) => {
        return scopes.includes(scope);
      })
    ) {
      return null;
    }
    const token = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      {
        orgId: installation.orgId,
        userId: installation.installedByUserId ?? undefined,
      },
    );
    signal.throwIfAborted();
    return {
      userId: connection.userId,
      botToken: token,
      client: createSlackClient(token, { automaticRetries: false }),
    };
  },
);

const sharingEnabled$ = command(
  async ({ set }, resource: SlackSharingResource, signal: AbortSignal) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      resource.orgId,
      resource.userId,
      signal,
    );
    return (
      isFeatureEnabled(FeatureSwitchKey.SlackArtifactChannelSharing, context) &&
      isFeatureEnabled(FeatureSwitchKey.HostedSiteEmailSharing, context)
    );
  },
);

interface ChannelRecipient {
  readonly slackUserId: string;
  readonly email: string;
  readonly recipient: HostedSiteShareAccount | undefined;
}
interface ChannelCoverage {
  readonly recipients: readonly ChannelRecipient[];
  readonly unresolved: readonly string[];
  readonly unconfirmed: number;
  readonly complete: boolean;
  readonly senderIsMember: boolean;
}

type MemberAccess =
  | { readonly kind: "covered" }
  | { readonly kind: "unknown"; readonly slackUserId: string }
  | { readonly kind: "recipient"; readonly value: ChannelRecipient };

interface MemberInput {
  readonly resource: SlackSharingResource;
  readonly slackUserId: string;
  readonly profile: SlackUserInfo;
}

function channelInvitation(
  input: MemberInput,
  recipient?: HostedSiteShareAccount,
): MemberAccess {
  const email = hostedSiteShareEmailSchema.safeParse(
    recipient?.email ?? input.profile.email,
  );
  if (!email.success) {
    return { kind: "unknown", slackUserId: input.slackUserId };
  }
  const existing = input.resource.shares.find((share) => {
    return share.email === email.data;
  });
  if (existing) {
    // A claimed invitation cannot be reassigned using a recycled email.
    return existing.userId === null || existing.userId === recipient?.userId
      ? { kind: "covered" }
      : { kind: "unknown", slackUserId: input.slackUserId };
  }
  return {
    kind: "recipient",
    value: { slackUserId: input.slackUserId, email: email.data, recipient },
  };
}

const workspaceMemberAccess$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const members = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList({
      organizationId: args.orgId,
      userId: [args.userId],
      limit: 1,
    });
    signal.throwIfAborted();
    return members.data.some((member) => {
      return (
        member.organization.id === args.orgId &&
        member.publicUserData?.userId === args.userId
      );
    });
  },
);

const workspaceEmailAccess$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly email: string | undefined },
    signal: AbortSignal,
  ) => {
    const email = hostedSiteShareEmailSchema.safeParse(args.email);
    if (!email.success) {
      return false;
    }
    const members = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList({
      organizationId: args.orgId,
      emailAddress: [email.data],
      limit: 1,
    });
    signal.throwIfAborted();
    const memberId = members.data.find((member) => {
      return member.organization.id === args.orgId;
    })?.publicUserData?.userId;
    if (!memberId) {
      return false;
    }
    const user = await findClerkUser(get(clerk$), memberId, signal);
    return Boolean(
      user &&
      !user.banned &&
      user.emailAddresses.some((address) => {
        return (
          address.verification?.status === "verified" &&
          address.emailAddress.trim().toLowerCase() === email.data
        );
      }),
    );
  },
);

const linkedMemberAccess$ = command(
  async (
    { get, set },
    args: MemberInput & { readonly userId: string },
    signal: AbortSignal,
  ): Promise<MemberAccess> => {
    const user = await findClerkUser(get(clerk$), args.userId, signal);
    if (!user || user.banned) {
      return { kind: "unknown", slackUserId: args.slackUserId };
    }
    if (
      args.resource.shares.some((share) => {
        return share.userId === args.userId;
      })
    ) {
      return { kind: "covered" };
    }
    if (
      args.resource.audience === "organization" &&
      (await set(
        workspaceMemberAccess$,
        { orgId: args.resource.orgId, userId: args.userId },
        signal,
      ))
    ) {
      return { kind: "covered" };
    }
    const emails = user.emailAddresses
      .filter((email) => {
        return email.verification?.status === "verified";
      })
      .map((email) => {
        return email.emailAddress.trim().toLowerCase();
      });
    if (
      args.resource.shares.some((share) => {
        return share.userId === null && emails.includes(share.email);
      })
    ) {
      return { kind: "covered" };
    }
    const email = emails[0];
    if (!email) {
      return { kind: "unknown", slackUserId: args.slackUserId };
    }
    return channelInvitation(args, {
      userId: args.userId,
      email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    });
  },
);

const channelMemberAccess$ = command(
  async (
    { set },
    args: {
      readonly resource: SlackSharingResource;
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly profile: SlackUserInfo | undefined;
      readonly userId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<MemberAccess> => {
    const profile = args.profile;
    if (!profile) {
      return { kind: "unknown", slackUserId: args.slackUserId };
    }
    if (profile.deleted || profile.isBot) {
      return { kind: "covered" };
    }
    const userId =
      profile.teamId === args.workspaceId ? args.userId : undefined;
    if (userId === args.resource.userId) {
      return { kind: "covered" };
    }
    const input = {
      resource: args.resource,
      slackUserId: args.slackUserId,
      profile,
    };
    if (userId) {
      return set(linkedMemberAccess$, { ...input, userId }, signal);
    }
    if (
      args.resource.audience === "organization" &&
      (await set(
        workspaceEmailAccess$,
        { orgId: args.resource.orgId, email: profile.email },
        signal,
      ))
    ) {
      return { kind: "covered" };
    }
    return channelInvitation(input);
  },
);

/** Inspect access without claiming invitations or changing any grants. */
const channelCoverage$ = command(
  async (
    { get, set },
    args: SlackActor & {
      readonly channelId: string;
      readonly resource: SlackSharingResource;
      readonly botToken: string;
    },
    signal: AbortSignal,
  ): Promise<ChannelCoverage> => {
    const client = createSlackClient(args.botToken, {
      automaticRetries: false,
    });
    const listed = await settle(
      client.fetchConversationMembers(args.channelId),
      signal,
    );
    if (!listed.ok) {
      return {
        recipients: [],
        unresolved: [],
        unconfirmed: 0,
        complete: false,
        senderIsMember: false,
      };
    }
    if (!listed.value.includes(args.slackUserId)) {
      return {
        recipients: [],
        unresolved: [],
        unconfirmed: 0,
        complete: true,
        senderIsMember: false,
      };
    }
    const connections = await get(db$)
      .select({
        slackUserId: slackOrgConnections.slackUserId,
        userId: slackOrgConnections.userId,
      })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
          inArray(slackOrgConnections.slackUserId, [...listed.value]),
        ),
      );
    signal.throwIfAborted();
    const accounts = new Map(
      connections.map((connection) => {
        return [connection.slackUserId, connection.userId];
      }),
    );
    const members = listed.value.filter((id) => {
      return id !== args.slackUserId;
    });
    const recipients: ChannelRecipient[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();
    let unconfirmed = 0;
    for (let offset = 0; offset < members.length; offset += 10) {
      const access = await Promise.all(
        members
          .slice(offset, offset + 10)
          .map(async (slackUserId): Promise<MemberAccess> => {
            const profile = await settle(
              client.fetchUserIdentity(slackUserId),
              signal,
            );
            const result = await settle(
              set(
                channelMemberAccess$,
                {
                  resource: args.resource,
                  workspaceId: args.workspaceId,
                  slackUserId,
                  userId: accounts.get(slackUserId),
                  profile: profile.ok ? profile.value : undefined,
                },
                signal,
              ),
              signal,
            );
            return result.ok ? result.value : { kind: "unknown", slackUserId };
          }),
      );
      signal.throwIfAborted();
      for (const member of access) {
        if (member.kind === "unknown") {
          unresolved.push(member.slackUserId);
        }
        if (member.kind !== "recipient" || seen.has(member.value.email)) {
          continue;
        }
        seen.add(member.value.email);
        recipients.push(member.value);
        if (!member.value.recipient) {
          unconfirmed++;
        }
      }
    }
    return {
      recipients,
      unresolved,
      unconfirmed,
      complete: true,
      senderIsMember: true,
    };
  },
);

export const promptSlackArtifactChannelSharing$ = command(
  async (
    { set },
    args: SlackActor & {
      readonly channelId: string;
      readonly messageTs: string;
      readonly threadTs?: string;
      readonly urls: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const actor = await set(slackActor$, args, signal);
    if (!actor) {
      return;
    }
    const prompted = new Set<string>();
    for (const url of args.urls) {
      const resource = await set(
        resolveSlackSharingResource$,
        { url, userId: actor.userId },
        signal,
      );
      if (
        !resource ||
        resource.audience === "public" ||
        prompted.has(`${resource.kind}:${resource.id}`) ||
        !(await set(sharingEnabled$, resource, signal))
      ) {
        continue;
      }
      prompted.add(`${resource.kind}:${resource.id}`);
      const limited = await set(
        consumeHostedSiteSharingQuota$,
        { userId: resource.userId, orgId: resource.orgId, kind: "search" },
        signal,
      );
      if (limited !== null) {
        continue;
      }
      const coverage = await set(
        channelCoverage$,
        { ...args, resource, botToken: actor.botToken },
        signal,
      );
      if (
        coverage.complete &&
        (!coverage.senderIsMember ||
          (coverage.recipients.length === 0 &&
            coverage.unresolved.length === 0))
      ) {
        continue;
      }
      const token = signSlackArtifactShare({
        ...args,
        url,
        kind: resource.kind,
        id: resource.id,
        userId: resource.userId,
        orgId: resource.orgId,
      });
      const blocks = slackArtifactSharingBlocks({
        token,
        url: resource.url,
        title: resource.title,
        audience: resource.audience,
        missing: coverage.recipients.length - coverage.unconfirmed,
        unknown: coverage.unresolved.length + coverage.unconfirmed,
      });
      const result = await actor.client.postEphemeral({
        channel: args.channelId,
        user: args.slackUserId,
        text: "Some channel members may need access to your artifact.",
        threadTs: args.threadTs,
        blocks,
      });
      signal.throwIfAborted();
      if (result.kind !== "ok") {
        throw new Error(
          `Slack artifact sharing prompt failed: ${result.error}`,
        );
      }
    }
  },
);

const interactionSchema = object({
  type: literal("block_actions"),
  team: object({ id: string().min(1) }),
  user: object({ id: string().min(1) }),
  channel: object({ id: string().min(1) }),
  response_url: zUrl(),
  actions: array(
    object({
      action_id: zEnum(Object.values(SLACK_ARTIFACT_SHARE_ACTIONS)),
      value: string(),
    }),
  )
    .min(1)
    .max(1),
});

export function slackArtifactShareInteraction(payload: unknown) {
  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const action = parsed.data.actions[0];
  if (!action) {
    return null;
  }
  const state = verifySlackArtifactShare(action.value);
  if (
    !state ||
    state.workspaceId !== parsed.data.team.id ||
    state.slackUserId !== parsed.data.user.id ||
    state.channelId !== parsed.data.channel.id
  ) {
    return { kind: "invalid" as const };
  }
  const callback = new URL(parsed.data.response_url);
  if (
    callback.protocol !== "https:" ||
    !["hooks.slack.com", "hooks.slack-gov.com"].includes(callback.hostname) ||
    callback.port ||
    callback.username ||
    callback.password ||
    !callback.pathname.startsWith("/actions/")
  ) {
    return { kind: "invalid" as const };
  }
  return {
    kind: "action" as const,
    state,
    action: action.action_id,
    responseUrl: callback.href,
  };
}

export type SlackArtifactShareInteraction = Extract<
  NonNullable<ReturnType<typeof slackArtifactShareInteraction>>,
  { kind: "action" }
>;

interface SharingResult {
  readonly text: string;
  readonly outboxIds: readonly string[];
  readonly refresh: SlackArtifactShareState | null;
}

const changeSlackArtifactVisibility$ = command(
  async (
    { set },
    args: {
      readonly resource: SlackSharingResource;
      readonly state: SlackArtifactShareState;
      readonly action: SlackArtifactShareInteraction["action"];
    },
    signal: AbortSignal,
  ): Promise<SharingResult> => {
    const audience =
      args.action === SLACK_ARTIFACT_SHARE_ACTIONS.organization
        ? "organization"
        : "public";
    const changed =
      args.resource.kind === "site"
        ? await set(
            updateHostedSiteVisibility$,
            {
              siteId: args.resource.id,
              userId: args.resource.userId,
              orgId: args.resource.orgId,
              expectedRevision: args.resource.revision,
              visibility: audience,
            },
            signal,
          )
        : await set(
            updateArtifactShare$,
            {
              target: { kind: "file", id: args.resource.id },
              userId: args.resource.userId,
              orgId: args.resource.orgId,
              audience,
            },
            signal,
          );
    const success =
      changed &&
      ("audience" in changed
        ? changed.audience === audience
        : "status" in changed && changed.status === "ok");
    return {
      text: success
        ? audience === "public"
          ? "This artifact is now public. Anyone with the link can access it."
          : "This artifact is now visible to its Okou workspace. Slack channel members outside that workspace may still need invitations."
        : "Visibility could not be changed. Check the current settings and share the link again.",
      outboxIds: [],
      refresh: success && audience === "public" ? args.state : null,
    };
  },
);

const shareSlackChannelMembers$ = command(
  async (
    { set },
    args: {
      readonly resource: SlackSharingResource;
      readonly coverage: ChannelCoverage;
    },
    signal: AbortSignal,
  ): Promise<SharingResult> => {
    const outboxIds: string[] = [];
    let processed = 0;
    let attempted = 0;
    let limited =
      args.coverage.recipients.length > 0 &&
      (await set(
        consumeHostedSiteSharingQuota$,
        {
          userId: args.resource.userId,
          orgId: args.resource.orgId,
          kind: "channel-share",
        },
        signal,
      )) !== null;
    const unresolved = [...args.coverage.unresolved];
    for (const recipient of args.coverage.recipients) {
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
        unresolved.push(recipient.slackUserId);
        continue;
      }
      processed++;
      outboxIds.push(shared.value.outboxId);
    }
    const text = [
      `Access granted or invitations created for ${processed} current channel ${processed === 1 ? "member" : "members"}.`,
      ...(unresolved.length
        ? [
            `Could not finish sharing with: ${unresolved
              .map((id) => {
                return `<@${id}>`;
              })
              .join(", ")}.`,
          ]
        : []),
      ...(limited
        ? [
            `The sharing limit was reached with ${args.coverage.recipients.length - attempted} remaining. Share the link again later to finish those invitations.`,
          ]
        : []),
      ...(!processed && !unresolved.length && !limited
        ? ["All current members already have access or an invitation."]
        : []),
      "Later channel joins and departures do not change these grants.",
    ].join("\n");
    return { text, outboxIds, refresh: null };
  },
);

/** Signature verification and acknowledgement belong to the webhook entry. */
export const applySlackArtifactChannelSharing$ = command(
  async (
    { set },
    input: SlackArtifactShareInteraction,
    signal: AbortSignal,
  ): Promise<SharingResult> => {
    const state = input.state;
    const actor = await set(slackActor$, state, signal);
    const resource =
      actor?.userId === state.userId
        ? await set(ownedSlackSharingResource$, state, signal)
        : null;
    if (
      !actor ||
      !resource ||
      resource.orgId !== state.orgId ||
      !(await set(sharingEnabled$, resource, signal))
    ) {
      return {
        text: "This sharing action is no longer available. Share the link again after checking your account and permissions.",
        outboxIds: [],
        refresh: null,
      };
    }
    if (resource.audience === "public") {
      return {
        text: "This artifact is already public.",
        outboxIds: [],
        refresh: state,
      };
    }
    if (input.action !== SLACK_ARTIFACT_SHARE_ACTIONS.channel) {
      return set(
        changeSlackArtifactVisibility$,
        { resource, state, action: input.action },
        signal,
      );
    }
    const coverage = await set(
      channelCoverage$,
      { ...state, resource, botToken: actor.botToken },
      signal,
    );
    if (!coverage.complete || !coverage.senderIsMember) {
      return {
        text: "The current channel members could not be verified. No access changes were made.",
        outboxIds: [],
        refresh: null,
      };
    }
    return set(shareSlackChannelMembers$, { resource, coverage }, signal);
  },
);
