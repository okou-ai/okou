import { screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
const context = testContext();
function titles() {
  return queryAllByRoleFast("tab").map((tab) => {
    return tab.getAttribute("aria-label") ?? tab.textContent?.trim();
  });
}
async function chooseLast() {
  click(await findFastControl("button", "All tabs"));
  click(
    (await screen.findByText("Page 12", { exact: true })).closest(
      '[role="menuitem"]',
    )!,
  );
}
function tabGeometry() {
  let width = 240,
    host = 420;
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "browserTabBudget")) {
        return new DOMRect(0, 0, width, 32);
      }
      if (this.matches('[data-sidebar-layout-owner="panel"]')) {
        return new DOMRect(0, 0, host, 660);
      }
      return original.call(this);
    },
  );
  return (next: number, panel: number) => {
    width = next;
    host = panel;
    window.dispatchEvent(new Event("resize"));
  };
}
test("chat-navigation-browser-008 A selected overflow tab survives an unchanged resize and the wide budget then admits all twelve", async () => {
  const resize = tabGeometry(),
    { open } = await openBrowserChat(context, "live", false, { many: true });
  click(open);
  await remoteBrowserInput();
  await waitFor(() => {
    return expect(titles()).toStrictEqual(["Example", "Page 2", "Page 3"]);
  });
  await chooseLast();
  await waitFor(() => {
    return expect(titles()).toStrictEqual(["Example", "Page 2", "Page 12"]);
  });
  resize(240, 420);
  await expect(findFastControl("button", "All tabs")).resolves.toBeVisible();
  await expect(findFastControl("tab", "Page 12")).resolves.toHaveAttribute(
    "aria-selected",
    "true",
  );
  resize(800, 1000);
  await waitFor(() => {
    return expect(titles()).toStrictEqual([
      "Example",
      ...Array.from({ length: 11 }, (_, i) => {
        return "Page " + (i + 2);
      }),
    ]);
  });
  expect(screen.queryByLabelText("All tabs")).toBeNull();
  await expect(findFastControl("tab", "Page 12")).resolves.toHaveAttribute(
    "aria-selected",
    "true",
  );
});
test("chat-navigation-browser-021 Workspace search belongs to the chat editor and returns focus there after Escape", async () => {
  const { open } = await openBrowserChat(context, "live");
  click(open);
  await remoteBrowserInput();
  const address = screen.getByLabelText("Address"),
    editor = await findComposerEditor(),
    user = userEvent.setup({ delay: null });
  const shortcut = (el: HTMLElement) => {
    el.focus();
    fireEvent.keyDown(el, {
      key: "F",
      code: "KeyF",
      ctrlKey: true,
      shiftKey: true,
    });
  };
  shortcut(address);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(address).toHaveFocus();
  shortcut(editor);
  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByPlaceholderText(/Search workspace/i),
  ).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(editor).toHaveFocus();
  });
});
test("chat-navigation-browser-023 A mobile standalone chat opens Browser from More actions and returns from the started viewer", async () => {
  await openBrowserChat(context, "stopped", false, { mobile: true });
  click(await findFastControl("button", "More actions"));
  click(await screen.findByText(/Open browser/i));
  click(await findFastControl("button", "Start browser"));
  await remoteBrowserInput();
  const external = await findFastControl(
    "link",
    "Open this browser in a new page",
  );
  expect(external).toHaveAttribute("target", "_blank");
  expect(external.getAttribute("href")).toContain("/browsers/");
  click(await findFastControl("button", /close.*browser/i));
  await waitFor(() => {
    return expect(external).not.toBeInTheDocument();
  });
  await expect(findComposerEditor()).resolves.toBeVisible();
});
test("chat-navigation-browser-025 The closed browser input stays retired and only the reopened viewer can send new text and keys", async () => {
  const { open, cdp, closedThreads } = await openBrowserChat(
    context,
    "stopped",
  );
  click(open);
  await expect(screen.findByText("Browser not live")).resolves.toBeVisible();
  click(await findFastControl("button", "Start browser"));
  const first = await remoteBrowserInput();
  click(await findFastControl("button", /close.*browser/i));
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  await expect(findComposerEditor()).resolves.toBeVisible();
  fireEvent.keyDown(first, { key: "q", code: "KeyQ" });
  expect(closedThreads).toHaveLength(1);
  click(open);
  click(await findFastControl("button", "Start browser"));
  const next = await remoteBrowserInput();
  await userEvent.setup({ delay: null }).type(next, "w{Enter}");
  await waitFor(() => {
    return expect(cdp.inputForTarget("review-page")).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ text: "w" }),
        }),
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ key: "Enter" }),
        }),
      ]),
    );
  });
  expect(
    cdp.inputForTarget("review-page").some((msg) => {
      return msg.params?.key === "q";
    }),
  ).toBeFalsy();
});
