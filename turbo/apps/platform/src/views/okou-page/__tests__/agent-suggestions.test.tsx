import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  suggestionsContract,
  type Suggestion,
  type SuggestionOption,
} from "@okouai/api-contracts/contracts/suggestions";
import {
  chatEventsContract,
  chatThreadDraftContract,
  chatThreadMetadataContract,
  chatThreadByIdContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  agentsMainContract,
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  draftAttachment,
  mockPrivateUrlSequence,
} from "./chat-attachment-test-helpers.ts";
import { nowDate } from "../../../lib/time.ts";

const context = testContext();
const agentId = "c0000000-0000-4000-a000-000000000001";
const threadId = "b0000000-0000-4000-a000-000000000811";
function makeSuggestion(): Suggestion {
  const timestamp = nowDate().toISOString();
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    title: "Review the pending decision",
    rationale: "A response is needed",
    priority: 20,
    feedbacks: [],
    status: "active",
    selectedOptionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    customOption: {
      id: "custom",
      threadId: null,
      draft: {
        draftUserMessage: {
          version: 1,
          parts: [
            {
              type: "feedback",
              quote:
                "Launch background: source launch-plan-v2. Budget and owner are not confirmed.",
              note: [],
            },
          ],
        },
        draftAttachments: null,
      },
    },
    options: [makeOption()],
  };
}
function makeOption(
  overrides: Partial<SuggestionOption> = {},
): SuggestionOption {
  return {
    id: "review",
    label: "Review decision",
    description: "Review the context and prepare the next step",
    threadId: null,
    draft: {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Review the pending decision in " },
          {
            type: "chat_thread",
            threadId,
            titleSnapshot: "Referenced decision",
          },
        ],
      },
      draftAttachments: null,
    },
    ...overrides,
  };
}
function button(
  name: string,
  role: "button" | "tab" = "button",
  container: ParentNode = document.body,
) {
  const found = queryAllByRoleFast(role, container).find((element) => {
    return (
      element.textContent?.trim().startsWith(name) ||
      element.getAttribute("aria-label") === name
    );
  });
  if (!found) {
    throw new Error(
      `Missing ${role}: ${name}; available: ${queryAllByRoleFast(
        role,
        container,
      )
        .map((element) => {
          return element.textContent;
        })
        .join(" | ")}`,
    );
  }
  return found;
}
function composer() {
  const node = document.querySelector(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!(node instanceof HTMLElement)) {
    throw new Error("Missing composer");
  }
  return node;
}
function queryLink(href: string) {
  return (
    queryAllByRoleFast("link").find((element) => {
      return element.getAttribute("href") === href;
    }) ?? null
  );
}
function link(href: string) {
  const found = queryLink(href);
  if (!found) {
    throw new Error(`Missing link: ${href}`);
  }
  return found;
}

const SUGGESTIONS_TOPIC = "agentSuggestionsChanged";

// The API publishes every committed suggestion change.
function notifySuggestionsChanged(): void {
  context.mocks.ably.trigger(SUGGESTIONS_TOPIC);
}

function mockPool(initial: Suggestion[] = [makeSuggestion()]) {
  let items = initial;
  const retired = new Map<string, Suggestion>();
  const consumed: string[] = [];
  const selections: { id: string; optionId: string | null }[] = [];
  context.mocks.api(
    suggestionsContract.feedback,
    ({ params, body, respond }) => {
      if (body.kind === "undo") {
        const saved = retired.get(params.id);
        if (saved) {
          items = [...items, saved];
          notifySuggestionsChanged();
        }
        return respond(200, { restored: saved !== undefined });
      }
      if (body.kind === "reason") {
        return respond(200, { restored: false });
      }
      const found = items.find((item) => {
        return item.id === params.id;
      });
      if (!found) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Already consumed" },
        });
      }
      retired.set(params.id, found);
      consumed.push(params.id);
      selections.push({ id: params.id, optionId: null });
      items = items.filter((item) => {
        return item.id !== params.id;
      });
      notifySuggestionsChanged();
      return respond(200, { restored: false });
    },
  );
  context.mocks.api(suggestionsContract.list, ({ respond }) => {
    return respond(200, { suggestions: items });
  });
  context.mocks.api(
    suggestionsContract.consume,
    ({ params, body, respond }) => {
      const found = items.find((entry) => {
        return entry.id === params.id;
      });
      if (
        !found ||
        (body.optionId !== null &&
          !found.options.some((option) => {
            return option.id === body.optionId;
          }))
      ) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Already consumed" },
        });
      }
      consumed.push(params.id);
      selections.push({ id: params.id, optionId: body.optionId });
      items = items.filter((entry) => {
        return entry.id !== params.id;
      });
      notifySuggestionsChanged();
      return respond(200, {
        ...found,
        status: "consumed",
        selectedOptionId: body.optionId,
      });
    },
  );
  return {
    consumed,
    selections,
    publish: (item: Suggestion) => {
      items = [...items, item];
    },
    withdrawAll: () => {
      items = [];
    },
  };
}
const features = {
  [FeatureSwitchKey.AgentSuggestion]: true,
  [FeatureSwitchKey.ProactiveLearning]: false,
} as const;
const homePath = `/agents/${agentId}/chat`;
const EMPTY_FEED = "You’re all caught up";

async function openFeed(): Promise<void> {
  await setupPage({ context, path: "/feed", featureSwitches: features });
}
// The Feed has no composer, so a home draft is written first and the Feed is
// opened through its sidebar entry.
async function openFeedFromHome(draft: string): Promise<void> {
  await setupPage({ context, path: homePath, featureSwitches: features });
  await fill(composer(), draft);
  click(link("/feed"));
}
const SENT = "Sent to a new chat";
const MESSAGE_SENT = "Message sent";
const REFERENCED_THREAD = {
  type: "chat_thread",
  threadId,
  titleSnapshot: "Referenced decision",
} as const;
interface SentInput {
  readonly threadId?: string;
  readonly userMessage?: UserMessageDocument;
}
// Resolves with the chat input the Feed sends while the page stays in place.
function captureSend(): Promise<SentInput> {
  const sent = context.mocks.deferred<SentInput>();
  mockChatLifecycle(context, {
    onSendRequest: ({ threadId: sentThreadId, userMessage }) => {
      if (!sent.settled()) {
        sent.resolve({ threadId: sentThreadId, userMessage });
      }
    },
  });
  return sent.promise;
}
async function openCustomDirection(
  container: ParentNode = document.body,
): Promise<{ dialog: HTMLElement; note: HTMLElement }> {
  click(button("I’d like to…", "button", container));
  const dialog = await screen.findByRole("dialog");
  const note = await within(dialog).findByRole("textbox", {
    name: "What do you have in mind?",
  });
  return { dialog, note };
}
async function writeDirection(note: HTMLElement, text: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(note);
  await user.keyboard(text);
}

test("A cached card still sends its action after server cleanup", async () => {
  const suggestion = { ...makeSuggestion(), consumeToken: "a".repeat(64) };
  const pool = mockPool([suggestion]);
  const consumedWith = context.mocks.deferred<string | undefined>();
  context.mocks.api(suggestionsContract.consume, ({ body, respond }) => {
    if (!consumedWith.settled()) {
      consumedWith.resolve(body.snapshot?.consumeToken);
    }
    if (body.snapshot?.consumeToken !== suggestion.consumeToken) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Unavailable" },
      });
    }
    return respond(200, {
      ...suggestion,
      status: "consumed",
      selectedOptionId: body.optionId,
    });
  });
  const sent = captureSend();
  await openFeed();
  await screen.findByText(suggestion.title);
  pool.withdrawAll();
  click(button(makeOption().label));
  await screen.findByText(SENT);
  expect((await sent).userMessage?.parts).toContainEqual(REFERENCED_THREAD);
  await expect(consumedWith.promise).resolves.toBe(suggestion.consumeToken);
  expect(pathname()).toBe("/feed");
});

test("The Okou row leads the chat list, counts waiting cards and opens the Feed", async () => {
  mockPool(numberedSuggestions(2));
  await setupPage({ context, path: homePath, featureSwitches: features });
  const row = await waitFor(() => {
    return link("/feed");
  });
  expect(row).toHaveTextContent(/^Okou/);
  await within(row).findByText("2 waiting");
  expect(
    within(screen.getByTestId("labeled-nav-rail")).queryByRole("link", {
      name: "Feed",
    }),
  ).not.toBeInTheDocument();
  expect(
    within(screen.getByTestId("chat-list-column")).getByRole("link", {
      name: /^Okou/,
    }),
  ).toBe(row);

  click(row);
  await screen.findByText("Suggested action 1");
  expect(pathname()).toBe("/feed");
  expect(link("/feed")).toHaveAttribute("aria-current", "page");
});

test("The Okou row's count follows committed suggestion changes", async () => {
  const pool = mockPool(numberedSuggestions(2));
  await openFeed();
  await within(link("/feed")).findByText("2 waiting");

  click(button("Dismiss"));
  await within(link("/feed")).findByText("1 waiting");

  pool.publish(numberedSuggestions(3)[2]);
  notifySuggestionsChanged();
  await within(link("/feed")).findByText("2 waiting");

  pool.withdrawAll();
  notifySuggestionsChanged();
  await waitFor(() => {
    expect(within(link("/feed")).queryByText(/waiting$/)).toBeNull();
  });
  expect(link("/feed")).toHaveTextContent(/^Okou$/);
});

test("Each Feed visit loads new suggestions and an empty pool says so", async () => {
  const pool = mockPool([]);
  await openFeed();
  await screen.findByText(EMPTY_FEED);
  click(link("/agents"));
  await screen.findByRole("heading", { name: "Agents" });

  pool.publish(makeSuggestion());
  click(link("/feed"));
  await screen.findByText(makeSuggestion().title);
  expect(screen.queryByText(EMPTY_FEED)).not.toBeInTheDocument();
});
test("Choosing an action sends it to a new thread and keeps the Feed and the home draft", async () => {
  const selected = makeOption({ id: "prepare", label: "Prepare response" });
  const suggestion = {
    ...makeSuggestion(),
    options: [
      makeOption({
        draft: {
          draftUserMessage: {
            version: 1 as const,
            parts: [{ type: "text" as const, text: "Unselected action" }],
          },
          draftAttachments: null,
        },
      }),
      selected,
      makeOption({ id: "summarize", label: "Summarize the decision" }),
    ],
  };
  const next = {
    ...makeSuggestion(),
    id: "a0000000-0000-4000-a000-000000000002",
    title: "Review the budget",
  };
  const pool = mockPool([suggestion, next]);
  const sent = captureSend();
  await openFeedFromHome("My original draft");
  await screen.findByText(suggestion.title);
  expect(button("Review decision")).toBeInTheDocument();
  expect(button("Summarize the decision")).toBeInTheDocument();
  click(button(selected.label));
  await screen.findByText(SENT);
  expect(pathname()).toBe("/feed");
  expect(feedItemLabels()).toStrictEqual([next.title, MESSAGE_SENT]);
  await waitFor(() => {
    expect(pool.selections).toStrictEqual([
      { id: suggestion.id, optionId: selected.id },
    ]);
  });
  const { threadId: sentThreadId, userMessage: message } = await sent;
  expect(openChatLink()).toHaveAttribute("href", `/chats/${sentThreadId}`);
  expect(message?.parts).toContainEqual(REFERENCED_THREAD);
  expect(JSON.stringify(message)).not.toContain("Unselected action");
  click(link(homePath));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("My original draft");
  });
  expect(composer()).not.toHaveTextContent("Referenced decision");
});

test("An existing-thread suggestion merges its content and attachments with the remote draft", async () => {
  const incoming = draftAttachment("suggested.txt", {
    id: "a0000000-0000-4000-a000-000000000081",
    contentType: "text/plain",
  });
  const original = draftAttachment("original.txt", {
    id: "a0000000-0000-4000-a000-000000000082",
    contentType: "text/plain",
  });
  const suggestion: Suggestion = {
    ...makeSuggestion(),
    options: [
      makeOption({
        threadId,
        draft: {
          draftUserMessage: {
            version: 1,
            parts: [
              ...(makeOption().draft.draftUserMessage?.parts ?? []),
              {
                type: "file",
                fileId: incoming.id,
                filenameSnapshot: incoming.filename,
                contentType: incoming.contentType,
              },
            ],
          },
          draftAttachments: [incoming],
        },
      }),
    ],
  };
  mockPool([suggestion]);
  const sends: UserMessageDocument[] = [];
  mockPrivateUrlSequence(context, {
    [incoming.id]: [incoming.url],
    [original.id]: [original.url],
  });
  mockChatLifecycle(context, {
    threadId,
    onSendRequest: ({ userMessage }) => {
      if (userMessage) {
        sends.push(userMessage);
      }
    },
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Existing remote draft" },
          {
            type: "file",
            fileId: original.id,
            filenameSnapshot: original.filename,
            contentType: original.contentType,
          },
        ],
      },
      draftAttachments: [original],
    });
  });
  await openFeed();
  await screen.findByText(makeSuggestion().title);
  click(button(makeOption().label));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threadId}`);
    expect(composer()).toHaveTextContent("Referenced decision");
    expect(composer()).toHaveTextContent("Existing remote draft");
  });
  await expect(screen.findByText("suggested.txt")).resolves.toBeInTheDocument();
  await expect(screen.findByText("original.txt")).resolves.toBeInTheDocument();
  expect(sends).toHaveLength(0);
});
test("A consumed suggestion is saved when target metadata is unavailable", async () => {
  const suggestion = {
    ...makeSuggestion(),
    options: [makeOption({ threadId })],
  };
  const pool = mockPool([suggestion]);
  mockChatLifecycle(context, { threadId });
  const loadingDraft = context.mocks.deferred<void>();
  const releaseDraft = context.mocks.deferred<void>();
  const saved: (UserMessageDocument | null | undefined)[] = [];
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Thread metadata is unavailable" },
    });
  });
  context.mocks.api(chatThreadDraftContract.get, async ({ respond }) => {
    loadingDraft.resolve();
    await releaseDraft.promise;
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
    saved.push(body.draftUserMessage);
    return respond(204);
  });
  await openFeed();
  await screen.findByText(suggestion.title);
  click(button(suggestion.options[0].label));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threadId}`);
    expect(composer()).toHaveTextContent("Referenced decision");
  });
  await loadingDraft.promise;
  releaseDraft.resolve();
  await waitFor(() => {
    expect(saved).toContainEqual(suggestion.options[0].draft.draftUserMessage);
  });
  expect(pool.consumed).toStrictEqual([suggestion.id]);
});
test("A choice is still sent when another session consumed the card", async () => {
  const pool = mockPool();
  const consumed = context.mocks.deferred<void>();
  context.mocks.api(suggestionsContract.consume, ({ respond }) => {
    // Another session consumed it first and the API announced the change.
    pool.withdrawAll();
    notifySuggestionsChanged();
    consumed.resolve();
    return respond(409, {
      error: { code: "CONFLICT", message: "Already consumed" },
    });
  });
  const sent = captureSend();
  await openFeed();
  await screen.findByText(makeSuggestion().title);
  click(button(makeOption().label));
  await screen.findByText(SENT);
  expect((await sent).userMessage?.parts).toContainEqual(REFERENCED_THREAD);
  await consumed.promise;
  expect(pathname()).toBe("/feed");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("A suggestion uses the ordinary composer to join a running target chat", async () => {
  const runId = "d0000000-0000-4000-a000-000000000821";
  const queued: UserMessageDocument[] = [];
  mockPool([{ ...makeSuggestion(), options: [makeOption({ threadId })] }]);
  mockChatLifecycle(context, {
    threadId,
    activeRunIds: [runId],
    onQueuedEventAppend: ({ userMessage }) => {
      if (userMessage) {
        queued.push(userMessage);
      }
    },
    chatEvents: [
      {
        role: "user",
        content: "Earlier request",
        runId,
        createdAt: "2026-10-13T00:00:00Z",
      },
      {
        role: "assistant",
        content: "Still working",
        runId,
        createdAt: "2026-10-13T00:00:01Z",
      },
    ],
  });
  await openFeed();
  await screen.findByText(makeSuggestion().title);
  click(button(makeOption().label));
  await waitFor(() => {
    return expect(pathname()).toBe(`/chats/${threadId}`);
  });
  await screen.findByText("Still working");
  await screen.findByText("Referenced decision");
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    return expect(queued).toHaveLength(1);
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "chat_thread",
    threadId,
    titleSnapshot: "Referenced decision",
  });
});
test("The loaded option keeps its draft and destination when the server responds with a later version", async () => {
  mockPool();
  const sent = captureSend();
  const consumed = context.mocks.deferred<void>();
  context.mocks.api(suggestionsContract.consume, ({ respond }) => {
    consumed.resolve();
    return respond(200, {
      ...makeSuggestion(),
      status: "consumed",
      selectedOptionId: makeOption().id,
      options: [
        makeOption({
          threadId,
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [{ type: "text", text: "Updated action" }],
            },
            draftAttachments: null,
          },
        }),
      ],
    });
  });
  await openFeed();
  await screen.findByText(makeSuggestion().title);
  click(button(makeOption().label));
  const message = await sent;
  expect(message.threadId).not.toBe(threadId);
  expect(message.userMessage?.parts).toContainEqual(REFERENCED_THREAD);
  expect(JSON.stringify(message.userMessage)).not.toContain("Updated action");
  await consumed.promise;
  expect(pathname()).toBe("/feed");
});
function numberedSuggestions(count: number): Suggestion[] {
  return Array.from({ length: count }, (_, index) => {
    return {
      ...makeSuggestion(),
      id: `a0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      title: `Suggested action ${index + 1}`,
    };
  });
}
// The sidebar also links the new thread, so the sent row's own link is read.
function openChatLink(): HTMLElement {
  const found = queryAllByRoleFast(
    "link",
    screen.getByRole("region", { name: "Suggestions" }),
  ).find((element) => {
    return element.textContent?.trim() === "Open chat";
  });
  if (!found) {
    throw new Error("Missing Open chat link");
  }
  return found;
}
function feedItemLabels(): (string | null)[] {
  return within(screen.getByRole("region", { name: "Suggestions" }))
    .getAllByRole("listitem")
    .map((row) => {
      const content =
        within(row).queryByRole("heading") ?? within(row).getByRole("status");
      return content.textContent;
    });
}
test("The Feed lists every suggestion card and sends the chosen card's action in place", async () => {
  const items = numberedSuggestions(3).map((item, index) => {
    return {
      ...item,
      options: [
        makeOption({
          label: `Review option ${index + 1}`,
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: `Draft for suggested action ${index + 1}`,
                },
              ],
            },
            draftAttachments: null,
          },
        }),
      ],
    };
  });
  mockPool(items);
  const sent = captureSend();
  await openFeed();
  const suggestions = await screen.findByRole("region", {
    name: "Suggestions",
  });
  const cards = within(suggestions).getAllByRole("article");
  expect(
    cards.map((card) => {
      return within(card).getByRole("heading").textContent;
    }),
  ).toStrictEqual(
    items.map((item) => {
      return item.title;
    }),
  );
  for (const [index, card] of cards.entries()) {
    expect(button(items[index].options[0].label, "button", card)).toBeEnabled();
    expect(button("I’d like to…", "button", card)).toBeEnabled();
    expect(button("Dismiss", "button", card)).toBeEnabled();
  }
  click(button(items[1].options[0].label, "button", cards[1]));
  await screen.findByText(SENT);
  expect(feedItemLabels()).toStrictEqual([
    items[0].title,
    items[2].title,
    MESSAGE_SENT,
  ]);
  expect(JSON.stringify((await sent).userMessage)).toContain(
    "Draft for suggested action 2",
  );
  expect(pathname()).toBe("/feed");
});
test("A sent suggestion moves below the waiting cards and opens its new thread", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  const sent = captureSend();
  await openFeed();
  click(
    button(
      makeOption().label,
      "button",
      await screen.findByRole("article", { name: items[0].title }),
    ),
  );
  await screen.findByText(MESSAGE_SENT);
  expect(feedItemLabels()).toStrictEqual([items[1].title, MESSAGE_SENT]);
  const { threadId: sentThreadId } = await sent;
  click(openChatLink());
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${sentThreadId}`);
  });
});
test("A choice that sends nothing returns its card to its place", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  mockChatLifecycle(context);
  // No model, not even Auto, can run, so the send never publishes a thread.
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, { models: [] });
  });
  await openFeed();
  click(
    button(
      makeOption().label,
      "button",
      await screen.findByRole("article", { name: items[0].title }),
    ),
  );
  await screen.findByText("The selected model is not available");
  await screen.findByRole("article", { name: items[0].title });
  expect(feedItemLabels()).toStrictEqual(
    items.map((item) => {
      return item.title;
    }),
  );
});

test("A send that fails before its thread is published shows the failure in its row", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  mockChatLifecycle(context);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    runModelsMainContract.list,
    async ({ respond, withSignal }) => {
      requested.resolve();
      await withSignal(release.promise);
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Model routing unavailable",
        },
      });
    },
  );
  await openFeed();
  click(
    button(
      makeOption().label,
      "button",
      await screen.findByRole("article", { name: items[0].title }),
    ),
  );
  await requested.promise;
  await screen.findByText("Sending…");
  expect(feedItemLabels()).toStrictEqual([items[1].title, "Sending…"]);
  release.resolve();
  const failure = await within(
    screen.getByRole("region", { name: "Suggestions" }),
  ).findByRole("alert");
  expect(failure).toHaveTextContent("Model routing unavailable");
  expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
});
test("Dismissing a suggestion moves only its card below the waiting cards and keeps the rest available", async () => {
  const pool = mockPool(numberedSuggestions(2));
  await openFeed();
  await screen.findByText("Suggested action 1");
  click(button("Dismiss"));
  await screen.findByText("Suggestion dismissed");
  expect(feedItemLabels()).toStrictEqual([
    "Suggested action 2",
    "Suggestion dismissed",
  ]);
  expect(
    screen.queryByRole("article", { name: "Suggested action 1" }),
  ).not.toBeInTheDocument();
  await waitFor(() => {
    expect(pool.consumed).toStrictEqual([
      "a0000000-0000-4000-a000-000000000001",
    ]);
  });
  expect(pool.selections).toStrictEqual([
    { id: makeSuggestion().id, optionId: null },
  ]);
  expect(pathname()).toBe("/feed");
  click(button("Dismiss"));
  await waitFor(() => {
    expect(pool.consumed).toStrictEqual([
      "a0000000-0000-4000-a000-000000000001",
      "a0000000-0000-4000-a000-000000000002",
    ]);
  });
  // Each handled card keeps its own row, in the order it was handled.
  await waitFor(() => {
    expect(feedItemLabels()).toStrictEqual([
      "Suggestion dismissed",
      "Suggestion dismissed",
    ]);
  });
  expect(
    within(screen.getByRole("region", { name: "Suggestions" }))
      .getAllByRole("listitem")
      .map((row) => {
        return within(row).getByText(/^Suggested action/).textContent;
      }),
  ).toStrictEqual(["Suggested action 1", "Suggested action 2"]);
  expect(screen.queryByText(EMPTY_FEED)).not.toBeInTheDocument();
  await userEvent.setup().click(button("Close feedback"));
  expect(feedItemLabels()).toStrictEqual(["Suggestion dismissed"]);
  await userEvent.setup().click(button("Close feedback"));
  await screen.findByText(EMPTY_FEED);
  expect(pathname()).toBe("/feed");
});
test("A deleted target shows its unavailable page and preserves the home draft", async () => {
  mockPool([{ ...makeSuggestion(), options: [makeOption({ threadId })] }]);
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  });
  await openFeedFromHome("Keep my home draft");
  await screen.findByText(makeSuggestion().title);
  click(button(makeOption().label));
  await screen.findByRole("heading", { name: "Chat thread not found" });
  expect(pathname()).toBe(`/chats/${threadId}`);
  click(link(homePath));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Keep my home draft");
  });
});

test("With the switch off, the sidebar has no Feed entry", async () => {
  await setupPage({ context, path: homePath });
  expect(button("Workflow")).toBeInTheDocument();
  expect(queryLink("/feed")).toBeNull();
});
test("With the switch off, the Feed route is not found", async () => {
  await setupPage({ context, path: "/feed" });
  await expect(
    screen.findByRole("heading", { name: "That page isn't here." }),
  ).resolves.toBeInTheDocument();
});
test("Feed options start in the default Agent after visiting a secondary Agent", async () => {
  const secondary = "c0000000-0000-4000-a000-000000000002";
  const agents: AgentResponse[] = [agentId, secondary].map((id) => {
    return {
      agentId: id,
      isDefaultAgent: id === agentId,
      ownerId: "user_mock",
      displayName: id === agentId ? "Okou" : "Secondary",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "private",
    };
  });
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, agents);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const found = agents.find((agent) => {
      return agent.agentId === params.id;
    });
    if (!found) {
      throw new Error("Missing mocked Agent");
    }
    return respond(200, found);
  });
  mockPool();
  mockChatLifecycle(context);
  const sender = context.mocks.deferred<string>();
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (!sender.settled()) {
      sender.resolve(body.agentId);
    }
    return respond(201, {
      threadId: body.threadId ?? threadId,
      createdAt: "2026-10-27T00:00:00Z",
    });
  });
  await setupPage({
    context,
    path: `/agents/${secondary}/chat`,
    featureSwitches: features,
  });
  expect(button("Workflow")).toBeInTheDocument();
  click(link("/feed"));
  await screen.findByText(makeSuggestion().title);
  click(button(makeOption().label));
  await screen.findByText(SENT);
  await expect(sender.promise).resolves.toBe(agentId);
  expect(pathname()).toBe("/feed");
});

test("Custom direction opens a dialog composer for the default Agent without touching its home draft", async () => {
  const pool = mockPool();
  await openFeedFromHome("Keep my original draft");
  await screen.findByText(makeSuggestion().title);
  const custom = button("I’d like to…");
  expect(custom).toHaveTextContent(
    "Ask a question or describe what you’d like to do.",
  );
  expect(
    custom.compareDocumentPosition(button("Dismiss")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const { dialog, note } = await openCustomDirection();
  expect(pathname()).toBe("/feed");
  expect(composer()).toHaveTextContent(makeSuggestion().title);
  expect(composer()).not.toHaveTextContent("launch-plan-v2");
  expect(composer()).not.toHaveTextContent("Keep my original draft");
  expect(button("Send", "button", dialog)).toBeDisabled();
  await writeDirection(note, "What decision should I make first?");
  await waitFor(() => {
    expect(button("Send", "button", dialog)).toBeEnabled();
  });
  expect(pool.consumed).toStrictEqual([]);
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(
    screen.getByRole("article", { name: makeSuggestion().title }),
  ).toBeInTheDocument();
  click(link(homePath));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Keep my original draft");
  });
  expect(composer()).not.toHaveTextContent(makeSuggestion().title);
});

test("Each custom direction dialog starts from its own card's background", async () => {
  const first = makeSuggestion();
  const second: Suggestion = {
    ...makeSuggestion(),
    id: "a0000000-0000-4000-a000-000000000002",
    title: "Review the budget",
    customOption: {
      ...first.customOption,
      draft: {
        draftUserMessage: {
          version: 1,
          parts: [
            {
              type: "feedback",
              quote: "Budget background: source BUDGET-42",
              note: [],
            },
          ],
        },
        draftAttachments: null,
      },
    },
  };
  mockPool([first, second]);
  await openFeed();
  await screen.findByText(first.title);
  const opened = await openCustomDirection(
    screen.getByRole("article", { name: first.title }),
  );
  expect(composer()).toHaveTextContent(first.title);
  await writeDirection(opened.note, "Assess the risks first");
  click(within(opened.dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await openCustomDirection(
    screen.getByRole("article", { name: second.title }),
  );
  expect(composer()).toHaveTextContent(second.title);
  expect(composer()).not.toHaveTextContent(first.title);
  expect(composer()).not.toHaveTextContent("Assess the risks first");
  click(within(screen.getByRole("dialog")).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(feedItemLabels()).toStrictEqual([first.title, second.title]);
});

test("A custom follow-up retains its dialog on failure and reuses its identities until acceptance", async () => {
  const pool = mockPool();
  mockChatLifecycle(context);
  const attempts: {
    threadId?: string;
    clientEventId?: string;
    userMessage?: UserMessageDocument;
  }[] = [];
  const retryRequested = context.mocks.deferred<void>();
  const acceptRetry = context.mocks.deferred<void>();
  let failing = true;
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    attempts.push({
      threadId: body.threadId,
      clientEventId: body.clientEventId,
      userMessage: body.userMessage,
    });
    if (failing) {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Follow-up temporarily unavailable",
        },
      });
    }
    retryRequested.resolve();
    await acceptRetry.promise;
    return respond(201, {
      threadId: body.threadId ?? threadId,
      createdAt: "2026-10-27T00:00:00Z",
    });
  });
  await openFeed();
  await screen.findByText(makeSuggestion().title);
  const { dialog, note } = await openCustomDirection();
  await writeDirection(note, "Assess the budget risk first");
  await waitFor(() => {
    return expect(button("Send", "button", dialog)).not.toBeDisabled();
  });
  click(button("Send", "button", dialog));
  await screen.findByText("Follow-up temporarily unavailable");
  expect(pathname()).toBe("/feed");
  expect(composer()).toHaveTextContent("Assess the budget risk first");
  expect(composer()).toHaveTextContent(makeSuggestion().title);
  failing = false;
  click(button("Send", "button", dialog));
  await retryRequested.promise;
  expect(composer()).toHaveTextContent("Assess the budget risk first");
  expect(attempts[1]).toStrictEqual(attempts[0]);
  const [quote] = suggestionFeedbacks(
    attempts[1].userMessage ?? { version: 1, parts: [] },
  );
  expect(quote.part.quote).toContain("launch-plan-v2");
  expect(JSON.stringify(quote.part.note)).toContain(
    "Assess the budget risk first",
  );
  acceptRetry.resolve();
  await screen.findByText(SENT);
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(pathname()).toBe("/feed");
  expect(
    screen.queryByRole("article", { name: makeSuggestion().title }),
  ).not.toBeInTheDocument();
  expect(feedItemLabels()).toStrictEqual([MESSAGE_SENT]);
  expect(openChatLink()).toHaveAttribute(
    "href",
    `/chats/${attempts[1].threadId}`,
  );
  // The API records the custom follow-up when it accepts the input.
  expect(pool.consumed).toStrictEqual([]);
});

test("The custom direction dialog sends the background files without the home draft", async () => {
  const incoming = draftAttachment("suggestion-background.txt", {
    id: "a0000000-0000-4000-a000-000000000091",
    contentType: "text/plain",
  });
  const original = draftAttachment("my-original.txt", {
    id: "a0000000-0000-4000-a000-000000000092",
    contentType: "text/plain",
  });
  const suggestion = makeSuggestion();
  mockPool([
    {
      ...suggestion,
      customOption: {
        ...suggestion.customOption,
        draft: {
          ...suggestion.customOption.draft,
          draftAttachments: [incoming],
        },
      },
    },
  ]);
  mockPrivateUrlSequence(context, {
    [incoming.id]: [incoming.url],
    [original.id]: [original.url],
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: "My saved draft" },
          {
            type: "file",
            fileId: original.id,
            filenameSnapshot: original.filename,
            contentType: original.contentType,
          },
        ],
      },
      draftAttachments: [original],
    });
  });
  const sent = captureSend();
  await setupPage({ context, path: homePath, featureSwitches: features });
  await screen.findByText("my-original.txt");
  click(link("/feed"));
  await screen.findByText(suggestion.title);
  const { dialog, note } = await openCustomDirection();
  await within(dialog).findByText("suggestion-background.txt");
  expect(within(dialog).queryByText("my-original.txt")).not.toBeInTheDocument();
  expect(composer()).not.toHaveTextContent("My saved draft");
  await writeDirection(note, "Keep my own requirements");
  await waitFor(() => {
    expect(button("Send", "button", dialog)).toBeEnabled();
  });
  click(button("Send", "button", dialog));
  await screen.findByText(SENT);
  const message = (await sent).userMessage;
  expect(message?.parts).toContainEqual(
    expect.objectContaining({ type: "file", fileId: incoming.id }),
  );
  expect(JSON.stringify(message)).not.toContain(original.id);
  expect(JSON.stringify(message)).not.toContain("My saved draft");
  expect(pathname()).toBe("/feed");
});

test("Feedback stays available after the last card, accepts an optional reason, and undo restores the card", async () => {
  mockPool([{ ...makeSuggestion(), consumeToken: "a".repeat(64) }]);
  await openFeed();
  await screen.findByText(makeSuggestion().title);
  const actions = ["Dismiss", "Already done", "Not planned", "Less like this"];
  const suggestion = screen.getByRole("region", { name: "Suggestions" });
  expect(
    queryAllByRoleFast("button", suggestion)
      .map((action) => {
        return action.textContent?.trim();
      })
      .filter((label) => {
        return label !== undefined && actions.includes(label);
      }),
  ).toStrictEqual(actions);
  await userEvent.setup().click(button("Less like this"));
  await screen.findByText("You’ll see fewer suggestions like this.");
  await userEvent.setup().click(button("Add a reason"));
  await userEvent
    .setup()
    .type(
      screen.getByLabelText("Add a reason (optional)"),
      "Another teammate handles this work",
    );
  await userEvent.setup().click(button("Save"));
  await screen.findByText("Edit reason");
  await userEvent.setup().click(button("Edit reason"));
  expect(screen.getByLabelText("Add a reason (optional)")).toHaveValue(
    "Another teammate handles this work",
  );
  await userEvent.setup().click(button("Undo"));
  await screen.findByText(makeSuggestion().title);
  await userEvent.setup().click(button("Not planned"));
  await screen.findByText("Noted — this is not planned");
  await userEvent.setup().click(button("Close feedback"));
  await screen.findByText(EMPTY_FEED);
});

test("Not planned moves its card below the waiting cards and Undo restores it in place", async () => {
  const items = numberedSuggestions(3);
  mockPool(items);
  await openFeed();
  await screen.findByText(items[1].title);
  click(
    button(
      "Not planned",
      "button",
      screen.getByRole("article", { name: items[1].title }),
    ),
  );
  await screen.findByText("Noted — this is not planned");
  expect(feedItemLabels()).toStrictEqual([
    items[0].title,
    items[2].title,
    "Noted — this is not planned",
  ]);
  click(button("Undo"));
  await screen.findByRole("article", { name: items[1].title });
  expect(feedItemLabels()).toStrictEqual(
    items.map((item) => {
      return item.title;
    }),
  );
});

test("Failed feedback keeps the local choice and can retry the same feedback identity", async () => {
  const item = makeSuggestion();
  mockPool([item]);
  const attemptedIds: string[] = [];
  const retried = context.mocks.deferred<void>();
  let failing = true;
  context.mocks.api(suggestionsContract.feedback, ({ body, respond }) => {
    attemptedIds.push(body.id);
    if (failing) {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Feedback could not be saved",
        },
      });
    }
    retried.resolve();
    return respond(200, { restored: false });
  });
  await openFeed();
  await screen.findByText(item.title);
  click(button("Already done"));
  const error = await screen.findByRole("alert");
  expect(
    within(error).getByText(/Feedback could not be saved/),
  ).toBeInTheDocument();
  expect(screen.getByText("Noted — this is already done")).toBeInTheDocument();
  expect(
    screen.queryByRole("article", { name: item.title }),
  ).not.toBeInTheDocument();
  click(button("Close feedback"));
  await screen.findByText(EMPTY_FEED);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  failing = false;
  click(button("Try again"));
  await retried.promise;
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(attemptedIds[1]).toBe(attemptedIds[0]);
});

test("Slow feedback leaves other cards usable and Undo restores the original card in order", async () => {
  const items = numberedSuggestions(3);
  mockPool(items);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const undone = context.mocks.deferred<void>();
  const otherCardSaved = context.mocks.deferred<void>();
  const requests: { id: string; kind: string; targetId: string | null }[] = [];
  context.mocks.api(
    suggestionsContract.feedback,
    async ({ params, body, respond }) => {
      requests.push(body);
      if (params.id === items[1].id) {
        otherCardSaved.resolve();
      }
      if (params.id === items[0].id && body.kind !== "undo") {
        requested.resolve();
        await release.promise;
      }
      if (body.kind === "undo") {
        undone.resolve();
      }
      return respond(200, { restored: body.kind === "undo" });
    },
  );
  await openFeed();
  await screen.findByText(items[0].title);
  click(button("Already done"));
  await requested.promise;
  await screen.findByText("Noted — this is already done");
  expect(feedItemLabels()).toStrictEqual([
    items[1].title,
    items[2].title,
    "Noted — this is already done",
  ]);
  expect(
    button(
      "Not planned",
      "button",
      screen.getByRole("article", { name: items[1].title }),
    ),
  ).toBeEnabled();
  click(button("Undo"));
  await screen.findByRole("article", { name: items[0].title });
  expect(
    within(screen.getByRole("region", { name: "Suggestions" }))
      .getAllByRole("heading")
      .map((heading) => {
        return heading.textContent;
      }),
  ).toStrictEqual(
    items.map((item) => {
      return item.title;
    }),
  );
  // Another card stays interactive while the restored card's feedback waits.
  click(
    button(
      "Not planned",
      "button",
      screen.getByRole("article", { name: items[1].title }),
    ),
  );
  await screen.findByText("Noted — this is not planned");
  await otherCardSaved.promise;
  release.resolve();
  await undone.promise;
  expect(screen.getByText(items[2].title)).toBeInTheDocument();
  expect(screen.getByText("Noted — this is not planned")).toBeInTheDocument();
  const feedback = requests.find((request) => {
    return request.kind === "already_done";
  });
  const undo = requests.find((request) => {
    return request.kind === "undo";
  });
  expect(undo?.targetId).toBe(feedback?.id);
});

test("Reason edits and Undo are local while their writes follow the original feedback", async () => {
  const item = { ...makeSuggestion(), consumeToken: "a".repeat(64) };
  mockPool([item]);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const reasonRequested = context.mocks.deferred<void>();
  const releaseReason = context.mocks.deferred<void>();
  const undone = context.mocks.deferred<void>();
  let feedbackSaved = false;
  let reasonSaved = false;
  context.mocks.api(suggestionsContract.feedback, async ({ body, respond }) => {
    if (body.kind === "less_like_this") {
      requested.resolve();
      await release.promise;
      feedbackSaved = true;
    }
    if (body.kind === "reason") {
      if (!feedbackSaved) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Feedback is not saved" },
        });
      }
      reasonRequested.resolve();
      await releaseReason.promise;
      reasonSaved = true;
    }
    if (body.kind === "undo") {
      if (!reasonSaved) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Reason is not saved" },
        });
      }
      undone.resolve();
    }
    return respond(200, { restored: body.kind === "undo" });
  });
  await openFeed();
  await screen.findByText(item.title);
  click(button("Less like this"));
  await requested.promise;
  click(button("Add a reason"));
  await fill(
    screen.getByLabelText("Add a reason (optional)"),
    "Handled by my teammate",
  );
  click(button("Save"));
  await screen.findByText("Edit reason");
  click(button("Edit reason"));
  expect(screen.getByLabelText("Add a reason (optional)")).toHaveValue(
    "Handled by my teammate",
  );
  click(button("Undo"));
  await screen.findByText(item.title);
  release.resolve();
  await reasonRequested.promise;
  expect(screen.getByText(item.title)).toBeInTheDocument();
  releaseReason.resolve();
  await undone.promise;
  expect(screen.getByText(item.title)).toBeInTheDocument();
});

test("Choosing an action confirms the send while its consumption is still saving", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  mockChatLifecycle(context);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(suggestionsContract.consume, async ({ body, respond }) => {
    requested.resolve();
    await release.promise;
    return respond(200, {
      ...items[0],
      status: "consumed",
      selectedOptionId: body.optionId,
    });
  });
  await openFeed();
  await screen.findByText(items[0].title);
  click(
    button(
      makeOption().label,
      "button",
      screen.getByRole("article", { name: items[0].title }),
    ),
  );
  await requested.promise;
  await screen.findByText(SENT);
  expect(feedItemLabels()).toStrictEqual([items[1].title, MESSAGE_SENT]);
  expect(pathname()).toBe("/feed");
  release.resolve();
});

test("An existing conversation opens before consumption and its remote draft finish", async () => {
  const item = { ...makeSuggestion(), options: [makeOption({ threadId })] };
  mockPool([item]);
  mockChatLifecycle(context, { threadId });
  const consuming = context.mocks.deferred<void>();
  const releaseConsumption = context.mocks.deferred<void>();
  const loadingDraft = context.mocks.deferred<void>();
  const releaseDraft = context.mocks.deferred<void>();
  context.mocks.api(suggestionsContract.consume, async ({ body, respond }) => {
    consuming.resolve();
    await releaseConsumption.promise;
    return respond(200, {
      ...item,
      status: "consumed",
      selectedOptionId: body.optionId,
    });
  });
  context.mocks.api(chatThreadDraftContract.get, async ({ respond }) => {
    loadingDraft.resolve();
    await releaseDraft.promise;
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "My saved target draft" }],
      },
      draftAttachments: null,
    });
  });
  await openFeed();
  await screen.findByText(item.title);
  click(button(makeOption().label));
  await consuming.promise;
  await loadingDraft.promise;
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threadId}`);
    expect(composer()).toHaveTextContent("Referenced decision");
  });
  releaseDraft.resolve();
  await waitFor(() => {
    expect(composer()).toHaveTextContent("My saved target draft");
  });
  releaseConsumption.resolve();
});
