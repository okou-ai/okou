import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
async function accountSettings() {
  await setupPage({
    context,
    path: "/",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex@example.test",
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
      [FeatureSwitchKey.AgentSuggestion]: false,
    },
  });
  click(await findAction("button", "Alex Rivera"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  return screen.findByRole("dialog", { name: "Settings" });
}
test("sidebar-account-settings-001 Alex’s account menu opens focused preferences with the profile link and Morning Brief", async () => {
  context.mocks.data.userPreferences({
    timezone: "America/New_York",
    locale: "en-US",
  });
  const settings = await accountSettings();
  const view = within(settings);
  await view.findByRole("heading", { name: "Preference" });
  expect(
    view.getByRole("heading", { name: "Account & security" }),
  ).toBeInTheDocument();
  expect(view.getByText("Alex Rivera")).toBeInTheDocument();
  expect(view.getByText("alex@example.test")).toBeInTheDocument();
  const proactive = await view.findByRole("region", { name: "Proactive" });
  await expect(
    within(proactive).findByRole("switch", { name: /Morning Brief/iu }),
  ).resolves.toBeInTheDocument();
  expect(settings.contains(document.activeElement)).toBeTruthy();
  const manage = getAction("link", "Manage", settings);
  expect(manage).toHaveAttribute("href", "https://accounts.example.test/user");
  expect(manage).toHaveAttribute("target", "_blank");
  expect(manage).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
});
test("sidebar-account-settings-002 Debug saves the capture allowance selected by click, Space and label", async () => {
  const preferences: UserPreferencesResponse = {
    timezone: "UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],

    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    Object.assign(preferences, body);
    return respond(200, preferences);
  });
  const settings = await accountSettings();
  click(getAction("button", "Debug", settings));
  const toggle = await within(settings).findByRole("switch", {
    name: "Capture network bodies",
  });
  expect(toggle).not.toBeChecked();
  expect(toggle).toHaveAccessibleDescription("Disabled");
  const user = userEvent.setup();
  await user.click(toggle);
  await waitFor(() => {
    return expect(toggle).toHaveAccessibleDescription(
      "Enabled for the next 3 runs",
    );
  });
  expect(preferences.captureNetworkBodiesRemaining).toBe(3);
  expect(toggle).toHaveFocus();
  await user.keyboard(" ");
  await waitFor(() => {
    return expect(toggle).toHaveAccessibleDescription("Disabled");
  });
  expect(preferences.captureNetworkBodiesRemaining).toBe(0);
  click(
    within(settings).getByText("Capture network bodies", { selector: "label" }),
  );
  await waitFor(() => {
    return expect(toggle).toHaveAccessibleDescription(
      "Enabled for the next 3 runs",
    );
  });
  expect(preferences.captureNetworkBodiesRemaining).toBe(3);
});
