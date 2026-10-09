import { randomUUID } from "node:crypto";

import type { TestContext } from "../../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createBddIntegrationApi } from "./api-bdd-integrations";

export interface PublicSlackOrgFixture {
  /** The org member the test acts as. */
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly userId: string;
  readonly slackWorkspaceId: string;
  readonly slackWorkspaceName: string;
  /** Connected Slack user when `withConnection`, otherwise an unlinked id. */
  readonly slackUserId: string;
  /** Bot token the production OAuth install stored for the workspace. */
  readonly botToken: string;
}

export interface PublicSlackOrgOptions {
  /** Connect the actor's Slack user through the installing OAuth flow. */
  readonly withConnection?: boolean;
  /** Which org owns the workspace installation. Defaults to the actor's. */
  readonly installation?: "own" | "unbound" | "other-org";
  readonly actor?: ApiTestUser;
}

export function uniqueSlackUserId(): string {
  return `U_${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/**
 * Builds Slack workspace installations and member connections through the
 * production Slack OAuth install flow instead of seeding installation rows.
 */
export function createPublicSlackOrgApi(context: TestContext) {
  const bdd = createBddApi(context);
  const integrations = createBddIntegrationApi(context);

  async function installOrg(
    options: PublicSlackOrgOptions = {},
  ): Promise<PublicSlackOrgFixture> {
    integrations.configureSlackAppMocks();
    const actor = options.actor ?? bdd.user({ orgRole: "org:admin" });
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected the Slack actor to belong to an org");
    }
    const installation = options.installation ?? "own";
    const slackUserId = uniqueSlackUserId();
    let teamId: string;
    if (options.withConnection === true) {
      if (installation !== "own") {
        throw new Error("Only an own-org install connects the actor");
      }
      ({ teamId } = await integrations.installSlackWorkspace(actor, {
        installerSlackUserId: slackUserId,
      }));
    } else if (installation === "own") {
      // Another admin of the same org installs, so the actor stays unlinked.
      const installer = bdd.user({ orgId, orgRole: "org:admin" });
      ({ teamId } = await integrations.installSlackWorkspace(installer));
    } else if (installation === "unbound") {
      ({ teamId } = await integrations.installSlackWorkspace(null));
    } else {
      ({ teamId } = await integrations.installSlackWorkspace(
        bdd.user({ orgRole: "org:admin" }),
      ));
    }
    return {
      actor,
      orgId,
      userId: actor.userId,
      slackWorkspaceId: teamId,
      slackWorkspaceName: `BDD Slack App ${teamId}`,
      slackUserId,
      botToken: `xoxb-bdd-${teamId}`,
    };
  }

  /** Clears Slack client call history left by OAuth notifications. */
  async function settleSlackNotifications(): Promise<void> {
    await flushWaitUntilForTest();
    context.mocks.slack.chat.postMessage.mockClear();
    context.mocks.slack.views.publish.mockClear();
    context.mocks.slack.conversations.open.mockClear();
    context.mocks.slack.oauth.v2.access.mockClear();
    context.mocks.slack.users.info.mockClear();
  }

  /**
   * Installs Slack for an existing org through the production OAuth install,
   * performed by another admin of that org so the caller stays unlinked. The
   * install exchange returns the given bot token, scopes and team name.
   * Callers that rely on their own Clerk membership mock must re-apply it:
   * the install authenticates the installing admin.
   */
  async function installForOrg(args: {
    readonly orgId: string;
    readonly botToken?: string;
    readonly botScopes?: string | null;
    readonly teamName?: string;
  }): Promise<{
    readonly slackWorkspaceId: string;
    readonly slackWorkspaceName: string;
  }> {
    mockEnv("SLACK_OAUTH_CLIENT_ID", "slack-bdd-client-id");
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-bdd-client-secret");
    const installer = bdd.user({ orgId: args.orgId, orgRole: "org:admin" });
    const teamName = args.teamName ?? "Test Org Workspace";
    const { teamId } = await integrations.installSlackWorkspace(installer, {
      ...(args.botToken === undefined ? {} : { botToken: args.botToken }),
      // Like the former seeded installation, scopes default to unreported.
      botScopes: args.botScopes === undefined ? null : args.botScopes,
      teamName,
    });
    await settleSlackNotifications();
    return { slackWorkspaceId: teamId, slackWorkspaceName: teamName };
  }

  /** Connects the member's Slack user through the production connect flow. */
  async function connectMember(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly slackWorkspaceId: string;
  }): Promise<{ readonly slackUserId: string }> {
    const slackUserId = uniqueSlackUserId();
    await integrations.connectSlackUser(
      bdd.user({
        userId: args.userId,
        orgId: args.orgId,
        orgRole: "org:admin",
      }),
      { workspaceId: args.slackWorkspaceId, slackUserId },
    );
    await settleSlackNotifications();
    return { slackUserId };
  }

  /** Slack's signed uninstall event removes the OAuth-created binding. */
  async function uninstallWorkspace(slackWorkspaceId: string): Promise<void> {
    integrations.configureSlackAppMocks();
    await integrations.postSlackEvent(slackWorkspaceId, {
      type: "app_uninstalled",
    });
    await flushWaitUntilForTest();
  }

  return { installOrg, installForOrg, connectMember, uninstallWorkspace };
}
