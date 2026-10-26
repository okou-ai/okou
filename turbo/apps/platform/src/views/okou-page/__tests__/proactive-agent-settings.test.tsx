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

test("offers Learning, Planning and action, and Suggestions as independent preferences", async () => {
  await setupPage({
    context,
    path: "/agents?settings=proactive-agent",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveAgent]: true,
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const learning = await screen.findByRole("switch", { name: "Learning" });
  const planning = await screen.findByRole("switch", {
    name: "Planning & action",
  });
  const suggestions = await screen.findByRole("switch", {
    name: "Suggestions",
  });
  await waitFor(() => {
    for (const toggle of [learning, planning, suggestions]) {
      expect(toggle).toBeEnabled();
      expect(toggle).not.toBeChecked();
    }
  });
  expect(screen.getAllByRole("switch")).toHaveLength(3);
  expect(
    screen.getByRole("heading", { name: "Proactive" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Morning brief" }),
  ).not.toBeInTheDocument();
  click(learning);
  await waitFor(() => {
    return expect(learning).toBeChecked();
  });
  expect(planning).not.toBeChecked();
  expect(suggestions).not.toBeChecked();
  click(planning);
  await waitFor(() => {
    return expect(planning).toBeChecked();
  });
  expect(learning).toBeChecked();
  expect(suggestions).not.toBeChecked();
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

test("redirects an unavailable Proactive deep link without hiding Morning Brief", async () => {
  await setupPage({
    context,
    path: "/agents?settings=proactive-agent",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveAgent]: false,
      [FeatureSwitchKey.AgentSuggestion]: false,
    },
  });
  await expect(
    screen.findByRole("switch", { name: "Morning brief" }),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.textContent?.trim() === "Proactive";
    }),
  ).toBeFalsy();
  expect(
    screen.queryByRole("switch", { name: "Learning" }),
  ).not.toBeInTheDocument();
});

test.each([
  {
    rollout: "Suggestions",
    proactiveAgent: false,
    suggestions: true,
    labels: ["Suggestions"],
  },
  {
    rollout: "Learning and Planning & action",
    proactiveAgent: true,
    suggestions: false,
    labels: ["Learning", "Planning & action"],
  },
])("offers $rollout independently of the other rollout", async (flags) => {
  await setupPage({
    context,
    path: "/agents?settings=proactive-agent",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveAgent]: flags.proactiveAgent,
      [FeatureSwitchKey.AgentSuggestion]: flags.suggestions,
    },
  });
  await screen.findByRole("heading", { name: "Proactive" });
  await waitFor(() => {
    for (const name of flags.labels) {
      expect(screen.getByRole("switch", { name })).toBeEnabled();
    }
  });
  expect(
    screen.getAllByRole("switch").map((toggle) => {
      return toggle.getAttribute("aria-label");
    }),
  ).toStrictEqual(flags.labels);
});
