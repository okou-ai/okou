import { waitFor, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import userEvent from "@testing-library/user-event";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

test.each([
  { id: "001", cookie: "v1.fr-FR", languages: ["ja-JP"], lang: "fr-FR" },
  {
    id: "002",
    cookie: "v1.unknown",
    languages: ["sv-SE", "de-AT", "ja-JP"],
    lang: "de-DE",
  },
])(
  "initial-locale-$id opens sign-in in $lang",
  async ({ cookie, languages, lang }) => {
    context.mocks.browser.languages(languages);
    context.mocks.browser.cookie(`__Secure-okou-locale=${cookie}`);
    await setupPage({ context, path: "/sign-in", auth: null });
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("lang", lang);
    });
  },
);

const RUN_ID = "d0000000-0000-4000-a000-000000000d81";

/** The value shown beside the activity's Duration label. */
function durationValue(): string | undefined {
  const label = screen.getByText("Duration");
  return label.nextElementSibling?.textContent?.trim();
}

test("French uses local number formatting", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: RUN_ID,
      sessionId: null,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Summarize the quarter",
      appendSystemPrompt: null,
      createdAt: "2026-11-21T09:00:00.000Z",
      startedAt: "2026-11-21T09:00:01.000Z",
      completedAt: "2026-11-21T09:00:02.200Z",
    });
  });
  await setupPage({
    context,
    path: `/activities/${RUN_ID}?settings=preference`,
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(durationValue()).toBe("1.2s");
  const user = userEvent.setup({ delay: null });

  await user.click(
    within(settings).getByRole("combobox", { name: "Language" }),
  );
  await user.click(await screen.findByRole("option", { name: "Français" }));
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
  });
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(settings).not.toBeInTheDocument();
  });
  expect(durationValue()).toBe("1,2s");
});

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
