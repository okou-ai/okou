import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function nativeGeometry(budget: number) {
  let surface = 800;
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "browserTabBudget")) {
        return new DOMRect(0, 0, budget, 32);
      }
      if (this.matches('[data-sidebar-layout-owner="panel"]')) {
        return new DOMRect(0, 0, budget === 180 ? 400 : 1000, 680);
      }
      if (
        Object.hasOwn(this.dataset, "browserSurface") ||
        Object.hasOwn(this.dataset, "browserCanvas")
      ) {
        return new DOMRect(0, 0, surface, 600);
      }
      return rect.call(this);
    },
  );
  return (width: number, next = surface) => {
    budget = width;
    surface = next;
    fireEvent.resize(window);
  };
}
function tabs() {
  return queryAllByRoleFast("tab").map((t) => {
    return t.getAttribute("aria-label") ?? t.textContent?.trim();
  });
}
async function admission(n: number, selected: string) {
  await waitFor(() => {
    expect(tabs()).toHaveLength(n);
    expect(
      queryAllByRoleFast("tab").find((tab) => {
        return (
          (tab.getAttribute("aria-label") ?? tab.textContent?.trim()) ===
          selected
        );
      }),
    ).toHaveAttribute("aria-selected", "true");
  });
}
async function selectLast() {
  click(await findFastControl("button", "All tabs"));
  click(
    await screen.findByText("Page 12", { selector: '[role="menuitem"] *' }),
  );
}
function owner(id: string) {
  const el = document.querySelector<HTMLElement>(
    '[data-sidebar-layout-owner="' + id + '"]',
  );
  if (!el) {
    throw new Error("Missing layout owner " + id);
  }
  return el;
}
function nativeTransitions() {
  const style = document.createElement("style");
  style.textContent = '[data-sidebar-layout-owner="panel"] { flex-grow: 0; }';
  document.head.append(style);
  context.signal.addEventListener(
    "abort",
    () => {
      return style.remove();
    },
    {
      once: true,
    },
  );
  function set(el: HTMLElement, running: boolean) {
    Object.defineProperty(el, "getAnimations", {
      configurable: true,
      value: () => {
        return running
          ? [{ transitionProperty: "width", playState: "running" }]
          : [];
      },
    });
    const e = new Event(running ? "transitionrun" : "transitionend", {
      bubbles: true,
    });
    Object.defineProperty(e, "propertyName", { value: "width" });
    fireEvent(el, e);
  }
  return set;
}
test("chat-navigation-browser-016 Resizing during a disconnected viewer takes effect on recovery before the tab row widens", async () => {
  const retry = context.mocks.deferred<{ open(): void }>();
  let disconnected = false;
  const resize = nativeGeometry(800);
  const { open, cdp } = await openBrowserChat(context, "live", false, {
    many: true,
    onConnecting: (_url, socket) => {
      if (disconnected) {
        retry.resolve(socket);
      }
    },
  });
  click(open);
  const field = await remoteBrowserInput();
  await admission(12, "Example");
  disconnected = true;
  cdp.setAutoOpen(false);
  cdp.disconnect({ code: 1006, reason: "Reconnect the native browser" });
  await waitFor(() => {
    return expect(field).toBeDisabled();
  });
  resize(240, 916);
  const replacement = await retry.promise;
  replacement.open();
  await remoteBrowserInput();
  await admission(3, "Example");
  await waitFor(() => {
    return expect(cdp.requests).toContainEqual(
      expect.objectContaining({
        method: "Emulation.setDeviceMetricsOverride",
        params: expect.objectContaining({ width: 916, height: 600 }),
      }),
    );
  });
  resize(800);
  await admission(12, "Example");
});
test("chat-navigation-browser-012 Narrow Page 12 admission releases after both native width owners finish", async () => {
  const resize = nativeGeometry(180),
    transition = nativeTransitions();
  const { open } = await openBrowserChat(context, "live", false, {
    many: true,
  });
  click(open);
  await remoteBrowserInput();
  await selectLast();
  await admission(2, "Page 12");
  const hide = await findFastControl("button", "Hide chat list");
  click(hide);
  const show = await findFastControl("button", "Show chat list");
  const panel = owner("panel");
  panel.style.flexGrow = "0";
  transition(panel, true);
  click(show);
  const list = await waitFor(() => {
    return owner("chat-list");
  });
  transition(list, true);
  resize(800);
  await admission(2, "Page 12");
  transition(panel, false);
  await admission(2, "Page 12");
  transition(list, false);
  await admission(12, "Page 12");
  expect(tabs()).toContain("Page 12");
});
