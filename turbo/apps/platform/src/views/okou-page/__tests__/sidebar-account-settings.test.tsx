import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { click, setupPage } from "../../../__tests__/page-helper.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  buttonByText,
  createSidebarAccountHelpers,
  linkByText,
  openAccountMenu,
} from "./sidebar-account-test-helpers.ts";

const context = testContext();
const { prepareDefaultAgent } = createSidebarAccountHelpers(context);

test("Open personal Settings and manage account security", async () => {
  prepareDefaultAgent();
  context.mocks.data.userPreferences({
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });

  const menu = await openAccountMenu();
  expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(menu).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  click(within(menu).getByText("Settings"));

  await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Preference" }),
    ).toBeInTheDocument();
    // Scoped to the dialog: the sidebar account row also carries the name.
    expect(within(dialog).getByText("Account & security")).toBeInTheDocument();
    expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(dialog).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();
    const morningBrief = within(dialog).getByTestId("morning-brief-preference");
    expect(
      within(dialog).getByRole("region", { name: "Proactive" }),
    ).toContainElement(morningBrief);
  });

  const openedSettingsDialog = screen.getByRole("dialog", {
    name: "Settings",
  });
  await waitFor(() => {
    const activeElement = document.activeElement;
    expect(openedSettingsDialog).not.toHaveFocus();
    expect(activeElement).toBeInstanceOf(HTMLElement);
    expect(openedSettingsDialog).toContainElement(activeElement as HTMLElement);
  });

  const userProfileLink = linkByText("Manage");
  expect(userProfileLink).toHaveAttribute(
    "href",
    "https://accounts.example.test/user",
  );
  expect(userProfileLink).toHaveAttribute("target", "_blank");
  expect(userProfileLink).toHaveAttribute("rel", "noreferrer");
});

test("Toggle network-body capture in Debug settings", async () => {
  prepareDefaultAgent();
  const user = userEvent.setup({ delay: null });
  const submitted: number[] = [];
  let preferences: UserPreferencesResponse = {
    timezone: null,
    locale: "en-US",
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: true,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  context.mocks.data.userPreferences(preferences);
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    if (body.captureNetworkBodiesRemaining !== undefined) {
      submitted.push(body.captureNetworkBodiesRemaining);
    }
    preferences = { ...preferences, ...body };
    context.mocks.data.userPreferences(preferences);
    return respond(200, preferences);
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  const menu = await openAccountMenu();
  expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
  expect(
    within(menu).getByText("alex.rivera@example.test"),
  ).toBeInTheDocument();

  click(within(menu).getByText("Settings"));

  await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Preference" }),
    ).toBeInTheDocument();
    // Scoped to the dialog: the sidebar account row also carries the name.
    expect(within(dialog).getByText("Account & security")).toBeInTheDocument();
    expect(within(dialog).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(dialog).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();
  });

  click(buttonByText("Debug"));

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Debug" })).toBeInTheDocument();
    expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  const captureSwitch = screen.getByRole("switch", {
    name: "Capture network bodies",
    checked: false,
  });
  expect(captureSwitch).toHaveAccessibleDescription("Disabled");
  await user.click(captureSwitch);

  await waitFor(() => {
    expect(
      screen.getByRole("switch", {
        name: "Capture network bodies",
        checked: true,
      }),
    ).toHaveAccessibleDescription("Enabled for the next 3 runs");
  });
  expect(submitted).toStrictEqual([3]);

  captureSwitch.focus();
  expect(captureSwitch).toHaveFocus();
  await user.keyboard("[Space]");

  await waitFor(() => {
    expect(
      screen.getByRole("switch", {
        name: "Capture network bodies",
        checked: false,
      }),
    ).toHaveAccessibleDescription("Disabled");
  });
  expect(submitted).toStrictEqual([3, 0]);

  await user.click(screen.getByText("Capture network bodies"));
  await waitFor(() => {
    expect(
      screen.getByRole("switch", {
        name: "Capture network bodies",
        checked: true,
      }),
    ).toHaveAccessibleDescription("Enabled for the next 3 runs");
  });
  expect(submitted).toStrictEqual([3, 0, 3]);
});

test("Hide Debug settings without Debug access", async () => {
  prepareDefaultAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?settings=debug`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    },
  });

  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(
    within(dialog).getByRole("heading", { name: "Preference" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText("Debug")).not.toBeInTheDocument();
});
