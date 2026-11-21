import { test, expect } from "vitest";
import { screen } from "@testing-library/react";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { onboardingDraftContract } from "@okouai/api-contracts/contracts/onboarding";
import { mockNow } from "../../../lib/time.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  mockSlack,
  mockTeams,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
} from "./onboarding-catalog-test-helpers.ts";

const context = testContext();
const route = "/onboarding/slack";
const timestamp = 1_790_000_000_000;
function workspace() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin: true,
  });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  mockNow(timestamp, context.signal);
}
test("onboarding-chat-channels-001 Slack and Teams launch their own install flows before Slack is added", async () => {
  workspace();
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
  workspace();
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
  workspace();
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
  workspace();
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
  workspace();
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
