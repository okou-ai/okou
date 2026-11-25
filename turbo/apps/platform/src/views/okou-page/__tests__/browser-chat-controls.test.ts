import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();

const takeover =
  "I've taken over the browser. Don't use it until I hand it back.";
const handback = "I'm done in the browser. Please continue.";

async function openPage(working: boolean) {
  const { open, cdp } = await openBrowserChat(context, "live", false, {
    working,
    completed: !working,
  });
  click(open);
  const input = await remoteBrowserInput();
  const canvas = await screen.findByRole("img", { name: /live.*view/i });
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1600, 400),
  );
  function touch(x: number, y: number) {
    const point = {
      pointerType: "mouse",
      pointerId: 1,
      clientX: x,
      clientY: y,
      button: 0,
      isPrimary: true,
    };
    fireEvent.pointerDown(canvas, { ...point, buttons: 1 });
    fireEvent.mouseDown(canvas, { ...point, detail: 1, buttons: 1 });
    fireEvent.pointerUp(canvas, { ...point, buttons: 0 });
    fireEvent.mouseUp(canvas, { ...point, detail: 1, buttons: 0 });
  }
  return { input, cdp, touch };
}
async function giveBack() {
  const button = await findFastControl("button", "Hand back");
  await waitFor(() => {
    return expect(button).toBeEnabled();
  });
  click(button);
  await screen.findByText(handback);
  await screen.findByText(/is working$/);
}
test("chat-navigation-browser-029 Repeated live keyboard input takes control once and Hand back returns it to the working run", async () => {
  const { input } = await openPage(true);
  await screen.findByText(/is working$/);
  const user = userEvent.setup({ delay: null });
  input.focus();
  await user.keyboard("j");
  await screen.findByText("You're in control");
  await screen.findByText(takeover);
  await user.keyboard("k");
  await giveBack();
  expect(screen.getAllByText(takeover)).toHaveLength(1);
  await expect(findFastControl("button", "Take over")).resolves.toBeEnabled();
});
test("chat-navigation-browser-032 A letterbox click leaves the run working while accepted page typing transfers control", async () => {
  const { input, cdp, touch } = await openPage(true);
  await screen.findByText(/is working$/);
  touch(4, 200);
  expect(screen.queryByText(takeover)).toBeNull();
  expect(screen.getByText(/is working$/)).toBeVisible();
  input.focus();
  await userEvent.setup({ delay: null }).keyboard("k");
  await screen.findByText("You're in control");
  await screen.findByText(takeover);
  await waitFor(() => {
    return expect(cdp.inputForTarget("review-page")).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        params: expect.objectContaining({ key: "k" }),
      }),
    );
  });
  expect(
    cdp.inputForTarget("review-page").some((r) => {
      return (
        r.method === "Input.dispatchMouseEvent" &&
        r.params?.type === "mousePressed"
      );
    }),
  ).toBeFalsy();
});
test("chat-navigation-browser-036 A member signs in between runs and Hand back starts one continuing chat turn", async () => {
  const { touch } = await openPage(false);
  await screen.findByText(/Please sign in to the billing site\./);
  expect(screen.queryByText(/is working$/)).toBeNull();
  touch(800, 200);
  await screen.findByText("You're in control");
  expect(screen.queryByText(takeover)).toBeNull();
  await giveBack();
  expect(screen.queryByText(takeover)).toBeNull();
});

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

test("chat-navigation-browser-017 Off persists across embedded viewer sizing menus", async () => {
  const { open } = await openBrowserChat(context, "live");
  click(open);
  await remoteBrowserInput();
  const settings = await screen.findByLabelText("Browser settings");
  async function sizing() {
    await userEvent.click(settings);
    const windowSize = await screen.findByText("Window size", {
      selector: '[role="menuitem"]',
    });
    await userEvent.hover(windowSize);
    return (await screen.findByText("Off")).closest<HTMLElement>(
      '[role="menuitemradio"]',
    )!;
  }
  const off = await sizing();
  expect(
    screen.getByText("Follow panel").closest('[role="menuitemradio"]'),
  ).toBeChecked();
  await userEvent.click(off);
  await waitFor(() => {
    expect(settings).toHaveAttribute("aria-expanded", "false");
  });
  await expect(sizing()).resolves.toBeChecked();
  await userEvent.click(settings);
  await waitFor(() => {
    expect(
      screen.queryByText("Off", { selector: '[role="menuitemradio"] *' }),
    ).toBeNull();
  });
  await userEvent.click(settings);
  await screen.findByText("Window size", { selector: '[role="menuitem"]' });
  expect(
    screen.queryByText("Off", { selector: '[role="menuitemradio"] *' }),
  ).toBeNull();
});

test("chat-navigation-browser-003 A denied Browser card opens an authorization placeholder while the original card stays visible", async () => {
  const { card, open } = await openBrowserChat(context, "denied");
  click(open);
  const close = await findFastControl("button", /close.*browser/i);
  expect(close).toBeEnabled();
  expect(card).toBeVisible();
  await expect(
    screen.findAllByText("Cloud browser is not enabled for this chat"),
  ).resolves.toHaveLength(2);
  expect(
    screen.queryByRole("textbox", { name: "Remote browser input" }),
  ).toBeNull();
  expect(screen.queryByText("Browser not live")).toBeNull();
});
test("chat-navigation-browser-026 Opening a stopped Browser from chat exposes Start browser", async () => {
  const { open } = await openBrowserChat(context, "stopped");
  expect(screen.queryByText("Browser not live")).toBeNull();
  click(open);
  await screen.findByText("Browser not live");
  await expect(
    findFastControl("button", "Start browser"),
  ).resolves.toBeEnabled();
});
test("chat-navigation-browser-001 A reclaimed Browser resumes from its live summary and sends typed input to the resumed page", async () => {
  const { open, setStatus, cdp, resumed, release } = await openBrowserChat(
    context,
    "live",
    true,
  );
  expect(open).toHaveAttribute("data-browser-session-status", "active");
  setStatus("stopped");
  click(open);
  try {
    await resumed.promise;
    expect(
      screen
        .queryByRole("textbox", { name: "Remote browser input" })
        ?.matches(":enabled") ?? false,
    ).toBeFalsy();
    release.resolve();
    const input = await remoteBrowserInput();
    await userEvent.setup({ delay: null }).type(input, "r");
    await waitFor(() => {
      return expect(cdp.inputForTarget("review-page")).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "Input.dispatchKeyEvent",
            params: expect.objectContaining({ text: "r" }),
          }),
        ]),
      );
    });
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});
test("chat-navigation-browser-002 Reopening the previously started Browser rechecks authorization before exposing the viewer", async () => {
  const { open, setStatus } = await openBrowserChat(context, "stopped");
  click(open);
  click(await findFastControl("button", "Start browser"));
  await remoteBrowserInput();
  setStatus("denied");
  click(await findFastControl("button", /close.*browser/i));
  await waitFor(() => {
    return expect(
      screen.queryByRole("textbox", { name: "Remote browser input" }),
    ).toBeNull();
  });
  click(open);
  await waitFor(() => {
    return expect(
      screen.getAllByText("Cloud browser is not enabled for this chat"),
    ).toHaveLength(2);
  });
  expect(
    screen.queryByRole("textbox", { name: "Remote browser input" }),
  ).toBeNull();
});
