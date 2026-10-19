import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  proactiveSuggestionsContract,
  type ProactiveSuggestionsPreference,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
test("hides Proactive Suggestions behind Agent Suggestion while retaining Morning Brief", async () => {
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: false },
  });
  await expect(
    screen.findByRole("switch", { name: "Morning brief" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Proactive Suggestions" }),
  ).not.toBeInTheDocument();
});

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
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
  const toggle = await screen.findByRole("switch", {
    name: "Proactive Suggestions",
  });
  await waitFor(() => {
    return expect(toggle).toBeEnabled();
  });
  expect(toggle).not.toBeChecked();
  const morning = screen.getByRole("switch", { name: "Morning brief" });
  expect(morning).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  expect(morning).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
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
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
  const card = await screen.findByTestId("proactive-suggestions-preference");
  await expect(
    within(card).findByText(
      "Choose a usable default Agent to receive proactive suggestions.",
    ),
  ).resolves.toBeInTheDocument();
  const toggle = within(card).getByRole("switch", {
    name: "Proactive Suggestions",
  });
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
});

test("retries a failed opt-out without enabling proactive suggestions", async () => {
  const preference: ProactiveSuggestionsPreference = {
    enabled: false,
    status: "error",
    unavailableReason: null,
  };
  const choices: boolean[] = [];
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    proactiveSuggestionsContract.update,
    ({ body, respond }) => {
      choices.push(body.enabled);
      return respond(200, { ...preference, status: "paused" });
    },
  );
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
  const card = await screen.findByTestId("proactive-suggestions-preference");
  const retry = await waitFor(() => {
    const button = queryAllByRoleFast("button", card).find((item) => {
      return item.textContent === "Retry";
    });
    if (!button) {
      throw new Error("Retry button is not available");
    }
    expect(button).toBeEnabled();
    return button;
  });
  click(retry);
  await waitFor(() => {
    return expect(choices).toStrictEqual([false]);
  });
  expect(
    within(card).getByRole("switch", { name: "Proactive Suggestions" }),
  ).not.toBeChecked();
});
