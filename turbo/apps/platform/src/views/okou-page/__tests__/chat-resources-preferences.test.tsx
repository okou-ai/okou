import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { buttonNamed } from "./chat-navigation-artifact-test-helpers.ts";

import {
  context,
  resourceButton,
  resourceState,
  setupResources,
} from "./chat-resources-test-helpers.ts";

test("Keep a manual close while the available gutter narrows and widens again", async () => {
  const resize = await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(200);
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  expect(resourceButton()).toBeEnabled();
});

test("Step a manually opened panel aside while the gutter is too narrow, then bring it back", async () => {
  const resize = await setupResources({ preferred: false });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  resize(200);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Honor a previously saved off preference on entry", async () => {
  await setupResources({ preferred: false });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Keep the existing artifact entry when the rollout switch is off", async () => {
  await setupResources({ enabled: false });
  click(buttonNamed("Open artifacts"));
  const all = await screen.findByTestId("thread-sidebar-artifacts");
  expect(all).toHaveAccessibleName("Artifacts");
});

test("Turn automatic resources off from Chat settings", async () => {
  await setupPage({
    context,
    path: "/?settings=chat",
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const toggle = await within(dialog).findByRole("switch", {
    name: "Open resources automatically",
  });
  await waitFor(() => {
    expect(toggle).toBeChecked();
  });
  click(toggle);
  await waitFor(() => {
    expect(
      within(dialog).getByRole("switch", {
        name: "Open resources automatically",
      }),
    ).not.toBeChecked();
  });
});

test("Offer the automatic resources setting only with the rollout switch", async () => {
  await setupPage({ context, path: "/?settings=chat" });
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await within(dialog).findByRole("switch", { name: "Cloud browser" });
  expect(
    within(dialog).queryByRole("switch", {
      name: "Open resources automatically",
    }),
  ).not.toBeInTheDocument();
});
