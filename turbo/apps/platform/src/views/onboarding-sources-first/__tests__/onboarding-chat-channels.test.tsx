import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import {
  integrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import {
  teamsConnectContract,
  type TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { pathname } from "../../../signals/location.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const teamsDraftStorage = localStorageSignals("onboarding:sources-first-draft");

const NOW = Date.parse("2026-09-21T10:00:00.000Z");
const SLACK_INSTALL_URL = "https://slack.example.test/oauth/install";
const TEAMS_CONNECT_URL = "/api/teams/oauth/connect?orgId=org_default";

const SLACK_TITLE = "Keep Okou a message away";
const SLACK_CONNECTED_TITLE = "Your chat is connected";
const SLACK_ADD = "Add to Slack";
const SLACK_CONNECTED_STATUS = "Added to your workspace";

/** The step only opens for someone who still has onboarding to do. */
function mockOnboardingNeeded(): void {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
}

/**
 * The step before this one demands a connected source, and its guard sends the
 * run back to the entry without one.
 */
function mockConnectedSource(): void {
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
}

/** The org's Slack installation, as the API reports it while the step is open. */
function mockSlack(initial: SlackOrgStatus): (next: SlackOrgStatus) => void {
  let current = initial;
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, current);
  });
  return (next: SlackOrgStatus) => {
    current = next;
  };
}

function mockTeams(status: TeamsConnectStatus): void {
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, status);
  });
}

function openChatChannelStep(): Promise<void> {
  return setupPage({
    context,
    locale: "en-US",
    path: ROUTES.onboardingSlack,
  });
}

function getButtonByName(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

/**
 * A tile carries its state as an extra word after the channel's name, so the
 * name is the prefix of whatever the tile currently reads.
 */
function getChannelTile(name: string): HTMLElement {
  const tile = [
    ...queryAllByRoleFast("button"),
    ...queryAllByRoleFast("link"),
  ].find((candidate) => {
    return candidate.textContent?.trim().startsWith(name) === true;
  });
  if (!tile) {
    throw new Error(`Expected the "${name}" chat channel tile`);
  }
  return tile;
}

/** The install finished in the other tab, and Slack says so. */
async function announceSlackChange(): Promise<void> {
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("slack:changed")).toBeTruthy();
  });
  act(() => {
    context.mocks.ably.trigger("slack:changed");
  });
}

test("The step sends an admin to Slack's own install and turns connected once the install lands", async () => {
  mockOnboardingNeeded();
  mockConnectedSource();
  const setSlack = mockSlack({
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    installUrl: SLACK_INSTALL_URL,
    connectUrl: null,
  });
  mockTeams({
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    linkedAccounts: [],
    pendingInstallation: false,
    connectUrl: TEAMS_CONNECT_URL,
  });
  mockNow(NOW, context.signal);
  const open = vi.spyOn(window, "open").mockReturnValue(null);

  await openChatChannelStep();

  await expect(
    screen.findByRole("heading", { name: SLACK_TITLE }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName(SLACK_ADD)).toBeEnabled();
  });

  click(getButtonByName(SLACK_ADD));

  expect(open).toHaveBeenCalledWith(`${SLACK_INSTALL_URL}?_t=${NOW}`, "_blank");

  click(getChannelTile("Teams"));

  // New Teams actions opt into the canonical completion page.
  expect(open).toHaveBeenCalledWith(
    `${window.location.origin}${TEAMS_CONNECT_URL}&_t=${NOW}`,
    "_blank",
  );

  setSlack({
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    workspaceName: "Northwind",
    installUrl: SLACK_INSTALL_URL,
    connectUrl: null,
  });
  await announceSlackChange();

  await expect(
    screen.findByRole("heading", { name: SLACK_CONNECTED_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(getButtonByName(SLACK_CONNECTED_STATUS)).toBeDisabled();
});

test("A protected worker preview keeps access on its matching OAuth start URL", async () => {
  mockOnboardingNeeded();
  mockConnectedSource();
  const installUrl =
    "https://pr-431-api.vm6.ai/api/slack/oauth/install?state=slack-state";
  mockSlack({
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    installUrl,
    connectUrl: null,
  });
  mockTeams({
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    linkedAccounts: [],
    pendingInstallation: false,
    teamName: "Northwind",
    connectUrl: TEAMS_CONNECT_URL,
  });
  mockNow(NOW, context.signal);
  const open = vi.spyOn(window, "open").mockReturnValue(null);

  await setupPage({
    context,
    locale: "en-US",
    host: "pr-431-app-okou-app-preview.vm0.workers.dev",
    path: `${ROUTES.onboardingSlack}?x-vercel-protection-bypass=preview-secret`,
  });

  await waitFor(() => {
    expect(getButtonByName(SLACK_ADD)).toBeEnabled();
  });
  click(getButtonByName(SLACK_ADD));

  expect(open).toHaveBeenCalledWith(
    `${installUrl}&_t=${NOW}&x-vercel-protection-bypass=preview-secret`,
    "_blank",
  );
});

test("An installed workspace offers the account connect rather than the install", async () => {
  mockOnboardingNeeded();
  mockConnectedSource();
  mockSlack({
    isConnected: false,
    isInstalled: true,
    isAdmin: true,
    installUrl: SLACK_INSTALL_URL,
    connectUrl: "https://slack.example.test/oauth/connect",
  });
  mockTeams({
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    linkedAccounts: [],
    pendingInstallation: false,
    teamName: "Northwind",
    connectUrl: TEAMS_CONNECT_URL,
  });
  mockNow(NOW, context.signal);
  const open = vi.spyOn(window, "open").mockReturnValue(null);

  await openChatChannelStep();

  await waitFor(() => {
    expect(getButtonByName("Connect Slack")).toBeEnabled();
  });
  // Teams is already in, so its tile only reports it.
  const teams = getChannelTile("Teams");
  expect(within(teams).getByText("Added")).toBeInTheDocument();
  expect(teams).toBeDisabled();

  click(getButtonByName("Connect Slack"));

  expect(open).toHaveBeenCalledWith(
    `https://slack.example.test/oauth/connect?_t=${NOW}`,
    "_blank",
  );
});

test("A workspace this user cannot add to names who can, instead of a dead button", async () => {
  mockOnboardingNeeded();
  mockConnectedSource();
  mockSlack({
    isConnected: false,
    isInstalled: false,
    isAdmin: false,
    installUrl: null,
    connectUrl: null,
  });
  mockTeams({
    isConnected: false,
    isInstalled: false,
    isAdmin: false,
    linkedAccounts: [],
    pendingInstallation: false,
    installUrl: null,
    connectUrl: null,
  });

  await openChatChannelStep();

  await expect(
    screen.findByText("Ask a workspace admin to add Okou to Slack."),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Ask a workspace admin to add Okou to Teams."),
  ).toBeInTheDocument();
  expect(getButtonByName(SLACK_ADD)).toBeDisabled();
  expect(getChannelTile("Teams")).toBeDisabled();
});

test.each([
  {
    reason: "bot_not_configured",
    message:
      "Telegram connection is not configured yet. Please contact support.",
  },
  {
    reason: "domain_not_verified",
    message:
      "We couldn't verify Telegram login for this app. Contact support if the problem continues.",
  },
  {
    reason: "domain_check_failed",
    message: "We couldn't reach Telegram to check the connection.",
  },
] satisfies {
  reason: Extract<
    TelegramLinkStatusResponse,
    { linked: false }
  >["readinessError"];
  message: string;
}[])(
  "Onboarding explains Telegram $reason and leaves retry available",
  async ({ reason, message }) => {
    mockOnboardingNeeded();
    mockConnectedSource();
    const sentry = context.mocks.sentry();
    context.mocks.api(
      integrationsTelegramContract.getLinkStatus,
      ({ query, respond }) => {
        expect(query.source).toBe("onboarding");
        return respond(200, {
          linked: false,
          readinessError: reason,
          installation: {
            id: "official",
            botUsername: "okou_bot",
            loginBotId: "987654321",
            domainConfigured: false,
          },
        });
      },
    );
    const popup = context.mocks.browser.authWindow();
    context.mocks.browser.open(popup);
    await openChatChannelStep();
    await waitFor(() => {
      expect(getChannelTile("Telegram")).toBeEnabled();
    });

    click(getChannelTile("Telegram"));

    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(getChannelTile("Telegram")).toBeEnabled();
    });
    expect(popup.closed).toBeTruthy();
    expect(getChannelTile("Telegram")).not.toHaveTextContent("Added");
    expect(pathname()).toBe(ROUTES.onboardingSlack);
    expect(sentry.reports).toStrictEqual([]);
  },
);

test("Telegram authorizes the official bot in a new tab and keeps onboarding open", async () => {
  mockOnboardingNeeded();
  mockConnectedSource();
  mockSlack({
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    installUrl: SLACK_INSTALL_URL,
    connectUrl: null,
  });
  mockTeams({
    isConnected: false,
    isInstalled: false,
    isAdmin: true,
    linkedAccounts: [],
    pendingInstallation: false,
    connectUrl: TEAMS_CONNECT_URL,
  });
  context.mocks.data.telegramIntegration({
    statuses: [
      {
        id: "official",
        kind: "official",
        username: "okou_bot",
        avatarUrl: null,
        agent: null,
        isOwner: false,
        isConnected: false,
        tokenStatus: "valid",
        domainConfigured: true,
        environment: {
          requiredSecrets: [],
          requiredVars: [],
          missingSecrets: [],
          missingVars: [],
        },
      },
    ],
  });
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return respond(200, {
        linked: false,
        installation: {
          id: "official",
          botUsername: "okou_bot",
          loginBotId: "987654321",
          domainConfigured: true,
        },
      });
    },
  );
  const bindingRequested = context.mocks.deferred<void>();
  const finishBinding = context.mocks.deferred<void>();
  context.mocks.api(integrationsTelegramContract.link, async ({ respond }) => {
    bindingRequested.resolve();
    await finishBinding.promise;
    context.mocks.data.telegramIntegration({
      statuses: [
        {
          id: "official",
          kind: "official",
          username: "okou_bot",
          avatarUrl: null,
          agent: null,
          isOwner: false,
          isConnected: true,
          connectedUser: {
            telegramUserId: "99001",
            telegramUsername: "alice",
            telegramDisplayName: "Alice",
          },
          tokenStatus: "valid",
          domainConfigured: true,
          environment: {
            requiredSecrets: [],
            requiredVars: [],
            missingSecrets: [],
            missingVars: [],
          },
        },
      ],
    });
    return respond(200, { botUsername: "okou_bot", telegramUserId: "99001" });
  });
  const authorizationWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authorizationWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  const opened = context.mocks.browser.open(authorizationWindow);

  await openChatChannelStep();

  await expect(
    screen.findByRole("heading", { name: SLACK_TITLE }),
  ).resolves.toBeInTheDocument();

  const telegram = getChannelTile("Telegram");
  expect(telegram).toBeEnabled();
  click(telegram);

  expect(opened.calls).toStrictEqual([
    { url: "about:blank", target: "_blank", features: null },
  ]);
  const authUrl = await waitFor(() => {
    const url = new URL(authorizationWindow.location.href);
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    expect(url.searchParams.get("bot_id")).toBe("987654321");
    return url;
  });
  const callbackUrl = new URL(authUrl.searchParams.get("return_to") ?? "");
  expect(callbackUrl.pathname).toBe("/api/integrations/telegram/auth-callback");
  expect(callbackUrl.searchParams.get("targetOrigin")).toBe(
    window.location.origin,
  );
  const callback = {
    protocol: 2,
    operationId: callbackUrl.searchParams.get("operationId"),
    bot: "official",
  };
  act(() => {
    context.mocks.browser.message(
      { ...callback, type: "telegram-auth-bridge-ready" },
      { source: authorizationWindow, origin: callbackUrl.origin },
    );
    context.mocks.browser.message(
      {
        ...callback,
        type: "telegram-auth",
        data: {
          id: "99001",
          first_name: "Alice",
          username: "alice",
          auth_date: "1700000000",
          hash: "b".repeat(64),
        },
      },
      { source: authorizationWindow, origin: callbackUrl.origin },
    );
  });

  await bindingRequested.promise;
  expect(getChannelTile("Telegram")).not.toHaveTextContent("Added");
  expect(getButtonByName("Continue")).toBeDisabled();
  expect(pathname()).toBe(ROUTES.onboardingSlack);
  finishBinding.resolve();
  await expect(
    screen.findByText("Connected to Telegram!"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(ROUTES.onboardingSlack);
  await expect(
    screen.findByRole("heading", { name: SLACK_CONNECTED_TITLE }),
  ).resolves.toBeInTheDocument();
  expect(getChannelTile("Telegram")).toHaveTextContent("Added");
  expect(getButtonByName("Continue")).toBeEnabled();
  expect({ value: authorizationWindow.closed }).toStrictEqual({ value: false });
});

test("A pending Teams installation keeps onboarding in place until real status is connected", async () => {
  mockOnboardingNeeded();
  mockConnectedSource();
  const draft = JSON.stringify({
    version: 2,
    orgId: "org_default",
    userId: "test-user-123",
    industry: "marketing",
    experienced: false,
    provider: null,
    startingPromptDraft: "Keep my launch plan",
    startingPromptKey: "marketing:gmail",
    recommendationJobId: null,
    recommendationStartedAt: null,
  });
  context.store.set(teamsDraftStorage.set$, draft);
  mockSlack({
    isConnected: false,
    isInstalled: false,
    isAdmin: false,
    installUrl: null,
    connectUrl: null,
  });
  let teams: TeamsConnectStatus = {
    isInstalled: false,
    isConnected: false,
    isAdmin: true,
    pendingInstallation: true,
    connectUrl: TEAMS_CONNECT_URL,
    installUrl: "https://teams.microsoft.com/l/app/app-id",
    linkedAccounts: [],
  };
  context.mocks.api(teamsConnectContract.getStatus, ({ respond }) => {
    return respond(200, teams);
  });
  const open = context.mocks.browser.open();
  const visibility = context.mocks.browser.visibilityState("visible");
  await openChatChannelStep();
  await waitFor(() => {
    return expect(getChannelTile("Teams")).toBeEnabled();
  });
  expect(getButtonByName("Continue")).toBeDisabled();
  click(getChannelTile("Teams"));
  expect(new URL(open.calls[0]?.url ?? "").pathname).toBe("/settings/teams");
  expect(getButtonByName("Continue")).toBeDisabled();
  teams = {
    ...teams,
    isInstalled: true,
    isConnected: true,
    pendingInstallation: false,
  };
  act(() => {
    return visibility.changeTo("hidden");
  });
  act(() => {
    return visibility.changeTo("visible");
  });
  await waitFor(() => {
    return expect(getChannelTile("Teams")).toHaveTextContent("Added");
  });
  expect(getButtonByName("Continue")).toBeEnabled();
  expect(pathname()).toBe(ROUTES.onboardingSlack);
  click(getButtonByName("Continue"));
  await screen.findByRole("heading", { name: "Meet Okou’s secret tools" });
  click(getButtonByName("Continue"));
  await expect(
    screen.findByLabelText("Your starting prompt"),
  ).resolves.toHaveValue("Keep my launch plan");
  expect(pathname()).toBe(ROUTES.onboardingReady);
});
