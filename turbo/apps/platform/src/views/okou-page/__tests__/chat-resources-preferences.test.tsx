import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { buttonNamed } from "./chat-navigation-artifact-test-helpers.ts";

import {
  context,
  resourceButton,
  resourceState,
  setupResources,
} from "./chat-resources-test-helpers.ts";

test("Keep the saved off preference when the available gutter becomes wide again", async () => {
  const resize = await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  resize(200);
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
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

test("Roll back the visible state and explain a failed preference save", async () => {
  context.mocks.api(userPreferencesContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Preference update failed" },
    });
  });
  await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(resourceButton());
  await screen.findByText("Preference update failed");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  expect(screen.getAllByText("Preference update failed")).toHaveLength(1);
});
