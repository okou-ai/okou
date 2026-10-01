import { randomUUID } from "node:crypto";

import type { TestContext } from "../../../../__tests__/test-context";
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

  return { installOrg };
}
