import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("offers four independent preferences and leaves Morning Brief in Preference", async () => {
  await setupPage({
    context,
    path: "/agents?settings=proactive-agent",
    featureSwitches: { [FeatureSwitchKey.ProactiveAgent]: true },
  });
  const learning = await screen.findByRole("switch", { name: "Learning" });
  const planning = await screen.findByRole("switch", { name: "Planning" });
  const tasks = await screen.findByRole("switch", { name: "Proactive tasks" });
  const suggestions = await screen.findByRole("switch", {
    name: "Proactive Suggestions",
  });
  await waitFor(() => {
    for (const toggle of [learning, planning, tasks, suggestions]) {
      expect(toggle).toBeEnabled();
      expect(toggle).not.toBeChecked();
    }
  });
  expect(
    screen.queryByRole("switch", { name: "Morning brief" }),
  ).not.toBeInTheDocument();
  click(learning);
  await waitFor(() => {
    return expect(learning).toBeChecked();
  });
  expect(planning).not.toBeChecked();
  expect(tasks).not.toBeChecked();
  expect(suggestions).not.toBeChecked();
  click(planning);
  await waitFor(() => {
    return expect(planning).toBeChecked();
  });
  expect(learning).toBeChecked();
  expect(tasks).not.toBeChecked();
  const preference = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Preference";
  });
  if (!preference) {
    throw new Error("Expected Preference navigation");
  }
  click(preference);
  const morning = await screen.findByRole("switch", { name: "Morning brief" });
  expect(morning).not.toBeChecked();
});

test("redirects an unavailable Proactive Agent deep link without hiding Morning Brief", async () => {
  await setupPage({
    context,
    path: "/agents?settings=proactive-agent",
    featureSwitches: { [FeatureSwitchKey.ProactiveAgent]: false },
  });
  await expect(
    screen.findByRole("switch", { name: "Morning brief" }),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.textContent?.trim() === "Proactive Agent";
    }),
  ).toBeFalsy();
  expect(
    screen.queryByRole("switch", { name: "Learning" }),
  ).not.toBeInTheDocument();
});
