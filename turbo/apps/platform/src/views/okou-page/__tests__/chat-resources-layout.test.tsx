import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { buttonNamed } from "./chat-navigation-artifact-test-helpers.ts";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  composer,
  createChatResourcesHelpers,
  resourceButton,
  resourcePanel,
  resourceState,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const { setupResources, setupOverflowResources } =
  createChatResourcesHelpers(context);

test("Start each chat with the resource panel closed", async () => {
  await setupResources({ open: false });
  expect(resourceState()).toStrictEqual({ open: false, visible: false });
});

test("Dismiss the panel on a composer click, like other header panels", async () => {
  await setupResources();
  expect(resourceState()).toStrictEqual({ open: true, visible: true });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Dismiss the panel with Escape", async () => {
  await setupResources();
  act(() => {
    resourcePanel()?.focus();
  });
  fireEvent.keyDown(resourcePanel()!, { key: "Escape" });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Toggle resources on mobile and dismiss them from the composer", async () => {
  await setupResources({ open: false, desktop: false });
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Toggle the artifact panel with the keyboard", async () => {
  await setupResources({ open: false });
  act(() => {
    resourceButton().focus();
  });
  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Return focus to the resource trigger when Escape dismisses its content", async () => {
  await setupResources();
  const user = userEvent.setup();
  const panel = resourcePanel()!;
  act(() => {
    resourceButton().focus();
  });
  expect(resourceButton()).toHaveFocus();
  const artifact = (await within(panel).findByText("report.pdf")).closest(
    "button",
  )!;
  act(() => {
    artifact.focus();
  });
  expect(artifact).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
    expect(resourceButton()).toHaveFocus();
    expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
  });
});

test("Preserve category expansion controls after switching to mobile", async () => {
  const { panel, media } = await setupOverflowResources(4);
  await userEvent.click(
    buttonNamed(
      "Show more",
      within(panel).getByRole("region", { name: "Artifacts" }),
    ),
  );
  await userEvent.click(
    buttonNamed(
      "Collapse",
      within(panel).getByRole("region", { name: "Artifacts" }),
    ),
  );

  act(() => {
    media.setMatches(false);
  });
  const mobilePanel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  const artifacts = within(mobilePanel).getByRole("region", {
    name: "Artifacts",
  });
  await userEvent.click(buttonNamed("Show more", artifacts));
  await within(artifacts).findByText("report-4.pdf");
  await userEvent.click(buttonNamed("Collapse", artifacts));
  expect(within(artifacts).queryByText("report-4.pdf")).not.toBeInTheDocument();
});
