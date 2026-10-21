import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { getFeatureSwitchMetadata } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const PINNED_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function featureSwitchRow(feature: FeatureSwitchKey): HTMLElement {
  const label = getFeatureSwitchMetadata()[feature].displayName ?? feature;
  const row = screen.getByText(label).closest("li");
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

test.each([
  { email: "bingjie@okou.ai", enabled: true },
  { email: "ethan@okou.ai", enabled: false },
])("PWA keyboard viewport defaults for $email", async ({ email, enabled }) => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(display-mode: standalone)";
  });
  await setupPage({
    context,
    path: "/_/lab",
    auth: {
      user: { id: "keyboard-rollout-user", fullName: "Rollout Tester", email },
      organization: {
        activeOrg: {
          id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
          name: "Staff",
        },
        memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
      },
    },
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });
  await screen.findByRole("heading", { name: "Lab" });
  const control = within(
    featureSwitchRow(FeatureSwitchKey.PwaKeyboardViewport),
  ).getByRole("switch");
  expect(control).toHaveAttribute("aria-checked", String(enabled));
  expect(document.documentElement.dataset.pwaKeyboardViewport).toBe(
    enabled ? "true" : undefined,
  );
});

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

  // Available switches are listed once, in their rollout-stage group.
  const metadata = getFeatureSwitchMetadata();
  const stageGroups = {
    released: "Released",
    beta: "Beta",
    alpha: "Alpha",
    internal: "Internal",
  } as const;
  const keys = Object.values(FeatureSwitchKey);
  for (const key of keys) {
    const group = featureSwitchGroup(stageGroups[metadata[key].rolloutStage]);
    expect(
      within(group).getByText(metadata[key].displayName ?? key),
    ).toBeInTheDocument();
  }
  expect(screen.getAllByRole("switch")).toHaveLength(keys.length);
  expect(
    within(featureSwitchGroup("Alpha")).getByText(FeatureSwitchKey.Banking),
  ).toBeVisible();
  expect(
    within(featureSwitchGroup("Beta")).getByText("Custom templates"),
  ).toBeVisible();
  expect(
    within(featureSwitchGroup("Internal")).getByText(
      FeatureSwitchKey.TestOauthConnector,
    ),
  ).toBeVisible();
  expect(buttonNamed("Reset all")).toBeEnabled();
});

test("The maintainer can manage the remote UI switch in Lab", async () => {
  await setupPage({
    context,
    path: "/_/lab",
    auth: {
      user: { id: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV", fullName: "Bingjie" },
    },
    featureSwitches: { [FeatureSwitchKey.Lab]: true },
  });
  await screen.findByText("Remote control guided setup");
  expect(
    within(
      featureSwitchRow(FeatureSwitchKey.RemoteControlGuidedSetup),
    ).getByRole("switch"),
  ).toBeEnabled();
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

  expect(screen.getByText("Custom templates")).toBeInTheDocument();
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

test.each([
  FeatureSwitchKey.TestOauthConnector,
  FeatureSwitchKey.PwaKeyboardViewport,
  FeatureSwitchKey.RemoteControlGuidedSetup,
])("Toggle and reset a Lab override: %s", async (featureKey) => {
  const user = userEvent.setup();
  const updatedSwitches: Record<string, boolean>[] = [];
  let resetRequested = false;

  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: {
      [FeatureSwitchKey.Lab]: true,
      [featureKey]: false,
    },
  });
  await screen.findByRole("heading", { name: "Lab" });

  let effectiveSwitches: Record<string, boolean> = {
    [FeatureSwitchKey.Lab]: true,
    [featureKey]: false,
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

  const feature = featureSwitchRow(featureKey);
  const featureControl = within(feature).getByRole("switch");
  expect(featureControl).not.toBeChecked();

  await user.click(featureControl);

  await waitFor(() => {
    expect(featureControl).toBeChecked();
  });
  expect(document.documentElement.dataset.pwaKeyboardViewport).toBe(
    featureKey === FeatureSwitchKey.PwaKeyboardViewport ? "true" : undefined,
  );
  expect(updatedSwitches).toStrictEqual([{ [featureKey]: true }]);

  await user.click(buttonNamed("Reset all"));

  await waitFor(() => {
    expect(resetRequested).toBeTruthy();
    expect(featureControl).not.toBeChecked();
  });
  expect(document.documentElement).not.toHaveAttribute(
    "data-pwa-keyboard-viewport",
  );
});
