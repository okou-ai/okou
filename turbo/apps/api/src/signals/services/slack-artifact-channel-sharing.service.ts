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
import { slackArtifactPreviewBlocks } from "../../lib/slack-artifact-preview";
import {
  createSlackClient,
  unfurlSlackLinks,
  type SlackUserInfo,
} from "../external/slack-message-client";
import {
  artifactChannelMemberAccess$,
  type ChannelMemberAccess,
  type ArtifactChannelRecipient,
} from "./artifact-channel-access.service";
import { grantArtifactChannelMembers$ } from "./artifact-channel-grants.service";
import { artifactChannelPreview$ } from "./artifact-channel-preview.service";
import { slackPreviewImageUrl } from "./slack-preview-image.service";
import { settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  channelSharingResource$,
  resolveChannelSharingResource$,
  type ChannelSharingResource,
} from "./artifact-channel-resource.service";
import { consumeHostedSiteSharingQuota$ } from "./hosted-site-sharing-quota.service";
import { updateArtifactVisibility$ } from "./artifact-access.service";

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
      canUnfurl:
        scopes.includes("links:read") && scopes.includes("links:write"),
      client: createSlackClient(token, { automaticRetries: false }),
    };
  },
);

const sharingEnabled$ = command(
  async ({ set }, resource: ChannelSharingResource, signal: AbortSignal) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      resource.orgId,
      resource.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.ArtifactUserSharing, context);
  },
);

interface ChannelCoverage {
  readonly recipients: readonly ArtifactChannelRecipient[];
  readonly unresolved: readonly string[];
  readonly unconfirmed: number;
  readonly pendingInvitations: number;
  readonly complete: boolean;
  readonly senderIsMember: boolean;
}

const channelMemberAccess$ = command(
  async (
    { set },
    args: {
      readonly resource: ChannelSharingResource;
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly profile: SlackUserInfo | undefined;
      readonly userId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<ChannelMemberAccess> => {
    const profile = args.profile;
    if (!profile) {
      return { kind: "unknown", memberId: args.slackUserId };
    }
    if (profile.deleted || profile.isBot) {
      return { kind: "covered" };
    }
    return await set(
      artifactChannelMemberAccess$,
      {
        resource: args.resource,
        memberId: args.slackUserId,
        userId: profile.teamId === args.workspaceId ? args.userId : undefined,
        email: profile.email,
      },
      signal,
    );
  },
);

/** Inspect access without claiming invitations or changing any grants. */
const channelCoverage$ = command(
  async (
    { get, set },
    args: SlackActor & {
      readonly channelId: string;
      readonly resource: ChannelSharingResource;
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
        pendingInvitations: 0,
        complete: false,
        senderIsMember: false,
      };
    }
    if (!listed.value.includes(args.slackUserId)) {
      return {
        recipients: [],
        unresolved: [],
        unconfirmed: 0,
        pendingInvitations: 0,
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
    const recipients: ArtifactChannelRecipient[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();
    let unconfirmed = 0;
    let pendingInvitations = 0;
    for (let offset = 0; offset < members.length; offset += 10) {
      const access = await Promise.all(
        members
          .slice(offset, offset + 10)
          .map(async (slackUserId): Promise<ChannelMemberAccess> => {
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
            return result.ok
              ? result.value
              : { kind: "unknown", memberId: slackUserId };
          }),
      );
      signal.throwIfAborted();
      for (const member of access) {
        if (member.kind === "invited") {
          pendingInvitations++;
        }
        if (member.kind === "unknown") {
          unresolved.push(member.memberId);
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
      pendingInvitations,
      complete: true,
      senderIsMember: true,
    };
  },
);

function everyoneCanView(coverage: ChannelCoverage): boolean {
  return (
    coverage.complete &&
    coverage.senderIsMember &&
    coverage.recipients.length === 0 &&
    coverage.unresolved.length === 0 &&
    coverage.pendingInvitations === 0
  );
}

const publishSlackChannelPreview$ = command(
  async (
    { set },
    args: {
      readonly resource: ChannelSharingResource;
      readonly botToken: string;
      readonly url: string;
      readonly channelId: string;
      readonly messageTs: string;
    },
    signal: AbortSignal,
  ) => {
    const preview = await set(artifactChannelPreview$, args.resource, signal);
    if (!preview) {
      return;
    }
    await unfurlSlackLinks(
      args.botToken,
      {
        channel: args.channelId,
        ts: args.messageTs,
        unfurls: {
          [args.url]: {
            blocks: slackArtifactPreviewBlocks(args.url, {
              ...preview,
              imageUrl: preview.imageUrl
                ? slackPreviewImageUrl(preview.imageUrl)
                : null,
            }),
          },
        },
      },
      signal,
    );
  },
);

/** Rechecks live grants after an action; an invitation alone never permits a shared preview. */
export const refreshSlackArtifactChannelPreview$ = command(
  async ({ set }, state: SlackArtifactShareState, signal: AbortSignal) => {
    const actor = await set(slackActor$, state, signal);
    if (!actor?.canUnfurl || actor.userId !== state.userId) {
      return;
    }
    const resource = await set(channelSharingResource$, state, signal);
    if (
      !resource ||
      resource.audience === "public" ||
      resource.orgId !== state.orgId ||
      !(await set(sharingEnabled$, resource, signal))
    ) {
      return;
    }
    const coverage = await set(
      channelCoverage$,
      { ...state, resource, botToken: actor.botToken },
      signal,
    );
    if (everyoneCanView(coverage)) {
      await set(
        publishSlackChannelPreview$,
        { ...state, resource, botToken: actor.botToken },
        signal,
      );
    }
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
        resolveChannelSharingResource$,
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
      if (everyoneCanView(coverage)) {
        if (actor.canUnfurl) {
          await set(
            publishSlackChannelPreview$,
            { ...args, url, resource, botToken: actor.botToken },
            signal,
          );
        }
        continue;
      }
      if (coverage.complete && !coverage.senderIsMember) {
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
        unknown:
          coverage.unresolved.length +
          coverage.unconfirmed +
          coverage.pendingInvitations,
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
      readonly resource: ChannelSharingResource;
      readonly state: SlackArtifactShareState;
      readonly action: SlackArtifactShareInteraction["action"];
    },
    signal: AbortSignal,
  ): Promise<SharingResult> => {
    const audience =
      args.action === SLACK_ARTIFACT_SHARE_ACTIONS.organization
        ? "organization"
        : "public";
    const changed = await set(
      updateArtifactVisibility$,
      {
        artifactId: args.resource.artifactId,
        userId: args.resource.userId,
        orgId: args.resource.orgId,
        visibility: audience,
      },
      signal,
    );
    const success = changed.status === "ok";
    return {
      text: success
        ? audience === "public"
          ? "This artifact is now public. Anyone with the link can access it."
          : "This artifact is now visible to its Okou workspace. Slack channel members outside that workspace may still need invitations."
        : "Visibility could not be changed. Check the current settings and share the link again.",
      outboxIds: [],
      refresh: success ? args.state : null,
    };
  },
);

const shareSlackChannelMembers$ = command(
  async (
    { set },
    args: {
      readonly resource: ChannelSharingResource;
      readonly coverage: ChannelCoverage;
    },
    signal: AbortSignal,
  ): Promise<SharingResult> => {
    const { processed, unresolved, remaining, outboxIds } = await set(
      grantArtifactChannelMembers$,
      {
        resource: args.resource,
        recipients: args.coverage.recipients,
        unresolved: args.coverage.unresolved,
      },
      signal,
    );
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
      ...(remaining > 0
        ? [
            `The sharing limit was reached with ${remaining} remaining. Share the link again later to finish those invitations.`,
          ]
        : []),
      ...(!processed && !unresolved.length && remaining === 0
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
        ? await set(channelSharingResource$, state, signal)
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
    const shared = await set(
      shareSlackChannelMembers$,
      { resource, coverage },
      signal,
    );
    return { ...shared, refresh: state };
  },
);
