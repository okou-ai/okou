import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  mockConnectors,
  mockOAuthCompletions,
} from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import {
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";
import {
  receiveFirstChat,
  findSentPrompt,
  documentInstructions,
} from "./onboarding-first-chat-test-helpers.ts";
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
