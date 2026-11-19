import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  artifactSummary,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const POINTER = Object.freeze({
  pointerId: 1,
  pointerType: "mouse",
  isPrimary: true,
  button: 0,
  buttons: 1,
});
const REPORT = "Unified report.txt";
const DEFAULT_SHARE = "clamp(400px, 55%, calc(100% - 420px))";

function panelWidth(px: number): string {
  return `clamp(400px, ${px}px, calc(100% - 420px))`;
}

function shellOf(handle: HTMLElement): HTMLElement {
  const shell = handle.closest<HTMLElement>(
    '[style*="--chat-thread-sidebar-width"]',
  );
  if (!shell) {
    throw new Error("The side-panel divider must be inside its shell");
  }
  return shell;
}

function sidePanelWidth(handle: HTMLElement): string {
  return shellOf(handle).style.getPropertyValue("--chat-thread-sidebar-width");
}

function chatListDivider(): HTMLElement {
  return screen.getByRole("separator", { name: "Resize chat list" });
}

function chatListWidth(): string | null {
  return chatListDivider().getAttribute("aria-valuenow");
}

function resizeOverlay(): Element | null {
  return document.querySelector(
    "[data-chat-list-resize-mask], [data-chat-thread-sidebar-resize-mask]",
  );
}

/** The widths the browser keeps for the next page load. */
function persistedWidths(handle: HTMLElement): {
  readonly chatList: string | null;
  readonly chatListHidden: string | null;
  readonly sidePanel: unknown;
} {
  const read = (
    key: "chat-list-width" | "chat-list-hidden" | "thread-sidebar-widths",
  ) => {
    return context.store.set(localStorageSignals(key).readFresh$);
  };
  const sidePanels: unknown = JSON.parse(read("thread-sidebar-widths") ?? "{}");
  const widthKey = handle.dataset.widthKey ?? "";
  return {
    chatList: read("chat-list-width"),
    chatListHidden: read("chat-list-hidden"),
    sidePanel:
      typeof sidePanels === "object" && sidePanels !== null
        ? (sidePanels as Record<string, unknown>)[widthKey]
        : undefined,
  };
}

/** Opens the chat at desktop width with the artifact preview beside it. */
async function openWorkspace(
  runtime: TestContext,
  workspaceWidth: number,
): Promise<HTMLElement> {
  runtime.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  mockArtifactConversation(runtime, {
    catalog: [
      artifactSummary("a0000000-0000-4000-a000-000000000960", "file", REPORT),
    ],
  });
  await setupPage({
    context: runtime,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await openResourceArtifact(REPORT);
  await screen.findByTestId("thread-sidebar-artifact-unavailable");
  const handle = await screen.findByRole("separator", {
    name: "Resize sidebar",
  });
  const container = handle.parentElement;
  if (!container) {
    throw new Error("The side-panel divider must be inside the workspace");
  }
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, workspaceWidth, 900),
  );
  return handle;
}

test("The unified workspace opens each side panel at its default width and resizes it from the keyboard", async () => {
  const handle = await openWorkspace(context, 1440);
  expect(sidePanelWidth(handle)).toBe(DEFAULT_SHARE);

  handle.focus();
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  await waitFor(() => {
    expect(sidePanelWidth(handle)).toBe(panelWidth(808));
  });

  fireEvent.keyDown(handle, { key: "End" });
  await waitFor(() => {
    expect(sidePanelWidth(handle)).toBe(panelWidth(1020));
  });

  fireEvent.keyDown(handle, { key: "Enter" });
  await waitFor(() => {
    expect(sidePanelWidth(handle)).toBe(DEFAULT_SHARE);
  });

  click(
    buttonNamed(
      "Back to artifacts",
      screen.getByTestId("thread-sidebar-artifact-unavailable"),
    ),
  );
  await screen.findByTestId("thread-sidebar-artifacts");
  expect(sidePanelWidth(handle)).toBe(panelWidth(480));
});

test("Double-clicking the side panel divider restores its default width", async () => {
  const handle = await openWorkspace(context, 1440);
  expect(sidePanelWidth(handle)).toBe(DEFAULT_SHARE);

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 648 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 900 });
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 900 });
  await waitFor(() => {
    expect(sidePanelWidth(handle)).toBe(panelWidth(540));
  });

  fireEvent.doubleClick(handle);

  await waitFor(() => {
    expect(sidePanelWidth(handle)).toBe(DEFAULT_SHARE);
  });
});

test("Panel borrowing folds immediately after the list minimum and restores only after 16px of reversal", async () => {
  const handle = await openWorkspace(context, 1000);
  expect(chatListWidth()).toBe("300");

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 450 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 380 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("260");
  });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 360 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("240");
  });

  fireEvent.pointerMove(handle, { ...POINTER, clientX: 359 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("0");
  });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 375 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("0");
  });

  fireEvent.pointerMove(handle, { ...POINTER, clientX: 376 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("256");
  });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 390 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("270");
  });
  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeTruthy();
  expect(resizeOverlay()).toBeInTheDocument();

  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 390 });

  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
  expect(resizeOverlay()).toBeNull();
  expect(chatListWidth()).toBe("270");
});

test("The workspace preserves the grab offset and remembers final pointerup widths after a reload", async () => {
  const handle = await openWorkspace(context, 1440);
  expect(chatListWidth()).toBe("300");
  expect(sidePanelWidth(handle)).toBe(DEFAULT_SHARE);

  const listDivider = chatListDivider();
  fireEvent.pointerDown(listDivider, { ...POINTER, clientX: 306 });
  fireEvent.pointerMove(listDivider, { ...POINTER, clientX: 330 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("324");
  });
  fireEvent.pointerUp(listDivider, { ...POINTER, buttons: 0, clientX: 354 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("348");
  });

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 648 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 700 });
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 808 });
  await waitFor(() => {
    expect(sidePanelWidth(handle)).toBe(panelWidth(632));
  });

  click(buttonNamed("Hide chat list"));
  await waitFor(() => {
    expect(chatListWidth()).toBe("0");
  });
  expect(persistedWidths(handle)).toStrictEqual({
    chatList: "348",
    chatListHidden: "true",
    sidePanel: 632,
  });

  click(buttonNamed("Show chat list"));
  await waitFor(() => {
    expect(chatListWidth()).toBe("348");
  });
  expect(sidePanelWidth(handle)).toBe(panelWidth(632));
});

test("Cancellation and blur preserve the last valid widths and discard stale gesture callbacks", async () => {
  const handle = await openWorkspace(context, 1440);

  const listDivider = chatListDivider();
  fireEvent.pointerDown(listDivider, { ...POINTER, clientX: 300 });
  fireEvent.pointerMove(listDivider, { ...POINTER, clientX: 340 });
  await waitFor(() => {
    expect(chatListWidth()).toBe("340");
  });
  fireEvent.pointerCancel(listDivider, {
    ...POINTER,
    buttons: 0,
    clientX: 400,
  });
  expect(resizeOverlay()).toBeNull();
  expect(listDivider.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
  fireEvent.pointerMove(listDivider, { ...POINTER, clientX: 380 });
  expect(chatListWidth()).toBe("340");

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 648 });
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 840 });
  await waitFor(() => {
    expect(sidePanelWidth(handle)).toBe(panelWidth(600));
  });
  fireEvent.blur(window);
  expect(resizeOverlay()).toBeNull();
  expect(handle.hasPointerCapture(POINTER.pointerId)).toBeFalsy();
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0, clientX: 700 });
  expect(sidePanelWidth(handle)).toBe(panelWidth(600));
  expect(chatListWidth()).toBe("340");
  expect(persistedWidths(handle)).toMatchObject({
    chatList: "340",
    sidePanel: 600,
  });
});
