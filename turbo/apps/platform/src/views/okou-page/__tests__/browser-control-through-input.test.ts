import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
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
