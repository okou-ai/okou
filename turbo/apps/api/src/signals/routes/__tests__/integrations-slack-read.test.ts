import { integrationsSlackReadContract } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsSlackReadRoutes } from "../integrations-slack-read";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRouteMocks } from "./helpers/route-test";
import { uniqueSlackUserId } from "./helpers/slack-public-install";

const context = testContext();
const bdd = createBddApi(context);
const integrations = createBddIntegrationApi(context);
const routeMocks = createRouteMocks(context);
const slackRead = setupApp({ context, routes: integrationsSlackReadRoutes })(
  integrationsSlackReadContract,
);

const NOT_CONNECTED_ERROR = Object.freeze({
  error: Object.freeze({
    code: "NOT_FOUND",
    message:
      "Your Slack account is not connected to this organization. Connect it from Settings > Slack before reading conversations.",
  }),
});

function signIn(actor: ApiTestUser): { authorization: string } {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function expectedGeneralChannel(teamId: string) {
  return {
    channels: [
      {
        id: "C001",
        name: "general",
        isPrivate: false,
        isMember: true,
        channelUrl: `https://slack.com/app_redirect?team=${teamId}&channel=C001`,
      },
    ],
    nextCursor: null,
  };
}

interface SlackListCall {
  readonly authorization: string | null;
  readonly user: string | null;
}

function mockSharedGeneralChannel(): SlackListCall[] {
  const calls: SlackListCall[] = [];
  server.use(
    http.get("https://slack.com/api/users.conversations", ({ request }) => {
      calls.push({
        authorization: request.headers.get("authorization"),
        user: new URL(request.url).searchParams.get("user"),
      });
      return HttpResponse.json({
        ok: true,
        channels: [{ id: "C001", name: "general", is_private: false }],
        response_metadata: { next_cursor: "" },
      });
    }),
  );
  return calls;
}

async function installConnectedOrg() {
  const actor = bdd.user({ orgRole: "org:admin" });
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected admin actor to have an orgId");
  }
  const slackUserId = uniqueSlackUserId();
  const { teamId } = await integrations.installSlackWorkspace(actor, {
    installerSlackUserId: slackUserId,
  });
  return {
    actor,
    orgId,
    slackWorkspaceId: teamId,
    slackUserId,
    botToken: `xoxb-bdd-${teamId}`,
  };
}

describe("Slack bot channel discovery and history", () => {
  it("integrations-slack-read-001 (1/4) rejects a user whose organization has no Slack installation", async () => {
    const uninstalledUser = bdd.user({ orgRole: "org:admin" });
    const slackCalls = mockSharedGeneralChannel();

    const uninstalledRead = await accept(
      slackRead.listChannels({
        headers: signIn(uninstalledUser),
        query: { limit: 10 },
      }),
      [404],
    );
    expect(uninstalledRead.body).toStrictEqual(NOT_CONNECTED_ERROR);
    expect(slackCalls).toStrictEqual([]);
  });

  it("integrations-slack-read-001 (2/4) returns workspace A channels for admin A and rejects an unconnected member", async () => {
    integrations.configureSlackAppMocks();
    const orgA = await installConnectedOrg();
    const memberA = bdd.user({ orgId: orgA.orgId, orgRole: "org:member" });
    await flushWaitUntilForTest();
    const slackCalls = mockSharedGeneralChannel();

    const adminAFirst = await accept(
      slackRead.listChannels({
        headers: signIn(orgA.actor),
        query: { limit: 10 },
      }),
      [200],
    );
    expect(adminAFirst.body).toStrictEqual(
      expectedGeneralChannel(orgA.slackWorkspaceId),
    );

    const unconnectedMember = await accept(
      slackRead.listChannels({
        headers: signIn(memberA),
        query: { limit: 10 },
      }),
      [404],
    );
    expect(unconnectedMember.body).toStrictEqual(NOT_CONNECTED_ERROR);

    expect(slackCalls).toStrictEqual([
      { authorization: `Bearer ${orgA.botToken}`, user: orgA.slackUserId },
    ]);
  });

  it("integrations-slack-read-001 (3/4) scopes workspace A reads for the newly connected member and back to admin A", async () => {
    integrations.configureSlackAppMocks();
    const orgA = await installConnectedOrg();
    const memberA = bdd.user({ orgId: orgA.orgId, orgRole: "org:member" });
    const memberSlackUserId = uniqueSlackUserId();
    await integrations.connectSlackUser(memberA, {
      workspaceId: orgA.slackWorkspaceId,
      slackUserId: memberSlackUserId,
    });
    await flushWaitUntilForTest();
    const slackCalls = mockSharedGeneralChannel();

    const connectedMember = await accept(
      slackRead.listChannels({
        headers: signIn(memberA),
        query: { limit: 10 },
      }),
      [200],
    );
    expect(connectedMember.body).toStrictEqual(
      expectedGeneralChannel(orgA.slackWorkspaceId),
    );

    const adminAAgain = await accept(
      slackRead.listChannels({
        headers: signIn(orgA.actor),
        query: { limit: 10 },
      }),
      [200],
    );
    expect(adminAAgain.body).toStrictEqual(
      expectedGeneralChannel(orgA.slackWorkspaceId),
    );

    expect(slackCalls).toStrictEqual([
      { authorization: `Bearer ${orgA.botToken}`, user: memberSlackUserId },
      { authorization: `Bearer ${orgA.botToken}`, user: orgA.slackUserId },
    ]);
  });

  it("integrations-slack-read-001 (4/4) isolates successive reads between workspace A and workspace B", async () => {
    integrations.configureSlackAppMocks();
    const orgA = await installConnectedOrg();
    const orgB = await installConnectedOrg();
    await flushWaitUntilForTest();
    const slackCalls = mockSharedGeneralChannel();

    const adminAFirst = await accept(
      slackRead.listChannels({
        headers: signIn(orgA.actor),
        query: { limit: 10 },
      }),
      [200],
    );
    expect(adminAFirst.body).toStrictEqual(
      expectedGeneralChannel(orgA.slackWorkspaceId),
    );

    const adminBRead = await accept(
      slackRead.listChannels({
        headers: signIn(orgB.actor),
        query: { limit: 10 },
      }),
      [200],
    );
    expect(adminBRead.body).toStrictEqual(
      expectedGeneralChannel(orgB.slackWorkspaceId),
    );

    const adminAAgain = await accept(
      slackRead.listChannels({
        headers: signIn(orgA.actor),
        query: { limit: 10 },
      }),
      [200],
    );
    expect(adminAAgain.body).toStrictEqual(
      expectedGeneralChannel(orgA.slackWorkspaceId),
    );

    expect(slackCalls).toStrictEqual([
      { authorization: `Bearer ${orgA.botToken}`, user: orgA.slackUserId },
      { authorization: `Bearer ${orgB.botToken}`, user: orgB.slackUserId },
      { authorization: `Bearer ${orgA.botToken}`, user: orgA.slackUserId },
    ]);
  });
});
