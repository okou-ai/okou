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

test("Lab groups every feature by rollout stage with a switch", async () => {
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
    within(released).getByText(FeatureSwitchKey.WelcomeThread),
  ).toBeVisible();
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

test("A user can filter Lab features by maintainer", async () => {
  const user = userEvent.setup();

  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });
  await screen.findByRole("heading", { name: "Lab" });

  await user.click(buttonNamed("bingjie"));

  expect(screen.getByText(FeatureSwitchKey.ComposerTaskChips)).toBeVisible();
  expect(
    screen.queryByText(FeatureSwitchKey.AhrefsConnector),
  ).not.toBeInTheDocument();

  await user.click(buttonNamed("All"));

  expect(screen.getByText(FeatureSwitchKey.AhrefsConnector)).toBeVisible();
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

test("A feature switch update resynchronizes color theme document attributes", async () => {
  const user = userEvent.setup();

  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: {
      [FeatureSwitchKey.Lab]: true,
      [FeatureSwitchKey.GradientColorThemes]: false,
    },
  });
  await screen.findByRole("heading", { name: "Lab" });

  let effectiveSwitches: Record<string, boolean> = {
    [FeatureSwitchKey.Lab]: true,
    [FeatureSwitchKey.GradientColorThemes]: false,
  };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: effectiveSwitches,
      effectiveSwitches,
    });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    effectiveSwitches = { ...effectiveSwitches, ...body.switches };
    return respond(200, {
      switches: body.switches,
      effectiveSwitches,
    });
  });

  const featureControl = within(
    featureSwitchRow(FeatureSwitchKey.GradientColorThemes),
  ).getByRole("switch");
  expect(featureControl).not.toBeChecked();
  expect(document.documentElement.dataset.gradientColorThemes).toBeUndefined();

  await user.click(featureControl);

  await waitFor(() => {
    expect(featureControl).toBeChecked();
    expect(document.documentElement.dataset.gradientColorThemes).toBe("");
  });
});

test("Lab orders features by name within each rollout stage", async () => {
  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });

  await screen.findByRole("heading", { name: "Lab" });

  const banking = featureSwitchRow(FeatureSwitchKey.Banking);
  const realAgentInPreview = featureSwitchRow(
    FeatureSwitchKey.RealAgentInPreview,
  );
  expect(
    banking.compareDocumentPosition(realAgentInPreview) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
