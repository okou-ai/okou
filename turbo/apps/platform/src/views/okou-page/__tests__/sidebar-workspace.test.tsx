import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockNow } from "../../../lib/time.ts";
import {
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
const context = testContext();
function history(entries: readonly (readonly [string, number])[]) {
  const today = new Date("2026-05-20T12:00:00Z");
  const threads = entries.map(([title, age], index) => {
    const date = new Date(today.valueOf() - age * 60_000).toISOString();
    return chatListThread(index + 1, title, {
      sortAt: date,
      updatedAt: date,
      createdAt: date,
    });
  });
  mockNow(today, context.signal);
  installChatListStream(context, { caseId: 65, snapshot: threads });
  return threads;
}
async function search() {
  await setupPage({
    context,
    path: "/",
    sharedWorkerTestTransport: "message-port",
  });
  click(await screen.findByLabelText("Search workspace"));
  return screen.findByRole("dialog");
}
test("sidebar-workspace-003 Selecting a title-filtered result opens that conversation", async () => {
  const [notes, incident] = history([
    ["Deployment notes", 3],
    ["Incident response", 10],
  ]);
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    return respond(200, {
      results:
        query.keyword === "deploy"
          ? [
              {
                chatThreadId: incident.id,
                matchedMessage: {
                  chatThreadId: incident.id,
                  role: "user",
                  content: "deploy the recovery",
                  createdAt: incident.updatedAt,
                  seqId: 1,
                  runId: null,
                },
                matchedRanges: [{ start: 0, end: 6 }],
              },
            ]
          : [],
    });
  });
  const dialog = await search();
  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "deploy",
  );
  await expect(
    within(dialog).findByText("Incident response"),
  ).resolves.toBeInTheDocument();
  await expect(
    within(dialog).findByText(/the recovery/),
  ).resolves.toBeInTheDocument();
  click(within(dialog).getByText("Chats"));
  expect(within(dialog).queryByText("Incident response")).toBeNull();
  click(within(dialog).getByText("Deployment notes"));
  await waitFor(() => {
    return expect(window.location.pathname).toBe("/chats/" + notes.id);
  });
  expect(dialog).not.toBeInTheDocument();
});
test("sidebar-workspace-004 Search shows each chat's age and an illustrated empty result", async () => {
  const entries = [
    ["Triage", 5],
    ["Handover", 180],
    ["Escalation", 2880],
    ["Quarterly review", 86_400],
  ] as const;
  history(entries);
  context.mocks.api(chatSearchContract.search, ({ respond }) => {
    return respond(200, { results: [] });
  });
  const dialog = await search();
  for (const [title, age] of [
    ["Triage", "5 minutes ago"],
    ["Handover", "3 hours ago"],
    ["Escalation", "2 days ago"],
    ["Quarterly review", /Mar 21/],
  ] as const) {
    const row = await within(dialog).findByText(title);
    const result = row.closest('[role="option"]');
    if (!(result instanceof HTMLElement)) {
      throw new Error("Missing result for " + title);
    }
    expect(within(result).getByText(age)).toBeInTheDocument();
  }
  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "xyzzzzz",
  );
  await expect(
    within(dialog).findByText("No results found"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByRole("presentation")).toHaveAttribute(
    "src",
    expect.stringMatching(/empty.*search/i),
  );
  for (const [title] of entries) {
    expect(within(dialog).queryByText(title)).toBeNull();
  }
});
