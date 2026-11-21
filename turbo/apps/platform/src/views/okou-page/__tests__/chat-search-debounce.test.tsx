import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { completedMarkdownReply } from "./markdown-page-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
const context = testContext();
async function searchFixture() {
  const requests: string[] = [];
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    requests.push(query.keyword);
    return respond(200, {
      results: [
        {
          chatThreadId: context.resourceId,
          agentName: "Operations",
          matchedRanges: [{ start: 0, end: query.keyword.length }],
          matchedMessage: {
            role: "assistant",
            chatThreadId: context.resourceId,
            content: query.keyword + " in the operations ledger",
            createdAt: "2026-06-03T12:00:00Z",
            seqId: 2,
            runId: null,
          },
        },
      ],
    });
  });
  await setupPage({
    context,
    path: completedMarkdownReply(context, "Review the ledger"),
  });
  await screen.findByText("Review the ledger");
  return requests;
}
async function openSearch() {
  click(await findAction("button", "Search workspace"));
  const dialog = await screen.findByRole("dialog");
  return within(dialog).getByRole("combobox");
}
test("chat-search-debounce-001 only the settled number reaches workspace message search", async () => {
  const requests = await searchFixture();
  const input = await openSearch();
  for (const value of ["3", "32", "320", "3205", "32059"]) {
    fireEvent.change(input, { target: { value } });
  }
  const result = await screen.findByLabelText("32059 in the operations ledger");
  expect(result).toHaveTextContent("32059 in the operations ledger");
  expect(requests).toStrictEqual(["32059"]);
});
test("chat-search-debounce-002 cleared and dismissed keywords never reach the search service", async () => {
  const requests = await searchFixture();
  const input = await openSearch();
  const type = (box: HTMLElement, value: string) => {
    return fireEvent.change(box, { target: { value } });
  };
  type(input, "discarded");
  type(input, "");
  await expect(
    within(await screen.findByRole("dialog")).findByText("Rich content"),
  ).resolves.toBeVisible();
  type(input, "issue");
  await expect(
    screen.findByLabelText("issue in the operations ledger"),
  ).resolves.toBeVisible();
  type(input, "dismissed");
  await userEvent.keyboard("{Escape}");
  const reopened = await openSearch();
  expect(reopened).toHaveValue("");
  type(reopened, "budget");
  await expect(
    screen.findByLabelText("budget in the operations ledger"),
  ).resolves.toBeVisible();
  expect(requests).toStrictEqual(["issue", "budget"]);
});
