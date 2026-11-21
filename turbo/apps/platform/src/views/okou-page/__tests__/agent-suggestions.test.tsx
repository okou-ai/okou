import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  feedContract,
  type Suggestion,
} from "@okouai/api-contracts/contracts/feed";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { nowDate } from "../../../lib/time.ts";
import {
  createChatRunFixtures,
  RUN_THREAD_ID,
  promptEvent,
} from "./chat-run-test-fixtures.ts";
import {
  chatThreadDraftContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
test("agent-suggestions-039 the empty For you destination reports zero remaining items", async () => {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [] });
  });
  await setupPage({
    context,
    path: "/for-you",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
  await screen.findByText("All caught up");
  expect(screen.getByText("0 to go")).toBeInTheDocument();
  expect(location.pathname).toBe("/for-you");
});

function proposal(title: string, priority = 10): Suggestion {
  const created = nowDate();
  const stamp = created.toISOString();
  return {
    id: crypto.randomUUID(),
    type: "suggestion",
    createdAt: stamp,
    updatedAt: stamp,
    expiresAt: new Date(created.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    priority,
    consumeToken: (crypto.randomUUID() + crypto.randomUUID()).replaceAll(
      "-",
      "",
    ),
    state: { status: "active", selectedOptionId: null, feedbacks: [] },
    content: {
      title,
      rationale: "Review " + title,
      options: [
        {
          id: "prepare",
          label: "Prepare " + title,
          description: "Prepare the requested report",
          threadId: null,
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [{ type: "text", text: "Draft " + title }],
            },
            draftAttachments: null,
          },
        },
      ],
      customOption: {
        id: "custom",
        threadId: null,
        draft: {
          draftAttachments: null,
          draftUserMessage: {
            version: 1,
            parts: [
              { type: "feedback", quote: "Notes for " + title, note: [] },
            ],
          },
        },
      },
    },
  };
}

function feed(items: Suggestion[]) {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items });
  });
}

function openDeck(path = "/for-you") {
  return setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
}

function activeCard(item: Suggestion) {
  return screen.findByRole("article", { name: item.content.title });
}

test("agent-suggestions-001 a removed feed item sends the choice with its original consume token", async () => {
  const item = proposal("Vendor renewals");
  const items = [item];
  feed(items);
  const sent = context.mocks.deferred<string>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest: ({ prompt }) => {
      return sent.resolve(prompt);
    },
  });
  const consume = context.mocks.deferred<{
    card: string;
    choice: string | null;
    token?: string;
  }>();
  context.mocks.api(feedContract.consume, ({ params, body, respond }) => {
    consume.resolve({
      card: params.id,
      choice: body.optionId,
      token: body.snapshot?.consumeToken,
    });
    return respond(200, item);
  });
  await openDeck();
  const button = await findFastControl(
    "button",
    "Prepare Vendor renewals",
    await activeCard(item),
  );
  items.splice(0);
  click(button);
  await expect(consume.promise).resolves.toStrictEqual({
    card: item.id,
    choice: "prepare",
    token: item.consumeToken,
  });
  await expect(sent.promise).resolves.toBe("Draft Vendor renewals");
  await screen.findByText("All caught up");
  expect(location.pathname).toBe("/for-you");
});

test("agent-suggestions-020 changing cards discards the first inline direction", async () => {
  const one = proposal("Supply forecast");
  const two = proposal("Packing list", 1);
  feed([one, two]);
  await openDeck();
  click(
    await findFastControl(
      "button",
      "What do you have in mind?",
      await activeCard(one),
    ),
  );
  const first = await screen.findByRole("region", {
    name: "What do you have in mind?",
  });
  const edit = await within(first).findByRole("textbox", { name: /message/i });
  await appendDirection(edit, "Expedite shipping");
  expect(edit).toHaveTextContent("Expedite shipping");
  click(await findFastControl("link", "Show suggestion 2 of 2"));
  await activeCard(two);
  expect(first).not.toBeInTheDocument();
  click(
    await findFastControl(
      "button",
      "What do you have in mind?",
      await activeCard(two),
    ),
  );
  const next = await screen.findByRole("region", {
    name: "What do you have in mind?",
  });
  await within(next).findByRole("textbox", { name: /message/i });
  expect(next).toHaveTextContent("Packing list");
  expect(next).not.toHaveTextContent("Supply forecast");
  expect(next).not.toHaveTextContent("Expedite shipping");
});

test("agent-suggestions-023 undo restores the second suggestion after Not planned", async () => {
  const first = proposal("Produce order", 30),
    second = proposal("Bread order", 20),
    third = proposal("Dairy order", 10);
  feed([first, second, third]);
  context.mocks.api(feedContract.feedback, ({ body, respond }) => {
    return respond(200, { restored: body.kind === "undo" });
  });
  await openDeck();
  await activeCard(first);
  click(await findFastControl("link", "Show suggestion 2 of 3"));
  click(
    await findFastControl("button", "Not planned", await activeCard(second)),
  );
  await activeCard(third);
  click(await findFastControl("button", "Undo"));
  await expect(
    findFastControl("button", "Prepare Bread order", await activeCard(second)),
  ).resolves.toBeEnabled();
});

test("agent-suggestions-008 selecting a referenced action keeps the homepage draft separate", async () => {
  const item = proposal("Buyer review", 20),
    next = proposal("Weekly quantities");
  const source = crypto.randomUUID();
  item.content.options[0]!.draft.draftUserMessage!.parts.push({
    type: "chat_thread",
    threadId: source,
    titleSnapshot: "Wholesale ledger",
  });
  item.content.options.push({
    ...item.content.options[0]!,
    id: "skip",
    label: "Contact supplier",
    draft: {
      draftAttachments: null,
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Discarded supplier option" }],
      },
    },
  });
  feed([item, next]);
  let title: string | undefined;
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onThreadCreate: (body) => {
      title = body.title;
    },
    onSendRequest: (body) => {
      sent.resolve(body.userMessage);
    },
  });
  context.mocks.api(feedContract.consume, ({ respond }) => {
    return respond(200, item);
  });
  await openDeck("/");
  const home = await screen.findByRole("textbox", { name: /message/i });
  await fill(home, "Personal order");
  click(await findFastControl("link", /For you/));
  click(
    await findFastControl(
      "button",
      "Prepare Buyer review",
      await activeCard(item),
    ),
  );
  await activeCard(next);
  expect(location.pathname).toBe("/for-you");
  const doc = await sent.promise;
  expect(title).toBe(item.content.title);
  expect(doc?.parts).toStrictEqual([
    { type: "text", text: "Draft Buyer review" },
    {
      type: "chat_thread",
      threadId: source,
      titleSnapshot: "Wholesale ledger",
    },
  ]);
  click(await findFastControl("link", "Chat"));
  const restored = await screen.findByRole("textbox", { name: /message/i });
  await waitFor(() => {
    return expect(restored).toHaveTextContent("Personal order");
  });
  expect(restored).not.toHaveTextContent("Buyer review");
});

test("agent-suggestions-009 the destination composer combines the two drafts and attachments", async () => {
  const item = proposal("Shipping receipt");
  const option = item.content.options[0]!;
  option.threadId = RUN_THREAD_ID;
  const remote = {
    id: crypto.randomUUID(),
    url: "https://files.example.test/purchase.txt",
    filename: "purchase.txt",
    contentType: "text/plain",
    size: 24,
  };
  const file = {
    ...remote,
    id: crypto.randomUUID(),
    filename: "receipt.txt",
    url: "https://files.example.test/receipt.txt",
  };
  option.draft.draftAttachments = [file];
  option.draft.draftUserMessage!.parts.push({
    type: "file",
    fileId: file.id,
    filenameSnapshot: file.filename,
    contentType: file.contentType,
  });
  feed([item]);
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        seqId: 1,
        text: "Original request",
      }),
    ],
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftAttachments: [remote],
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Existing purchase" },
          {
            type: "file",
            fileId: remote.id,
            filenameSnapshot: remote.filename,
            contentType: remote.contentType,
          },
        ],
      },
    });
  });
  context.mocks.api(feedContract.consume, ({ respond }) => {
    return respond(200, item);
  });
  await openDeck();
  click(
    await findFastControl(
      "button",
      "Prepare Shipping receipt",
      await activeCard(item),
    ),
  );
  await screen.findByText("Original request");
  const editor = await screen.findByRole("textbox", { name: /message/i });
  await waitFor(() => {
    return expect(editor).toHaveTextContent("Existing purchase");
  });
  expect(editor).toHaveTextContent("Draft Shipping receipt");
  const composer = editor.closest<HTMLElement>("[data-chat-composer]")!;
  expect(composer).toHaveTextContent(file.filename);
  expect(composer).toHaveTextContent(remote.filename);
  expect(location.pathname).toBe("/chats/" + RUN_THREAD_ID);
  expect(
    Array.from(document.querySelectorAll('[data-role="user"]')).map((row) => {
      return row.textContent;
    }),
  ).toStrictEqual([expect.stringContaining("Original request")]);
  expect(document.querySelector('[data-role="user"]')).not.toHaveTextContent(
    "Draft Shipping receipt",
  );
  await expect(
    findFastControl("button", "Send", composer),
  ).resolves.toBeEnabled();
});

test("agent-suggestions-014 the chat list opens the suggestion just sent", async () => {
  const item = proposal("Inspect dispatch", 20),
    next = proposal("Book courier");
  feed([item, next]);
  createChatRunFixtures(context).installRunChat();
  context.mocks.api(feedContract.consume, ({ respond }) => {
    return respond(200, item);
  });
  await openDeck();
  click(
    await findFastControl(
      "button",
      "Prepare Inspect dispatch",
      await activeCard(item),
    ),
  );
  await activeCard(next);
  const threads = await screen.findByLabelText("Chat threads");
  const link = await findFastControl("link", /Inspect dispatch/, threads);
  const destination = link.getAttribute("href");
  click(link);
  await screen.findByText("Draft Inspect dispatch", {
    selector: '[data-role="user"] *',
  });
  expect(location.pathname).toBe(destination);
});

test("agent-suggestions-019 returning home keeps an unsent inline direction out of the homepage draft", async () => {
  const item = proposal("Delivery accounts");
  feed([item]);
  await openDeck("/");
  const previous = "Do the inventory";
  await fill(
    await screen.findByRole("textbox", { name: /message/i }),
    previous,
  );
  click(await findFastControl("link", /For you/));
  const card = await activeCard(item);
  click(await findFastControl("button", "What do you have in mind?", card));
  const inline = await screen.findByRole("region", {
    name: "What do you have in mind?",
  });
  const editor = await within(inline).findByRole("textbox", {
    name: /message/i,
  });
  expect(inline).toHaveTextContent(item.content.title);
  expect(inline).not.toHaveTextContent("Notes for " + item.content.title);
  expect(inline).not.toHaveTextContent(previous);
  expect(within(inline).queryByRole("heading")).toBeNull();
  expect(queryFastControl("button", "Close", inline)).toBeNull();
  expect(queryFastControl("button", "Remove feedback", inline)).toBeNull();
  const send = await findFastControl("button", "Send", inline);
  expect(send).toBeDisabled();
  await appendDirection(editor, "Start with November");
  await waitFor(() => {
    return expect(queryFastControl("button", "Send", inline)).toBeEnabled();
  });
  const homeLink = await findFastControl("link", "Chat");
  expect(homeLink).toHaveAttribute("href", "/");
  click(homeLink);
  const home = await screen.findByRole("textbox", { name: /message/i });
  await waitFor(() => {
    return expect(home).toHaveTextContent(previous);
  });
  expect(home).not.toHaveTextContent("Start with November");
  click(await findFastControl("link", /For you/));
  await expect(activeCard(item)).resolves.toBeVisible();
});

test("agent-suggestions-028 the next card is available while the prior choice is being saved", async () => {
  const first = proposal("Parts due", 20),
    next = proposal("Cost revision");
  feed([first, next]);
  const release = context.mocks.deferred<void>(),
    arrived = context.mocks.deferred<void>();
  context.mocks.api(feedContract.consume, async ({ respond }) => {
    arrived.resolve();
    await release.promise;
    return respond(200, first);
  });
  createChatRunFixtures(context).installRunChat();
  await openDeck();
  click(
    await findFastControl(
      "button",
      "Prepare Parts due",
      await activeCard(first),
    ),
  );
  try {
    await arrived.promise;
    await screen.findByText("Sent to a new chat");
    await expect(activeCard(next)).resolves.toBeVisible();
    expect(location.pathname).toBe("/for-you");
  } finally {
    release.resolve();
  }
});

async function appendDirection(editor: HTMLElement, text: string) {
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  await user.paste(text);
}

test("agent-suggestions-025 a withdrawn second choice refreshes the pool and preserves the first undo", async () => {
  const one = proposal("Supplier one", 40),
    two = proposal("Supplier two", 30),
    three = proposal("Supplier three", 20),
    offer = proposal("November shipment");
  const pool = [one, two, three];
  const staleMessage =
    "Suggestion is no longer available. Refresh your suggestions.";
  feed(pool);
  context.mocks.api(feedContract.feedback, ({ params, body, respond }) => {
    return params.id === two.id
      ? respond(409, { error: { code: "CONFLICT", message: staleMessage } })
      : respond(200, { restored: body.kind === "undo" });
  });
  await openDeck();
  click(await findFastControl("button", "Dismiss", await activeCard(one)));
  await screen.findByText("Suggestion dismissed");
  pool.splice(0, pool.length, offer);
  click(await findFastControl("button", "Already done", await activeCard(two)));
  await screen.findByText(
    "That suggestion is no longer available. Suggestions have been refreshed.",
  );
  await expect(activeCard(offer)).resolves.toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(staleMessage)).toBeNull();
  click(await findFastControl("button", "Undo"));
  await expect(activeCard(one)).resolves.toBeVisible();
});

test("agent-suggestions-026 an unavailable card clears its feedback error on retry", async () => {
  const first = proposal("Payment date", 20),
    next = proposal("Freight window");
  const pool = [first, next];
  feed(pool);
  let withdrawn = false;
  context.mocks.api(feedContract.feedback, ({ respond }) => {
    return withdrawn
      ? respond(409, { error: { code: "CONFLICT", message: "Withdrawn" } })
      : respond(503, {
          error: { code: "UNAVAILABLE", message: "Saving failed" },
        });
  });
  await openDeck();
  click(
    await findFastControl("button", "Already done", await activeCard(first)),
  );
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent(first.content.title);
  withdrawn = true;
  pool.splice(0, 1);
  click(await findFastControl("button", "Try again", error));
  await screen.findByText(
    "That suggestion is no longer available. Suggestions have been refreshed.",
  );
  await activeCard(next);
  await waitFor(() => {
    return expect(error).not.toBeInTheDocument();
  });
  expect(screen.queryByText("Noted — this is already done")).toBeNull();
});

test("agent-suggestions-027 feedback on two independent cards can finish in opposite order", async () => {
  const one = proposal("January order", 30),
    two = proposal("February order", 20),
    three = proposal("March order");
  feed([one, two, three]);
  const gate = context.mocks.deferred<void>(),
    started = context.mocks.deferred<void>(),
    undone = context.mocks.deferred<string | null>();
  let original: string | undefined;
  context.mocks.api(
    feedContract.feedback,
    async ({ params, body, respond }) => {
      if (params.id === one.id) {
        if (body.kind === "undo") {
          undone.resolve(body.targetId);
        } else {
          original = body.id;
          started.resolve();
          await gate.promise;
        }
      }
      return respond(200, { restored: body.kind === "undo" });
    },
  );
  await openDeck();
  click(await findFastControl("button", "Not planned", await activeCard(one)));
  try {
    await started.promise;
    click(
      await findFastControl("button", "Already done", await activeCard(two)),
    );
    await expect(activeCard(three)).resolves.toBeVisible();
    await screen.findByText("Noted — this is already done");
  } finally {
    gate.resolve();
  }
  const firstReceipt = await screen.findByText("Noted — this is not planned");
  const toast = firstReceipt.closest<HTMLElement>("[data-sonner-toast]")!;
  click(await findFastControl("button", "Undo", toast));
  await expect(activeCard(one)).resolves.toBeVisible();
  await expect(undone.promise).resolves.toBe(original);
});
