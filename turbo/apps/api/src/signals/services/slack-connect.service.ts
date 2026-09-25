import { awardCompletedGetStartedQuest } from "./get-started-rewards.service";
import { command, computed, type Computed } from "ccstate";
import type { SlackConnectLinkStatus } from "@okouai/api-contracts/contracts/slack-connect";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { slackUserAgentPreferences } from "@okouai/db/schema/slack-user-agent-preference";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

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
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;

type ConnectResult =
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly connectionId: string;
      readonly role: "admin" | "member";
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
      readonly replacedSlackUserIds: readonly string[];
    };

const workspaceNotFoundMessage =
  "Workspace not found. Please install the Slack app first.";
const adminRequiredMessage =
  "Only org admins can connect an unconfigured workspace. Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Slack workspace. Please switch to the correct organization in the platform sidebar before connecting.";
const slackAccountInUseMessage =
  "This Slack account is already connected to another user.";
const slackAccountMismatchMessage =
  "Your Okou account is connected to a different Slack account in this workspace.";

type SlackConnectionWriteResult =
  | {
      readonly kind: "ok";
      readonly connectionId: string;
      readonly replacedSlackUserIds: readonly string[];
    }
  | { readonly kind: "forbidden"; readonly message: string };

async function connectSlackUser(
  tx: Tx,
  args: {
    readonly slackUserId: string;
    readonly slackWorkspaceId: string;
    readonly userId: string;
    readonly connectionIntent: "connect" | "switch";
  },
): Promise<SlackConnectionWriteResult> {
  const [targetConnection] = await tx
    .select({ id: slackOrgConnections.id, userId: slackOrgConnections.userId })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, args.slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, args.slackWorkspaceId),
      ),
    )
    .limit(1);

  if (targetConnection && targetConnection.userId !== args.userId) {
    return { kind: "forbidden", message: slackAccountInUseMessage };
  }

  const currentConnections = await tx
    .select({
      id: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
    })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.userId, args.userId),
        eq(slackOrgConnections.slackWorkspaceId, args.slackWorkspaceId),
      ),
    );
  const staleConnections = currentConnections.filter((connection) => {
    return connection.slackUserId !== args.slackUserId;
  });

  if (staleConnections.length > 0 && args.connectionIntent !== "switch") {
    return { kind: "forbidden", message: slackAccountMismatchMessage };
  }

  let connectionId = targetConnection?.id;
  if (!connectionId) {
    const [inserted] = await tx
      .insert(slackOrgConnections)
      .values({
        slackUserId: args.slackUserId,
        slackWorkspaceId: args.slackWorkspaceId,
        userId: args.userId,
      })
      .onConflictDoNothing({
        target: [
          slackOrgConnections.slackUserId,
          slackOrgConnections.slackWorkspaceId,
        ],
      })
      .returning({ id: slackOrgConnections.id });
    connectionId = inserted?.id;
  }

  if (!connectionId) {
    const [existing] = await tx
      .select({
        id: slackOrgConnections.id,
        userId: slackOrgConnections.userId,
      })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackUserId, args.slackUserId),
          eq(slackOrgConnections.slackWorkspaceId, args.slackWorkspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error("Slack connection insert did not return a row");
    }
    if (existing.userId !== args.userId) {
      return { kind: "forbidden", message: slackAccountInUseMessage };
    }
    connectionId = existing.id;
  }

  if (staleConnections.length > 0) {
    await tx.delete(slackOrgConnections).where(
      inArray(
        slackOrgConnections.id,
        staleConnections.map((connection) => {
          return connection.id;
        }),
      ),
    );
  }

  return {
    kind: "ok",
    connectionId,
    replacedSlackUserIds: staleConnections.map((connection) => {
      return connection.slackUserId;
    }),
  };
}

async function resolveDefaultComposeId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function getUserAgentPreference(
  db: Db,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [preference] = await db
    .select({ selectedAgentId: slackUserAgentPreferences.selectedAgentId })
    .from(slackUserAgentPreferences)
    .where(
      and(
        eq(slackUserAgentPreferences.userId, userId),
        eq(slackUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return preference?.selectedAgentId ?? null;
}

async function resolveEffectiveComposeId(
  db: Db,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const override = await getUserAgentPreference(db, userId, orgId);
  if (override) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, override), eq(agents.orgId, orgId)))
      .limit(1);
    if (agent?.id) {
      return override;
    }
  }
  return resolveDefaultComposeId(db, orgId);
}

async function getWorkspaceAgentName(
  db: Db,
  composeId: string,
): Promise<string | undefined> {
  const [agent] = await db
    .select({ name: agents.name, displayName: agents.displayName })
    .from(agents)
    .where(eq(agents.id, composeId))
    .limit(1);
  return agent?.displayName ?? agent?.name;
}

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
  return `${env("APP_URL")}/settings/slack?${params.toString()}`;
}

async function refreshSlackAppHome(args: {
  readonly db: Db;
  readonly clerkClient: ReturnType<typeof clerk$.read>;
  readonly client: SlackClient;
  readonly installation: SlackInstallation;
  readonly slackUserId: string;
}): Promise<void> {
  const [connection] = await args.db
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
  let isOverrideActive = false;
  let canSwitch = false;
  if (args.installation.orgId) {
    const [effectiveComposeId, overrideComposeId, defaultAgentId] =
      await Promise.all([
        resolveEffectiveComposeId(
          args.db,
          connection.userId,
          args.installation.orgId,
        ),
        getUserAgentPreference(
          args.db,
          connection.userId,
          args.installation.orgId,
        ),
        resolveDefaultComposeId(args.db, args.installation.orgId),
      ]);

    if (effectiveComposeId) {
      agentName = await getWorkspaceAgentName(args.db, effectiveComposeId);
    }
    isOverrideActive = Boolean(
      overrideComposeId && overrideComposeId !== defaultAgentId,
    );
    canSwitch = Boolean(defaultAgentId);
  }

  await args.client.publishAppHome(
    args.slackUserId,
    buildAppHomeView({
      botUserId: args.installation.botUserId,
      appUrl: env("APP_URL"),
      isLinked: true,
      userId: connection.userId,
      userEmail: await getPrimaryUserEmail(args.clerkClient, connection.userId),
      agentName,
      isOverrideActive,
      canSwitch,
    }),
  );
}

async function resolveSlackConnectLinkStatus(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly isAdmin: boolean;
    readonly workspaceId?: string;
    readonly slackUserId?: string;
  },
  orgInstallation: SlackInstallation | undefined,
): Promise<SlackConnectLinkStatus | undefined> {
  if (!args.workspaceId || !args.slackUserId) {
    return undefined;
  }

  const [requestedInstallation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
    .limit(1);
  const currentWorkspaceName =
    orgInstallation?.slackWorkspaceId === args.workspaceId
      ? undefined
      : orgInstallation?.slackWorkspaceName;

  if (
    !requestedInstallation ||
    (requestedInstallation.orgId !== null &&
      requestedInstallation.orgId !== args.orgId) ||
    (requestedInstallation.orgId === null &&
      ((orgInstallation &&
        orgInstallation.slackWorkspaceId !== args.workspaceId) ||
        !args.isAdmin))
  ) {
    return {
      kind: "workspace_mismatch",
      ...(currentWorkspaceName !== undefined ? { currentWorkspaceName } : {}),
    };
  }

  const [requestedConnection] = await db
    .select({ userId: slackOrgConnections.userId })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        eq(slackOrgConnections.slackUserId, args.slackUserId),
      ),
    )
    .limit(1);
  if (requestedConnection && requestedConnection.userId !== args.userId) {
    return { kind: "slack_account_in_use" };
  }
  const [currentConnection] = await db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.userId, args.userId),
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        ne(slackOrgConnections.slackUserId, args.slackUserId),
      ),
    )
    .limit(1);
  if (currentConnection) {
    return {
      kind: "slack_account_mismatch",
      currentSlackUserId: currentConnection.slackUserId,
      requestedSlackUserId: args.slackUserId,
    };
  }
  if (requestedConnection?.userId === args.userId) {
    return { kind: "connected" };
  }

  return { kind: "connect" };
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
  return computed(async (get) => {
    const db = get(db$);
    const [orgInstallation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);
    const linkStatus = await resolveSlackConnectLinkStatus(
      db,
      args,
      orgInstallation,
    );

    const [connection] = orgInstallation
      ? await db
          .select()
          .from(slackOrgConnections)
          .where(
            and(
              eq(slackOrgConnections.userId, args.userId),
              eq(
                slackOrgConnections.slackWorkspaceId,
                orgInstallation.slackWorkspaceId,
              ),
            ),
          )
          .limit(1)
      : [];

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
      workspaceName: orgInstallation?.slackWorkspaceName ?? null,
      isAdmin: args.isAdmin,
      defaultAgentName: agent?.name ?? null,
      ...(linkStatus ? { linkStatus } : {}),
    };
  });
}

export const connectSlackWorkspace$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly orgRole: "admin" | "member";
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
      readonly pendingPrompt?: string;
      readonly connectionIntent: "connect" | "switch";
    },
    signal: AbortSignal,
  ): Promise<ConnectResult> => {
    const writeDb = set(writeDb$);
    signal.throwIfAborted();
    const result = await writeDb.transaction(
      async (tx): Promise<ConnectResult> => {
        const [installation] = await tx
          .select()
          .from(slackOrgInstallations)
          .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
          .for("update")
          .limit(1);

        if (!installation) {
          return { kind: "not_found", message: workspaceNotFoundMessage };
        }

        if (installation.orgId === null && args.orgRole !== "admin") {
          return { kind: "forbidden", message: adminRequiredMessage };
        }
        if (installation.orgId !== null && installation.orgId !== args.orgId) {
          return { kind: "forbidden", message: orgMismatchMessage };
        }

        const connection = await connectSlackUser(tx, {
          slackUserId: args.slackUserId,
          slackWorkspaceId: args.workspaceId,
          userId: args.userId,
          connectionIntent: args.connectionIntent,
        });
        if (connection.kind !== "ok") {
          return connection;
        }

        let boundInstallation = installation;
        let role = args.orgRole;
        if (installation.orgId === null) {
          const [updated] = await tx
            .update(slackOrgInstallations)
            .set({
              orgId: args.orgId,
              installedByUserId: args.userId,
              updatedAt: nowDate(),
            })
            .where(
              and(
                eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId),
                isNull(slackOrgInstallations.orgId),
              ),
            )
            .returning();
          if (!updated) {
            throw new Error("Locked Slack installation could not be bound");
          }
          await awardCompletedGetStartedQuest(tx, {
            orgId: args.orgId,
            userId: args.userId,
            questKey: "slack",
            sourceKey: args.workspaceId,
          });
          boundInstallation = updated;
          role = "admin";
        }

        return {
          kind: "ok",
          connectionId: connection.connectionId,
          role,
          installation: boundInstallation,
          slackUserId: args.slackUserId,
          channelId: args.channelId,
          threadTs: args.threadTs,
          replacedSlackUserIds: connection.replacedSlackUserIds,
        };
      },
    );
    signal.throwIfAborted();
    return result;
  },
);

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
    const defaultAgentId = await resolveDefaultComposeId(writeDb, args.orgId);
    signal.throwIfAborted();
    const agentName = defaultAgentId
      ? await getWorkspaceAgentName(writeDb, defaultAgentId)
      : undefined;
    signal.throwIfAborted();
    const { assistantName } = PUBLIC_BRAND_PRESENTATION;

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
      await refreshSlackAppHome({
        db: writeDb,
        clerkClient: get(clerk$),
        client,
        installation: args.installation,
        slackUserId: replacedSlackUserId,
      });
      signal.throwIfAborted();
    }

    await refreshSlackAppHome({
      db: writeDb,
      clerkClient: get(clerk$),
      client,
      installation: args.installation,
      slackUserId: args.slackUserId,
    });
    signal.throwIfAborted();
  },
);
