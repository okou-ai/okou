import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
  textContinuityDraft,
  continuitySidebarLink,
} from "./chat-continuity-test-helpers.ts";
import {
  chatListEvent,
  installChatListStream,
} from "./chat-list-test-helpers.ts";

const context = testContext();
async function splitWorkspace() {
  const main = continuityThread(310, 2, "Project plan");
  const side = continuityThread(310, 1, "❓");
  const newer = continuityThread(310, 3, "Release checklist");
  const threads = [newer, main, side];
  const drafts = new Map(
    threads.map((t) => {
      return [t.id, textContinuityDraft("Draft for " + t.title)];
    }),
  );
  const workspace = installContinuityWorkspace(context, {
    caseId: 310,
    threads,
    drafts,
  });
  const renames: ReturnType<typeof chatListEvent>[] = [];
  const stream = installChatListStream(context, {
    caseId: 310,
    snapshot: threads,
    events: renames,
  });
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ body, params, respond }) => {
      renames.push(
        chatListEvent(310, renames.length + 2, "renamed", params.id, {
          id: body.eventId,
          title: body.title,
        }),
      );
      stream.setEvents(renames);
      return respond(204);
    },
  );
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: "/chats/" + main.id + "?sidebar=" + side.id,
  });
  const sideText = await screen.findByText("Draft for ❓");
  const sidePane = sideText.closest<HTMLElement>(
    "[data-chat-thread-container-id]",
  )!;
  const editor = (
    await screen.findByText("Draft for Project plan")
  ).closest<HTMLElement>('[contenteditable="true"]')!;
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  return { main, side, newer, user, sidePane };
}
test("chat-continuity-keyboard-001 moves the focused main conversation to its newer neighbor", async () => {
  const { newer, side, user, sidePane } = await splitWorkspace();
  await user.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
  await screen.findByText("Draft for Release checklist");
  expect(location.pathname).toBe("/chats/" + newer.id);
  expect(new URL(location.href).searchParams.get("sidebar")).toBe(side.id);
  expect(within(sidePane).getByText("Draft for ❓")).toBeVisible();
});
test("chat-continuity-keyboard-002 sets and clears the main chat icon from its composer", async () => {
  const { main, user } = await splitWorkspace();
  for (const [key, title] of [
    ["[Digit1]", "✅ Project plan"],
    ["[Digit0]", "Project plan"],
  ] as const) {
    await user.keyboard("{Control>}{Shift>}" + key + "{/Shift}{/Control}");
    await waitFor(() => {
      expect(
        continuitySidebarLink(main.id)
          .querySelector('[data-slot="sidebar-thread-title"]')
          ?.textContent?.trim(),
      ).toBe(title);
    });
    expect(screen.queryByLabelText("Search emoji")).toBeNull();
  }
});
