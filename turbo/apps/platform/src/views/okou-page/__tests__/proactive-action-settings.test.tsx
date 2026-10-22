import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  proactiveActionContract,
  type ProactiveActionPreference,
} from "@okouai/api-contracts/contracts/proactive-action";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("hides proactive action when its feature switch is off", async () => {
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: { [FeatureSwitchKey.ProactiveAction]: false },
  });
  await expect(
    screen.findByRole("switch", { name: "Morning brief" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Proactive action" }),
  ).not.toBeInTheDocument();
});

test("requires an explicit user choice independently of the Suggestions feature switch", async () => {
  let preference: ProactiveActionPreference = {
    enabled: false,
    status: "paused",
    unavailableReason: null,
  };
  context.mocks.api(proactiveActionContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(proactiveActionContract.update, ({ body, respond }) => {
    preference = {
      ...preference,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, preference);
  });
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveAction]: true,
      [FeatureSwitchKey.AgentSuggestion]: false,
    },
  });
  const toggle = await screen.findByRole("switch", {
    name: "Proactive action",
  });
  await waitFor(() => {
    return expect(toggle).toBeEnabled();
  });
  expect(toggle).not.toBeChecked();
  expect(
    screen.queryByRole("switch", { name: "Proactive Suggestions" }),
  ).not.toBeInTheDocument();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  expect(
    screen.getByRole("switch", { name: "Morning brief" }),
  ).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
});

test("shows Suggestions paused while Action is enabled and preserves its saved choice", async () => {
  let action: ProactiveActionPreference = {
    enabled: false,
    status: "paused",
    unavailableReason: null,
  };
  context.mocks.api(proactiveActionContract.get, ({ respond }) => {
    return respond(200, action);
  });
  context.mocks.api(proactiveActionContract.update, ({ body, respond }) => {
    action = {
      ...action,
      enabled: body.enabled,
      status: body.enabled ? "enabled" : "paused",
    };
    return respond(200, action);
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: action.enabled ? "paused" : "enabled",
      unavailableReason: action.enabled ? "proactive-action-enabled" : null,
    });
  });
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveAction]: true,
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const toggle = await screen.findByRole("switch", {
    name: "Proactive action",
  });
  const suggestions = await screen.findByRole("switch", {
    name: "Proactive Suggestions",
  });
  await waitFor(() => {
    expect(toggle).toBeEnabled();
    expect(suggestions).toBeEnabled();
  });
  expect(suggestions).toBeChecked();
  click(toggle);
  await expect(
    screen.findByText(
      "Paused while Proactive action is on. Your preference is saved.",
    ),
  ).resolves.toBeInTheDocument();
  expect(suggestions).toBeChecked();
  await waitFor(() => {
    return expect(toggle).toBeEnabled();
  });
  click(toggle);
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
    expect(suggestions).toBeEnabled();
    expect(suggestions).toBeChecked();
    expect(
      screen.queryByText(
        "Paused while Proactive action is on. Your preference is saved.",
      ),
    ).not.toBeInTheDocument();
  });
});
