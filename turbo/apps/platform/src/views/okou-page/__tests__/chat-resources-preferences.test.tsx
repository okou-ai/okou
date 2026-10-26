import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatResourcesHelpers,
  resourceButton,
  resourceState,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const { setupResources, recordPreferenceUpdates } =
  createChatResourcesHelpers(context);

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

test("Keep the saved preference while its update is pending", async () => {
  const saving = createDeferredPromise<void>(context.signal);
  const updates = recordPreferenceUpdates(false, saving.promise);
  await setupResources();
  await screen.findByTestId("chat-thread-header-title");
  click(resourceButton());
  await waitFor(() => {
    expect(updates).toContainEqual({ chatResourcesEnabledByDefault: true });
    expect(resourceButton()).toHaveAttribute("aria-busy", "true");
  });
  saving.resolve();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
    expect(resourceButton()).not.toHaveAttribute("aria-disabled", "true");
  });
});

test("Keep the saved preference and explain a failed update", async () => {
  context.mocks.api(userPreferencesContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Preference update failed" },
    });
  });
  await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  click(resourceButton());
  await screen.findByText("Preference update failed");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  expect(screen.getAllByText("Preference update failed")).toHaveLength(1);
});
