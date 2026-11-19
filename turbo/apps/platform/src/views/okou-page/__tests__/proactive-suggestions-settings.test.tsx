import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
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
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    proactiveSuggestionsContract.update,
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
    path: "/agents?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
      [FeatureSwitchKey.ProactiveLearning]: false,
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

test("keeps a pending opt-in cancellable when the primary Agent is unavailable", async () => {
  let preference: ProactiveSuggestionsPreference = {
    enabled: true,
    status: "preparing",
    unavailableReason: "missing-default-agent",
  };
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    proactiveSuggestionsContract.update,
    ({ body, respond }) => {
      preference = { ...preference, enabled: body.enabled, status: "paused" };
      return respond(200, preference);
    },
  );
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
      [FeatureSwitchKey.ProactiveLearning]: false,
    },
  });
  const card = await screen.findByTestId("proactive-suggestions-preference");
  await expect(
    within(card).findByText(
      "Okou is unavailable in this workspace. Contact a workspace administrator.",
    ),
  ).resolves.toBeInTheDocument();
  const toggle = within(card).getByRole("switch", {
    name: "Suggestions",
  });
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
});
