import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const POINTER = Object.freeze({
  pointerId: 1,
  pointerType: "touch",
  isPrimary: true,
  button: 0,
  buttons: 1,
});

function resizeMask(): Element | null {
  return document.querySelector("[data-chat-thread-sidebar-resize-mask]");
}

async function openResizableSidebar(): Promise<{
  handle: HTMLElement;
  shell: HTMLElement;
}> {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  mockArtifactConversation(context, { catalog: [] });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  click(buttonNamed("Open artifacts"));
  const handle = await screen.findByRole("separator", {
    name: "Resize sidebar",
  });
  const container = handle.parentElement;
  const shell = handle.closest<HTMLElement>(
    '[style*="--chat-thread-sidebar-width"]',
  );
  if (!container || !shell) {
    throw new Error("The resize handle must be in the sidebar shell");
  }
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1440, 900),
  );
  // Happy DOM tracks capture without retargeting events. Send subsequent
  // pointer events to the handle, as native touch capture does in the browser.
  return { handle, shell };
}

test.each(["pointerup", "pointercancel", "lostpointercapture"] as const)(
  "A captured touch resize ends on %s and leaves the sidebar usable",
  async (endEvent) => {
    const { handle, shell } = await openResizableSidebar();
    fireEvent.pointerDown(handle, { ...POINTER, clientX: 1000 });
    expect(resizeMask()).toBeInTheDocument();

    fireEvent.pointerMove(handle, { ...POINTER, clientX: 840 });
    await waitFor(() => {
      expect(shell.style.getPropertyValue("--chat-thread-sidebar-width")).toBe(
        "clamp(400px, 600px, calc(100% - 600px))",
      );
    });
    fireEvent(handle, new PointerEvent(endEvent, { ...POINTER, buttons: 0 }));
    expect(resizeMask()).toBeNull();
    expect(handle.hasPointerCapture(POINTER.pointerId)).toBeFalsy();

    fireEvent.pointerMove(handle, { ...POINTER, clientX: 700 });
    expect(shell.style.getPropertyValue("--chat-thread-sidebar-width")).toBe(
      "clamp(400px, 600px, calc(100% - 600px))",
    );
    click(
      buttonNamed(
        "Close artifacts",
        screen.getByTestId("thread-sidebar-artifacts"),
      ),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("separator", { name: "Resize sidebar" }),
      ).toBeNull();
    });
  },
);

test("A second touch cannot move or end the active resize", async () => {
  const { handle, shell } = await openResizableSidebar();
  fireEvent.pointerDown(handle, { ...POINTER, isPrimary: false, pointerId: 2 });
  expect(resizeMask()).toBeNull();

  fireEvent.pointerDown(handle, POINTER);
  const widthBefore = shell.style.getPropertyValue(
    "--chat-thread-sidebar-width",
  );
  fireEvent.pointerMove(handle, { ...POINTER, pointerId: 2, clientX: 700 });
  fireEvent.pointerUp(handle, { ...POINTER, pointerId: 2, buttons: 0 });
  expect(shell.style.getPropertyValue("--chat-thread-sidebar-width")).toBe(
    widthBefore,
  );
  expect(resizeMask()).toBeInTheDocument();

  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0 });
  expect(resizeMask()).toBeNull();
});

test("Closing the sidebar during a resize removes its blocking mask", async () => {
  const { handle } = await openResizableSidebar();
  fireEvent.pointerDown(handle, POINTER);
  expect(resizeMask()).toBeInTheDocument();

  // Keyboard activation can close the panel while the pointer is still held.
  const close = buttonNamed(
    "Close artifacts",
    screen.getByTestId("thread-sidebar-artifacts"),
  );
  close.focus();
  click(close);
  await waitFor(() => {
    expect(handle).not.toBeInTheDocument();
  });
  expect(resizeMask()).toBeNull();
  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeFalsy();

  click(buttonNamed("Open artifacts"));
  await expect(
    screen.findByRole("separator", { name: "Resize sidebar" }),
  ).resolves.toBeInTheDocument();
  expect(resizeMask()).toBeNull();
});
