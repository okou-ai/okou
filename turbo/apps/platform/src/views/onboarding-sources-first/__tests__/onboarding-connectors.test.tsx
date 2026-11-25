import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  mockSlack,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  mockConnectors,
  mockOAuthCompletions,
} from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
  connectedGmailSource,
} from "./onboarding-catalog-test-helpers.ts";
import {
  receiveFirstChat,
  findSentPrompt,
  documentInstructions,
} from "./onboarding-first-chat-test-helpers.ts";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

const recommendations = [
  ["gmail", "Gmail"],
  ["google-drive", "Google Drive"],
  ["google-calendar", "Google Calendar"],
  ["google-docs", "Google Docs"],
  ["google-sheets", "Google Sheets"],
  ["google-ads", "Google Ads"],
  ["notion", "Notion"],
  ["github", "GitHub"],
] as const;

function catalog(hasAds = false) {
  mockOnboardingConnectorCatalog(
    context,
    recommendations.map(([slug, label]) => {
      return onboardingSourceItem({
        slug,
        label,
        description: label + " workspace connection",
        hasAccount: hasAds && slug === "google-ads",
      });
    }),
  );
}

test.each([
  ["onboarding-prompt-connectors-001", "/onboarding", "Next", false],
  [
    "onboarding-prompt-connectors-002",
    "/onboarding/sources",
    "Start task",
    true,
  ],
] as const)(
  "%s offers eight workspace tools and sends the edited prompt from %s",
  async (_id, path, button, mobile) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    context.mocks.browser.matchMedia((q) => {
      return mobile && q === "(width < 640px)";
    });
    catalog();
    const receipt = receiveFirstChat(context);
    await setupPage({
      context,
      path: path + "?prompt=Plan+the+customer+workshop",
    });
    const prompt = await screen.findByLabelText("Onboarding prompt");
    expect(prompt).toHaveValue("Plan the customer workshop");
    for (const [, label] of recommendations) {
      await expect(
        findAction("button", "Connect " + label),
      ).resolves.toBeEnabled();
    }
    const edit = "Design the Friday customer workshop agenda.";
    await fill(prompt, edit);
    click(await findAction("button", button));
    const sent = await receipt;
    await expect(findSentPrompt(sent.prompt)).resolves.toBeInTheDocument();
    expect(sent.prompt).toBe(edit + "\n\n" + documentInstructions);
    expect(window.location.pathname).toBe("/chats/" + sent.threadId);
  },
);

test("onboarding-prompt-connectors-004 Google Ads consent preserves the draft and other connection options", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  catalog();
  const attempt = crypto.randomUUID();
  const completed = mockOAuthCompletions(context);
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  const consent = "https://consent.example.test/google-ads/authorized-account";
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, respond }) => {
      expect(params.connectorSlug).toBe("google-ads");
      return respond(200, {
        oauthAttemptId: attempt,
        authorizationUrl: consent,
      });
    },
  );
  await setupPage({
    context,
    path: "/onboarding?prompt=Summarize+our+acquisition",
  });
  const field = await screen.findByLabelText("Onboarding prompt");
  const task = "Summarize our acquisition using Google Ads";
  await fill(field, task);
  click(await findAction("button", "Connect Google Ads"));
  await waitFor(() => {
    return expect(popup.location.href).toBe(consent);
  });
  catalog(true);
  const [ads] = mockConnectors(context, [
    { connectorSlug: "google-ads", externalUsername: "harbor-marketing" },
  ]);
  completed.set(attempt, ads!.id);
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "google-ads",
  });
  await findAction("button", "Manage Google Ads access");
  expect(field).toHaveValue(task);
  await expect(findAction("button", "Connect Gmail")).resolves.toBeEnabled();
  await expect(findAction("button", "Next")).resolves.toBeEnabled();
});

test("onboarding-experience-connect-002 a completed device session marks the listed personal Codex plan connected", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.data.personalModelProviders([]);
  const approved = createDeferredPromise<void>(context.signal);
  const provider = {
    id: crypto.randomUUID(),
    type: "codex-oauth-token",
    framework: "codex",
    isActive: true,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-10-18T10:00:00Z",
    updatedAt: "2026-10-18T10:00:00Z",
  } as const;
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      type: "codex",
      scope: "personal",
      status: "pending",
      sessionToken: "harbor-session",
      browserUrl: "https://device.example.test/verify",
      verificationCode: "HARBOR-23",
      expiresIn: 300,
      interval: 1,
    });
  });
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ body, respond }) => {
      expect(body.sessionToken).toBe("harbor-session");
      await approved.promise;
      context.mocks.data.personalModelProviders([provider]);
      return respond(200, { status: "complete", provider, created: true });
    },
  );
  await setupPage({ context, path: "/onboarding/experience" });
  click(await screen.findByText("Codex"));
  click(await findAction("button", "Connect Codex"));
  await screen.findByText("HARBOR-23");
  approved.resolve();
  const linked = await findAction("button", "Connected");
  expect(linked).toBeDisabled();
  expect(window.location.pathname).toBe("/onboarding/experience");
});

test("onboarding-experience-connect-004 a new user starting with Okou goes directly from plan selection to chat channels", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  mockSlack(context, { isAdmin: true, installUrl: "/install/slack" });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  await setupPage({ context, path: "/onboarding" });
  click(await screen.findByText("Business & operations"));
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a work tool" });
  const next = await findAction("button", "Continue");
  await waitFor(() => {
    return expect(next).toBeEnabled();
  });
  click(next);
  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  click(await screen.findByText("Start with Okou"));
  expect(queryAction("button", "Connect Codex")).toBeNull();
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  expect(window.location.pathname).toBe("/onboarding/slack");
  await expect(findAction("button", "Add to Slack")).resolves.toBeEnabled();
});
