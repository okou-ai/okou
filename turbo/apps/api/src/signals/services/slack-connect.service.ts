import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { command, computed, type Computed } from "ccstate";
import type { SlackConnectLinkStatus } from "@okouai/api-contracts/contracts/slack-connect";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq, isNull, ne, or } from "drizzle-orm";

import {
  buildAppHomeView,
  buildSuccessMessage,
  buildWelcomeMessage,
} from "../../lib/slack-connect-blocks";
import { env } from "../../lib/env";
import { officialSlackBotMention } from "../../lib/slack-official-app";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { publishUserSignal } from "../external/realtime";
import {
  createSlackClient,
  type SlackClient,
} from "../external/slack-message-client";
import { db$, writeDb$ } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { slackAccountConnection } from "./slack-workspace-identity.service";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { settle } from "../utils";
import { logger } from "../../lib/log";

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
const L = logger("SlackConnect");

async function getPrimaryUserEmail(
  clerkClient: ReturnType<typeof clerk$.read>,
  userId: string,
): Promise<string | undefined> {
  const user = await findClerkUser(clerkClient, userId);
  const primaryEmailAddressId = user?.primaryEmailAddressId;
  const email = user?.emailAddresses.find((candidate) => {
    return candidate.id === primaryEmailAddressId;
  });
  return email?.emailAddress;
}

function buildSlackConnectUrl(
  workspaceId: string,
  slackUserId: string,
): string {
  const params = new URLSearchParams({ w: workspaceId, u: slackUserId });
  return `${env("APP_URL")}${INTEGRATION_SETTINGS_PATHS.slack}?${params.toString()}`;
}

const refreshSlackAppHome$ = command(
  async (
    { get },
    args: {
      readonly clerkClient: ReturnType<typeof clerk$.read>;
      readonly client: SlackClient;
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
    },
  ): Promise<void> => {
    const db = get(db$);

    const [connection] = await db
      .select()
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackUserId, args.slackUserId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            args.installation.slackWorkspaceId,
          ),
        ),
      )
      .limit(1);

    if (!connection) {
      await args.client.publishAppHome(
        args.slackUserId,
        buildAppHomeView({
          botUserId: args.installation.botUserId,
          appUrl: env("APP_URL"),
          isLinked: false,
          loginUrl: buildSlackConnectUrl(
            args.installation.slackWorkspaceId,
            args.slackUserId,
          ),
        }),
      );
      return;
    }

    let agentName: string | undefined;
    if (args.installation.orgId) {
      const [metadata] = await db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.installation.orgId))
        .limit(1);
      const defaultAgentId = metadata?.defaultAgentId ?? null;
      if (defaultAgentId) {
        const [agent] = await db
          .select({ name: agents.name, displayName: agents.displayName })
          .from(agents)
          .where(eq(agents.id, defaultAgentId))
          .limit(1);
        agentName = agent?.displayName ?? agent?.name;
      }
    }

    await args.client.publishAppHome(
      args.slackUserId,
      buildAppHomeView({
        botUserId: args.installation.botUserId,
        appUrl: env("APP_URL"),
        isLinked: true,
        userId: connection.userId,
        userEmail: await getPrimaryUserEmail(
          args.clerkClient,
          connection.userId,
        ),
        agentName,
      }),
    );
  },
);

function slackAccountLinkStatus(
  connection: { readonly slackUserId: string } | undefined,
  requestedSlackUserId: string,
): SlackConnectLinkStatus {
  if (connection?.slackUserId === requestedSlackUserId) {
    return { kind: "connected" };
  }
  if (connection) {
    return {
      kind: "slack_account_mismatch",
      currentSlackUserId: connection.slackUserId,
      requestedSlackUserId,
    };
  }
  return { kind: "connect" };
}

function slackConnectLinkStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId?: string;
  readonly slackUserId?: string;
}): Computed<Promise<SlackConnectLinkStatus | undefined>> {
  const identity$ = computed(() => {
    return {
      orgId: args.orgId,
      userId: args.userId,
    };
  });
  const account$ = slackAccountConnection(identity$);
  return computed(async (get): Promise<SlackConnectLinkStatus | undefined> => {
    if (!args.workspaceId || !args.slackUserId) {
      return undefined;
    }

    return slackAccountLinkStatus(
      (await get(account$))?.connection,
      args.slackUserId,
    );
  });
}

interface SlackConnectStatusArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}

interface SlackConnectLinkStatusArgs extends SlackConnectStatusArgs {
  readonly workspaceId: string;
  readonly slackUserId: string;
}

interface SlackConnectStatusResponse {
  readonly isConnected: boolean;
  readonly isAdmin: boolean;
  readonly workspaceName?: string | null;
  readonly defaultAgentName?: string | null;
}

export function slackConnectStatus(
  args: SlackConnectLinkStatusArgs,
): Computed<
  Promise<
    SlackConnectStatusResponse & { readonly linkStatus: SlackConnectLinkStatus }
  >
>;
export function slackConnectStatus(
  args: SlackConnectStatusArgs,
): Computed<Promise<SlackConnectStatusResponse>>;
export function slackConnectStatus(
  args: SlackConnectStatusArgs & {
    readonly workspaceId?: string;
    readonly slackUserId?: string;
  },
): Computed<
  Promise<
    SlackConnectStatusResponse & {
      readonly linkStatus?: SlackConnectLinkStatus;
    }
  >
> {
  const identity$ = computed(() => {
    return {
      orgId: args.orgId,
      userId: args.userId,
    };
  });
  const account$ = slackAccountConnection(identity$);
  const orgInstallation$ = computed(async (get) => {
    const [orgInstallation] = await get(db$)
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);
    return orgInstallation;
  });
  const linkStatus$ = slackConnectLinkStatus(args);

  return computed(async (get) => {
    const db = get(db$);
    const orgInstallation = await get(orgInstallation$);
    const linkStatus = await get(linkStatus$);

    const account = await get(account$);
    const connection = account?.connection;

    if (!connection) {
      return {
        isConnected: false,
        isAdmin: args.isAdmin,
        ...(linkStatus ? { linkStatus } : {}),
      };
    }

    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);

    const [agent] = metadata?.defaultAgentId
      ? await db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, metadata.defaultAgentId))
          .limit(1)
      : [];

    return {
      isConnected: true,
      workspaceName:
        account?.connection.slackWorkspaceName ??
        orgInstallation?.slackWorkspaceName ??
        null,
      isAdmin: args.isAdmin,
      defaultAgentName: agent?.name ?? null,
      ...(linkStatus ? { linkStatus } : {}),
    };
  });
}

export const publishSlackAdminSignal$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly topic: string;
      readonly payload?: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const admins = await db
      .select({ userId: orgMembersCache.userId })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, args.orgId),
          eq(orgMembersCache.role, "admin"),
        ),
      );
    signal.throwIfAborted();

    await publishUserSignal(
      admins.map((admin) => {
        return admin.userId;
      }),
      args.topic,
      args.payload,
    );
    signal.throwIfAborted();
  },
);

export interface SlackConnectNotificationArgs {
  readonly installation: SlackInstallation;
  readonly slackUserId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly channelId?: string;
  readonly threadTs?: string;
  readonly pendingPrompt?: string;
  readonly replacedSlackUserIds?: readonly string[];
}

export const notifySlackConnect$ = command(
  async (
    { get, set },
    args: SlackConnectNotificationArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const client = createSlackClient(
      await decryptPersistentSecretValue(
        args.installation.encryptedBotToken,
        await get(userFeatureSwitchContext(args.orgId, args.userId)),
      ),
    );
    const [connection] = await writeDb
      .select({
        id: slackOrgConnections.id,
        dmWelcomeSent: slackOrgConnections.dmWelcomeSent,
        agentName: agents.name,
        agentDisplayName: agents.displayName,
      })
      .from(slackOrgConnections)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, args.orgId))
      .leftJoin(
        agents,
        and(
          eq(agents.id, orgMetadata.defaultAgentId),
          eq(agents.orgId, args.orgId),
        ),
      )
      .where(
        and(
          eq(slackOrgConnections.userId, args.userId),
          eq(slackOrgConnections.slackUserId, args.slackUserId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            args.installation.slackWorkspaceId,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const agentName =
      connection?.agentDisplayName ?? connection?.agentName ?? undefined;
    const { assistantName } = BRAND_PRESENTATION;

    const blocks = buildSuccessMessage(
      `You're connected to ${assistantName}! :tada:\nMention ${officialSlackBotMention(args.installation.botUserId)} in any channel or send a DM to start chatting with your agent.`,
    );

    let sentEphemeral = false;
    if (args.channelId) {
      const result = await client.postEphemeral({
        channel: args.channelId,
        user: args.slackUserId,
        text: "You're connected!",
        blocks,
        threadTs: args.threadTs,
      });
      signal.throwIfAborted();
      sentEphemeral = result.kind === "ok";
    }

    if (connection && !connection.dmWelcomeSent) {
      let threadTs: string | undefined;
      if (!sentEphemeral) {
        const connectMessage = await client.postMessage(
          args.slackUserId,
          "You're connected!",
          { blocks },
        );
        signal.throwIfAborted();
        if (connectMessage.kind === "ok") {
          threadTs = connectMessage.ts;
        }
      }
      const welcome = await client.postMessage(
        args.slackUserId,
        `Hi! I'm ${officialSlackBotMention(args.installation.botUserId)}.`,
        {
          threadTs,
          blocks: buildWelcomeMessage(args.installation.botUserId, agentName),
        },
      );
      signal.throwIfAborted();
      if (welcome.kind === "ok") {
        await writeDb
          .update(slackOrgConnections)
          .set({ dmWelcomeSent: true })
          .where(eq(slackOrgConnections.id, connection.id));
        signal.throwIfAborted();
        if (args.pendingPrompt) {
          const safePrompt = `\`\`\`${args.pendingPrompt.replaceAll("`", "'")}\`\`\``;
          await client.postMessage(
            args.slackUserId,
            `By the way, would you like me to run this for you?\n\n${safePrompt}\n\nJust paste it in a message and I'll get started!`,
            { threadTs: threadTs ?? welcome.ts },
          );
          signal.throwIfAborted();
        }
      }
    }

    for (const replacedSlackUserId of args.replacedSlackUserIds ?? []) {
      await set(refreshSlackAppHome$, {
        clerkClient: get(clerk$),
        client,
        installation: args.installation,
        slackUserId: replacedSlackUserId,
      });
      signal.throwIfAborted();
    }

    await set(refreshSlackAppHome$, {
      clerkClient: get(clerk$),
      client,
      installation: args.installation,
      slackUserId: args.slackUserId,
    });
    signal.throwIfAborted();
  },
);

/** Pending welcomes cannot borrow the bot from a different Okou workspace. */
export const notifyPendingSlackConnectWelcomes$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly workspaceId: string;
      readonly userId?: string;
      readonly excludeUserId?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const rows = await set(writeDb$)
      .select({
        connection: slackOrgConnections,
        installation: slackOrgInstallations,
      })
      .from(slackOrgConnections)
      .innerJoin(
        slackOrgInstallations,
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
      )
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
          eq(slackOrgInstallations.orgId, args.orgId),
          or(
            eq(slackOrgConnections.orgId, args.orgId),
            isNull(slackOrgConnections.orgId),
          ),
          args.userId ? eq(slackOrgConnections.userId, args.userId) : undefined,
          args.excludeUserId
            ? ne(slackOrgConnections.userId, args.excludeUserId)
            : undefined,
          eq(slackOrgConnections.dmWelcomeSent, false),
        ),
      );
    signal.throwIfAborted();
    for (const { connection, installation } of rows) {
      const membership = await set(
        getMemberRoleAndUpdateCache$,
        args.orgId,
        connection.userId,
        signal,
      );
      if (membership.kind !== "member") {
        continue;
      }
      const result = await settle(
        set(
          notifySlackConnect$,
          {
            installation,
            slackUserId: connection.slackUserId,
            orgId: args.orgId,
            userId: connection.userId,
          },
          signal,
        ),
        signal,
      );
      if (!result.ok) {
        L.warn("Failed to deliver pending Slack connect welcome", {
          connectionId: connection.id,
          error: result.error,
        });
      }
    }
  },
);
