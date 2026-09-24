import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const PINNED_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function featureSwitchRow(feature: FeatureSwitchKey): HTMLElement {
  const row = screen.getByText(feature).closest("li");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${feature} feature row not found`);
  }
  return row;
}

function featureSwitchGroup(name: string): HTMLElement {
  const section = screen.getByRole("heading", { name }).closest("section");
  if (!(section instanceof HTMLElement)) {
    throw new Error(`${name} feature group not found`);
  }
  return section;
}

function buttonNamed(name: string): HTMLElement {
  const button = screen.getByText(name).closest("button");
  if (!(button instanceof HTMLElement)) {
    throw new Error(`${name} button not found`);
  }
  return button;
}

test("Lab remains available while onboarding is required", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.data.agents([
    {
      agentId: PINNED_AGENT_ID,
      displayName: "Pinned Agent",
      visibility: "private",
    },
  ]);

  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: {
      [FeatureSwitchKey.Banking]: true,
      [FeatureSwitchKey.Lab]: true,
    },
  });

  await screen.findByRole("heading", { name: "Lab" });
  expect(
    within(featureSwitchGroup("Alpha")).getByText(FeatureSwitchKey.Banking),
  ).toBeInTheDocument();
  expect((await screen.findAllByText("Pinned Agent")).length).toBeGreaterThan(
    0,
  );
});

test("Lab groups active feature switches", async () => {
  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });

  await screen.findByRole("heading", { name: "Lab" });

  const released = featureSwitchGroup("Released");
  const beta = featureSwitchGroup("Beta");
  const alpha = featureSwitchGroup("Alpha");
  const internal = featureSwitchGroup("Internal");
  const featureRows = [released, beta, alpha, internal].flatMap((group) => {
    return Array.from(group.querySelectorAll("li"));
  });

  expect(featureRows).toHaveLength(Object.values(FeatureSwitchKey).length);
  expect(screen.getAllByRole("switch")).toHaveLength(featureRows.length);
  expect(
    within(released).getByText(FeatureSwitchKey.AvatarNeckSweater),
  ).toBeVisible();
  expect(within(alpha).getByText(FeatureSwitchKey.Banking)).toBeVisible();
  expect(
    within(beta).getByText(FeatureSwitchKey.CustomTemplates),
  ).toBeVisible();
  expect(
    within(alpha).getByText(FeatureSwitchKey.AhrefsConnector),
  ).toBeVisible();
  expect(
    within(internal).getByText(FeatureSwitchKey.TestOauthConnector),
  ).toBeVisible();
  expect(buttonNamed("Reset all")).toBeEnabled();
});

test("Maintainer filters narrow the feature list", async () => {
  const user = userEvent.setup({ delay: null });

  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });
  await screen.findByRole("heading", { name: "Lab" });

  const all = buttonNamed("All");
  const bingjie = buttonNamed("bingjie");
  const totalCount = screen.getAllByRole("switch").length;
  expect(within(all).getByText(String(totalCount))).toBeInTheDocument();

  await user.click(bingjie);

  expect(
    screen.getByText(FeatureSwitchKey.ComposerTaskChips),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(FeatureSwitchKey.AhrefsConnector),
  ).not.toBeInTheDocument();
  const maintainerCount = screen.getAllByRole("switch").length;
  expect(maintainerCount).toBeLessThan(totalCount);
  expect(
    within(bingjie).getByText(String(maintainerCount)),
  ).toBeInTheDocument();
  expect(within(all).getByText(String(totalCount))).toBeInTheDocument();

  await user.click(all);

  expect(all).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByText(FeatureSwitchKey.AhrefsConnector),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("switch")).toHaveLength(totalCount);
});

test("A user can toggle a Lab feature and reset all overrides", async () => {
  const user = userEvent.setup();
  const updatedSwitches: Record<string, boolean>[] = [];
  let resetRequested = false;

  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: {
      [FeatureSwitchKey.Lab]: true,
      [FeatureSwitchKey.TestOauthConnector]: false,
    },
  });
  await screen.findByRole("heading", { name: "Lab" });

  let effectiveSwitches: Record<string, boolean> = {
    [FeatureSwitchKey.Lab]: true,
    [FeatureSwitchKey.TestOauthConnector]: false,
  };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: effectiveSwitches,
      effectiveSwitches,
    });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    updatedSwitches.push(body.switches);
    effectiveSwitches = { ...effectiveSwitches, ...body.switches };
    return respond(200, {
      switches: effectiveSwitches,
      effectiveSwitches,
    });
  });
  context.mocks.api(featureSwitchesContract.delete, ({ respond }) => {
    resetRequested = true;
    effectiveSwitches = { [FeatureSwitchKey.Lab]: true };
    return respond(200, { deleted: true });
  });

  const feature = featureSwitchRow(FeatureSwitchKey.TestOauthConnector);
  const featureControl = within(feature).getByRole("switch");
  expect(featureControl).not.toBeChecked();

  await user.click(featureControl);

  await waitFor(() => {
    expect(featureControl).toBeChecked();
  });
  expect(updatedSwitches).toStrictEqual([
    { [FeatureSwitchKey.TestOauthConnector]: true },
  ]);

  await user.click(buttonNamed("Reset all"));

  await waitFor(() => {
    expect(resetRequested).toBeTruthy();
    expect(featureControl).not.toBeChecked();
  });
});
