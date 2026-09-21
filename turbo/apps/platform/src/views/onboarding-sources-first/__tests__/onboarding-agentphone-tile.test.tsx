import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
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
  const connector: PublicConnectorCatalogStatusItem = {
    slug: "gmail",
    label: "Gmail",
    description: "Connect Gmail to continue",
    icon: {
      url: "https://icons.example.test/onboarding-gmail.svg",
      invertInDarkMode: false,
    },
    category: "productivity",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: null,
        grantKind: "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: true,
    connectionStatus: "connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
}

/**
 * A channel tile, found by the channel it names. The name stays whatever the
 * state, so the tile is still this one once it reads as added.
 */
function queryChannelTile(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim().startsWith(name) === true;
  });
}

function getChannelTile(name: string): HTMLElement {
  const tile = queryChannelTile(name);
  if (!tile) {
    throw new Error(`Expected the "${name}" channel tile`);
  }
  return tile;
}

async function openSlackStep(agentPhone: boolean): Promise<void> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockConnectedSource();

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
