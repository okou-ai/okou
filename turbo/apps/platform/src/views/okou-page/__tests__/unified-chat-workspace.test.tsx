import { FeatureSwitchKey } from "@okouai/core";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  buttonNamed,
  artifactSummary,
  mockArtifactConversation,
  openResourceArtifact,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
// A second runtime stands in for the page after a reload.
const reloadedContext = createTestRuntime(context);
const POINTER = Object.freeze({
  pointerId: 1,
  pointerType: "mouse",
  isPrimary: true,
  button: 0,
  buttons: 1,
});

function sidebarWidth(shell: HTMLElement): string {
  return shell.style.getPropertyValue("--chat-thread-sidebar-width");
}

function chatListSeam(): Promise<HTMLElement> {
  return screen.findByRole("separator", { name: "Resize chat list" });
}

function releasePageDom(): void {
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

async function openUnifiedWorkspace(
  options: {
    readonly unified?: boolean;
    readonly containerWidth?: number;
    readonly pageContext?: Parameters<typeof setupPage>[0]["context"];
  } = {},
): Promise<{ handle: HTMLElement; shell: HTMLElement }> {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  mockArtifactConversation(context, {
    catalog: [
      artifactSummary(
        "a0000000-0000-4000-a000-000000000960",
        "file",
        "Unified report.txt",
      ),
    ],
  });
  await setupPage({
    context: options.pageContext ?? context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.UnifiedChatWorkspace]: options.unified ?? true,
    },
  });
  await openResourceArtifact("Unified report.txt");
  const unavailable = await screen.findByTestId(
    "thread-sidebar-artifact-unavailable",
  );
  click(buttonNamed("Back to artifacts", unavailable));
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
    new DOMRect(0, 0, options.containerWidth ?? 1440, 900),
  );
  return { handle, shell };
}

test("The unified workspace opens the side panel at its share and resizes it from the keyboard", async () => {
  const { handle, shell } = await openUnifiedWorkspace();
  expect(sidebarWidth(shell)).toBe("clamp(400px, 55%, calc(100% - 420px))");

  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  // 55% of the 1440px workspace plus one 16px step.
  expect(sidebarWidth(shell)).toBe("clamp(400px, 808px, calc(100% - 420px))");
  expect(handle).toHaveAttribute("aria-valuenow", "808");

  fireEvent.keyDown(handle, { key: "End" });
  expect(sidebarWidth(shell)).toBe("clamp(400px, 1020px, calc(100% - 420px))");

  fireEvent.keyDown(handle, { key: "Enter" });
  expect(sidebarWidth(shell)).toBe("clamp(400px, 55%, calc(100% - 420px))");
});

test("Double-clicking the side panel divider restores its default width", async () => {
  const { handle, shell } = await openUnifiedWorkspace();
  fireEvent.pointerDown(handle, { ...POINTER, clientX: 700 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 900 });
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 900 });
  expect(sidebarWidth(shell)).toBe("clamp(400px, 540px, calc(100% - 420px))");

  fireEvent.doubleClick(handle);
  expect(sidebarWidth(shell)).toBe("clamp(400px, 55%, calc(100% - 420px))");
});

test("Panel borrowing folds immediately after the list minimum and restores only after 16px of reversal", async () => {
  const { handle } = await openUnifiedWorkspace({ containerWidth: 1000 });
  const listSeam = await chatListSeam();
  expect(listSeam).toHaveAttribute("aria-valuenow", "300");

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 450 });
  // 620px leaves the chat 380px; the list gives up the missing 40px.
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 380 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "260");
  expect(handle).toHaveAttribute("aria-valuenow", "620");

  fireEvent.pointerMove(handle, { ...POINTER, clientX: 360 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "240");
  expect(handle).toHaveAttribute("aria-valuenow", "640");
  // The very next pixel folds: there is no held-geometry plateau.
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 359 });
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  expect(handle).toHaveAttribute("aria-valuenow", "641");
  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeTruthy();

  fireEvent.pointerMove(handle, { ...POINTER, clientX: 360 });
  expect(handle).toHaveAttribute("aria-valuenow", "640");
  expect(screen.queryByTestId("chat-list-column")).toBeNull();
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 375 });
  expect(handle).toHaveAttribute("aria-valuenow", "625");
  expect(screen.queryByTestId("chat-list-column")).toBeNull();
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 376 });
  await screen.findByTestId("chat-list-column");
  expect(listSeam).toHaveAttribute("aria-valuenow", "256");
  expect(handle).toHaveAttribute("aria-valuenow", "624");

  // After restoring, approaching the minimum does not fold early either.
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 360 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "240");
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 380 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "260");
  expect(handle).toHaveAttribute("aria-valuenow", "620");
  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
  expect(
    document.querySelector("[data-chat-thread-sidebar-resize-mask]"),
  ).toBeNull();
});

test("The chat list folds at its minimum and keeps capture for a hysteretic same-gesture restore", async () => {
  await openUnifiedWorkspace();
  const listSeam = await chatListSeam();

  listSeam.focus();
  fireEvent.keyDown(listSeam, { key: "ArrowRight", shiftKey: true });
  expect(listSeam).toHaveAttribute("aria-valuenow", "364");
  fireEvent.doubleClick(listSeam);
  expect(listSeam).toHaveAttribute("aria-valuenow", "300");

  fireEvent.pointerDown(listSeam, { ...POINTER, clientX: 300 });
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 500 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "420");
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 240 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "240");
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 239 });
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  expect(
    document.querySelector("[data-chat-list-resize-mask]"),
  ).toBeInTheDocument();
  expect(listSeam.hasPointerCapture(POINTER.pointerId)).toBeTruthy();
  expect(buttonNamed("Show chat list")).toBeInTheDocument();

  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 255 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "0");
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 256 });
  await screen.findByTestId("chat-list-column");
  expect(listSeam).toHaveAttribute("aria-valuenow", "256");
  fireEvent.pointerUp(listSeam, { ...POINTER, buttons: 0, clientX: 264 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "264");
  expect(document.querySelector("[data-chat-list-resize-mask]")).toBeNull();
  expect(listSeam.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
});

test("The workspace preserves the grab offset and remembers final pointerup widths after a reload", async () => {
  const resetFirstPage$ = resetSignal();
  const firstPageSignal = context.store.set(resetFirstPage$, context.signal);
  const { handle } = await openUnifiedWorkspace({
    pageContext: { ...context, signal: firstPageSignal },
  });
  const listSeam = await chatListSeam();
  // The list uses displacement from the initial grab, not the hit target edge.
  fireEvent.pointerDown(listSeam, { ...POINTER, clientX: 304 });
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 324 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "320");
  fireEvent.pointerUp(listSeam, { ...POINTER, buttons: 0, clientX: 352 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "348");

  // The panel starts at 792px, with a 12px hit target centred at x=648.
  vi.spyOn(handle, "getBoundingClientRect").mockReturnValue(
    new DOMRect(642, 0, 12, 900),
  );
  fireEvent.pointerDown(handle, { ...POINTER, clientX: 652 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 652 });
  expect(handle).toHaveAttribute("aria-valuenow", "792");
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 852 });
  expect(handle).toHaveAttribute("aria-valuenow", "592");
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 812 });
  expect(handle).toHaveAttribute("aria-valuenow", "632");
  click(buttonNamed("Hide chat list"));
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });

  context.store.set(resetFirstPage$);
  releasePageDom();
  const { handle: reloadedHandle } = await openUnifiedWorkspace({
    pageContext: reloadedContext,
  });
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  expect(reloadedHandle).toHaveAttribute("aria-valuenow", "632");

  click(buttonNamed("Show chat list"));
  await expect(chatListSeam()).resolves.toHaveAttribute("aria-valuenow", "348");
});

test("Cancellation and blur preserve the last valid widths and discard stale gesture callbacks", async () => {
  const resetFirstPage$ = resetSignal();
  const firstPageSignal = context.store.set(resetFirstPage$, context.signal);
  const { handle } = await openUnifiedWorkspace({
    pageContext: { ...context, signal: firstPageSignal },
  });
  const listSeam = await chatListSeam();
  fireEvent.pointerDown(listSeam, { ...POINTER, clientX: 304 });
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 344 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "340");
  // A cancelled event's coordinate is not another resize sample.
  fireEvent.pointerCancel(listSeam, { ...POINTER, buttons: 0, clientX: 1000 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "340");
  expect(document.querySelector("[data-chat-list-resize-mask]")).toBeNull();
  expect(listSeam.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 400 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "340");

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 700 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 840 });
  expect(handle).toHaveAttribute("aria-valuenow", "600");
  fireEvent(window, new Event("blur"));
  expect(
    document.querySelector("[data-chat-thread-sidebar-resize-mask]"),
  ).toBeNull();
  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 500 });
  expect(handle).toHaveAttribute("aria-valuenow", "600");

  context.store.set(resetFirstPage$);
  releasePageDom();
  const { handle: reloadedHandle } = await openUnifiedWorkspace({
    pageContext: reloadedContext,
  });
  expect(reloadedHandle).toHaveAttribute("aria-valuenow", "600");
  await expect(chatListSeam()).resolves.toHaveAttribute("aria-valuenow", "340");
});

test("Releasing at the viewport origin applies the final coordinate before cleanup", async () => {
  const { handle } = await openUnifiedWorkspace();
  const listSeam = await chatListSeam();
  fireEvent.pointerDown(listSeam, { ...POINTER, clientX: 300 });
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 340 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "340");
  fireEvent.pointerUp(listSeam, { ...POINTER, buttons: 0, clientX: 0 });
  expect(listSeam).toHaveAttribute("aria-valuenow", "0");
  expect(listSeam.hasPointerCapture(POINTER.pointerId)).toBeFalsy();

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 700 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 840 });
  expect(handle).toHaveAttribute("aria-valuenow", "600");
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 0 });
  expect(handle).toHaveAttribute("aria-valuenow", "1020");
  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
});

test("A folded chat list can be dragged open from its persistent divider", async () => {
  await openUnifiedWorkspace();
  click(buttonNamed("Hide chat list"));
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  const seam = await chatListSeam();
  expect(seam).toHaveAttribute("aria-valuenow", "0");

  fireEvent.pointerDown(seam, { ...POINTER, clientX: 80 });
  fireEvent.pointerMove(seam, { ...POINTER, clientX: 90 });
  expect(seam).toHaveAttribute("aria-valuenow", "0");
  fireEvent.pointerMove(seam, { ...POINTER, clientX: 160 });
  await screen.findByTestId("chat-list-column");
  fireEvent.pointerMove(seam, { ...POINTER, clientX: 180 });
  expect(seam).toHaveAttribute("aria-valuenow", "240");
  fireEvent.pointerMove(seam, { ...POINTER, clientX: 400 });
  fireEvent.pointerUp(seam, { ...POINTER, buttons: 0, clientX: 400 });
  expect(seam).toHaveAttribute("aria-valuenow", "320");
  expect(document.querySelector("[data-chat-list-resize-mask]")).toBeNull();
});

test("Without the switch the chat list keeps its fixed width", async () => {
  const { shell } = await openUnifiedWorkspace({ unified: false });
  expect(
    screen.queryByRole("separator", { name: "Resize chat list" }),
  ).toBeNull();
  expect(sidebarWidth(shell)).toBe("min(760px, 48vw)");
});
