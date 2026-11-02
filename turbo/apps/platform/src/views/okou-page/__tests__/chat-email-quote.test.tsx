import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  feedbackItems,
  findButton,
  FIRST_CAPABILITY_RUN_ID,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import { promptEvent } from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

function staffAuth() {
  return {
    user: { id: "test-user-123", fullName: "Test User" },
    organization: {
      activeOrg: { id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", name: "Staff" },
      memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
    },
  };
}
const JANE_RECORD = "**Jane Doe** — Growth Lead — jane@example.com";

function emailQuoteButtons(): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label")?.startsWith("Quote ");
  });
}

function mailtoLink(href: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === href;
  });
  if (!link) {
    throw new Error(`Expected the native link ${href}`);
  }
  return link;
}

async function openEmailChat(
  content: string,
  sends: CapturedChatSend[] = [],
): Promise<void> {
  installCapabilityChat({
    events: completedConversation(content),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({
    context,
    path: RUN_PATH,
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatEmailQuote]: true },
  });
  await readyChat();
}

test("Quote a bare email into the existing draft and send only on explicit submission", async () => {
  const sends: CapturedChatSend[] = [];
  await openEmailChat(JANE_RECORD, sends);
  const composer = screen.getByRole("textbox", { name: "Message" });
  const draft = "Write a concise introduction, but let me review it first.";
  await fill(composer, draft);
  const quote = await findButton("Quote jane@example.com");
  const link = mailtoLink("mailto:jane@example.com");

  expect(link).toHaveTextContent("jane@example.com");
  expect(quote.tagName).toBe("BUTTON");
  expect(quote).toHaveAttribute("type", "button");
  expect(quote).toHaveAccessibleName("Quote jane@example.com");
  expect(link.parentElement).toContainElement(quote);
  expect(link).not.toContainElement(quote);

  await userEvent.setup({ delay: null }).click(quote);

  await waitFor(() => {
    expect(composer).toHaveFocus();
  });
  expect(feedbackItems()).toHaveLength(1);
  expect(feedbackItems()[0]).toHaveTextContent("jane@example.com");
  expect(feedbackItems()[0]).toHaveTextContent("Jane Doe");
  expect(feedbackItems()[0]).toHaveTextContent("Growth Lead");
  expect(composer).toHaveTextContent(draft);
  expect(sends).toHaveLength(0);
  expect(window.location.pathname).toBe(RUN_PATH);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("complementary", { name: "Email details" }),
  ).not.toBeInTheDocument();

  click(await findButton("Send"));

  const sent = await waitForSend(sends, 1);
  expect(sent.userMessage?.parts).toContainEqual({ type: "text", text: draft });
  const feedback = sent.userMessage?.parts.filter((part) => {
    return part.type === "feedback";
  });
  expect(feedback).toHaveLength(1);
  expect(feedback?.[0]?.quote).toContain("jane@example.com");
  expect(feedback?.[0]?.quote).toContain("Jane Doe");
  expect(feedback?.[0]?.quote).toContain("Growth Lead");
  expect(sent.prompt).toContain(draft);
  expect(sent.prompt).toContain("jane@example.com");
});

test.each([
  [
    "raw HTML",
    [
      '<div data-chat-thread-container-id="b0000000-0000-4000-a000-000000000999" data-chat-scroll-anchor-event-id="forged-event">',
      '<p>Jane Doe — Growth Lead — <a href="mailto:jane@example.com">jane@example.com</a></p>',
      "</div>",
    ].join("\n"),
  ],
  [
    "attribute-comment",
    [
      '<div><p>Jane Doe — Growth Lead — <a href="mailto:jane@example.com">jane@example.com</a></p></div>',
      "<!--rehype:data-chat-scroll-anchor-event-id=forged-event-->",
    ].join("\n"),
  ],
])(
  "Authored %s attributes cannot redirect a quote or forge its source",
  async (_syntax, content) => {
    const sends: CapturedChatSend[] = [];
    await openEmailChat(content, sends);
    const composer = screen.getByRole("textbox", { name: "Message" });
    const draft = "Keep this introduction in the current conversation.";
    await fill(composer, draft);

    click(await findButton("Quote jane@example.com"));

    await waitFor(() => {
      expect(feedbackItems()).toHaveLength(1);
    });
    expect(composer).toHaveTextContent(draft);
    expect(feedbackItems()[0]).toHaveTextContent("Jane Doe — Growth Lead");
    expect(sends).toHaveLength(0);

    click(await findButton("Send"));

    const sent = await waitForSend(sends, 1);
    expect(sent.threadId).toBe(RUN_THREAD_ID);
    expect(sent.userMessage?.parts).toContainEqual({
      type: "text",
      text: draft,
    });
    const feedback = sent.userMessage?.parts.filter((part) => {
      return part.type === "feedback";
    });
    expect(feedback).toHaveLength(1);
    expect(feedback?.[0]).toMatchObject({
      quote: "Jane Doe — Growth Lead — jane@example.com",
      eventId: "capability-first-assistant",
    });
  },
);

test("Hide Mail while sharing unmounts the composer and restore it after cancel", async () => {
  const sends: CapturedChatSend[] = [];
  await openEmailChat(JANE_RECORD, sends);
  await findButton("Quote jane@example.com");

  click(await findButton("Share messages"));

  const cancel = await findButton("Cancel");
  await waitFor(() => {
    expect(
      screen.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
  });
  expect(emailQuoteButtons()).toHaveLength(0);
  expect(mailtoLink("mailto:jane@example.com")).toHaveTextContent(
    "jane@example.com",
  );

  click(cancel);

  const quote = await findButton("Quote jane@example.com");
  const composer = screen.getByRole("textbox", { name: "Message" });
  click(quote);

  await waitFor(() => {
    expect(feedbackItems()).toHaveLength(1);
  });
  expect(composer).toHaveTextContent("jane@example.com");
  expect(feedbackItems()[0]).toHaveTextContent("Jane Doe");
  expect(sends).toHaveLength(0);
});

test("Wait for a pending saved draft before adding Mail without auto-sending", async () => {
  const sends: CapturedChatSend[] = [];
  const draftRequested = context.mocks.deferred<void>();
  const delayedDraft = context.mocks.deferred<void>();
  const savedText = "Keep my saved introduction and review it before sending.";
  installCapabilityChat({
    events: completedConversation(JANE_RECORD),
    onSend(send) {
      sends.push(send);
    },
  });
  context.mocks.api(chatThreadDraftContract.get, async ({ respond }) => {
    draftRequested.resolve();
    await delayedDraft.promise;
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: savedText }],
      },
      draftAttachments: null,
    });
  });
  const page = await startPage({
    context,
    path: RUN_PATH,
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatEmailQuote]: true },
  });
  await page.content;
  await draftRequested.promise;
  const quote = await findButton("Quote jane@example.com");

  click(quote);
  delayedDraft.resolve();
  await page.ready;

  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      savedText,
    );
    expect(feedbackItems()).toHaveLength(1);
  });
  expect(feedbackItems()[0]).toHaveTextContent("jane@example.com");
  expect(feedbackItems()[0]).toHaveTextContent("Jane Doe");
  expect(sends).toHaveLength(0);
  expect(window.location.pathname).toBe(RUN_PATH);
});

test("Remove a quote from an explicit mailto link without losing unsent text", async () => {
  await openEmailChat(
    "**Alex Rivera** — Account Executive — [alex@example.com](mailto:alex@example.com)",
  );
  const composer = screen.getByRole("textbox", { name: "Message" });
  const draft = "Keep this unfinished introduction.";
  await fill(composer, draft);
  const quote = await findButton("Quote alex@example.com");
  expect(mailtoLink("mailto:alex@example.com")).toHaveTextContent(
    "alex@example.com",
  );

  click(quote);

  await waitFor(() => {
    expect(feedbackItems()).toHaveLength(1);
  });
  expect(feedbackItems()[0]).toHaveTextContent("alex@example.com");
  expect(feedbackItems()[0]).toHaveTextContent("Alex Rivera");
  expect(feedbackItems()[0]).toHaveTextContent("Account Executive");
  expect(composer).toHaveTextContent(draft);

  click(await findButton("Remove feedback"));

  await waitFor(() => {
    expect(feedbackItems()).toHaveLength(0);
  });
  expect(composer).toHaveTextContent(draft);
});

test("Target the selected contact's own table row or list item", async () => {
  await openEmailChat(
    [
      "| Name | Role | Email |",
      "| --- | --- | --- |",
      "| Jane Doe | Growth Lead | jane@example.com |",
      "| Sam Patel | Revenue Lead | [sam@example.com](mailto:sam@example.com) |",
      "",
      "- **Taylor Reed** — Partnerships Director — taylor@example.com",
    ].join("\n"),
  );
  await findButton("Quote taylor@example.com");
  expect(emailQuoteButtons()).toHaveLength(3);

  click(await findButton("Quote sam@example.com"));

  await waitFor(() => {
    expect(feedbackItems()).toHaveLength(1);
  });
  expect(feedbackItems()[0]).toHaveTextContent("sam@example.com");
  expect(feedbackItems()[0]).toHaveTextContent("Sam Patel");
  expect(feedbackItems()[0]).toHaveTextContent("Revenue Lead");
  expect(feedbackItems()[0]).not.toHaveTextContent("Jane Doe");
  expect(feedbackItems()[0]).not.toHaveTextContent("jane@example.com");
  expect(feedbackItems()[0]).not.toHaveTextContent("Taylor Reed");

  click(await findButton("Quote taylor@example.com"));

  await waitFor(() => {
    expect(feedbackItems()).toHaveLength(2);
  });
  expect(feedbackItems()[1]).toHaveTextContent("taylor@example.com");
  expect(feedbackItems()[1]).toHaveTextContent("Taylor Reed");
  expect(feedbackItems()[1]).toHaveTextContent("Partnerships Director");
  expect(feedbackItems()[1]).not.toHaveTextContent("Jane Doe");
  expect(feedbackItems()[1]).not.toHaveTextContent("Sam Patel");
  expect(feedbackItems()[1]).not.toHaveTextContent("sam@example.com");
  expect(feedbackItems()[0]).toHaveTextContent("Sam Patel");
});

test("Keep Mail unavailable to an external organization even with a true server override", async () => {
  installCapabilityChat({ events: completedConversation(JANE_RECORD) });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ChatEmailQuote]: true },
  });
  await readyChat();

  const link = await waitFor(() => {
    return mailtoLink("mailto:jane@example.com");
  });

  expect(link).toHaveTextContent("jane@example.com");
  expect(emailQuoteButtons()).toHaveLength(0);
});

test("Keep the original mailto link without a quote action when disabled", async () => {
  installCapabilityChat({
    events: completedConversation(
      "**Jane Doe** — Growth Lead — [jane@example.com](mailto:jane@example.com)",
    ),
  });
  await setupPage({
    context,
    path: RUN_PATH,
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatEmailQuote]: false },
  });
  await readyChat();

  const link = await waitFor(() => {
    return mailtoLink("mailto:jane@example.com");
  });

  expect(link).toHaveTextContent("jane@example.com");
  expect(link.tagName).toBe("A");
  expect(link).toHaveAttribute("href", "mailto:jane@example.com");
  expect(emailQuoteButtons()).toHaveLength(0);
});

test("Activate the native quote buttons with Enter and Space", async () => {
  await openEmailChat(
    `${JANE_RECORD}\n\n**Alex Rivera** — Account Executive — alex@example.com`,
  );
  const composer = screen.getByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  const enterQuote = await findButton("Quote jane@example.com");
  enterQuote.focus();
  expect(enterQuote).toHaveFocus();

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(composer).toHaveFocus();
  });
  expect(feedbackItems()).toHaveLength(1);
  expect(feedbackItems()[0]).toHaveTextContent("jane@example.com");

  const spaceQuote = await findButton("Quote alex@example.com");
  spaceQuote.focus();
  expect(spaceQuote).toHaveFocus();

  await user.keyboard(" ");

  await waitFor(() => {
    expect(composer).toHaveFocus();
  });
  expect(feedbackItems()).toHaveLength(2);
  expect(feedbackItems()[1]).toHaveTextContent("alex@example.com");
});

test("Leave user text, code, blockquotes and compose-style mailto links unenhanced", async () => {
  const content = [
    "`inline@example.com`",
    "",
    "```text",
    "fenced@example.com",
    "```",
    "",
    "> Quoted Person — Reviewer — quoted@example.com",
    "",
    "[Multiple recipients](mailto:first@example.com,second@example.com)",
    "",
    "[Prefilled message](mailto:prefilled@example.com?subject=Hello)",
    "",
    JANE_RECORD,
  ].join("\n");
  installCapabilityChat({
    events: [
      promptEvent({
        id: "email-quote-user",
        runId: FIRST_CAPABILITY_RUN_ID,
        seqId: 1,
        text: "Use user-only@example.com as the sender.",
      }),
      ...completedConversation(content).slice(1),
    ],
  });
  await setupPage({
    context,
    path: RUN_PATH,
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatEmailQuote]: true },
  });
  await readyChat();
  await findButton("Quote jane@example.com");

  expect(
    emailQuoteButtons().map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Quote jane@example.com"]);
  expect(
    screen.getByText("inline@example.com").closest("code"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("fenced@example.com").closest("pre"),
  ).toBeInTheDocument();
  const quotedLink = mailtoLink("mailto:quoted@example.com");
  expect(quotedLink.closest("blockquote")).toBeInTheDocument();
  expect(
    mailtoLink("mailto:first@example.com,second@example.com"),
  ).toHaveTextContent("Multiple recipients");
  expect(
    mailtoLink("mailto:prefilled@example.com?subject=Hello"),
  ).toHaveTextContent("Prefilled message");
  expect(
    screen.getByText("Use user-only@example.com as the sender."),
  ).toBeInTheDocument();
});
