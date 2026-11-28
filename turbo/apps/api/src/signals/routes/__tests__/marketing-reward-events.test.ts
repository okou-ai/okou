import { randomUUID } from "node:crypto";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { marketingRewardOAuthEventSchema } from "../../../lib/marketing-reward-events";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import {
  createAgentPhoneBddApi,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
} from "./helpers/api-bdd-connectors";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { marketingRewardConsumer } from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";
import { uniqueSlackUserId } from "./helpers/slack-public-install";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const agentPhone = createAgentPhoneBddApi(context);
const connectors = createConnectorBddApi(context);

/** A Slack workspace installed anonymously; an org admin is ready to bind their Slack user. */
async function anonymousSlackWorkspace() {
  integrations.configureSlackAppMocks();
  const { teamId } = await integrations.installSlackWorkspace(null);
  const consumer = marketingRewardConsumer();
  const admin = integrations.user({ orgRole: "org:admin" });
  return { consumer, admin, teamId, slackUserId: uniqueSlackUserId() };
}

async function connectSlackUser(
  admin: ApiTestUser,
  workspaceId: string,
  slackUserId: string,
) {
  await integrations.connectSlackUser(admin, { workspaceId, slackUserId });
  await flushWaitUntilForTest();
}

function slackAuthorizations(
  consumer: ReturnType<typeof marketingRewardConsumer>,
) {
  return consumer.received.filter((event) => {
    return event.type === "slack.oauth-authorized";
  });
}

describe("Marketing reward source events", () => {
  it("marketing-reward-events-004 publishes immutable iMessage owner facts through repeated requests, switching and source deletion", async () => {
    const consumer = marketingRewardConsumer();
    integrations.configureAgentPhoneProvider();
    integrations.configureAgentPhoneWebhook();
    const capture = agentPhone.captureAgentPhoneSends();
    const occurredAt = "2026-01-01T08:00:00.000Z";
    mockNow(new Date(occurredAt));
    const member = integrations.user({ orgRole: "org:member" });
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const firstProof = await agentPhone.requestConnectLink(firstPhone, capture);
    const secondProof = await agentPhone.requestConnectLink(
      secondPhone,
      capture,
    );

    await integrations.requestConnectAgentPhone(member, firstProof, [200]);
    await integrations.requestConnectAgentPhone(member, firstProof, [200]);
    const afterFirstConnects = [...consumer.received];
    await integrations.requestConnectAgentPhone(member, secondProof, [409]);
    const switchBody = { ...secondProof, replacePhoneHandle: firstPhone };
    await integrations.requestConnectAgentPhone(member, switchBody, [200]);
    await integrations.requestConnectAgentPhone(member, switchBody, [200]);
    await integrations.requestUnlinkAgentPhone(member, [204]);
    const link = await integrations.getAgentPhoneLinkStatus(member);

    expect(afterFirstConnects).toStrictEqual([
      {
        version: 2,
        id: expect.any(String),
        environment: "development",
        type: "imessage.identity-linked",
        occurredAt,
        orgId: member.orgId,
        userId: member.userId,
        linkId: expect.any(String),
      },
    ]);
    expect(link.linked).toBeFalsy();
    expect(consumer.received).toHaveLength(2);
    const [first, switched] = consumer.received;
    if (
      first?.type !== "imessage.identity-linked" ||
      switched?.type !== "imessage.identity-linked"
    ) {
      throw new Error("expected two iMessage identity events");
    }
    expect(switched.id).not.toBe(first.id);
    expect(switched.linkId).not.toBe(first.linkId);
    expect(switched).toMatchObject({
      orgId: member.orgId,
      userId: member.userId,
    });
  });

  it("marketing-reward-events-002 records custom OAuth connection identity without publishing its provider credentials", async () => {
    const consumer = marketingRewardConsumer();
    const refreshToken = `refresh-${randomUUID()}`;
    const clientSecret = `secret-${randomUUID()}`;
    const provider = mockCustomConnectorOAuth2Provider(context, {
      initialRefreshToken: refreshToken,
    });
    const member = integrations.user({ orgRole: "org:admin" });
    const connector = await connectors.createCustomConnector(member, {
      displayName: "Marketing Custom OAuth",
      prefixTemplates: [`https://custom-${randomUUID()}.example.test/`],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "marketing-custom-client-id",
        clientSecret,
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
    });

    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const started = await accept(
      setupApp({ context, routes: customConnectorOAuth2Routes })(
        customConnectorOAuth2Contract,
      ).start({
        params: { id: connector.id },
        headers: { authorization: "Bearer clerk-session" },
        body: { account: { intent: "add" } },
      }),
      [200],
    );
    if (started.body.result !== "authorization") {
      throw new Error("Expected a custom OAuth authorization redirect");
    }
    const state = new URL(started.body.authorizationUrl).searchParams.get(
      "state",
    );
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    const callback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state,
        code: `code-${randomUUID()}`,
      });
    expect(callback.body.status).toBe("success");
    await flushWaitUntilForTest();

    expect(consumer.received).toHaveLength(1);
    const [event] = consumer.received;
    const parsed = marketingRewardOAuthEventSchema.parse(event);
    expect(parsed).toMatchObject({
      version: 1,
      type: "connector.oauth-authorized",
      orgId: member.orgId,
      userId: member.userId,
      connector: {
        kind: "custom",
        customConnectorId: connector.id,
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(clientSecret);
    expect(serialized).not.toContain(refreshToken);
    expect(serialized).not.toContain("custom-oauth-");
  });

  it("marketing-reward-events-006 (1/3) publishes no authorization event when the admin binds their Slack user before admin authorization", async () => {
    const { consumer, admin, teamId, slackUserId } =
      await anonymousSlackWorkspace();

    await connectSlackUser(admin, teamId, slackUserId);

    expect(slackAuthorizations(consumer)).toStrictEqual([]);
  });

  it("marketing-reward-events-006 (2/3) publishes one version-2 authorization event after administrator authorization", async () => {
    const { consumer, admin, teamId, slackUserId } =
      await anonymousSlackWorkspace();
    await connectSlackUser(admin, teamId, slackUserId);

    await integrations.installSlackWorkspace(admin, {
      teamId,
      installerSlackUserId: slackUserId,
    });
    const status = await integrations.requestSlackIntegrationStatus(
      admin,
      [200],
    );
    await flushWaitUntilForTest();

    expect(status.body).toMatchObject({ isInstalled: true });
    expect(slackAuthorizations(consumer)).toStrictEqual([
      expect.objectContaining({
        version: 2,
        type: "slack.oauth-authorized",
        orgId: admin.orgId,
        userId: admin.userId,
        workspaceId: teamId,
      }),
    ]);
  });

  it("marketing-reward-events-006 (3/3) publishes no additional authorization when the Slack user reconnects", async () => {
    integrations.configureSlackAppMocks();
    const consumer = marketingRewardConsumer();
    const admin = integrations.user({ orgRole: "org:admin" });
    const slackUserId = uniqueSlackUserId();
    const { teamId } = await integrations.installSlackWorkspace(admin, {
      installerSlackUserId: slackUserId,
    });
    await flushWaitUntilForTest();
    const afterAuthorization = slackAuthorizations(consumer);

    await connectSlackUser(admin, teamId, slackUserId);

    expect(afterAuthorization).toHaveLength(1);
    expect(slackAuthorizations(consumer)).toStrictEqual(afterAuthorization);
  });
});
