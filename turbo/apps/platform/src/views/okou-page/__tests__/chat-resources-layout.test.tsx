import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { buttonNamed } from "./chat-navigation-artifact-test-helpers.ts";

import {
  composer,
  resourceButton,
  resourcePanel,
  resourceState,
  setupResources,
  setupOverflowResources,
} from "./chat-resources-test-helpers.ts";

test("Recompute at 408px from the actual gutter on native viewport resize", async () => {
  const resize = await setupResources({ gutter: 408 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(409);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  resize(408);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Recompute the gutter after toggling the chat list at fixed browser width", async () => {
  const setGeometry = await setupResources({ gutter: 408 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  setGeometry(409, false);
  await userEvent.click(buttonNamed("Hide chat list"));
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  setGeometry(408, false);
  await userEvent.click(buttonNamed("Show chat list"));
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Recompute the gutter when an artifact pane opens and its divider moves", async () => {
  const setGeometry = await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  setGeometry(408, false);
  const panel = resourcePanel()!;
  await within(panel).findByText("report.pdf");
  await userEvent.click(
    queryAllByRoleFast("button", panel).find((button) => {
      return button.textContent?.includes("report.pdf");
    })!,
  );
  const handle = await screen.findByRole("separator", {
    name: "Resize sidebar",
  });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  // Keep this element's geometry separate from the transcript prototype mock.
  Object.defineProperty(handle.parentElement!, "getBoundingClientRect", {
    value: () => {
      return new DOMRect(0, 0, 1440, 900);
    },
    configurable: true,
  });
  const pointer = {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
  };
  fireEvent.pointerDown(handle, { ...pointer, clientX: 840 });
  setGeometry(409, false);
  fireEvent.pointerMove(handle, { ...pointer, clientX: 1000 });
  await waitFor(() => {
    expect(
      handle
        .closest<HTMLElement>('[style*="--chat-thread-sidebar-width"]')
        ?.style.getPropertyValue("--chat-thread-sidebar-width"),
    ).toBe("clamp(400px, 440px, calc(100% - 600px))");
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  fireEvent.pointerUp(handle, { ...pointer, buttons: 0 });
});

test("Temporarily dismiss a manually opened narrow panel on composer click without changing preference", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(250);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(409);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Keep a wide panel open during composer focus and dismiss Escape only temporarily", async () => {
  const resize = await setupResources();
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  act(() => {
    resourcePanel()?.focus();
  });
  fireEvent.keyDown(resourcePanel()!, { key: "Escape" });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(300);
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Dismiss a narrow panel when keyboard focus moves to the composer", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  act(() => {
    composer().focus();
  });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test("Use the artifact icon on mobile without a separate switch or duplicate menu entry", async () => {
  await setupResources({ gutter: 16, desktop: false });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  expect(screen.queryByText("Show resources")).not.toBeInTheDocument();
  await userEvent.click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await userEvent.click(composer());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(buttonNamed("More actions"));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByText("Artifacts")).not.toBeInTheDocument();
});

test("Toggle the artifact panel with the keyboard", async () => {
  const resize = await setupResources({ gutter: 200 });
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  act(() => {
    resourceButton().focus();
  });
  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await waitFor(() => {
    expect(resourceButton()).toHaveAttribute("aria-busy", "false");
  });
  resize(500);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
});

test("Return focus to the resource trigger when Escape dismisses its content", async () => {
  await setupResources();
  const user = userEvent.setup();
  const panel = await screen.findByRole("region", { name: "Resources" });
  act(() => {
    resourceButton().focus();
  });
  expect(resourceButton()).toHaveFocus();
  const link = within(panel).getByText("Current guide");
  act(() => {
    link.focus();
  });
  expect(link).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
    expect(resourceButton()).toHaveFocus();
    expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
  });
});

test("Preserve category expansion controls after switching to mobile", async () => {
  const { media, resize } = await setupOverflowResources(4);
  resize(200);
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  await userEvent.click(resourceButton());
  const panel = await screen.findByRole("region", { name: "Resources" });
  await userEvent.click(
    buttonNamed(
      "Expand",
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
  const mobilePanel = await screen.findByRole("region", { name: "Resources" });
  const artifacts = within(mobilePanel).getByRole("region", {
    name: "Artifacts",
  });
  await userEvent.click(buttonNamed("Expand", artifacts));
  await within(artifacts).findByText("report-4.pdf");
  await userEvent.click(buttonNamed("Collapse", artifacts));
  expect(within(artifacts).queryByText("report-4.pdf")).not.toBeInTheDocument();
});
