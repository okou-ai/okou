import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  composer,
  createChatResourcesHelpers,
  resourceButton,
  resourcePanel,
  resourceState,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const { setupResources } = createChatResourcesHelpers(context);

test("Resources toggle open on mobile and close from the composer", async () => {
  await setupResources({ open: false, desktop: false });
  expect(resourceState()).toStrictEqual({ open: false, visible: false });

  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });

  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Space opens and then closes the resources from their trigger", async () => {
  await setupResources({ open: false });
  act(() => {
    resourceButton().focus();
  });
  expect(resourceButton()).toHaveFocus();

  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });

  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Escape from an artifact closes the resources and returns focus to their trigger", async () => {
  await setupResources();
  const panel = resourcePanel()!;
  const artifact = (await within(panel).findByText("report.pdf")).closest(
    "button",
  )!;
  act(() => {
    artifact.focus();
  });
  expect(artifact).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Artifacts and chats" }),
    ).not.toBeInTheDocument();
  });
  expect(resourceButton()).toHaveFocus();
  expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
});
