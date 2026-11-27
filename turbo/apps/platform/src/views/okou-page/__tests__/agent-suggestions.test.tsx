import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  feedContract,
  type SuggestionCard,
  type PlatformEvent,
} from "@okouai/api-contracts/contracts/feed";
import {
  act,
  screen,
  within,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
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
import {
  acme,
  design,
  directory,
  switchButton,
  switchMenu,
} from "./switcher-directory-fixture.ts";

const context = testContext();
test("agent-suggestions-039 the empty For you destination reports zero remaining items", async () => {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [] });
  });
  await setupPage({
    context,
    path: "/for-you",
  });
  await screen.findByText("All caught up");
  expect(screen.getByText("0 to go")).toBeInTheDocument();
  expect(location.pathname).toBe("/for-you");
});

function proposal(title: string, priority = 10): SuggestionCard {
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

function feed(items: SuggestionCard[]) {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items });
  });
}

function openDeck(path = "/for-you") {
  return setupPage({ context, path });
}

function activeCard(item: SuggestionCard) {
  return screen.findByRole("article", { name: item.content.title });
}

function swipeCard(card: HTMLElement, direction: "next" | "previous") {
  fireEvent.pointerDown(card, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    clientX: 150,
    clientY: 100,
  });
  fireEvent.pointerUp(card, {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
    clientX: direction === "next" ? 50 : 250,
    clientY: 100,
  });
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

test("agent-suggestions-042 dragging across an option's text selects it instead of choosing it", async () => {
  const base = proposal("Vendor renewals");
  const [prepare] = base.content.options;
  if (!prepare) {
    throw new Error("The proposal fixture has an option");
  }
  const item: SuggestionCard = {
    ...base,
    content: {
      ...base.content,
      options: [
        prepare,
        { ...prepare, id: "summarize", label: "Summarize Vendor renewals" },
      ],
    },
  };
  feed([item]);
  createChatRunFixtures(context).installRunChat();
  const choice = context.mocks.deferred<string | null>();
  context.mocks.api(feedContract.consume, ({ body, respond }) => {
    choice.resolve(body.optionId);
    return respond(200, item);
  });
  await openDeck();
  const card = await activeCard(item);
  const selected = await findFastControl(
    "button",
    "Prepare Vendor renewals",
    card,
  );
  act(() => {
    document
      .getSelection()
      ?.selectAllChildren(
        within(selected).getByText("Prepare Vendor renewals"),
      );
  });
  fireEvent.pointerDown(selected, { button: 0 });
  fireEvent.click(selected, { detail: 1 });
  act(() => {
    document.getSelection()?.removeAllRanges();
  });
  click(await findFastControl("button", "Summarize Vendor renewals", card));

  await expect(choice.promise).resolves.toBe("summarize");
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
  swipeCard(await activeCard(one), "next");
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

test("agent-suggestions-023 undo restores the second suggestion after Won't do", async () => {
  const first = proposal("Produce order", 30),
    second = proposal("Bread order", 20),
    third = proposal("Dairy order", 10);
  feed([first, second, third]);
  context.mocks.api(feedContract.feedback, ({ body, respond }) => {
    return respond(200, { restored: body.kind === "undo" });
  });
  await openDeck();
  await activeCard(first);
  swipeCard(await activeCard(first), "next");
  click(await findFastControl("button", "Won't do", await activeCard(second)));
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
  click(await findFastControl("link", "Okou"));
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
  const homeLink = await findFastControl("link", "Okou");
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
    four = proposal("Supplier four", 15),
    offer = proposal("November shipment");
  const refresh = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let withdrawn = false;
  const staleMessage =
    "Suggestion is no longer available. Refresh your suggestions.";
  context.mocks.api(feedContract.list, async ({ respond }) => {
    if (withdrawn && !refresh.settled()) {
      refresh.resolve();
      await release.promise;
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "Feed unavailable" },
      });
    }
    if (withdrawn) {
      return respond(200, { items: [offer] });
    }
    return respond(200, { items: [one, two, three, four] });
  });
  context.mocks.api(feedContract.feedback, ({ params, body, respond }) => {
    return params.id === two.id
      ? respond(409, { error: { code: "CONFLICT", message: staleMessage } })
      : respond(200, { restored: body.kind === "undo" });
  });
  await openDeck();
  click(await findFastControl("button", "Won't do", await activeCard(one)));
  await screen.findByText("Noted — you won't do this");
  withdrawn = true;
  try {
    click(await findFastControl("button", "Done", await activeCard(two)));
    await refresh.promise;
    await expect(activeCard(three)).resolves.toBeVisible();
    expect(screen.getByText("2 to go")).toBeInTheDocument();
    swipeCard(await activeCard(three), "next");
    await expect(activeCard(four)).resolves.toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "For you" }),
    ).toHaveAttribute("aria-valuenow", "2");
  } finally {
    release.resolve();
  }
  await screen.findByText(
    "That suggestion is no longer available. Suggestions have been refreshed.",
  );
  const alert = await screen.findByRole("alert");
  expect(screen.getByText("2 to go")).toBeInTheDocument();
  swipeCard(await activeCard(four), "previous");
  await expect(activeCard(three)).resolves.toBeVisible();
  click(await findFastControl("button", "Try again", alert));
  await expect(activeCard(offer)).resolves.toBeVisible();
  expect(screen.getByText("1 to go")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(staleMessage)).toBeNull();
  click(await findFastControl("button", "Undo"));
  await expect(activeCard(one)).resolves.toBeVisible();
  expect(screen.getByText("2 to go")).toBeInTheDocument();
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
  click(await findFastControl("button", "Done", await activeCard(first)));
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
  click(await findFastControl("button", "Won't do", await activeCard(one)));
  try {
    await started.promise;
    click(await findFastControl("button", "Done", await activeCard(two)));
    await expect(activeCard(three)).resolves.toBeVisible();
    await screen.findByText("Noted — this is already done");
  } finally {
    gate.resolve();
  }
  const firstReceipt = await screen.findByText("Noted — you won't do this");
  const toast = firstReceipt.closest<HTMLElement>("[data-sonner-toast]")!;
  click(await findFastControl("button", "Undo", toast));
  await expect(activeCard(one)).resolves.toBeVisible();
  await expect(undone.promise).resolves.toBe(original);
});
test("agent-suggestions-037 sending a custom budget instruction leaves the next suggestion on For you", async () => {
  const launch = proposal("Launch plan", 40),
    second = proposal("Revisit estimates", 10);
  feed([launch, second]);
  const wrote = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest: (body) => {
      return wrote.resolve(body.userMessage);
    },
  });
  context.mocks.api(feedContract.consume, ({ respond }) => {
    return respond(200, launch);
  });
  await openDeck();
  click(
    await findFastControl(
      "button",
      "What do you have in mind?",
      await activeCard(launch),
    ),
  );
  const box = await screen.findByRole("region", {
    name: "What do you have in mind?",
  });
  const direction = "Summarize the open budget question first";
  await appendDirection(
    await within(box).findByRole("textbox", { name: /message/i }),
    direction,
  );
  click(
    await waitFor(() => {
      const send = queryFastControl("button", "Send", box);
      if (!send || send.hasAttribute("disabled")) {
        throw new Error("Waiting for custom direction");
      }
      return send;
    }),
  );
  const doc = await wrote.promise;
  expect(JSON.stringify(doc?.parts)).toContain(direction);
  expect(JSON.stringify(doc?.parts)).toContain("Launch plan");
  await expect(activeCard(second)).resolves.toBeVisible();
  expect(location.pathname).toBe("/for-you");
});
test("agent-suggestions-041 declining a suggestion leaves the disabled automation until its own dismissal", async () => {
  const first = proposal("Reconcile vendor credit", 90),
    label = "Renew vendor archive";
  const event: PlatformEvent = {
    id: crypto.randomUUID(),
    priority: 1,
    createdAt: first.createdAt,
    updatedAt: first.updatedAt,
    expiresAt: null,
    type: "event",
    sourceType: "platform-event",
    state: { status: "active" },
    content: {
      eventType: "automation-disabled",
      automationId: crypto.randomUUID(),
      workflowId: crypto.randomUUID(),
      workspaceId: context.resourceId,
      automationName: label,
      disabledAt: first.createdAt,
      consecutiveFailures: 3,
      recoveryScheduled: false,
    },
  };
  let consumed = false,
    dismissed = false;
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, {
      items: [...(consumed ? [] : [first]), ...(dismissed ? [] : [event])],
    });
  });
  context.mocks.api(feedContract.feedback, ({ body, params, respond }) => {
    consumed = params.id === first.id && body.kind === "not_planned";
    return respond(200, { restored: false });
  });
  context.mocks.api(feedContract.dismiss, ({ params, respond }) => {
    dismissed = params.id === event.id;
    return respond(204);
  });
  await openDeck();
  click(await findFastControl("button", "Won't do", await activeCard(first)));
  const title = await screen.findByText(label, { exact: false });
  expect(title).toBeVisible();
  await waitFor(() => {
    return expect(consumed).toBeTruthy();
  });
  click(
    await findFastControl(
      "button",
      "Dismiss",
      title.closest("article") ?? document.body,
    ),
  );
  await screen.findByText("All caught up");
  await waitFor(() => {
    return expect(dismissed).toBeTruthy();
  });
});

test("The For you banner reads the saved artwork again when the member reopens the workspace", async () => {
  const first = createTestRuntime(context);
  context.mocks.data.userPreferences({ forYouCoverId: "cover-05" });
  feed([proposal("Review the support rota")]);
  async function show(runtime: typeof first) {
    await setupPage({
      context: runtime,
      path: "/for-you",
    });
    click(await findFastControl("button", "Change cover"));
    return screen.findByRole("dialog", { name: "Change cover" });
  }
  const picker = within(await show(first));
  await expect(
    picker.findByRole("radio", { name: "Cover 5" }),
  ).resolves.toBeChecked();
  const next = picker.getByRole("radio", { name: "Cover 2" });
  click(next);
  const banner = () => {
    return document.querySelector('[data-slot="for-you-cover"]');
  };
  await waitFor(() => {
    return expect(banner()).toHaveAttribute(
      "src",
      expect.stringContaining("/cover-02-"),
    );
  });
  const artwork = banner()?.getAttribute("src");
  first.dispose();
  cleanup();
  const reopened = within(await show(createTestRuntime(context)));
  await expect(
    reopened.findByRole("radio", { name: "Cover 2" }),
  ).resolves.toBeChecked();
  expect(banner()).toHaveAttribute("src", artwork!);
  const original = reopened.getByRole("radio", { name: "Default Cover 1" });
  click(original);
  await waitFor(() => {
    return expect(banner()).toHaveAttribute(
      "src",
      expect.stringContaining("/cover-01-"),
    );
  });
});
test("A failed cover change leaves the saved artwork and selection available for retry", async () => {
  context.mocks.data.userPreferences({ forYouCoverId: "cover-08" });
  context.mocks.api(userPreferencesContract.update, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Artwork selection was declined",
      },
    });
  });
  feed([proposal("Plan the service visit")]);
  await openDeck();
  click(await findFastControl("button", "Change cover"));
  const chooser = within(
    await screen.findByRole("dialog", { name: "Change cover" }),
  );
  const saved = await chooser.findByRole("radio", { name: "Cover 8" });
  expect(saved).toBeChecked();
  const current = document
    .querySelector('[data-slot="for-you-cover"]')
    ?.getAttribute("src");
  const replacement = chooser.getByRole("radio", { name: "Cover 3" });
  click(replacement);
  await screen.findByText("Artwork selection was declined");
  expect(saved).toBeChecked();
  expect(replacement).toBeEnabled();
  expect(document.querySelector('[data-slot="for-you-cover"]')).toHaveAttribute(
    "src",
    current!,
  );
});

test("A previously visited suggestion becomes available again after its fresh feed arrives", async () => {
  const first = createTestRuntime(context);
  const saved = proposal("Harbor budget review");
  const loading = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let reopening = false;
  context.mocks.api(feedContract.list, async ({ respond }) => {
    if (reopening) {
      if (!loading.settled()) {
        loading.resolve();
      }
      await release.promise;
    }
    return respond(200, { items: [saved] });
  });
  await setupPage({ context: first, path: "/for-you" });
  await activeCard(saved);
  cleanup();
  first.dispose();
  reopening = true;
  try {
    await openDeck("/");
    click(await findFastControl("link", /For you/));
    await loading.promise;
    expect(location.pathname).toBe("/for-you");
    expect(
      screen.queryByRole("article", { name: saved.content.title }),
    ).not.toBeInTheDocument();
  } finally {
    release.resolve();
  }
  await expect(activeCard(saved)).resolves.toBeInTheDocument();
});

test.each([
  ["agent-suggestions-011", 409],
  ["Rejected consume control", 503],
] as const)(
  "%s A loaded option sends its draft when the unavailable suggestion returns %i",
  async (_label, status) => {
    const item = proposal("Harbor permits");
    const pool = [item];
    feed(pool);
    const sent = context.mocks.deferred<string>();
    createChatRunFixtures(context).installRunChat({
      onSendRequest: ({ prompt }) => {
        return sent.resolve(prompt);
      },
    });
    const release = context.mocks.deferred<void>();
    const decoded = context.mocks.deferred<void>();
    const marker = "Another reviewer handled " + item.id;
    const read = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(async function (
      this: Response,
    ) {
      const body: unknown = await read.call(this);
      if (
        this.status === status &&
        JSON.stringify(body).includes(marker) &&
        !decoded.settled()
      ) {
        decoded.resolve();
      }
      return body;
    });
    const receipt = context.mocks.deferred<void>();
    context.mocks.api(feedContract.consume, async ({ respond }) => {
      receipt.resolve();
      await release.promise;
      return status === 409
        ? respond(409, {
            error: { code: "CONFLICT", message: marker },
          })
        : respond(503, {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: marker,
            },
          });
    });
    await openDeck();
    const choose = await findFastControl(
      "button",
      "Prepare Harbor permits",
      await activeCard(item),
    );
    pool.splice(0);
    click(choose);
    await expect(sent.promise).resolves.toBe("Draft Harbor permits");
    await receipt.promise;
    await screen.findByText("All caught up");
    expect(location.pathname).toBe("/for-you");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      release.resolve();
      await decoded.promise;
    });
    if (status === 503) {
      await screen.findByRole("alert");
    }
    expect(location.pathname).toBe("/for-you");
    expect(screen.queryAllByRole("alert")).toHaveLength(status === 503 ? 1 : 0);
  },
);

function prefetchReadSummary(firstItem: SuggestionCard | null) {
  const bootstrap = document.createElement("script");
  bootstrap.type = "application/json";
  bootstrap.dataset.okouApiBootstrap = "";
  bootstrap.dataset.method = feedContract.summary.method;
  bootstrap.dataset.path = encodeURIComponent(feedContract.summary.path);
  bootstrap.dataset.contentType = "application/json";
  bootstrap.textContent = JSON.stringify({
    hasUnread: false,
    firstItem,
  });
  document.head.append(bootstrap);
  context.signal.addEventListener(
    "abort",
    () => {
      bootstrap.remove();
    },
    { once: true },
  );
}

test("The For you entry shows a prefetched read card and follows live feed changes", async () => {
  const first = proposal("Check the harbor lights");
  prefetchReadSummary(first);
  let current: SuggestionCard | null = null;
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: current !== null, firstItem: current });
  });
  await setupPage({
    context,
    path: "/",
    featureSwitches: { [FeatureSwitchKey.HideEmptyForYou]: true },
  });
  const row = await findFastControl("link", /For you/);
  expect(within(row).queryByText("Unread")).toBeNull();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("agentSuggestionsChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("agentSuggestionsChanged");
  await waitFor(() => {
    expect(queryFastControl("link", /For you/)).toBeNull();
  });
  current = proposal("Inspect the new ferry");
  context.mocks.ably.trigger("agentSuggestionsChanged");
  const restored = await findFastControl("link", /For you/);
  await expect(
    within(restored).findByText("Unread"),
  ).resolves.toBeInTheDocument();
});

test("A delivery before the mobile chat list opens supersedes its unused Worker summary", async () => {
  context.mocks.browser.matchMedia(() => {
    return false;
  });
  createChatRunFixtures(context).installRunChat();
  prefetchReadSummary(null);
  const card = proposal("Review the ferry alert");
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: true, firstItem: card });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/chats/${RUN_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.HideEmptyForYou]: true },
  });
  const back = await findFastControl("link", "Back to chats");
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("agentSuggestionsChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("agentSuggestionsChanged");
  click(back);
  const row = await findFastControl("link", /For you/);
  await expect(within(row).findByText("Unread")).resolves.toBeInTheDocument();
});

test("Opening For you during a live summary refresh uses the fresh list even if the summary arrives later", async () => {
  const earlier = proposal("Survey the north quay");
  const later = proposal("Inspect the south pier");
  const refresh = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const markRead = context.mocks.deferred<void>();
  let summaryReads = 0;
  let listReads = 0;
  context.mocks.api(feedContract.summary, async ({ respond }) => {
    summaryReads++;
    if (summaryReads === 2) {
      refresh.resolve();
      await release.promise;
    }
    return respond(200, { hasUnread: summaryReads === 1, firstItem: earlier });
  });
  context.mocks.api(feedContract.list, ({ respond }) => {
    listReads++;
    return respond(200, { items: [later] });
  });
  context.mocks.api(feedContract.markRead, async ({ respond }) => {
    await markRead.promise;
    return respond(200, { readAt: nowDate().toISOString() });
  });
  try {
    await openDeck("/");
    const row = await findFastControl("link", /For you/);
    await within(row).findByText("Unread");
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("agentSuggestionsChanged"),
      ).toBeTruthy();
    });
    expect(summaryReads).toBe(1);
    context.mocks.ably.trigger("agentSuggestionsChanged");
    await refresh.promise;
    expect(listReads).toBe(0);
    click(row);
    await expect(activeCard(later)).resolves.toBeVisible();
    expect(listReads).toBe(1);
    release.resolve();
    await waitFor(() => {
      expect(within(row).queryByText("Unread")).toBeNull();
    });
    expect(
      screen.queryByRole("article", { name: earlier.content.title }),
    ).toBeNull();
    await expect(activeCard(later)).resolves.toBeVisible();
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
    markRead.resolve();
  }
});

test("agent-suggestions-022 revised inline direction sends the card file while the home attachment stays with its draft", async () => {
  const card = proposal("Inspect supplier terms");
  const homeFile = {
    id: crypto.randomUUID(),
    filename: "personal-note.txt",
    contentType: "text/plain",
    size: 4,
    url: "https://files.example.test/home-note",
  };
  const cardFile = {
    ...homeFile,
    id: crypto.randomUUID(),
    filename: "supplier-terms.txt",
    url: "https://files.example.test/supplier-terms",
  };
  card.content.customOption.draft.draftAttachments = [cardFile];
  feed([card]);
  context.mocks.upload.success(homeFile);
  const created = context.mocks.deferred<string | undefined>();
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    onThreadCreate: ({ title }) => {
      created.resolve(title);
    },
    onSendRequest: ({ userMessage }) => {
      sent.resolve(userMessage);
    },
  });
  context.mocks.api(feedContract.consume, ({ respond }) => {
    return respond(200, card);
  });
  await openDeck("/");
  const homeText = "Keep for my own review";
  await fill(
    await screen.findByRole("textbox", { name: /message/i }),
    homeText,
  );
  const picker = await screen.findByLabelText("Attach", {
    selector: 'input[type="file"]',
  });
  await userEvent.upload(
    picker,
    new File(["home"], homeFile.filename, { type: homeFile.contentType }),
  );
  await findFastControl("button", "Remove " + homeFile.filename);
  click(await findFastControl("link", /For you/));
  click(
    await findFastControl(
      "button",
      "What do you have in mind?",
      await activeCard(card),
    ),
  );
  const inline = await screen.findByRole("region", {
    name: "What do you have in mind?",
  });
  const direction = "Find the notice period";
  await appendDirection(
    await within(inline).findByRole("textbox", { name: /message/i }),
    direction,
  );
  const send = await findFastControl("button", "Send", inline);
  await waitFor(() => {
    expect(send).toBeEnabled();
  });
  click(send);
  await screen.findByText("Sent to a new chat");
  await expect(created.promise).resolves.toBe(card.content.title);
  const message = await sent.promise;
  const files = message?.parts.filter((part) => {
    return part.type === "file";
  });
  expect(files).toStrictEqual([
    expect.objectContaining({
      fileId: cardFile.id,
      filenameSnapshot: cardFile.filename,
    }),
  ]);
  const document = JSON.stringify(message);
  expect(document).toContain(direction);
  expect(document).not.toContain(homeFile.id);
  expect(document).not.toContain(homeText);
  expect(location.pathname).toBe("/for-you");
  click(await findFastControl("link", "Okou"));
  await findFastControl("button", "Remove " + homeFile.filename);
  await expect(
    screen.findByRole("textbox", { name: /message/i }),
  ).resolves.toHaveTextContent(homeText);
});

test("agent-suggestions-007 a member returning to For you sees only the selected workspace's card", async () => {
  const first = proposal("Reserve the Acme lab");
  const second = proposal("Review the design proofs");
  const feeds = new Map([
    [`Bearer ${acme.id}`, first],
    [`Bearer ${design.id}`, second],
  ]);
  context.mocks.api(feedContract.list, ({ request, respond }) => {
    const card = feeds.get(request.headers.get("authorization") ?? "");
    if (!card) {
      throw new Error("The feed request has no workspace credential");
    }
    return respond(200, { items: [card] });
  });
  await directory(context, () => {
    return Promise.resolve();
  });

  click(await findFastControl("link", /For you/));
  await expect(activeCard(first)).resolves.toBeVisible();
  expect(
    screen.queryByRole("article", { name: second.content.title }),
  ).toBeNull();

  click(await findFastControl("link", "Workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  const menu = await switchMenu();
  click(within(menu).getByText(design.name));
  await expect(
    within(await switchButton()).findByRole("img", { name: design.name }),
  ).resolves.toBeInTheDocument();

  click(await findFastControl("link", /For you/));
  await expect(activeCard(second)).resolves.toBeVisible();
  expect(
    screen.queryByRole("article", { name: first.content.title }),
  ).toBeNull();
});

test("agent-suggestions-012 a suggested dispatch goes into the running conversation with its source link", async () => {
  const target = RUN_THREAD_ID;
  const runId = crypto.randomUUID();
  const reference = {
    type: "chat_thread" as const,
    threadId: target,
    titleSnapshot: "Dispatch archive",
  };
  const suggestion = proposal("Schedule a dispatch");
  const action = suggestion.content.options[0]!;
  action.threadId = target;
  action.draft.draftUserMessage!.parts.push(reference);
  feed([suggestion]);
  context.mocks.api(feedContract.consume, ({ respond }) => {
    return respond(200, suggestion);
  });
  const queued = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    threadId: target,
    activeRunIds: [runId],
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        seqId: 1,
        runId,
        text: "Prepare today's shipping manifest",
      }),
    ],
    onQueuedEventAppend: ({ userMessage }) => {
      return queued.resolve(userMessage);
    },
  });

  await openDeck();
  click(
    await findFastControl("button", action.label, await activeCard(suggestion)),
  );
  const composer = await screen.findByRole("textbox", { name: /message/i });
  await waitFor(() => {
    expect(composer).toHaveTextContent("Draft Schedule a dispatch");
    expect(composer).toHaveTextContent(reference.titleSnapshot);
  });
  expect(location.pathname).toBe("/chats/" + target);
  await screen.findByText("Prepare today's shipping manifest");
  const send = await findFastControl("button", "Send");
  await waitFor(() => {
    return expect(send).toBeEnabled();
  });
  click(send);
  await expect(queued.promise).resolves.toMatchObject({
    parts: [{ type: "text", text: "Draft Schedule a dispatch" }, reference],
  });
  await screen.findByText("Draft Schedule a dispatch");
  expect(composer).not.toHaveTextContent("Draft Schedule a dispatch");
});

test("agent-suggestions-013 the new conversation keeps the displayed option after the server returns a changed destination", async () => {
  const loaded = proposal("Confirm the Baltic crossing");
  const alternate = crypto.randomUUID();
  const source = {
    type: "chat_thread" as const,
    threadId: alternate,
    titleSnapshot: "Dispatch archive",
  };
  loaded.content.options[0]!.draft.draftUserMessage!.parts.push(source);
  const later = structuredClone(loaded);
  const changed = later.content.options[0]!;
  changed.threadId = alternate;
  changed.draft.draftUserMessage = {
    version: 1,
    parts: [{ type: "text", text: "Divert the shipment to Oslo" }],
  };
  later.state = {
    ...later.state,
    status: "consumed",
    selectedOptionId: changed.id,
  };
  feed([loaded]);

  const consumed = context.mocks.deferred<unknown>();
  const read = Response.prototype.json;
  vi.spyOn(Response.prototype, "json").mockImplementation(async function (
    this: Response,
  ) {
    const result: unknown = await read.call(this);
    if (
      this.ok &&
      this.url.endsWith(`/api/feed/items/${loaded.id}/suggestion/consume`)
    ) {
      consumed.resolve(result);
    }
    return result;
  });
  context.mocks.api(feedContract.consume, ({ respond }) => {
    return respond(200, later);
  });
  const created = context.mocks.deferred<string | undefined>();
  const submitted = context.mocks.deferred<{
    thread?: string;
    message?: UserMessageDocument;
  }>();
  createChatRunFixtures(context).installRunChat({
    onThreadCreate: ({ clientThreadId }) => {
      return created.resolve(clientThreadId);
    },
    onSendRequest: ({ clientThreadId, threadId, userMessage }) => {
      return submitted.resolve({
        thread: clientThreadId ?? threadId,
        message: userMessage,
      });
    },
  });

  await openDeck();
  const choice = await findFastControl(
    "button",
    loaded.content.options[0]!.label,
    await activeCard(loaded),
  );
  click(choice);
  await expect(consumed.promise).resolves.toMatchObject({
    id: loaded.id,
    content: { options: [changed] },
  });
  await screen.findByText("All caught up");
  const { thread, message } = await submitted.promise;
  expect(message?.parts).toStrictEqual([
    { type: "text", text: "Draft Confirm the Baltic crossing" },
    source,
  ]);
  expect(thread).toBeTruthy();
  expect(thread).not.toBe(alternate);
  await expect(created.promise).resolves.toBe(thread);
  await screen.findByText("Sent to a new chat");
  expect(location.pathname).toBe("/for-you");
});

test("For you keeps the first and second cards in order when the model list is empty", async () => {
  const first = proposal("Tidal survey", 20);
  const second = proposal("Harbor lights", 10);
  feed([first, second]);
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, { models: [] });
  });

  await openDeck();
  const choose = await findFastControl(
    "button",
    "Prepare Tidal survey",
    await activeCard(first),
  );
  click(choose);
  await screen.findByText("The selected model is not available");
  await activeCard(first);
  swipeCard(await activeCard(first), "next");
  await activeCard(second);
  swipeCard(await activeCard(second), "previous");
  await expect(activeCard(first)).resolves.toBeInTheDocument();
});

test("agent-suggestions-015 a member with only built-in Auto can send the first of two suggestions", async () => {
  const first = proposal("Reconcile bore samples", 20);
  const second = proposal("Compare field maps", 10);
  feed([first, second]);
  const sent = context.mocks.deferred<string>();
  createChatRunFixtures(context).installRunChat({
    onSendRequest: ({ prompt }) => {
      return sent.resolve(prompt);
    },
  });
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, {
      models: [
        {
          model: "auto",
          modelLabel: "Auto",
          modelProviderId: null,
          memberEffective: {
            providerType: "built-in",
            runtimeProviderType: "openrouter-codex",
            credentialScope: "org",
            availability: "available",
            accountSelection: "not_applicable",
          },
        },
      ],
    });
  });
  await openDeck();
  click(
    await findFastControl(
      "button",
      "Prepare Reconcile bore samples",
      await activeCard(first),
    ),
  );
  await expect(sent.promise).resolves.toContain("Reconcile bore samples");
  await expect(
    screen.findByText("Sent to a new chat"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("The selected model is not available")).toBeNull();
  await expect(activeCard(second)).resolves.toBeVisible();
});

test("Opening For you shows the summary card and keeps its draft and read receipt when the list arrives", async () => {
  const first = proposal("Visit the eastern breakwater");
  const second = proposal("Review the ferry timetable", 20);
  const revised = {
    ...proposal("A revised breakwater plan", first.priority),
    id: first.id,
    createdAt: first.createdAt,
  };
  const release = context.mocks.deferred<void>();
  const reads: string[] = [];
  let listReads = 0;
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: true, firstItem: first });
  });
  context.mocks.api(feedContract.list, async ({ respond }) => {
    listReads++;
    await release.promise;
    return respond(200, { items: [second, revised] });
  });
  context.mocks.api(feedContract.markRead, ({ params, respond }) => {
    reads.push(params.id);
    return respond(200, { readAt: nowDate().toISOString() });
  });
  try {
    await openDeck("/");
    const row = await findFastControl("link", /For you/);
    await within(row).findByText("Unread");
    expect(listReads).toBe(0);
    expect(reads).toHaveLength(0);
    click(row);
    const card = await activeCard(first);
    click(await findFastControl("button", "What do you have in mind?", card));
    const editor = await screen.findByRole("textbox", { name: /message/i });
    await appendDirection(editor, "Check the tide");
    expect(listReads).toBe(1);
    expect(screen.queryByText(/\d+ to go/u)).toBeNull();
    expect(screen.queryByRole("progressbar", { name: "For you" })).toBeNull();
    expect(
      document.querySelector('[data-slot="suggestion-stack-layer"]'),
    ).toBeNull();
    expect(screen.queryByText("All caught up")).toBeNull();
  } finally {
    release.resolve();
  }
  const progress = await screen.findByRole("progressbar", { name: "For you" });
  expect(progress).toHaveAttribute("aria-valuenow", "2");
  expect(progress).toHaveAttribute("aria-valuemax", "2");
  expect(screen.getByText("2 to go")).toBeInTheDocument();

  expect(
    document.querySelectorAll('[data-slot="suggestion-stack-layer"]'),
  ).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: /message/i })).toHaveTextContent(
    "Check the tide",
  );
  expect(reads).toStrictEqual([first.id]);
  await expect(activeCard(first)).resolves.toBeVisible();
});

test("The full list updates an untouched preview when the same suggestion is revised", async () => {
  const preview = proposal("Confirm the morning sailing");
  const revised = {
    ...proposal("Confirm the evening sailing"),
    id: preview.id,
    createdAt: preview.createdAt,
    updatedAt: new Date(Date.parse(preview.updatedAt) + 1).toISOString(),
  };
  const release = context.mocks.deferred<void>();
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: true, firstItem: preview });
  });
  context.mocks.api(feedContract.list, async ({ respond }) => {
    await release.promise;
    return respond(200, { items: [revised] });
  });
  try {
    await openDeck();
    await expect(activeCard(preview)).resolves.toBeVisible();
  } finally {
    release.resolve();
  }
  const card = await activeCard(revised);
  await expect(
    findFastControl("button", "Prepare Confirm the evening sailing", card),
  ).resolves.toBeEnabled();
});

test("Retrying a failed list preserves feedback and Undo from the preview", async () => {
  const first = proposal("Review the bridge inspection");
  const next = proposal("Confirm the ferry slot", 1);
  const release = context.mocks.deferred<void>();
  let attempts = 0;
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: true, firstItem: first });
  });
  context.mocks.api(feedContract.list, async ({ respond }) => {
    attempts++;
    if (attempts === 1) {
      await release.promise;
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "Feed unavailable" },
      });
    }
    return respond(200, { items: [next] });
  });
  context.mocks.api(feedContract.feedback, ({ body, respond }) => {
    return respond(200, { restored: body.kind === "undo" });
  });
  try {
    await openDeck();
    click(await findFastControl("button", "Done", await activeCard(first)));
    await findFastControl("button", "Undo");
    expect(screen.queryByText("All caught up")).toBeNull();
  } finally {
    release.resolve();
  }
  const alert = await screen.findByRole("alert");
  click(await findFastControl("button", "Try again", alert));
  await activeCard(next);
  click(await findFastControl("button", "Undo"));
  await expect(activeCard(first)).resolves.toBeVisible();
  expect(attempts).toBe(2);
});

async function openDirectLinkPastFirstPage() {
  const preview = proposal("Review the eastern breakwater");
  const target = proposal("Review the western breakwater", 1);
  const firstPage = [
    preview,
    ...Array.from({ length: 9 }, (_, index) => {
      return proposal("Review berth " + String(index + 1), 5);
    }),
  ];
  const release = context.mocks.deferred<void>();
  const nextPage = context.mocks.deferred<void>();
  const reads: string[] = [];
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: true, firstItem: preview });
  });
  context.mocks.api(feedContract.list, async ({ query, respond }) => {
    if (!query.cursor) {
      return respond(200, { items: firstPage, nextCursor: "second-page" });
    }
    nextPage.resolve();
    await release.promise;
    return respond(200, { items: [target] });
  });
  context.mocks.api(feedContract.markRead, ({ params, respond }) => {
    reads.push(params.id);
    return respond(200, { readAt: nowDate().toISOString() });
  });
  try {
    await openDeck("/for-you?suggestion=" + target.id);
    await nextPage.promise;
    expect(reads).toHaveLength(0);
    expect(screen.queryByRole("progressbar", { name: "For you" })).toBeNull();
    expect(
      screen.queryByRole("article", { name: preview.content.title }),
    ).toBeNull();
  } finally {
    release.resolve();
  }
  await expect(activeCard(target)).resolves.toBeVisible();
  return { reads, target };
}

test("A direct link reads its card on the next page without displaying the summary card", async () => {
  const { reads, target } = await openDirectLinkPastFirstPage();
  const progress = await screen.findByRole("progressbar", {
    name: "For you",
  });
  expect(progress).toHaveAttribute("aria-valuenow", "11");
  expect(progress).toHaveAttribute("aria-valuemax", "11");
  // The bar draws a seven-step window around the current card.
  expect(progress.children).toHaveLength(7);
  expect(
    document.querySelectorAll('[data-slot="suggestion-stack-layer"]'),
  ).toHaveLength(2);
  await waitFor(() => {
    expect(reads).toStrictEqual([target.id]);
  });
});

test("Arrow keys page the deck without arrow controls, except while a direction is written", async () => {
  const one = proposal("Supply forecast");
  const two = proposal("Packing list", 1);
  const three = proposal("Freight quote", 0);
  feed([one, two, three]);
  await openDeck();
  await activeCard(one);
  const user = userEvent.setup({ delay: null });
  const progress = await screen.findByRole("progressbar", { name: "For you" });
  expect(progress).toHaveAttribute("aria-valuenow", "1");
  expect(progress).toHaveAttribute("aria-valuemax", "3");
  click(progress);
  expect(progress).toHaveAttribute("aria-valuenow", "1");
  await expect(activeCard(one)).resolves.toBeInTheDocument();

  await user.keyboard("{ArrowRight}");
  await activeCard(two);
  await user.keyboard("{ArrowLeft}");
  await activeCard(one);
  // Paging wraps round at either end.
  await user.keyboard("{ArrowLeft}");
  const card = await activeCard(three);

  click(await findFastControl("button", "What do you have in mind?", card));
  const region = await screen.findByRole("region", {
    name: "What do you have in mind?",
  });
  const edit = await within(region).findByRole("textbox", { name: /message/i });
  await appendDirection(edit, "Expedite shipping");
  await user.keyboard("{ArrowLeft}");
  // Focus on another control keeps the direction open, so the keys still wait.
  const done = await findFastControl("button", "Done", card);
  act(() => {
    done.focus();
  });
  expect(done).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  await appendDirection(edit, " today");

  expect(edit).toHaveTextContent("Expedite shipping today");
  await expect(activeCard(three)).resolves.toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "For you" })).toHaveAttribute(
    "aria-valuenow",
    "3",
  );
});
