import { command } from "ccstate";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { literal, object, string, url, enum as zEnum } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { feishuOrgEvents } from "@okouai/db/schema/feishu-org-event";
import { db$, writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import {
  resolveFeishuRequestCredentials$,
  feishuTokenUpdateValues,
} from "../external/feishu-client";
import {
  fetchFeishuArtifactMembers,
  sendFeishuArtifactPrompt,
  uploadFeishuArtifactPreviewImage,
  type FeishuArtifactCredentials,
} from "../external/feishu-artifact-client";
import { downloadS3BufferWithMaxBytes$ } from "../external/s3";
import {
  feishuArtifactCard,
  signFeishuArtifactShare,
  verifyFeishuArtifactShare,
  FEISHU_ARTIFACT_SHARE_ACTION,
  type FeishuArtifactShareState,
} from "../../lib/feishu-artifact-sharing";
import {
  artifactChannelMemberAccess$,
  type ArtifactChannelRecipient,
} from "./artifact-channel-access.service";
import { artifactChannelPreview$ } from "./artifact-channel-preview.service";
import {
  channelSharingResource$,
  resolveChannelSharingResource$,
  type ChannelSharingResource,
} from "./artifact-channel-resource.service";
import { grantArtifactChannelMembers$ } from "./artifact-channel-grants.service";
import { consumeHostedSiteSharingQuota$ } from "./hosted-site-sharing-quota.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { updateArtifactVisibility$ } from "./artifact-access.service";
import type { FeishuInstallationConfig } from "./feishu-config";
import { settle } from "../utils";

const previewEventSchema = object({
  operator: object({ open_id: string().min(1), tenant_key: string().min(1) }),
  host: literal("im_message"),
  context: object({
    url: url(),
    preview_token: string().min(1),
    open_message_id: string().min(1),
    open_chat_id: string().min(1),
  }),
});

const actor$ = command(
  async (
    { get },
    args: { readonly installationId: string; readonly openId: string },
    signal: AbortSignal,
  ) => {
    const [connection] = await get(db$)
      .select({ userId: feishuOrgConnections.userId })
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, args.installationId),
          eq(feishuOrgConnections.feishuOpenId, args.openId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return null;
    }
    const user = await findClerkUser(get(clerk$), connection.userId, signal);
    return user && !user.banned ? connection : null;
  },
);

const enabled$ = command(
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

export const feishuArtifactSharingCredentials$ = command(
  async ({ get, set }, installationId: string, signal: AbortSignal) => {
    const [installation] = await get(db$)
      .select()
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.id, installationId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return null;
    }
    const credentials = await set(
      resolveFeishuRequestCredentials$,
      installation,
      signal,
    );
    if (credentials.refreshedToken) {
      await set(writeDb$)
        .update(feishuOrgInstallations)
        .set(feishuTokenUpdateValues(credentials.refreshedToken))
        .where(eq(feishuOrgInstallations.id, installation.id));
      signal.throwIfAborted();
    }
    return credentials.context;
  },
);

interface FeishuCoverage {
  readonly recipients: readonly ArtifactChannelRecipient[];
  readonly unresolved: readonly string[];
  readonly complete: boolean;
  readonly canPrompt: boolean;
}

const coverage$ = command(
  async (
    { get, set },
    args: {
      readonly credentials: FeishuArtifactCredentials;
      readonly resource: ChannelSharingResource;
      readonly installationId: string;
      readonly openId: string;
      readonly chatId: string;
    },
    signal: AbortSignal,
  ): Promise<FeishuCoverage> => {
    const listed = await settle(
      fetchFeishuArtifactMembers(args.credentials, args.chatId, signal),
      signal,
    );
    if (!listed.ok || !listed.value?.includes(args.openId)) {
      return {
        complete: false,
        canPrompt: !listed.ok,
        recipients: [],
        unresolved: [],
      };
    }
    const connections = await get(db$)
      .select({
        openId: feishuOrgConnections.feishuOpenId,
        userId: feishuOrgConnections.userId,
      })
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, args.installationId),
          inArray(feishuOrgConnections.feishuOpenId, [...listed.value]),
        ),
      );
    signal.throwIfAborted();
    const members = new Map(
      connections.map((connection) => {
        return [connection.openId, connection.userId];
      }),
    );
    const recipients: ArtifactChannelRecipient[] = [];
    const unresolved: string[] = [];
    const emails = new Set<string>();
    for (const openId of listed.value) {
      if (openId === args.openId) {
        continue;
      }
      const result = await settle(
        set(
          artifactChannelMemberAccess$,
          {
            resource: args.resource,
            memberId: openId,
            userId: members.get(openId),
            email: undefined,
          },
          signal,
        ),
        signal,
      );
      if (
        !result.ok ||
        result.value.kind === "unknown" ||
        result.value.kind === "invited"
      ) {
        unresolved.push(openId);
        continue;
      }
      if (
        result.value.kind === "recipient" &&
        !emails.has(result.value.value.email)
      ) {
        emails.add(result.value.value.email);
        recipients.push(result.value.value);
      }
    }
    return { complete: true, canPrompt: true, recipients, unresolved };
  },
);

export const promptFeishuArtifactSharing$ = command(
  async (
    { get, set },
    state: FeishuArtifactShareState,
    signal: AbortSignal,
  ) => {
    const actor = await set(
      actor$,
      { installationId: state.installationId, openId: state.openId },
      signal,
    );
    const resource =
      actor?.userId === state.userId
        ? await set(channelSharingResource$, state, signal)
        : null;
    if (
      !resource ||
      resource.orgId !== state.orgId ||
      resource.audience === "public" ||
      !(await set(enabled$, resource, signal))
    ) {
      return;
    }
    // A reader may pull the same preview repeatedly. Send one owner prompt per message and artifact.
    const receiptId = `artifact-sharing:${createHash("sha256")
      .update(
        JSON.stringify([state.chatId, state.messageId, state.kind, state.id]),
      )
      .digest("hex")}`;
    const [existing] = await get(db$)
      .select({ eventId: feishuOrgEvents.eventId })
      .from(feishuOrgEvents)
      .where(
        and(
          eq(feishuOrgEvents.installationId, state.installationId),
          eq(feishuOrgEvents.eventId, receiptId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      return;
    }
    const limited = await set(
      consumeHostedSiteSharingQuota$,
      { userId: resource.userId, orgId: resource.orgId, kind: "search" },
      signal,
    );
    if (limited !== null) {
      return;
    }
    const credentials = await set(
      feishuArtifactSharingCredentials$,
      state.installationId,
      signal,
    );
    if (!credentials) {
      return;
    }
    const coverage = await set(
      coverage$,
      { ...state, resource, credentials },
      signal,
    );
    if (!coverage.canPrompt) {
      return;
    }
    if (
      coverage.complete &&
      coverage.recipients.length === 0 &&
      coverage.unresolved.length === 0
    ) {
      return;
    }
    const [receipt] = await set(writeDb$)
      .insert(feishuOrgEvents)
      .values({ installationId: state.installationId, eventId: receiptId })
      .onConflictDoNothing()
      .returning({ eventId: feishuOrgEvents.eventId });
    signal.throwIfAborted();
    if (!receipt) {
      return;
    }
    await sendFeishuArtifactPrompt(
      credentials,
      {
        chatId: state.chatId,
        openId: state.openId,
        card: feishuArtifactCard({
          title: resource.title,
          text: coverage.complete
            ? `${coverage.recipients.length} chat members need access. Access could not be confirmed for ${coverage.unresolved.length} members. Later joins and departures do not change grants.`
            : "Current chat members could not be verified. No access changes have been made.",
          share: {
            token: signFeishuArtifactShare(state),
            audience: resource.audience,
          },
        }),
      },
      signal,
    );
  },
);

/** Feishu/Lark request previews independently for each viewer; never reuse an owner's result for other viewers. */
export const prepareFeishuArtifactPreview$ = command(
  async (
    { set },
    args: {
      readonly event: unknown;
      readonly tenantKey: string;
      readonly config: FeishuInstallationConfig;
    },
    signal: AbortSignal,
  ) => {
    const parsed = previewEventSchema.safeParse(args.event);
    if (
      !parsed.success ||
      parsed.data.operator.tenant_key !== args.tenantKey ||
      (args.config.tenantKey !== null &&
        args.config.tenantKey !== args.tenantKey)
    ) {
      return { body: {}, resource: null, prompt: null };
    }
    const event = parsed.data;
    const actor = await set(
      actor$,
      { installationId: args.config.id, openId: event.operator.open_id },
      signal,
    );
    const resource = await set(
      resolveChannelSharingResource$,
      { url: event.context.url },
      signal,
    );
    if (!resource || !(await set(enabled$, resource, signal))) {
      return { body: {}, resource: null, prompt: null };
    }
    const access = actor
      ? await set(
          artifactChannelMemberAccess$,
          {
            resource,
            memberId: event.operator.open_id,
            userId: actor.userId,
            email: undefined,
          },
          signal,
        )
      : null;
    if (access?.kind !== "covered" && resource.audience !== "public") {
      return {
        body: {
          inline: {
            title: actor ? "Access required" : "Sign in to Okou to view",
          },
        },
        resource: null,
        prompt: null,
      };
    }
    const state: FeishuArtifactShareState = {
      installationId: args.config.id,
      tenantKey: args.tenantKey,
      openId: event.operator.open_id,
      chatId: event.context.open_chat_id,
      messageId: event.context.open_message_id,
      previewToken: event.context.preview_token,
      url: event.context.url,
      kind: resource.kind,
      id: resource.id,
      userId: resource.userId,
      orgId: resource.orgId,
    };
    return {
      body: {},
      resource,
      prompt: actor?.userId === resource.userId ? state : null,
    };
  },
);

/** Render only after the callback has authorized the resource for its current reader. */
export const renderFeishuArtifactPreview$ = command(
  async (
    { set },
    args: {
      readonly resource: ChannelSharingResource;
      readonly installationId: string;
    },
    signal: AbortSignal,
  ) => {
    const resource = args.resource;
    const preview = await set(artifactChannelPreview$, resource, signal);
    if (!preview) {
      return {};
    }
    const credentials = await set(
      feishuArtifactSharingCredentials$,
      args.installationId,
      signal,
    );
    if (!credentials) {
      return {};
    }
    let imageKey: string | undefined;
    if (preview.image) {
      const bytes = await set(
        downloadS3BufferWithMaxBytes$,
        { ...preview.image, maxBytes: 10 * 1024 * 1024 },
        signal,
      );
      imageKey = await uploadFeishuArtifactPreviewImage(
        credentials,
        bytes,
        preview.image.contentType,
        signal,
      );
    }
    return {
      inline: { title: preview.title },
      card: {
        type: "raw",
        data: feishuArtifactCard({
          title: preview.title,
          text: preview.description,
          url: resource.url,
          imageKey,
        }),
      },
    };
  },
);

const actionSchema = object({
  operator: object({ open_id: string().min(1) }),
  context: object({ open_chat_id: string().min(1) }),
  token: string().min(1),
  action: object({
    value: object({
      action: literal(FEISHU_ARTIFACT_SHARE_ACTION),
      token: string(),
      audience: zEnum(["channel", "organization", "public"]),
    }),
  }),
});

export function feishuArtifactSharingAction(
  event: unknown,
  config: FeishuInstallationConfig,
  tenantKey: string,
) {
  const parsed = actionSchema.safeParse(event);
  if (!parsed.success) {
    return null;
  }
  const state = verifyFeishuArtifactShare(parsed.data.action.value.token);
  if (
    !state ||
    state.installationId !== config.id ||
    state.tenantKey !== tenantKey ||
    state.openId !== parsed.data.operator.open_id ||
    state.chatId !== parsed.data.context.open_chat_id
  ) {
    return { kind: "invalid" as const };
  }
  return {
    kind: "action" as const,
    state,
    audience: parsed.data.action.value.audience,
    updateToken: parsed.data.token,
  };
}
export type FeishuArtifactSharingAction = Extract<
  NonNullable<ReturnType<typeof feishuArtifactSharingAction>>,
  { kind: "action" }
>;

export const applyFeishuArtifactSharing$ = command(
  async (
    { set },
    input: FeishuArtifactSharingAction & {
      readonly credentials: FeishuArtifactCredentials;
    },
    signal: AbortSignal,
  ) => {
    const state = input.state;
    const actor = await set(
      actor$,
      { installationId: state.installationId, openId: state.openId },
      signal,
    );
    const resource =
      actor?.userId === state.userId
        ? await set(channelSharingResource$, state, signal)
        : null;
    const credentials = input.credentials;
    if (
      !resource ||
      resource.orgId !== state.orgId ||
      !(await set(enabled$, resource, signal))
    ) {
      return {
        text: "This sharing action is no longer available. Share the link again.",
        outboxIds: [],
        refresh: false,
      };
    }
    if (resource.audience === "public") {
      return {
        text: "This artifact is already public.",
        outboxIds: [],
        refresh: false,
      };
    }
    if (input.audience !== "channel") {
      const audience = input.audience;
      const changed = await set(
        updateArtifactVisibility$,
        {
          artifactId: resource.artifactId,
          userId: resource.userId,
          orgId: resource.orgId,
          visibility: audience,
        },
        signal,
      );
      const success = changed.status === "ok";
      return {
        text: success
          ? `Artifact visibility is now ${audience}.`
          : "Visibility could not be changed. Check the current settings and share the link again.",
        outboxIds: [],
        refresh: success,
      };
    }
    const coverage = await set(
      coverage$,
      { ...state, resource, credentials },
      signal,
    );
    if (!coverage.complete) {
      return {
        text: "Current chat members could not be verified. No access changes were made.",
        outboxIds: [],
        refresh: false,
      };
    }
    const shared = await set(
      grantArtifactChannelMembers$,
      { resource, ...coverage },
      signal,
    );
    return {
      text: `Access granted or invitations created for ${shared.processed} current chat members. ${shared.unresolved.length} could not be verified. ${shared.remaining} remain due to sharing limits. Later joins and departures do not change access.`,
      outboxIds: shared.outboxIds,
      refresh: shared.processed > 0,
    };
  },
);
