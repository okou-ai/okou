import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const SLACK_QUESTION = "Give Okou a job without leaving Slack.";
const IMESSAGE_TILE = "iMessage";
const CONNECTION_CODE = "12345678";

/** One connected source, which every step after the source step requires. */
function mockConnectedSource(): void {
  context.mocks.data.connectors([
    {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "gmail",
      authMethod: "oauth",
      externalId: "gmail-user-1",
      externalUsername: "gmail-user",
      externalEmail: null,
      oauthScopes: ["read"],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
}

/**
 * A channel tile, found by the channel it names. The name stays whatever the
 * state, so the tile is still this one once it reads as added, and a tile that
 * leaves for an install is a link rather than a button.
 */
function queryChannelTile(name: string): HTMLElement | undefined {
  return [...queryAllByRoleFast("button"), ...queryAllByRoleFast("link")].find(
    (candidate) => {
      return candidate.textContent?.trim().startsWith(name) === true;
    },
  );
}

function getChannelTile(name: string): HTMLElement {
  const tile = queryChannelTile(name);
  if (!tile) {
    throw new Error(`Expected the "${name}" channel tile`);
  }
  return tile;
}

/** The org's Slack and Teams installations, which the step's own tiles read. */
function mockChatChannelInstalls(): void {
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: "https://slack.example.test/oauth/install",
      connectUrl: null,
      scopeMismatch: false,
      reinstallUrl: null,
      workspaceName: null,
    });
  });
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      connectUrl: "/api/teams/oauth/connect?orgId=org_default",
    });
  });
}

async function openSlackStep(agentPhone: boolean): Promise<void> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockConnectedSource();
  mockChatChannelInstalls();

  await setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSlack,
    featureSwitches: {
      [FeatureSwitchKey.OnboardingSourcesFirst]: true,
      [FeatureSwitchKey.AgentPhoneEntry]: agentPhone,
    },
  });

  await expect(
    screen.findByRole("heading", { name: SLACK_QUESTION }),
  ).resolves.toBeInTheDocument();
}

test("The AgentPhone tile is absent while its switch is off", async () => {
  await openSlackStep(false);

  expect(queryChannelTile(IMESSAGE_TILE)).toBeUndefined();
  // The channels that do not depend on that switch are untouched.
  expect(queryChannelTile("Telegram")).toBeDefined();
  expect(queryChannelTile("Teams")).toBeDefined();
});

test("The AgentPhone tile offers the real link and reports the real status", async () => {
  context.mocks.api(integrationsAgentPhoneContract.createLinkCode, () => {
    return {
      status: 200 as const,
      body: {
        code: CONNECTION_CODE,
        expiresAt: new Date(now() + 10 * 60 * 1000).toISOString(),
      },
    };
  });

  await openSlackStep(true);

  await waitFor(() => {
    expect(getChannelTile(IMESSAGE_TILE)).toBeEnabled();
  });
  click(getChannelTile(IMESSAGE_TILE));

  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  expect(within(dialog).getByTestId("agentphone-link-qr")).toHaveAttribute(
    "data-sms-href",
    `sms:+19039853128?body=${CONNECTION_CODE}`,
  );

  // The link's own status is what the tile says, so a link made elsewhere
  // reaches this step without it being opened again.
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    publicBrand: "okou",
    phoneHandle: "+15555550123",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.ably.trigger("agentphone:changed");

  await waitFor(() => {
    expect(getChannelTile(IMESSAGE_TILE)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(getChannelTile(IMESSAGE_TILE)).toHaveTextContent("Added");
});
