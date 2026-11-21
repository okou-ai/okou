import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
async function table(text: string) {
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 1,
        text: "List the invoice totals",
      }),
      assistantEvent({ id: crypto.randomUUID(), runId, seqId: 2, text }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
}
test("markdown-table-export-002 an empty single-column table keeps its export action", async () => {
  await table("| Invoice |\n| --- |");
  await screen.findByText("Invoice", { selector: "th" });
  await screen.findByText("0 rows · 1 column");
  await expect(findFastControl("button", "Export")).resolves.toBeEnabled();
});
test("markdown-table-export-013 keyboard export reveals both Google destinations and restores focus", async () => {
  await table("| Invoice |\n| --- |\n| March |");
  const trigger = await findFastControl("button", "Export");
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  const excel = await screen.findByText("Export Excel", {
    selector: '[role="menuitem"]',
  });
  await waitFor(() => {
    return expect(excel).toHaveFocus();
  });
  for (const name of ["Save to Google Drive", "Save to Google Sheets"]) {
    expect(
      screen.getByText(name, { selector: '[role="menuitem"]' }),
    ).toBeInTheDocument();
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
