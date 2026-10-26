import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("groups proactive preferences in Preference and keeps their opt-ins independent", async () => {
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveAgent]: true,
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const region = await screen.findByRole("region", { name: "Proactive" });
  expect(
    screen.getByRole("heading", { name: "Preference" }),
  ).toBeInTheDocument();
  const morning = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  const learning = await within(region).findByRole("switch", {
    name: "Learning",
  });
  const planning = await within(region).findByRole("switch", {
    name: "Planning & action",
  });
  const suggestions = await within(region).findByRole("switch", {
    name: "Suggestions",
  });
  await waitFor(() => {
    for (const toggle of [morning, suggestions, learning, planning]) {
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
  ).toStrictEqual([
    "Morning brief",
    "Suggestions",
    "Learning",
    "Planning & action",
  ]);
  click(learning);
  await waitFor(() => {
    return expect(learning).toBeChecked();
  });
  expect(planning).not.toBeChecked();
  expect(suggestions).not.toBeChecked();
  expect(morning).not.toBeChecked();
  click(planning);
  await waitFor(() => {
    return expect(planning).toBeChecked();
  });
  expect(learning).toBeChecked();
  expect(suggestions).not.toBeChecked();
  expect(morning).not.toBeChecked();
});

test.each([
  {
    rollout: "Morning brief",
    proactiveAgent: false,
    suggestions: false,
    labels: ["Morning brief"],
  },
  {
    rollout: "Suggestions",
    proactiveAgent: false,
    suggestions: true,
    labels: ["Morning brief", "Suggestions"],
  },
  {
    rollout: "Learning and Planning & action",
    proactiveAgent: true,
    suggestions: false,
    labels: ["Morning brief", "Learning", "Planning & action"],
  },
])("offers $rollout independently of the other rollout", async (flags) => {
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveAgent]: flags.proactiveAgent,
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
  ).toStrictEqual(flags.labels);
});
