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
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();

const SLACK_QUESTION = "Keep work moving in Slack";
const IMESSAGE_TILE = "iMessage";
const CONNECTION_CODE = "12345678";

/** One connected source, which every step after the source step requires. */
function mockConnectedSource(): void {
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
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

async function openSlackStep(): Promise<void> {
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
    },
  });

  await expect(
    screen.findByRole("heading", { name: SLACK_QUESTION }),
  ).resolves.toBeInTheDocument();
}

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

  await openSlackStep();

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
