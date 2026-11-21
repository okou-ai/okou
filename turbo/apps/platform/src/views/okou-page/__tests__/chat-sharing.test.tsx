import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  RUN_PATH,
  assistantEvent,
  promptEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function conversation(answer: string, refreshed = false) {
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 1,
        text: "Inspect inventory",
      }),
      assistantEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 2,
        text: answer,
      }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatShareRefresh]: refreshed },
  });
}
test("chat-sharing-001 toggling the prompt from its row label updates the selection once", async () => {
  await conversation("Inventory checked");
  click(await findFastControl("button", "Share messages"));
  const prompt = await screen.findByText("Inspect inventory");
  const share = await findFastControl("button", "Share");
  expect(share).toBeDisabled();
  const row = within(
    prompt.closest<HTMLElement>("[data-chat-share-selectable-group]")!,
  );
  click(row.getByText("Select message group"));
  await screen.findAllByText("1 selected");
  expect(row.getByRole("checkbox")).toBeChecked();
  expect(share).toBeEnabled();
  click(row.getByText("Deselect message group"));
  await waitFor(() => {
    return expect(share).toBeDisabled();
  });
  expect(row.getByRole("checkbox")).not.toBeChecked();
  await screen.findAllByText("0 selected");
});
test("chat-sharing-005 copying code and clicking the answer preserve the intended message selection", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await conversation(
    "Inventory checked. [Catalog](https://example.test/catalog)\n\n```sh\necho inventory\n```",
  );
  click(await findFastControl("button", "Share messages"));
  const share = await findFastControl("button", "Share");
  const link = await findFastControl("link", "Catalog");
  const row = within(
    link.closest<HTMLElement>("[data-chat-share-selectable-group]")!,
  );
  click(row.getByLabelText("Copy to clipboard"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual(["echo inventory\n"]);
  });
  expect(row.getByRole("checkbox")).not.toBeChecked();
  expect(share).toBeDisabled();
  click(row.getByText("Select message group"));
  expect(share).toBeEnabled();
  click(row.getByText(/Inventory checked\./));
  expect(row.getByRole("checkbox")).toBeChecked();
  expect(share).toBeEnabled();
});
test("chat-sharing-020 Escape dismisses the message audience menu and returns to Share", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await conversation("Inventory checked", true);
  const composer = await screen.findByRole("textbox", { name: /message/i });
  const share = await findFastControl("button", "Share message");
  click(share);
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(share).toHaveFocus();
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([]);
  expect(composer).toBeInTheDocument();
});
