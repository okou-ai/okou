import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  setupResources,
  resourceButton,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
async function loadedReport() {
  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  return await within(panel).findByText("report.pdf");
}
async function expectClosed() {
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Artifacts and chats" }),
    ).toBeNull();
  });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
}

test("chat-resources-layout-003 dismisses mobile resources by returning to the composer", async () => {
  await setupResources(context, { desktop: false, open: false });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
  click(resourceButton());
  await loadedReport();
  click(screen.getByRole("textbox", { name: "Message" }));
  await expectClosed();
});

test("chat-resources-layout-004 toggles the report panel with successive Space presses", async () => {
  await setupResources(context, { open: false });
  const user = userEvent.setup({ delay: null });
  const trigger = resourceButton();
  trigger.focus();
  expect(trigger).toHaveFocus();
  await user.keyboard("[Space]");
  await loadedReport();
  await user.keyboard("[Space]");
  await expectClosed();
});

test("chat-resources-layout-005 restores trigger focus when Escape is pressed on the report", async () => {
  await setupResources(context);
  const report = (await loadedReport()).closest("button")!;
  report.focus();
  expect(report).toHaveFocus();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await expectClosed();
  expect(resourceButton()).toHaveFocus();
});
