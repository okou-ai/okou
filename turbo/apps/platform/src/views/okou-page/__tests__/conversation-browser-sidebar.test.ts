import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click } from "../../../__tests__/page-helper.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
const context = testContext();
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
