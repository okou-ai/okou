import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000d91";
const TITLE = "Planejamento semanal";
const DRAFT = "Rascunho ainda não enviado.";

test("Closing translated Settings preserves the conversation and unsent draft", async () => {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: TITLE,
    chatEvents: [],
  });
  // The draft was written earlier and has not been sent.
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [{ type: "text", text: DRAFT }] },
      draftAttachments: [],
    });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}?settings=preference`,
    locale: "pt-BR",
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(document.documentElement).toHaveAttribute("lang", "pt-BR");
  await expect(findComposerEditor()).resolves.toHaveTextContent(DRAFT);
  const user = userEvent.setup({ delay: null });

  await user.click(
    within(settings).getByRole("combobox", { name: "Language" }),
  );
  await user.click(await screen.findByRole("option", { name: "English" }));
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "en-US");
  });
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(settings).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe(`/chats/${THREAD_ID}`);
  // The conversation header still names the same conversation.
  expect(
    screen.getAllByText(TITLE).some((title) => {
      return title.closest("header") !== null;
    }),
  ).toBeTruthy();
  await expect(findComposerEditor()).resolves.toHaveTextContent(DRAFT);
});
