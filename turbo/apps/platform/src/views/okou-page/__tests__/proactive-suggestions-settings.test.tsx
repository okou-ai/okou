import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  proactiveSuggestionsContract,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
test("starts off, enables hourly checks independently of Morning Brief, and preserves explicit opt-out", async () => {
  let preference: ProactiveSuggestionsPreference = {
    enabled: false,
    status: "paused",
    unavailableReason: null,
  };
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: preference.enabled,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    ({ body, respond }) => {
      preference = {
        ...preference,
        enabled: body.enabled,
        status: body.enabled ? "enabled" : "paused",
      };
      return respond(200, preference);
    },
  );
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const toggle = await screen.findByRole("switch", {
    name: "Suggestions",
  });
  await waitFor(() => {
    return expect(toggle).toBeEnabled();
  });
  expect(toggle).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
  await expect(
    screen.findByRole("switch", { name: "Morning brief" }),
  ).resolves.not.toBeChecked();
});

test("a failed opt-out preserves the current preference", async () => {
  const preference: ProactiveSuggestionsPreference = {
    enabled: true,
    status: "error",
    unavailableReason: null,
  };
  const choices: boolean[] = [];
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: preference.enabled,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    ({ body, respond }) => {
      choices.push(body.enabled);
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Preference not saved",
        },
      });
    },
  );
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const card = await screen.findByTestId("proactive-suggestions-preference");
  const toggle = within(card).getByRole("switch", { name: "Suggestions" });
  expect(toggle).toBeChecked();
  click(toggle);
  await within(card).findByText(
    "Proactive Suggestions settings could not be loaded or updated.",
  );
  expect(toggle).toBeChecked();
  expect(choices).toStrictEqual([false]);
});

test("keeps suggestions opted in during platform recovery without asking the user to restart them", async () => {
  let preference: ProactiveSuggestionsPreference = {
    enabled: true,
    status: "error",
    unavailableReason: null,
  };
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: preference.enabled,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    ({ body, respond }) => {
      preference = { ...preference, enabled: body.enabled, status: "paused" };
      return respond(200, preference);
    },
  );
  await setupPage({
    context,
    path: "/?settings=my-okou",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const card = await screen.findByTestId("proactive-suggestions-preference");
  await expect(
    within(card).findByText("Temporarily unavailable."),
  ).resolves.toBeInTheDocument();
  const toggle = within(card).getByRole("switch", {
    name: "Suggestions",
  });
  expect(toggle).toBeChecked();
  click(toggle);
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
  });
});
