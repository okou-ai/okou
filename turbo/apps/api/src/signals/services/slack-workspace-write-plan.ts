import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq, isNull, ne, or } from "drizzle-orm";

type Installation = typeof slackOrgInstallations.$inferSelect;
export interface SlackWorkspaceConnection {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: "admin" | "member";
  readonly workspaceId: string;
  readonly slackUserId: string;
  readonly channelId?: string;
  readonly threadTs?: string;
  readonly pendingPrompt?: string;
  readonly connectionIntent: "connect" | "switch";
}

export type SlackWorkspaceConnectionResult =
  | { readonly kind: "not_found" | "forbidden"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly connectionId: string;
      readonly role: "admin" | "member";
      readonly installation: Installation;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
      readonly replacedSlackUserIds: readonly string[];
    };

export function slackWorkspaceAdmission(
  args: SlackWorkspaceConnection,
  installation: Installation | undefined,
): Extract<
  SlackWorkspaceConnectionResult,
  { readonly message: string }
> | null {
  if (!installation) {
    return {
      kind: "not_found",
      message: "Workspace not found. Please install the Slack app first.",
    };
  }
  if (installation.orgId === null && args.orgRole !== "admin") {
    return {
      kind: "forbidden",
      message:
        "Only org admins can connect an unconfigured workspace. Ask your org admin to connect first.",
    };
  }
  if (installation.orgId !== null && installation.orgId !== args.orgId) {
    return {
      kind: "forbidden",
      message:
        "Your active organization doesn't match this Slack workspace. Please switch to the correct organization in the platform sidebar before connecting.",
    };
  }
  return { kind: "allowed", installation };
}

export function slackConnectionValues(args: SlackWorkspaceConnection) {
  const user = eq(slackOrgConnections.userId, args.userId);
  const workspace = eq(slackOrgConnections.slackWorkspaceId, args.workspaceId);
  return {
    currentWhere: and(
      workspace,
      or(user, eq(slackOrgConnections.slackUserId, args.slackUserId)),
    ),
    values: {
      slackUserId: args.slackUserId,
      slackWorkspaceId: args.workspaceId,
      userId: args.userId,
    },
    conflict: {
      target: [
        slackOrgConnections.slackUserId,
        slackOrgConnections.slackWorkspaceId,
      ],
      set: { userId: args.userId },
      setWhere: user,
    },
    staleWhere: and(
      workspace,
      user,
      ne(slackOrgConnections.slackUserId, args.slackUserId),
    ),
    bindWhere: and(
      eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId),
      isNull(slackOrgInstallations.orgId),
    ),
  };
}

export function slackConnectionAdmission(
  args: SlackWorkspaceConnection,
  current: readonly Pick<
    typeof slackOrgConnections.$inferSelect,
    "userId" | "slackUserId"
  >[],
): Extract<
  SlackWorkspaceConnectionResult,
  { readonly message: string }
> | null {
  if (
    current.some((connection) => {
      return (
        connection.slackUserId === args.slackUserId &&
        connection.userId !== args.userId
      );
    })
  ) {
    return {
      kind: "forbidden",
      message: "This Slack account is already connected to another user.",
    };
  }
  if (
    args.connectionIntent !== "switch" &&
    current.some((connection) => {
      return connection.slackUserId !== args.slackUserId;
    })
  ) {
    return {
      kind: "forbidden",
      message:
        "Your Okou account is connected to a different Slack account in this workspace.",
    };
  }
  return null;
}

export function connectedSlackWorkspace(
  args: SlackWorkspaceConnection,
  installation: Installation,
  connectionId: string,
  replaced: readonly { readonly slackUserId: string }[],
): SlackWorkspaceConnectionResult {
  return {
    kind: "ok",
    connectionId,
    role: installation.orgId === null ? "admin" : args.orgRole,
    installation,
    slackUserId: args.slackUserId,
    channelId: args.channelId,
    threadTs: args.threadTs,
    replacedSlackUserIds: replaced.map((connection) => {
      return connection.slackUserId;
    }),
  };
}
