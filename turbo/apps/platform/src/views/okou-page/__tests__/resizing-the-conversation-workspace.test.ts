import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { installPlatformLifecycle } from "../../../test/platform-lifecycle.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockAttachmentChat,
  ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext(),
  pointerId = 21;
function browserStorageForReload() {
  let entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key(i) {
      return [...entries.keys()][i] ?? null;
    },
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, String(value));
    },
    removeItem(key) {
      entries.delete(key);
    },
    clear() {
      entries = new Map<string, string>();
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    },
    { once: true },
  );
  return (dispose: () => void) => {
    const persisted = new Map(entries);
    dispose();
    entries = persisted;
  };
}
async function workspace(width: number) {
  const runtime = createTestRuntime(context);
  installPlatformLifecycle(runtime.signal);
  mockAttachmentChat(runtime);
  runtime.mocks.browser.matchMedia((q) => {
    return q.includes("min-width");
  });
  await setupPage({ context: runtime, path: "/chats/" + ATTACHMENT_THREAD_ID });
  const user = userEvent.setup({ delay: null });
  await user.click(await findFastControl("button", "More actions"));
  const entry = await waitFor(() => {
    const el = queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.includes("Open browser");
    });
    expect(el).toBeDefined();
    return el!;
  });
  await user.click(entry);
  const panel = await screen.findByRole("separator", {
      name: "Resize sidebar",
    }),
    list = await screen.findByRole("separator", { name: "Resize chat list" });
  vi.spyOn(panel.parentElement!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, width, 900),
  );
  const frame = panel.closest<HTMLElement>(
    '[style*="--chat-thread-sidebar-width"]',
  )!;
  return {
    panel,
    list,
    user,
    share: () => {
      return frame.style.getPropertyValue("--chat-thread-sidebar-width");
    },
    unload: () => {
      cleanup();
      vi.mocked(history.replaceState).mockRestore();
      runtime.dispose();
    },
  };
}
function capture(el: HTMLElement) {
  let owned: number | null = null;
  Object.defineProperties(el, {
    setPointerCapture: {
      configurable: true,
      value: (id: number) => {
        owned = id;
      },
    },
    hasPointerCapture: {
      configurable: true,
      value: (id: number) => {
        return owned === id;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value: () => {
        owned = null;
      },
    },
  });
}
function pointer(
  el: HTMLElement,
  kind: "pointerdown" | "pointerup" | "pointermove" | "pointercancel",
  clientX: number,
) {
  fireEvent(
    el,
    new PointerEvent(kind, {
      bubbles: true,
      cancelable: true,
      pointerId,
      isPrimary: true,
      pointerType: "mouse",
      button: 0,
      buttons: kind === "pointerup" || kind === "pointercancel" ? 0 : 1,
      clientX,
    }),
  );
}
const overlay = () => {
    return document.querySelector("[data-chat-thread-sidebar-resize-mask]");
  },
  listOverlay = () => {
    return document.querySelector("[data-chat-list-resize-mask]");
  };
test("unified-chat-workspace-001 Keyboard changes the visible workspace divider width and Enter restores its default share", async () => {
  const { panel, user, share } = await workspace(1440);
  expect(share()).toContain("55%");
  panel.focus();
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => {
    return expect(share()).toContain("808px");
  });
  await user.keyboard("{End}");
  await waitFor(() => {
    return expect(share()).toContain("1020px");
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    return expect(share()).toContain("55%");
  });
});
test("unified-chat-workspace-002 Dragging the side divider sets a measured width and double-click restores its original share", async () => {
  const { panel, user, share } = await workspace(1440);
  expect(share()).toContain("55%");
  capture(panel);
  pointer(panel, "pointerdown", 648);
  pointer(panel, "pointermove", 900);
  pointer(panel, "pointerup", 900);
  await waitFor(() => {
    return expect(share()).toContain("540px");
  });
  await user.dblClick(panel);
  await waitFor(() => {
    return expect(share()).toContain("55%");
  });
});
test("unified-chat-workspace-003 The conversation list folds at its minimum and reopens only after the return threshold", async () => {
  const { panel, list } = await workspace(1000);
  expect(list).toHaveAttribute("aria-valuenow", "300");
  capture(panel);
  pointer(panel, "pointerdown", 450);
  expect(panel.hasPointerCapture(pointerId)).toBeTruthy();
  expect(overlay()).toBeInTheDocument();
  for (const [x, shown] of [
    [380, 260],
    [360, 240],
    [359, 0],
    [374, 0],
    [375, 0],
    [376, 256],
    [385, 265],
  ] as const) {
    pointer(panel, "pointermove", x);
    await waitFor(() => {
      return expect(list).toHaveAttribute("aria-valuenow", String(shown));
    });
  }
  pointer(panel, "pointerup", 385);
  expect(overlay()).toBeNull();
  expect(panel.hasPointerCapture(pointerId)).toBeFalsy();
});
test("unified-chat-workspace-005 Reopening a folded chat list after reload restores both pointer-release widths and preserves the grab offset", async () => {
  const reload = browserStorageForReload();
  const first = await workspace(1440);
  expect(first.share()).toContain("55%");
  expect(first.list).toHaveAttribute("aria-valuenow", "300");
  capture(first.list);
  capture(first.panel);
  pointer(first.list, "pointerdown", 307);
  pointer(first.list, "pointermove", 341);
  await waitFor(() => {
    return expect(first.list).toHaveAttribute("aria-valuenow", "334");
  });
  pointer(first.list, "pointerup", 355);
  await waitFor(() => {
    return expect(first.list).toHaveAttribute("aria-valuenow", "348");
  });
  pointer(first.panel, "pointerdown", 660);
  pointer(first.panel, "pointermove", 864);
  pointer(first.panel, "pointerup", 808);
  await waitFor(() => {
    return expect(first.share()).toContain("632px");
  });
  await first.user.click(await findFastControl("button", "Hide chat list"));
  await waitFor(() => {
    return expect(first.list).toHaveAttribute("aria-valuenow", "0");
  });
  reload(first.unload);
  const next = await workspace(1440);
  expect(next.list).toHaveAttribute("aria-valuenow", "0");
  await next.user.click(await findFastControl("button", "Show chat list"));
  await waitFor(() => {
    return expect(next.list).toHaveAttribute("aria-valuenow", "348");
  });
  expect(next.share()).toContain("632px");
});
test("unified-chat-workspace-006 Cancellation and window blur release both dividers and preserve their last visible widths across reload", async () => {
  const reload = browserStorageForReload();
  const first = await workspace(1440);
  expect(first.share()).toContain("55%");
  expect(first.list).toHaveAttribute("aria-valuenow", "300");
  capture(first.list);
  capture(first.panel);
  pointer(first.list, "pointerdown", 310);
  expect(first.list.hasPointerCapture(pointerId)).toBeTruthy();
  expect(listOverlay()).toBeInTheDocument();
  pointer(first.list, "pointermove", 350);
  pointer(first.list, "pointercancel", 420);
  expect(first.list.hasPointerCapture(pointerId)).toBeFalsy();
  expect(listOverlay()).toBeNull();
  pointer(first.list, "pointermove", 440);
  await waitFor(() => {
    return expect(first.list).toHaveAttribute("aria-valuenow", "340");
  });
  pointer(first.panel, "pointerdown", 790);
  expect(first.panel.hasPointerCapture(pointerId)).toBeTruthy();
  expect(overlay()).toBeInTheDocument();
  pointer(first.panel, "pointermove", 840);
  fireEvent(window, new Event("blur"));
  expect(first.panel.hasPointerCapture(pointerId)).toBeFalsy();
  expect(overlay()).toBeNull();
  pointer(first.panel, "pointerup", 650);
  await waitFor(() => {
    return expect(first.share()).toContain("600px");
  });
  reload(first.unload);
  const next = await workspace(1440);
  expect(next.list).toHaveAttribute("aria-valuenow", "340");
  expect(next.share()).toContain("600px");
});
