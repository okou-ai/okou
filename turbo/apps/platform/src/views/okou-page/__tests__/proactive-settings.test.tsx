import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function startWithSuggestionsOff() {
  let enabled = false;
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: enabled,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, {
      enabled,
      status: enabled ? "enabled" : "paused",
      unavailableReason: null,
    });
  });
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    ({ body, respond }) => {
      enabled = body.enabled;
      return respond(200, {
        enabled,
        status: enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    },
  );
}

test("groups proactive preferences in My Okou and keeps Suggestions independent of Morning Brief", async () => {
  startWithSuggestionsOff();
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const region = await screen.findByRole("region", { name: "Proactive" });
  expect(screen.getByRole("heading", { name: "My Okou" })).toBeInTheDocument();
  const morning = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  const suggestions = await within(region).findByRole("switch", {
    name: "Suggestions",
  });
  await waitFor(() => {
    for (const toggle of [morning, suggestions]) {
      expect(toggle).toBeEnabled();
      expect(toggle).not.toBeChecked();
    }
  });
  expect(
    within(region)
      .getAllByRole("switch")
      .map((toggle) => {
        return toggle.getAttribute("aria-label");
      }),
  ).toStrictEqual(expect.arrayContaining(["Morning brief", "Suggestions"]));
  click(suggestions);
  await waitFor(() => {
    return expect(suggestions).toBeChecked();
  });
  expect(morning).not.toBeChecked();
});

test.each([
  {
    rollout: "Morning brief",
    suggestions: false,
    labels: ["Morning brief"],
  },
  {
    rollout: "Suggestions",
    suggestions: true,
    labels: ["Morning brief", "Suggestions"],
  },
])("offers $rollout independently of the other rollout", async (flags) => {
  startWithSuggestionsOff();
  await setupPage({
    context,
    path: flags.suggestions ? "/?settings=my-okou" : "/?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: flags.suggestions,
    },
  });
  const region = await screen.findByRole("region", { name: "Proactive" });
  await waitFor(() => {
    for (const name of flags.labels) {
      expect(within(region).getByRole("switch", { name })).toBeEnabled();
    }
  });
  expect(
    within(region)
      .getAllByRole("switch")
      .map((toggle) => {
        return toggle.getAttribute("aria-label");
      }),
  ).toStrictEqual(expect.arrayContaining(flags.labels));
  expect(
    within(region).queryByRole("switch", { name: "Suggestions" }) !== null,
  ).toBe(flags.suggestions);
});
