import { FeatureSwitchKey } from "@okouai/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  buttonNamed,
  artifactSummary,
  mockArtifactConversation,
  openResourceArtifact,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
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

async function openUnifiedWorkspace(
  options: {
    readonly unified?: boolean;
    readonly containerWidth?: number;
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
    context,
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
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0 });
  expect(sidebarWidth(shell)).toBe("clamp(400px, 540px, calc(100% - 420px))");

  fireEvent.doubleClick(handle);
  expect(sidebarWidth(shell)).toBe("clamp(400px, 55%, calc(100% - 420px))");
});

test("Widening the side panel past the chat's minimum narrows the chat list, then folds it", async () => {
  const { handle, shell } = await openUnifiedWorkspace({
    containerWidth: 1000,
  });
  const listSeam = await chatListSeam();
  expect(listSeam).toHaveAttribute("aria-valuenow", "300");

  fireEvent.pointerDown(handle, { ...POINTER, clientX: 500 });
  // 620px leaves the chat 380px; the list gives up the missing 40px.
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 380 });
  await waitFor(() => {
    expect(listSeam).toHaveAttribute("aria-valuenow", "260");
  });
  expect(sidebarWidth(shell)).toBe("clamp(400px, 620px, calc(100% - 420px))");

  // Past the list's minimum by more than the fold distance, the list folds.
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 100 });
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });

  // Dragging back within the same gesture brings the list back.
  fireEvent.pointerMove(handle, { ...POINTER, clientX: 380 });
  await expect(chatListSeam()).resolves.toHaveAttribute("aria-valuenow", "260");
  fireEvent.pointerUp(handle, { ...POINTER, buttons: 0 });
  // The pushed width is kept once the gesture ends.
  await expect(chatListSeam()).resolves.toHaveAttribute("aria-valuenow", "260");
});

test("The chat list resizes from its divider and folds when dragged past its minimum", async () => {
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
  fireEvent.pointerMove(listSeam, { ...POINTER, clientX: 120 });
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  expect(document.querySelector("[data-chat-list-resize-mask]")).toBeNull();
  expect(buttonNamed("Show chat list")).toBeInTheDocument();
});

test("Without the switch the chat list keeps its fixed width", async () => {
  const { shell } = await openUnifiedWorkspace({ unified: false });
  expect(
    screen.queryByRole("separator", { name: "Resize chat list" }),
  ).toBeNull();
  expect(sidebarWidth(shell)).toBe("min(760px, 48vw)");
});
