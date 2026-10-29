import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { command, computed, type Computed } from "ccstate";
import type { SlackConnectLinkStatus } from "@okouai/api-contracts/contracts/slack-connect";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

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

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;

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

export const notifySlackConnect$ = command(
  async (
    { get, set },
    args: {
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
      readonly pendingPrompt?: string;
      readonly replacedSlackUserIds?: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const client = createSlackClient(
      await decryptPersistentSecretValue(
        args.installation.encryptedBotToken,
        await get(userFeatureSwitchContext(args.orgId, args.userId)),
      ),
    );
    const [metadata] = await writeDb
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    const defaultAgentId = metadata?.defaultAgentId ?? null;
    const [agent] = defaultAgentId
      ? await writeDb
          .select({ name: agents.name, displayName: agents.displayName })
          .from(agents)
          .where(eq(agents.id, defaultAgentId))
          .limit(1)
      : [];
    signal.throwIfAborted();
    const agentName = agent?.displayName ?? agent?.name;
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

    if (!sentEphemeral) {
      const connectMessage = await client.postMessage(
        args.slackUserId,
        "You're connected!",
        { blocks },
      );
      signal.throwIfAborted();
      if (connectMessage.kind === "ok") {
        await client.postMessage(
          args.slackUserId,
          `Hi! I'm ${officialSlackBotMention(args.installation.botUserId)}.`,
          {
            threadTs: connectMessage.ts,
            blocks: buildWelcomeMessage(args.installation.botUserId, agentName),
          },
        );
        signal.throwIfAborted();

        if (args.pendingPrompt) {
          const safePrompt = `\`\`\`${args.pendingPrompt.replaceAll("`", "'")}\`\`\``;
          await client.postMessage(
            args.slackUserId,
            `By the way, would you like me to run this for you?\n\n${safePrompt}\n\nJust paste it in a message and I'll get started!`,
            { threadTs: connectMessage.ts },
          );
          signal.throwIfAborted();
        }

        await writeDb
          .update(slackOrgConnections)
          .set({ dmWelcomeSent: true })
          .where(
            and(
              eq(slackOrgConnections.slackUserId, args.slackUserId),
              eq(
                slackOrgConnections.slackWorkspaceId,
                args.installation.slackWorkspaceId,
              ),
            ),
          );
        signal.throwIfAborted();
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
