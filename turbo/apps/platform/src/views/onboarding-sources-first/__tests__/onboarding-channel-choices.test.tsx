import { findFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { now, mockNow } from "../../../lib/time.ts";
import {
  findAction,
  mockSlack,
  mockTeams,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { onboardingDraftContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";
import {
  authorizationService,
  authorizeUrl,
  browserPeer,
  harbor,
  statusService,
} from "../../okou-page/__tests__/discord-consent-fixtures.ts";

const context = testContext();

const channelPage = "/onboarding/slack";
const phone = "+14155550186";
function workspace(configured = true) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockSlack(context, { isAdmin: true, installUrl: "/slack/install" });
  mockTeams(context);
  context.mocks.data.agentPhoneIntegration({
    linked: false,
    agentPhoneNumber: configured ? phone : null,
    configured,
  });
}
function issue(code: string, valid: boolean) {
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code,
        expiresAt: new Date(now() + (valid ? 600_000 : -1000)).toISOString(),
      });
    },
  );
}
test("onboarding-agentphone-tile-003 the mobile SMS invitation unlocks Continue only after the account is linked", async () => {
  workspace();
  context.mocks.browser.matchMedia((q) => {
    return q === "(width < 640px)";
  });
  issue("36004296", true);
  await setupPage({ context, path: channelPage });
  await expect(findAction("link", "Open Messages")).resolves.toHaveAttribute(
    "href",
    "sms:+14155550186?body=36004296",
  );
  for (const name of ["Telegram", "Teams", "Add to Slack"]) {
    await expect(findAction("button", name)).resolves.toBeEnabled();
  }
  const next = await findAction("button", "Continue");
  expect(next).toBeDisabled();
  context.mocks.data.agentPhoneIntegration({
    configured: true,
    linked: true,
    agentPhoneNumber: phone,
    phoneHandle: "+14155550110",
  });
  context.mocks.ably.trigger("agentphone:changed");
  await screen.findByText("iMessage is connected");
  expect(next).toBeEnabled();
  click(next);
  await screen.findByRole("heading", {
    name: "More ways to get your work done",
  });
});
test("onboarding-agentphone-tile-006 an unconfigured workspace can skip or add Slack without obtaining a phone code", async () => {
  workspace(false);
  const requested = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      requested.resolve();
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "No phone configured" },
      });
    },
  );
  await setupPage({ context, path: channelPage });
  await screen.findByText("iMessage isn’t available for this workspace yet.");
  expect(screen.queryByTestId("agentphone-link-qr")).toBeNull();
  await expect(findAction("button", "Add to Slack")).resolves.toBeEnabled();
  await expect(findAction("button", "Not now")).resolves.toBeEnabled();
  expect(requested.settled()).toBeFalsy();
});
test("onboarding-agentphone-tile-007 replacing an expired invitation renders a QR for the new message", async () => {
  workspace();
  issue("14006120", false);
  await setupPage({ context, path: channelPage });
  await screen.findByText("Your connection code has expired.");
  expect(screen.queryByTestId("agentphone-link-qr")).toBeNull();
  expect(screen.queryByText("Open Messages")).toBeNull();
  issue("52009345", true);
  click(await findAction("button", "Get a new code"));
  await expect(
    screen.findByTestId("agentphone-link-qr"),
  ).resolves.toHaveAttribute("data-sms-href", "sms:+14155550186?body=52009345");
});

test("The inline phone invitation uses the issued code and copies its destination", async () => {
  workspace();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const issued = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  const code = "96048371";
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    async ({ respond }) => {
      if (!ready.settled()) {
        ready.resolve();
      }
      await issued.promise;
      return respond(200, {
        code,
        expiresAt: new Date(now() + 120_000).toISOString(),
      });
    },
  );
  await setupPage({ context, path: channelPage });
  await ready.promise;
  await expect(findAction("button", "Continue")).resolves.toBeDisabled();
  issued.resolve();
  const qr = await screen.findByTestId("agentphone-link-qr"),
    sms = "sms:" + phone + "?body=" + code;
  expect(qr).toHaveAttribute("data-sms-href", sms);
  const smsLink = await screen.findByTestId("agentphone-open-messages");
  expect(smsLink).toHaveAttribute("href", sms);
  expect(screen.queryByRole("dialog")).toBeNull();
  click(await findFastControl("button", /^Copy .*415/));
  await waitFor(() => {
    return expect(clipboard.writes).toContain(phone);
  });
  for (const channel of ["Add to Slack", "Telegram", "Teams"]) {
    await expect(findAction("button", channel)).resolves.toBeEnabled();
  }
  await expect(findAction("button", "Continue")).resolves.toBeDisabled();
});

const route = "/onboarding/slack";
const timestamp = 1_790_000_000_000;
function chatChannelsWorkspace() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  mockNow(timestamp, context.signal);
}
test("onboarding-chat-channels-001 Slack and Teams launch their own install flows before Slack is added", async () => {
  chatChannelsWorkspace();
  const tabs = context.mocks.browser.open();
  mockSlack(context, {
    isAdmin: true,
    installUrl: "https://slack.example.test/install",
  });
  mockTeams(context, { connectUrl: "https://teams.example.test/connect" });
  await setupPage({ context, path: route });
  click(await findAction("button", "Add to Slack"));
  expect(tabs.calls.at(-1)).toMatchObject({
    target: "_blank",
    url: "https://slack.example.test/install?_t=" + timestamp,
  });
  click(await findAction("button", "Teams"));
  expect(tabs.calls.at(-1)).toMatchObject({
    target: "_blank",
    url: "https://teams.example.test/connect?_t=" + timestamp,
  });
  mockSlack(context, {
    isAdmin: true,
    isInstalled: true,
    isConnected: true,
    workspaceName: "Marina",
  });
  context.mocks.ably.trigger("slack:changed");
  await screen.findByRole("heading", { name: "Your chat is connected" });
  await expect(
    findAction("button", "Added to your workspace"),
  ).resolves.toBeDisabled();
});
test("onboarding-chat-channels-002 the protected Slack install keeps its state and uses the matching preview API", async () => {
  chatChannelsWorkspace();
  const tabs = context.mocks.browser.open();
  const start = "https://pr-49101-api.vm6.ai/api/slack/oauth/start";
  mockSlack(context, {
    isAdmin: true,
    installUrl: start + "?state=harbor-invite",
  });
  mockTeams(context, { isInstalled: true, isConnected: true });
  await setupPage({
    context,
    host: "pr-49101-app.omby.ai",
    path: route + "?x-vercel-protection-bypass=preview-fixture",
  });
  await findAction("button", "TeamsAdded");
  click(await findAction("button", "Add to Slack"));
  const tab = tabs.calls.at(-1);
  expect(tab?.target).toBe("_blank");
  const destination = new URL(tab?.url ?? "");
  expect(destination.origin + destination.pathname).toBe(start);
  expect(Object.fromEntries(destination.searchParams)).toStrictEqual({
    state: "harbor-invite",
    _t: String(timestamp),
    "x-vercel-protection-bypass": "preview-fixture",
  });
});
test("onboarding-chat-channels-003 an installed Slack workspace offers its member's account link alongside added Teams", async () => {
  chatChannelsWorkspace();
  mockTeams(context, { isInstalled: true, isConnected: true });
  mockSlack(context, {
    isAdmin: true,
    isInstalled: true,
    isConnected: false,
    installUrl: "https://slack.example.test/install",
    connectUrl: "https://slack.example.test/link",
  });
  const tabs = context.mocks.browser.open();
  await setupPage({ context, path: route });
  await expect(findAction("button", "TeamsAdded")).resolves.toBeDisabled();
  expect(queryAction("button", "Add to Slack")).toBeNull();
  click(await findAction("button", "Connect Slack"));
  expect(tabs.calls.at(-1)).toMatchObject({
    target: "_blank",
    url: "https://slack.example.test/link?_t=" + timestamp,
  });
});
test("onboarding-chat-channels-005 the official Telegram bot's readiness error leaves its connection retry available", async () => {
  chatChannelsWorkspace();
  const sentry = context.mocks.sentry();
  context.mocks.browser.open(context.mocks.browser.authWindow());
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ query, respond }) => {
      expect(query).toMatchObject({ botId: "official", source: "onboarding" });
      return respond(200, {
        linked: false,
        readinessError: "bot_not_configured",
      });
    },
  );
  await setupPage({ context, path: route });
  click(await findAction("button", "Telegram"));
  await screen.findByText(
    "Telegram connection is not configured yet. Please contact support.",
  );
  const retry = await findAction("button", "Telegram");
  expect(retry).toBeEnabled();
  expect(retry).toHaveAttribute("aria-pressed", "false");
  expect(window.location.pathname).toBe(route);
  expect(sentry.reports).toStrictEqual([]);
});
test("onboarding-chat-channels-009 resuming a pending Teams installation unlocks the saved launch plan", async () => {
  chatChannelsWorkspace();
  mockSlack(context);
  mockTeams(context, { pendingInstallation: true });
  const tabs = context.mocks.browser.open();
  const page = context.mocks.browser.visibilityState("visible");
  context.mocks.api(onboardingDraftContract.get, ({ respond }) => {
    return respond(200, {
      draft: {
        revision: crypto.randomUUID(),
        step: "slack",
        answers: {
          industry: null,
          experienced: false,
          provider: null,
          startingPromptKey: "launch-plan",
          startingPromptDraft: "Keep my launch plan.",
          startingPromptOutput: null,
          recommendationStartedAt: null,
          recommendationJobId: null,
        },
      },
    });
  });
  await setupPage({ context, path: route });
  const next = await findAction("button", "Continue");
  expect(next).toBeDisabled();
  click(await findAction("button", "Teams"));
  expect(new URL(tabs.calls.at(-1)?.url ?? "").pathname).toBe(
    "/settings/teams",
  );
  expect(next).toBeDisabled();
  page.changeTo("hidden");
  const refreshed = createDeferredPromise<void>(context.signal);
  const installed = createDeferredPromise<void>(context.signal);
  context.mocks.api(teamsConnectContract.getStatus, async ({ respond }) => {
    if (!refreshed.settled()) {
      refreshed.resolve();
    }
    await installed.promise;
    return respond(200, {
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      linkedAccounts: [],
      pendingInstallation: false,
    });
  });
  expect(next).toBeDisabled();
  page.changeTo("visible");
  await refreshed.promise;
  expect(next).toBeDisabled();
  expect(queryAction("button", "TeamsAdded")).toBeNull();
  expect(window.location.pathname).toBe(route);
  installed.resolve();
  await expect(findAction("button", "TeamsAdded")).resolves.toBeDisabled();
  expect(next).toBeEnabled();
  expect(window.location.pathname).toBe(route);
  click(next);
  await screen.findByRole("heading", {
    name: "More ways to get your work done",
  });
  click(await findAction("button", "Continue"));
  await expect(screen.findByLabelText("Your first task")).resolves.toHaveValue(
    "Keep my launch plan.",
  );
});

function openChannels() {
  mockSlack(context);
  mockTeams(context);
  context.mocks.browser.matchMedia(false);
  context.mocks.data.onboardingStatus({
    isAdmin: true,
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  return setupPage({ context, path: "/onboarding/slack", auth: harbor.auth });
}
function discord() {
  return findAction("button", "Discord");
}
function addedDiscord() {
  return waitFor(() => {
    const button = screen.getByText("Discord").closest("button");
    expect(button).toHaveTextContent("Added");
    return button;
  });
}
function next() {
  return findAction("button", "Continue");
}
test("onboarding-discord-001 an administrator can continue to the first task after Discord finishes", async () => {
  const service = authorizationService(context, {}, { isAdmin: true });
  const tab = browserPeer(context);
  const browser = context.mocks.browser.open(tab);
  await openChannels();
  await expect(next()).resolves.toBeDisabled();
  click(await discord());
  await service.checking.promise;
  expect(browser.calls).toContainEqual(
    expect.objectContaining({ target: "_blank" }),
  );
  expect(tab.location.href).toBe(authorizeUrl);
  await expect(discord()).resolves.toBeDisabled();
  await expect(next()).resolves.toBeDisabled();
  expect(location.pathname).toBe("/onboarding/slack");
  service.approve();
  service.release.resolve();
  const added = await addedDiscord();
  expect(added).toBeDisabled();
  await expect(next()).resolves.toBeEnabled();
  click(await next());
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding/capabilities");
  });
  click(await next());
  await screen.findByText("Let’s start your first task");
  expect(location.pathname).toBe("/onboarding/ready");
});
test("onboarding-discord-003 losing the Discord connection makes the chat step required again", async () => {
  let connected = true;
  statusService(context, () => {
    return { isAdmin: true, isConnected: connected };
  });
  await openChannels();
  await addedDiscord();
  await expect(next()).resolves.toBeEnabled();
  connected = false;
  context.mocks.ably.trigger("discord:changed");
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  await expect(discord()).resolves.toBeEnabled();
  await expect(next()).resolves.toBeDisabled();
});
