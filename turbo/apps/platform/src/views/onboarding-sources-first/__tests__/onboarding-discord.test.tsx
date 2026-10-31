import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import {
  integrationsDiscordContract,
  type DiscordOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-discord";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();

function mockDiscord(overrides: Partial<DiscordOrgStatus> = {}) {
  let current: DiscordOrgStatus = {
    isAvailable: true,
    isConnected: false,
    isAdmin: false,
    guildId: null,
    guildName: null,
    discordUserId: null,
    defaultAgentId: null,
    defaultAgentName: null,
    contextMode: "mentions_only",
    onboarding: "oauth",
    dmSelectionConnectionId: null,
    dmBindings: [],
    ...overrides,
  };
  context.mocks.api(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  return (next: Partial<DiscordOrgStatus>) => {
    current = { ...current, ...next };
  };
}

function openChatChannelStep(mobile = false) {
  if (mobile) {
    context.mocks.browser.matchMedia((query) => {
      return query === "(width < 640px)";
    });
  }
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: null,
      connectUrl: null,
    });
  });
  return setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSlack,
  });
}

function getButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim().startsWith(name);
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

test.each([false, true])(
  "Discord verifies before allowing onboarding to continue (mobile=%s)",
  async (mobile) => {
    const setDiscord = mockDiscord();
    const state = "s".repeat(43);
    const completionToken = "c".repeat(43);
    const authorizationUrl = `https://discord.com/oauth2/authorize?client_id=123456789012345678&state=${state}&scope=identify`;
    context.mocks.api(discordOauthContract.start, ({ respond }) => {
      return respond(200, { authorizationUrl, completionToken });
    });
    const completionRequested = context.mocks.deferred<void>();
    const finishCompletion = context.mocks.deferred<void>();
    context.mocks.api(discordOauthContract.complete, async ({ respond }) => {
      completionRequested.resolve();
      await finishCompletion.promise;
      setDiscord({
        isConnected: true,
        discordUserId: "234567890123456789",
      });
      return respond(200, { status: "connected" });
    });
    const popup = context.mocks.browser.authWindow();
    Object.defineProperty(popup, "location", {
      configurable: true,
      value: { href: "" },
    });
    const opened = context.mocks.browser.open(popup);

    await openChatChannelStep(mobile);

    await waitFor(() => {
      expect(getButton("Discord")).toBeEnabled();
    });
    expect(getButton("Continue")).toBeDisabled();
    click(getButton("Discord"));

    expect(opened.calls).toStrictEqual([
      { url: "about:blank", target: "_blank", features: null },
    ]);
    await completionRequested.promise;
    expect(popup.location.href).toBe(authorizationUrl);
    expect(getButton("Discord")).toBeDisabled();
    expect(getButton("Continue")).toBeDisabled();
    expect(pathname()).toBe(ROUTES.onboardingSlack);

    finishCompletion.resolve();

    await expect(
      screen.findByRole("heading", { name: "Your chat is connected" }),
    ).resolves.toBeInTheDocument();
    expect(getButton("Discord")).toHaveTextContent("Added");
    expect(getButton("Discord")).toBeDisabled();
    expect(getButton("Continue")).toBeEnabled();
    expect(pathname()).toBe(ROUTES.onboardingSlack);

    click(getButton("Continue"));
    await screen.findByRole("heading", { name: "Meet Okou’s secret tools" });
    click(getButton("Continue"));

    await expect(
      screen.findByLabelText("Your starting prompt"),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe(ROUTES.onboardingReady);
  },
);

test("An existing Discord connection follows live connection changes during onboarding", async () => {
  const setDiscord = mockDiscord({
    isConnected: true,
    discordUserId: "234567890123456789",
  });

  await openChatChannelStep();

  await expect(
    screen.findByRole("heading", { name: "Your chat is connected" }),
  ).resolves.toBeInTheDocument();
  expect(getButton("Discord")).toHaveTextContent("Added");
  expect(getButton("Continue")).toBeEnabled();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("discord:changed")).toBeTruthy();
  });

  setDiscord({ isConnected: false, discordUserId: null });
  act(() => {
    context.mocks.ably.trigger("discord:changed");
  });

  await expect(
    screen.findByRole("heading", { name: "Keep Okou a message away" }),
  ).resolves.toBeInTheDocument();
  expect(getButton("Discord")).toBeEnabled();
  expect(getButton("Continue")).toBeDisabled();
});

test("An unavailable Discord integration explains why it cannot connect", async () => {
  mockDiscord({ isAvailable: false, contextMode: "unavailable" });

  await openChatChannelStep();

  await expect(
    screen.findByText("Discord is not configured for this organization yet."),
  ).resolves.toBeInTheDocument();
  expect(getButton("Discord")).toBeDisabled();
  expect(getButton("Continue")).toBeDisabled();
});
