import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { composerDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  feedContract,
  type Suggestion,
  type SuggestionOption,
  type PlatformEvent,
  type FeedSources,
} from "@okouai/api-contracts/contracts/feed";
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
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { pathname } from "../../../signals/location.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  draftAttachment,
  mockPrivateUrlSequence,
} from "./chat-attachment-test-helpers.ts";
import { nowDate } from "../../../lib/time.ts";
import { forYouCovers } from "../../../lib/for-you-artwork.ts";
const context = testContext();
const reloadedContext = createTestRuntime(context);
const agentId = "c0000000-0000-4000-a000-000000000001";
const threadId = "b0000000-0000-4000-a000-000000000811";
function makeSuggestion(): Suggestion {
  const timestamp = nowDate().toISOString();
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    priority: 20,
    createdAt: timestamp,
    updatedAt: timestamp,
    content: {
      title: "Review the pending decision",
      rationale: "A response is needed",
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
    },
    state: {
      feedbacks: [],
      status: "active",
      selectedOptionId: null,
    },
    type: "suggestion",
    expiresAt: new Date(Date.parse(timestamp) + 86_400_000).toISOString(),
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
  role: "button" | "tab" | "radio" = "button",
  container: ParentNode = document.body,
) {
  const found = queryAllByRoleFast(role, container).find((element) => {
    return (
      !element.closest('[inert], [aria-hidden="true"]') &&
      (element.textContent?.trim().startsWith(name) ||
        element.getAttribute("aria-label") === name)
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

async function undoSuggestionFeedback(): Promise<void> {
  const undo = button("Undo");
  click(undo);
  // Let Sonner finish removing the toast while the test still owns the page.
  await waitFor(() => {
    expect(undo).not.toBeInTheDocument();
  });
}

function composer(container: ParentNode = document) {
  const node = container.querySelector(
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
  let sources: FeedSources = {
    suggestions: true,
    whatsNew: true,
    offers: true,
    systemUpdates: true,
  };
  const read = new Set<string>();
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, sources);
  });
  context.mocks.api(feedContract.updateSources, ({ body, respond }) => {
    sources = { ...sources, ...body };
    notifySuggestionsChanged();
    return respond(200, sources);
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: sources.suggestions,
      status: sources.suggestions ? "enabled" : "paused",
      unavailableReason: null,
    });
  });
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    ({ body, respond }) => {
      sources = { ...sources, suggestions: body.enabled };
      notifySuggestionsChanged();
      return respond(200, {
        enabled: body.enabled,
        status: body.enabled ? "enabled" : "paused",
        unavailableReason: null,
      });
    },
  );
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, {
      hasUnread:
        sources.suggestions &&
        items.some((item) => {
          return !read.has(item.id);
        }),
    });
  });
  context.mocks.api(feedContract.markRead, ({ params, respond }) => {
    read.add(params.id);
    notifySuggestionsChanged();
    return respond(200, { readAt: nowDate().toISOString() });
  });
  const retired = new Map<string, Suggestion>();
  const consumed: string[] = [];
  const selections: {
    id: string;
    optionId: string | null;
  }[] = [];
  context.mocks.api(feedContract.feedback, ({ params, body, respond }) => {
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
        error: {
          code: "CONFLICT",
          message:
            "Suggestion is no longer available. Refresh your suggestions.",
        },
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
  });
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: items });
  });
  context.mocks.api(feedContract.consume, ({ params, body, respond }) => {
    const found = items.find((entry) => {
      return entry.id === params.id;
    });
    if (
      !found ||
      (body.optionId !== null &&
        !found.content.options.some((option) => {
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
      state: {
        ...found.state,
        status: "consumed",
        selectedOptionId: body.optionId,
      },
    });
  });
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
} as const;
// Suggestions live independently of the default Agent's new-chat draft.
const suggestionPath = "/for-you";
const homePath = "/";
async function openSuggestions(): Promise<void> {
  await setupPage({ context, path: suggestionPath, featureSwitches: features });
}
async function openSuggestionsWithDraft(draft: string): Promise<void> {
  await setupPage({ context, path: homePath, featureSwitches: features });
  await fill(composer(), draft);
  click(link(suggestionPath));
  await screen.findByRole("article");
}
// The new-chat row opens home without a suggestion count.
function okouRow(): HTMLElement {
  const found = queryAllByRoleFast(
    "link",
    screen.getByTestId("chat-list-column"),
  ).find((element) => {
    return element.getAttribute("href") === "/";
  });
  if (!found) {
    throw new Error("Missing Okou row");
  }
  return found;
}
const SENT = "Sent to a new chat";
const SUGGESTION_UNAVAILABLE =
  "That suggestion is no longer available. Suggestions have been refreshed.";
const REFERENCED_THREAD = {
  type: "chat_thread",
  threadId,
  titleSnapshot: "Referenced decision",
} as const;
interface SentInput {
  readonly threadId?: string;
  readonly title?: string;
  readonly userMessage?: UserMessageDocument;
}
// Resolves with the chat input home sends while the page stays in place.
function captureSend(): Promise<SentInput> {
  const sent = context.mocks.deferred<SentInput>();
  let title: string | undefined;
  mockChatLifecycle(context, {
    onThreadCreate: (body) => {
      title = body.title;
    },
    onSendRequest: ({ threadId: sentThreadId, userMessage }) => {
      if (!sent.settled()) {
        sent.resolve({ threadId: sentThreadId, title, userMessage });
      }
    },
  });
  return sent.promise;
}
const DIRECTION = "What do you have in mind?";
async function openCustomDirection(
  container: ParentNode = document.body,
): Promise<{ editor: HTMLElement; note: HTMLElement }> {
  const trigger = button(DIRECTION, "button", container);
  const card = trigger.closest("article");
  if (!card) {
    throw new Error("Expected the direction trigger inside a suggestion card");
  }
  click(trigger);
  const editor = await within(card).findByRole("region", { name: DIRECTION });
  const note = await within(editor).findByRole("textbox", { name: DIRECTION });
  return { editor, note };
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
  context.mocks.api(feedContract.consume, ({ body, respond }) => {
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
      state: {
        ...suggestion.state,
        status: "consumed",
        selectedOptionId: body.optionId,
      },
    });
  });
  const sent = captureSend();
  await openSuggestions();
  await screen.findByText(suggestion.content.title);
  pool.withdrawAll();
  click(button(makeOption().label));
  await screen.findByText(SENT);
  expect((await sent).userMessage?.parts).toContainEqual(REFERENCED_THREAD);
  await expect(consumedWith.promise).resolves.toBe(suggestion.consumeToken);
  expect(pathname()).toBe(suggestionPath);
});
test.each(["notification", "reconnect"] as const)(
  "For you opens background-updated cards after an Ably %s without waiting for another request",
  async (delivery) => {
    const [first, second] = numberedSuggestions(2);
    const pool = mockPool([first]);
    await setupPage({
      context,
      path: suggestionPath,
      featureSwitches: features,
      sharedWorkerTestTransport: "message-port",
    });
    await screen.findByText(first.content.title);
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription(SUGGESTIONS_TOPIC),
      ).toBeTruthy();
    });
    click(link("/workflows"));
    await screen.findByRole("heading", { name: "Workflows" });
    pool.publish(second);
    if (delivery === "notification") {
      notifySuggestionsChanged();
    } else {
      context.mocks.ably.triggerSharedWorkerConnectionState("suspended");
      context.mocks.ably.triggerSharedWorkerReconnect();
    }
    await within(link(suggestionPath)).findByText("Unread");
    const response = context.mocks.deferred<void>();
    context.mocks.api(feedContract.list, async ({ respond }) => {
      await response.promise;
      return respond(200, { items: [first, second] });
    });
    click(link(suggestionPath));
    await screen.findByText("2 to go");
    click(link(`/for-you?suggestion=${second.id}`));
    const card = await screen.findByRole("article", {
      name: second.content.title,
    });
    expect(card).toBeInTheDocument();
    response.resolve();
  },
);

test("For you preloads details when its sidebar shows an unread dot", async () => {
  const suggestion = makeSuggestion();
  mockPool([suggestion]);
  const preloaded = context.mocks.deferred<void>();
  context.mocks.api(feedContract.list, ({ respond }) => {
    preloaded.resolve();
    return respond(200, { items: [suggestion] });
  });
  await setupPage({ context, path: homePath, featureSwitches: features });
  await within(link(suggestionPath)).findByText("Unread");
  await preloaded.promise;
  const response = context.mocks.deferred<void>();
  context.mocks.api(feedContract.list, async ({ respond }) => {
    await response.promise;
    return respond(200, { items: [suggestion] });
  });
  click(link(suggestionPath));
  const card = await screen.findByRole("article", {
    name: suggestion.content.title,
  });
  expect(card).toBeInTheDocument();
  response.resolve();
});

test("For you retries a failed preloaded feed", async () => {
  const suggestion = makeSuggestion();
  mockPool([suggestion]);
  let failed = true;
  context.mocks.api(feedContract.list, ({ respond }) => {
    return failed
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Unavailable" },
        })
      : respond(200, { items: [suggestion] });
  });
  await openSuggestions();
  await screen.findByRole("alert");
  failed = false;
  click(button("Try again"));
  const card = await screen.findByRole("article", {
    name: suggestion.content.title,
  });
  expect(card).toBeInTheDocument();
});

test.each(["account", "workspace"] as const)(
  "For you opens the new owner's cards after an active %s change",
  async (scope) => {
    const [first, second] = numberedSuggestions(2);
    mockPool([first]);
    await openSuggestions();
    await screen.findByRole("article", { name: first.content.title });
    click(link("/workflows"));
    await screen.findByRole("heading", { name: "Workflows" });
    mockPool([second]);
    const clerk = context.mocks.clerk();
    act(() => {
      if (scope === "account") {
        clerk.user(
          { id: "other-feed-user", fullName: "Other User" },
          { id: "other-feed-session", token: "other-token" },
        );
      } else {
        clerk.organization({
          activeOrg: { id: "other-feed-org", name: "Other Workspace" },
          memberships: [{ id: "other-feed-org" }],
        });
      }
      clerk.stateChanged();
    });
    await screen.findByRole("heading", { name: "Workflows" });
    click(link(suggestionPath));
    const card = await screen.findByRole("article", {
      name: second.content.title,
    });
    expect(card).toBeInTheDocument();
    expect(screen.queryByText(first.content.title)).not.toBeInTheDocument();
  },
);
test("Choosing an action sends it to a new thread and keeps the homepage draft", async () => {
  const selected = makeOption({ id: "prepare", label: "Prepare response" });
  const suggestion = {
    ...makeSuggestion(),
    content: {
      ...makeSuggestion().content,
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
    },
  };
  const next = {
    ...makeSuggestion(),
    id: "a0000000-0000-4000-a000-000000000002",
    content: {
      ...makeSuggestion().content,
      title: "Review the budget",
    },
  };
  const pool = mockPool([suggestion, next]);
  const sent = captureSend();
  await openSuggestionsWithDraft("My original draft");
  await screen.findByText(suggestion.content.title);
  expect(button("Review decision")).toBeInTheDocument();
  expect(button("Summarize the decision")).toBeInTheDocument();
  click(button(selected.label));
  await screen.findByText(SENT);
  expect(pathname()).toBe(suggestionPath);
  await screen.findByRole("article", { name: next.content.title });
  await waitFor(() => {
    expect(pool.selections).toStrictEqual([
      { id: suggestion.id, optionId: selected.id },
    ]);
  });
  const { threadId: sentThreadId, title, userMessage: message } = await sent;
  expect(title).toBe(suggestion.content.title);
  expect(link(`/chats/${sentThreadId}`)).toHaveTextContent(
    suggestion.content.title,
  );

  expect(message?.parts).toContainEqual(REFERENCED_THREAD);
  expect(JSON.stringify(message)).not.toContain("Unselected action");
  click(okouRow());
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
    content: {
      ...makeSuggestion().content,
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
    },
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
  await openSuggestions();
  await screen.findByText(makeSuggestion().content.title);
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
    content: {
      ...makeSuggestion().content,
      options: [makeOption({ threadId })],
    },
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
  await openSuggestions();
  await screen.findByText(suggestion.content.title);
  click(button(suggestion.content.options[0].label));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threadId}`);
    expect(composer()).toHaveTextContent("Referenced decision");
  });
  await loadingDraft.promise;
  releaseDraft.resolve();
  await waitFor(() => {
    expect(saved).toContainEqual(
      suggestion.content.options[0].draft.draftUserMessage,
    );
  });
  expect(pool.consumed).toStrictEqual([suggestion.id]);
});
test("A choice is still sent when another session consumed the card", async () => {
  const pool = mockPool();
  const consumed = context.mocks.deferred<void>();
  context.mocks.api(feedContract.consume, ({ respond }) => {
    // Another session consumed it first and the API announced the change.
    pool.withdrawAll();
    notifySuggestionsChanged();
    consumed.resolve();
    return respond(409, {
      error: { code: "CONFLICT", message: "Already consumed" },
    });
  });
  const sent = captureSend();
  await openSuggestions();
  await screen.findByText(makeSuggestion().content.title);
  click(button(makeOption().label));
  await screen.findByText(SENT);
  expect((await sent).userMessage?.parts).toContainEqual(REFERENCED_THREAD);
  await consumed.promise;
  expect(pathname()).toBe(suggestionPath);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
test("A suggestion uses the ordinary composer to join a running target chat", async () => {
  const runId = "d0000000-0000-4000-a000-000000000821";
  const queued: UserMessageDocument[] = [];
  mockPool([
    {
      ...makeSuggestion(),
      content: {
        ...makeSuggestion().content,
        options: [makeOption({ threadId })],
      },
    },
  ]);
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
  await openSuggestions();
  await screen.findByText(makeSuggestion().content.title);
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
  context.mocks.api(feedContract.consume, ({ respond }) => {
    consumed.resolve();
    return respond(200, {
      ...makeSuggestion(),
      content: {
        ...makeSuggestion().content,
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
      },
      state: {
        ...makeSuggestion().state,
        status: "consumed",
        selectedOptionId: makeOption().id,
      },
    });
  });
  await openSuggestions();
  await screen.findByText(makeSuggestion().content.title);
  click(button(makeOption().label));
  const message = await sent;
  expect(message.threadId).not.toBe(threadId);
  expect(message.userMessage?.parts).toContainEqual(REFERENCED_THREAD);
  expect(JSON.stringify(message.userMessage)).not.toContain("Updated action");
  await consumed.promise;
  expect(pathname()).toBe(suggestionPath);
});
function numberedSuggestions(count: number): Suggestion[] {
  return Array.from({ length: count }, (_, index) => {
    return {
      ...makeSuggestion(),
      id: `a0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      content: {
        ...makeSuggestion().content,
        title: `Suggested action ${index + 1}`,
      },
    };
  });
}
test("A sent suggestion advances the stack and remains reachable in the chat list", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  const sent = captureSend();
  await openSuggestions();
  click(
    button(
      makeOption().label,
      "button",
      await screen.findByRole("article", { name: items[0].content.title }),
    ),
  );
  await screen.findByText(SENT);
  await screen.findByRole("article", { name: items[1].content.title });
  const { threadId: sentThreadId } = await sent;
  click(link(`/chats/${sentThreadId}`));
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
  await openSuggestions();
  click(
    button(
      makeOption().label,
      "button",
      await screen.findByRole("article", { name: items[0].content.title }),
    ),
  );
  await screen.findByText("The selected model is not available");
  await screen.findByRole("article", { name: items[0].content.title });
  expect(
    screen.getByRole("article", { name: items[0].content.title }),
  ).toBeInTheDocument();
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
  await openSuggestions();
  click(
    button(
      makeOption().label,
      "button",
      await screen.findByRole("article", { name: items[0].content.title }),
    ),
  );
  await requested.promise;
  await screen.findByText("Sending…");
  await screen.findByRole("article", { name: items[1].content.title });
  release.resolve();
  const failure = await screen.findByRole("alert");
  expect(failure).toHaveTextContent("Model routing unavailable");
  expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
});
test("A deleted target shows its unavailable page and preserves the home draft", async () => {
  mockPool([
    {
      ...makeSuggestion(),
      content: {
        ...makeSuggestion().content,
        options: [makeOption({ threadId })],
      },
    },
  ]);
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
  await openSuggestionsWithDraft("Keep my home draft");
  await screen.findByText(makeSuggestion().content.title);
  click(button(makeOption().label));
  await screen.findByRole("heading", { name: "Chat thread not found" });
  expect(pathname()).toBe(`/chats/${threadId}`);
  click(okouRow());
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Keep my home draft");
  });
});
test("Suggestion options start a member chat after visiting a legacy Agent", async () => {
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
    expect(body).not.toHaveProperty("agentId");
    if (!sender.settled()) {
      sender.resolve(body.threadId ?? threadId);
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
  expect(screen.getByRole("region", { name: "Workflow" })).toBeInTheDocument();
  click(link(suggestionPath));
  await screen.findByText(makeSuggestion().content.title);
  expect(pathname()).toBe(suggestionPath);
  click(button(makeOption().label));
  await screen.findByText(SENT);
  await expect(sender.promise).resolves.toMatch(/^[0-9a-f-]{36}$/u);
  expect(pathname()).toBe(suggestionPath);
});
test("Custom direction opens a full composer for a new chat without touching the home draft", async () => {
  const pool = mockPool();
  await openSuggestionsWithDraft("Keep my original draft");
  await screen.findByText(makeSuggestion().content.title);
  const { editor, note } = await openCustomDirection();
  expect(pathname()).toBe(suggestionPath);
  expect(within(editor).queryByRole("heading")).not.toBeInTheDocument();
  expect(within(editor).queryByLabelText("Close")).not.toBeInTheDocument();
  expect(
    within(editor).queryByLabelText("Remove feedback"),
  ).not.toBeInTheDocument();
  expect(composer(editor)).toHaveTextContent(makeSuggestion().content.title);
  expect(composer(editor)).not.toHaveTextContent("launch-plan-v2");
  expect(composer(editor)).not.toHaveTextContent("Keep my original draft");
  // The ordinary composer controls choose connectors, files and the model.
  expect(button("Connectors", "button", editor)).toBeInTheDocument();
  expect(within(editor).getByLabelText("Add")).toBeInTheDocument();
  expect(button("Send", "button", editor)).toBeDisabled();
  await writeDirection(note, "What decision should I make first?");
  await waitFor(() => {
    expect(button("Send", "button", editor)).toBeEnabled();
  });
  expect(pool.consumed).toStrictEqual([]);
  click(okouRow());
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Keep my original draft");
  });
  expect(composer()).not.toHaveTextContent(makeSuggestion().content.title);
});
test("Selecting a suggested action switches away from the open custom composer", async () => {
  const suggestion = makeSuggestion();
  const pool = mockPool([suggestion]);
  const sent = captureSend();
  await openSuggestions();
  const card = await screen.findByRole("article", {
    name: suggestion.content.title,
  });
  const { editor, note } = await openCustomDirection(card);
  await writeDirection(note, "Check the budget first");
  click(button(makeOption().label, "button", card));
  await screen.findByText(SENT);
  expect(editor).not.toBeInTheDocument();
  const { userMessage } = await sent;
  expect(userMessage).toStrictEqual(makeOption().draft.draftUserMessage);
  await waitFor(() => {
    expect(pool.consumed).toStrictEqual([suggestion.id]);
  });
});
test("Each card shows its own background in the direction editor", async () => {
  const first = makeSuggestion();
  const second: Suggestion = {
    ...makeSuggestion(),
    id: "a0000000-0000-4000-a000-000000000002",
    content: {
      ...makeSuggestion().content,
      title: "Review the budget",
      customOption: {
        ...first.content.customOption,
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
    },
  };
  mockPool([first, second]);
  await openSuggestions();
  await screen.findByText(first.content.title);
  const opened = await openCustomDirection(
    screen.getByRole("article", { name: first.content.title }),
  );
  expect(composer(opened.editor)).toHaveTextContent(first.content.title);
  await writeDirection(opened.note, "Assess the risks first");
  click(link(`/for-you?suggestion=${second.id}`));
  await screen.findByRole("article", { name: second.content.title });
  expect(opened.editor).not.toBeInTheDocument();
  const reopened = await openCustomDirection(
    screen.getByRole("article", { name: second.content.title }),
  );
  expect(composer(reopened.editor)).toHaveTextContent(second.content.title);
  expect(composer(reopened.editor)).not.toHaveTextContent(first.content.title);
  expect(composer(reopened.editor)).not.toHaveTextContent(
    "Assess the risks first",
  );
});
test("A custom follow-up retains its editor on failure and reuses its identities until acceptance", async () => {
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
  await openSuggestions();
  await screen.findByText(makeSuggestion().content.title);
  const { editor, note } = await openCustomDirection();
  await writeDirection(note, "Assess the budget risk first");
  await waitFor(() => {
    return expect(button("Send", "button", editor)).not.toBeDisabled();
  });
  click(button("Send", "button", editor));
  await screen.findByText("Follow-up temporarily unavailable");
  expect(pathname()).toBe(suggestionPath);
  expect(composer(editor)).toHaveTextContent("Assess the budget risk first");
  expect(composer(editor)).toHaveTextContent(makeSuggestion().content.title);
  failing = false;
  click(button("Send", "button", editor));
  await retryRequested.promise;
  expect(composer(editor)).toHaveTextContent("Assess the budget risk first");
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
    expect(editor).not.toBeInTheDocument();
  });
  expect(pathname()).toBe(suggestionPath);
  expect(
    screen.queryByRole("article", { name: makeSuggestion().content.title }),
  ).not.toBeInTheDocument();
  await screen.findByRole("heading", { name: "All caught up" });
  // The API records the custom follow-up when it accepts the input.
  expect(pool.consumed).toStrictEqual([]);
});
test("The custom direction editor sends the background files without the home draft", async () => {
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
      content: {
        ...suggestion.content,
        customOption: {
          ...suggestion.content.customOption,
          draft: {
            ...suggestion.content.customOption.draft,
            draftAttachments: [incoming],
          },
        },
      },
    },
  ]);
  mockPrivateUrlSequence(context, {
    [incoming.id]: [incoming.url],
    [original.id]: [original.url],
  });
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
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
  click(link(suggestionPath));
  await screen.findByText(suggestion.content.title);
  const { editor, note } = await openCustomDirection();
  await within(editor).findByText("suggestion-background.txt");
  expect(within(editor).queryByText("my-original.txt")).not.toBeInTheDocument();
  expect(composer(editor)).not.toHaveTextContent("My saved draft");
  await writeDirection(note, "Keep my own requirements");
  await waitFor(() => {
    expect(button("Send", "button", editor)).toBeEnabled();
  });
  click(button("Send", "button", editor));
  await screen.findByText(SENT);
  const { threadId: sentThreadId, title, userMessage: message } = await sent;
  expect(title).toBe(suggestion.content.title);
  expect(link(`/chats/${sentThreadId}`)).toHaveTextContent(
    suggestion.content.title,
  );
  expect(message?.parts).toContainEqual(
    expect.objectContaining({ type: "file", fileId: incoming.id }),
  );
  expect(JSON.stringify(message)).not.toContain(original.id);
  expect(JSON.stringify(message)).not.toContain("My saved draft");
  expect(pathname()).toBe(suggestionPath);
});
function withCustomThread(threadIdOverride: string): Suggestion {
  const suggestion = makeSuggestion();
  return {
    ...suggestion,
    content: {
      ...suggestion.content,
      customOption: {
        ...suggestion.content.customOption,
        threadId: threadIdOverride,
      },
    },
  };
}
test("A custom direction continues the chat its card names without touching its saved draft", async () => {
  const suggestion = withCustomThread(threadId);
  mockPool([suggestion]);
  const sends: { threadId?: string; userMessage?: UserMessageDocument }[] = [];
  const savedDrafts: unknown[] = [];
  mockChatLifecycle(context, {
    threadId,
    threadTitle: "Referenced decision",
    onSendRequest: ({ threadId: sentThreadId, userMessage }) => {
      sends.push({ threadId: sentThreadId, userMessage });
    },
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Existing remote draft" }],
      },
      draftAttachments: null,
    });
  });
  context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
    savedDrafts.push(body.draftUserMessage);
    return respond(204);
  });
  await openSuggestions();
  await screen.findByText(suggestion.content.title);
  const { editor, note } = await openCustomDirection();
  expect(composer(editor)).toHaveTextContent(suggestion.content.title);
  expect(composer(editor)).not.toHaveTextContent("Existing remote draft");
  await writeDirection(note, "Use the latest numbers from this chat");
  await waitFor(() => {
    expect(button("Send", "button", editor)).toBeEnabled();
  });
  click(button("Send", "button", editor));
  await screen.findByText("Sent to the chat");
  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(sends[0].threadId).toBe(threadId);
  const [quote] = suggestionFeedbacks(
    sends[0].userMessage ?? { version: 1, parts: [] },
  );
  expect(quote.context.suggestionId).toBe(suggestion.id);
  expect(JSON.stringify(quote.part.note)).toContain(
    "Use the latest numbers from this chat",
  );
  expect(pathname()).toBe(suggestionPath);
  await screen.findByRole("heading", { name: "All caught up" });
  expect(savedDrafts).toStrictEqual([]);
});
test("A custom direction continues its named chat before the chat list has loaded it", async () => {
  const suggestion = withCustomThread(threadId);
  mockPool([suggestion]);
  const sends: { threadId?: string; userMessage?: UserMessageDocument }[] = [];
  const lifecycle = mockChatLifecycle(context, {
    threadId,
    threadTitle: "Referenced decision",
    onSendRequest: ({ threadId: sentThreadId, userMessage }) => {
      sends.push({ threadId: sentThreadId, userMessage });
    },
  });
  // The chat exists, but this page's chat list has not received it yet.
  lifecycle.setThreadList([]);
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    return params.id === threadId
      ? respond(200, {
          id: threadId,
          title: "Referenced decision",
          selectedModel: null,
          modelSettings: {},
          serviceTier: null,
          pinnedAt: null,
          archived: false,
          muted: false,
          computerUseHostId: null,
          cloudBrowserEnabled: false,
        })
      : respond(404, {
          error: {
            code: "CHAT_THREAD_NOT_FOUND",
            message: "Chat thread not found",
          },
        });
  });
  await openSuggestions();
  await screen.findByText(suggestion.content.title);
  const { editor, note } = await openCustomDirection();
  await writeDirection(note, "Keep this in the decision chat");
  await waitFor(() => {
    expect(button("Send", "button", editor)).toBeEnabled();
  });
  click(button("Send", "button", editor));
  await screen.findByText("Sent to the chat");
  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(sends[0].threadId).toBe(threadId);
});
test("A custom direction starts a new chat when its card names none, even beside an existing-chat action", async () => {
  const suggestion: Suggestion = {
    ...makeSuggestion(),
    content: {
      ...makeSuggestion().content,
      options: [makeOption({ threadId })],
    },
  };
  mockPool([suggestion]);
  const sent = context.mocks.deferred<SentInput>();
  let title: string | undefined;
  mockChatLifecycle(context, {
    threadId,
    threadTitle: "Referenced decision",
    onThreadCreate: (body) => {
      title = body.title;
    },
    onSendRequest: ({ threadId: sentThreadId, userMessage }) => {
      sent.resolve({ threadId: sentThreadId, title, userMessage });
    },
  });
  await openSuggestions();
  await screen.findByText(suggestion.content.title);
  const { editor, note } = await openCustomDirection();
  await writeDirection(note, "Start fresh with this background");
  await waitFor(() => {
    expect(button("Send", "button", editor)).toBeEnabled();
  });
  click(button("Send", "button", editor));
  await screen.findByText(SENT);
  const message = await sent.promise;
  expect(message.threadId).not.toBe(threadId);
  expect(message.title).toBe(suggestion.content.title);
  expect(JSON.stringify(message.userMessage)).toContain(
    "Start fresh with this background",
  );
});
test("A custom direction whose chat is gone starts a new chat instead", async () => {
  const goneThreadId = "b0000000-0000-4000-a000-000000000999";
  const suggestion = withCustomThread(goneThreadId);
  mockPool([suggestion]);
  const sent = captureSend();
  await openSuggestions();
  await screen.findByText(suggestion.content.title);
  const { editor, note } = await openCustomDirection();
  await writeDirection(note, "Pick this up again");
  await waitFor(() => {
    expect(button("Send", "button", editor)).toBeEnabled();
  });
  click(button("Send", "button", editor));
  await screen.findByText(SENT);
  const message = await sent;
  expect(message.threadId).not.toBe(goneThreadId);
  expect(message.title).toBe(suggestion.content.title);
  expect(JSON.stringify(message.userMessage)).toContain("Pick this up again");
});
test("Not planned advances to the next card and Undo restores the selected card", async () => {
  const items = numberedSuggestions(3);
  mockPool(items);
  await openSuggestions();
  await screen.findByRole("article", { name: items[0].content.title });
  click(link(`/for-you?suggestion=${items[1].id}`));
  await screen.findByRole("article", { name: items[1].content.title });
  click(
    button(
      "Not planned",
      "button",
      screen.getByRole("article", { name: items[1].content.title }),
    ),
  );
  await screen.findByText("Noted — this is not planned");
  await screen.findByRole("article", { name: items[2].content.title });
  await undoSuggestionFeedback();
  const restored = await screen.findByRole("article", {
    name: items[1].content.title,
  });
  expect(restored).toBeInTheDocument();
});
test("Failed feedback keeps the local choice and can retry the same feedback identity", async () => {
  const item = makeSuggestion();
  mockPool([item]);
  const attemptedIds: string[] = [];
  const retried = context.mocks.deferred<void>();
  let failing = true;
  context.mocks.api(feedContract.feedback, ({ body, respond }) => {
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
  await openSuggestions();
  await screen.findByText(item.content.title);
  click(button("Already done"));
  const error = await screen.findByRole("alert");
  expect(
    within(error).getByText(/Feedback could not be saved/),
  ).toBeInTheDocument();
  await screen.findByRole("heading", { name: "All caught up" });
  expect(
    screen.queryByRole("article", { name: item.content.title }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  failing = false;
  click(button("Try again"));
  await retried.promise;
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(attemptedIds[1]).toBe(attemptedIds[0]);
});
test("Feedback on a card that left the pool refreshes the suggestions with a notice", async () => {
  const items = numberedSuggestions(3);
  const pool = mockPool(items);
  await openSuggestions();
  await screen.findByText(items[0].content.title);
  click(
    button(
      "Dismiss",
      "button",
      screen.getByRole("article", { name: items[0].content.title }),
    ),
  );
  await screen.findByText("Suggestion dismissed");
  expect(pool.consumed).toStrictEqual([items[0].id]);
  // A background check withdraws the rest of the pool and offers a new card
  // while home still shows the cards it loaded.
  const offered = {
    ...makeSuggestion(),
    id: "a0000000-0000-4000-a000-000000000009",
    content: {
      ...makeSuggestion().content,
      title: "Newly offered action",
    },
  };
  pool.withdrawAll();
  pool.publish(offered);
  click(
    button(
      "Already done",
      "button",
      screen.getByRole("article", { name: items[1].content.title }),
    ),
  );
  await screen.findByText(SUGGESTION_UNAVAILABLE);
  await screen.findByRole("article", { name: offered.content.title });
  // Every card that left goes; the card handled earlier keeps its row.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Refresh your suggestions/),
  ).not.toBeInTheDocument();
  // The earlier card is still part of the visit, so Undo restores it.
  await undoSuggestionFeedback();
  await screen.findByRole("article", { name: items[0].content.title });
});
test("Retrying feedback for a card that has since left the pool refreshes the suggestions", async () => {
  const item = makeSuggestion();
  const pool = mockPool([item]);
  let failing = true;
  context.mocks.api(feedContract.feedback, ({ respond }) => {
    if (failing) {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Feedback could not be saved",
        },
      });
    }
    return respond(409, {
      error: {
        code: "CONFLICT",
        message: "Suggestion is no longer available. Refresh your suggestions.",
      },
    });
  });
  await openSuggestions();
  await screen.findByText(item.content.title);
  click(button("Already done"));
  const error = await screen.findByRole("alert");
  // The card leaves the pool before the member retries.
  pool.withdrawAll();
  failing = false;
  click(button("Try again", "button", error));
  await screen.findByText(SUGGESTION_UNAVAILABLE);
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(
    screen.queryByText("Noted — this is already done"),
  ).not.toBeInTheDocument();
});
test("Slow feedback leaves other cards usable and Undo restores the original card in order", async () => {
  const items = numberedSuggestions(3);
  mockPool(items);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const undone = context.mocks.deferred<void>();
  const otherCardSaved = context.mocks.deferred<void>();
  const requests: {
    id: string;
    kind: string;
    targetId: string | null;
  }[] = [];
  context.mocks.api(
    feedContract.feedback,
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
  await openSuggestions();
  await screen.findByText(items[0].content.title);
  click(button("Already done"));
  await requested.promise;
  const next = await screen.findByRole("article", {
    name: items[1].content.title,
  });
  click(button("Not planned", "button", next));
  await otherCardSaved.promise;
  await screen.findByText("Noted — this is not planned");
  await screen.findByRole("article", { name: items[2].content.title });
  release.resolve();
  await screen.findByText("Noted — this is already done");
  await undoSuggestionFeedback();
  await undone.promise;
  await screen.findByRole("article", { name: items[0].content.title });
  const feedback = requests.find((request) => {
    return request.kind === "already_done";
  });
  const undo = requests.find((request) => {
    return request.kind === "undo";
  });
  expect(undo?.targetId).toBe(feedback?.id);
});
test("Choosing an action confirms the send while its consumption is still saving", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  mockChatLifecycle(context);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(feedContract.consume, async ({ body, respond }) => {
    requested.resolve();
    await release.promise;
    return respond(200, {
      ...items[0],
      state: {
        ...items[0].state,
        status: "consumed",
        selectedOptionId: body.optionId,
      },
    });
  });
  await openSuggestions();
  await screen.findByText(items[0].content.title);
  click(
    button(
      makeOption().label,
      "button",
      screen.getByRole("article", { name: items[0].content.title }),
    ),
  );
  await requested.promise;
  await screen.findByText(SENT);
  await screen.findByRole("article", { name: items[1].content.title });
  expect(pathname()).toBe(suggestionPath);
  release.resolve();
});
test("An existing conversation opens before consumption and its remote draft finish", async () => {
  const item = {
    ...makeSuggestion(),
    content: {
      ...makeSuggestion().content,
      options: [makeOption({ threadId })],
    },
  };
  mockPool([item]);
  mockChatLifecycle(context, { threadId });
  const consuming = context.mocks.deferred<void>();
  const releaseConsumption = context.mocks.deferred<void>();
  const loadingDraft = context.mocks.deferred<void>();
  const releaseDraft = context.mocks.deferred<void>();
  context.mocks.api(feedContract.consume, async ({ body, respond }) => {
    consuming.resolve();
    await releaseConsumption.promise;
    return respond(200, {
      ...item,
      state: {
        ...item.state,
        status: "consumed",
        selectedOptionId: body.optionId,
      },
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
  await openSuggestions();
  await screen.findByText(item.content.title);
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

async function openForYou(path = "/for-you"): Promise<void> {
  await setupPage({ context, path, featureSwitches: features });
}
async function activeForYouCard(title: string): Promise<HTMLElement> {
  return await screen.findByRole("article", { name: title });
}

test("For you moves suggestions out of the homepage into its own chat-list entry", async () => {
  mockPool(numberedSuggestions(3));
  await setupPage({
    context,
    path: homePath,
    featureSwitches: features,
  });
  await screen.findByTestId("chat-tagline");
  const row = link("/for-you");
  await within(row).findByText("Unread");
  click(row);
  const card = await activeForYouCard("Suggested action 1");
  expect(within(card).getByText("A response is needed")).toBeInTheDocument();
  expect(pathname()).toBe("/for-you");
  expect(link("/for-you")).toHaveAttribute("aria-current", "page");
});

test("For you keeps deck navigation and moves source settings into My Okou", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  await setupPage({
    context,
    path: suggestionPath,
    featureSwitches: {
      ...features,
    },
  });
  await activeForYouCard("Suggested action 1");
  expect(
    queryAllByRoleFast("button").some((control) => {
      return control.getAttribute("aria-label") === "For you sources";
    }),
  ).toBeFalsy();
  click(link(`/for-you?suggestion=${items[1].id}`));
  await activeForYouCard("Suggested action 2");
  expect(link(`/for-you?suggestion=${items[1].id}`)).toHaveAttribute(
    "aria-current",
    "step",
  );
});

test("For you browses without consuming and restores a card from its URL", async () => {
  const items = numberedSuggestions(3);
  const pool = mockPool(items);
  await openForYou(`/for-you?suggestion=${items[1].id}`);
  await activeForYouCard("Suggested action 2");
  pool.publish(numberedSuggestions(4)[3]);
  const next = link(`/for-you?suggestion=${items[2].id}`);
  next.focus();
  await userEvent.setup().keyboard("{Enter}");
  await activeForYouCard("Suggested action 3");
  expect(new URLSearchParams(window.location.search).get("suggestion")).toBe(
    items[2].id,
  );
  click(link(`/for-you?suggestion=${items[1].id}`));
  await activeForYouCard("Suggested action 2");
  expect(pool.consumed).toStrictEqual([]);
  await screen.findByText("3 to go");
});

function holdCardDeparture(article: HTMLElement) {
  const card = article.closest('[data-slot="suggestion-stack-card"]');
  if (!card) {
    throw new Error("Missing suggestion card");
  }
  const finished = context.mocks.deferred<void>();
  Object.defineProperty(card, "getAnimations", {
    configurable: true,
    value: () => {
      return [{ finished: finished.promise }];
    },
  });
  return finished;
}

test("For you mounts only the foreground content and retains a departure until its animation finishes", async () => {
  const items = numberedSuggestions(10);
  const pool = mockPool(items);
  await openForYou();
  const first = await activeForYouCard("Suggested action 1");
  await waitFor(() => {
    expect(
      first.querySelector('[data-slot="for-you-illustration"]'),
    ).toBeInTheDocument();
  });
  const illustration = first
    .querySelector('[data-slot="for-you-illustration"]')
    ?.getAttribute("src");
  expect(screen.queryByText("Suggested action 2")).not.toBeInTheDocument();
  const departure = holdCardDeparture(first);
  click(link(`/for-you?suggestion=${items[1].id}`));
  const second = await activeForYouCard("Suggested action 2");
  expect(first).toBeInTheDocument();
  expect(first.closest("[inert]")).not.toBeNull();
  expect(second.closest("[inert]")).toBeNull();
  expect(
    first.querySelector('[data-slot="for-you-illustration"]'),
  ).toHaveAttribute("src", illustration);
  expect(screen.queryByText("Suggested action 3")).not.toBeInTheDocument();
  departure.resolve();
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });
  expect(pool.consumed).toStrictEqual([]);
});

test("A superseded departure cannot finish a newer For you transition", async () => {
  const items = numberedSuggestions(10);
  mockPool(items);
  await openForYou();
  const first = await activeForYouCard("Suggested action 1");
  const firstDeparture = holdCardDeparture(first);
  click(link(`/for-you?suggestion=${items[1].id}`));
  const second = await activeForYouCard("Suggested action 2");
  const secondDeparture = holdCardDeparture(second);
  click(link(`/for-you?suggestion=${items[2].id}`));
  await activeForYouCard("Suggested action 3");
  firstDeparture.resolve();
  expect(first).not.toBeInTheDocument();
  expect(second).toBeInTheDocument();
  secondDeparture.resolve();
  await waitFor(() => {
    expect(second).not.toBeInTheDocument();
  });
  expect(new URLSearchParams(window.location.search).get("suggestion")).toBe(
    items[2].id,
  );
});

test("Reduced-motion For you navigation immediately releases the previous card in both directions", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(prefers-reduced-motion: reduce)";
  });
  const items = numberedSuggestions(10);
  const pool = mockPool(items);
  await openForYou();
  const first = await activeForYouCard("Suggested action 1");
  click(link(`/for-you?suggestion=${items[1].id}`));
  const second = await activeForYouCard("Suggested action 2");
  expect(first).not.toBeInTheDocument();
  click(link(`/for-you?suggestion=${items[0].id}`));
  await activeForYouCard("Suggested action 1");
  expect(second).not.toBeInTheDocument();
  expect(pool.consumed).toStrictEqual([]);
});

test("For you handles cards in order, completes, and restores a dismissed card with Undo", async () => {
  const pool = mockPool(numberedSuggestions(2));
  await openForYou();
  const first = await activeForYouCard("Suggested action 1");
  click(button("Dismiss", "button", first));
  const second = await activeForYouCard("Suggested action 2");
  await screen.findByText("Suggestion dismissed");
  click(button("Already done", "button", second));
  await screen.findByRole("heading", { name: "All caught up" });
  await screen.findByText("Noted — this is already done");
  expect(pool.consumed).toHaveLength(2);
  await undoSuggestionFeedback();
  await activeForYouCard("Suggested action 2");
});

test("For you sends a suggestion in place while retaining the next card and its background", async () => {
  mockPool(numberedSuggestions(2));
  const sent = captureSend();
  await openForYou();
  const card = await activeForYouCard("Suggested action 1");
  click(button("Review decision", "button", card));
  expect((await sent).userMessage?.parts).toContainEqual(REFERENCED_THREAD);
  await activeForYouCard("Suggested action 2");
  await screen.findByText(SENT);
  expect(pathname()).toBe("/for-you");
});

test("For you expands the composer inside the active card and advances after sending", async () => {
  mockPool(numberedSuggestions(2));
  const sent = captureSend();
  await openForYou();
  const card = await activeForYouCard("Suggested action 1");
  const { editor, note } = await openCustomDirection(card);
  await writeDirection(note, "Summarize the open budget question first");
  await waitFor(() => {
    expect(button("Send", "button", editor)).toBeEnabled();
  });
  click(button("Send", "button", editor));
  const message = await sent;
  expect(JSON.stringify(message.userMessage)).toContain(
    "Summarize the open budget question first",
  );
  expect(JSON.stringify(message.userMessage)).toContain("Launch background");
  await activeForYouCard("Suggested action 2");
  expect(pathname()).toBe("/for-you");
});

test("For you preserves a failed feedback write for an explicit retry", async () => {
  mockPool(numberedSuggestions(2));
  const writes: string[] = [];
  context.mocks.api(feedContract.feedback, ({ body, respond }) => {
    writes.push(body.id);
    return writes.length === 1
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Feedback could not be saved",
          },
        })
      : respond(200, { restored: false });
  });
  await openForYou();
  const card = await activeForYouCard("Suggested action 1");
  click(button("Dismiss", "button", card));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Feedback could not be saved");
  click(button("Try again", "button", alert));
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toBe(writes[0]);
  await activeForYouCard("Suggested action 2");
});

test("An empty For you page stays accessible and reports zero suggestions", async () => {
  mockPool([]);
  await openForYou();
  await screen.findByRole("heading", { name: "All caught up" });
  expect(screen.getByText("0 to go")).toBeInTheDocument();
});

test("Disabling Suggestions returns a direct For you link to the regular homepage", async () => {
  mockPool();
  await setupPage({
    context,
    path: "/for-you",
    featureSwitches: {
      ...features,
      [FeatureSwitchKey.AgentSuggestion]: false,
    },
  });
  await screen.findByTestId("chat-tagline");
  expect(pathname()).toBe(homePath);
});

function makePlatformEvent(): PlatformEvent {
  const timestamp = nowDate().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "event",
    sourceType: "platform-event",
    priority: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: null,
    state: { status: "active" },
    content: {
      eventType: "automation-disabled",
      workflowId: "d0000000-0000-4000-a000-000000000201",
      automationId: "e0000000-0000-4000-a000-000000000201",
      workspaceId: "org_example",
      automationName: "Daily work summary",
      disabledAt: timestamp,
      consecutiveFailures: 3,
      recoveryScheduled: false,
    },
  };
}

test("For you handles a suggestion and a platform event in the same deck", async () => {
  const suggestion = makeSuggestion();
  const pool = mockPool([suggestion]);
  let dismissed = false;
  const event = makePlatformEvent();
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, {
      items: [
        ...(pool.consumed.includes(suggestion.id) ? [] : [suggestion]),
        ...(dismissed ? [] : [event]),
      ],
    });
  });
  context.mocks.api(feedContract.dismiss, ({ respond }) => {
    dismissed = true;
    notifySuggestionsChanged();
    return respond(204);
  });
  await openForYou();
  const first = await activeForYouCard(suggestion.content.title);
  click(button("Dismiss", "button", first));
  await screen.findByRole("heading", { name: "Automation paused" });
  expect(screen.getByText("System update")).toBeInTheDocument();
  click(button("Dismiss"));
  await screen.findByRole("heading", { name: "All caught up" });
  expect(pool.consumed).toStrictEqual([suggestion.id]);
  expect(dismissed).toBeTruthy();
});

test("A hidden For you page leaves its card unread until the member sees it", async () => {
  mockPool();
  const visibility = context.mocks.browser.visibilityState("hidden");
  await setupPage({
    context,
    path: suggestionPath,
    featureSwitches: features,
  });
  await activeForYouCard("Review the pending decision");
  click(link("/workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  await within(link(suggestionPath)).findByText("Unread");
  click(link(suggestionPath));
  await activeForYouCard("Review the pending decision");
  visibility.changeTo("visible");
  await waitFor(() => {
    return expect(
      within(link(suggestionPath)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("1 to go")).toBeInTheDocument();
});

async function openSourceSettings() {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const navigation = within(dialog).getByRole("navigation");
  click(within(navigation).getByText("My Okou"));
  return dialog;
}

test("A failed system update source change keeps the saved choice and allows an explicit retry", async () => {
  mockPool(numberedSuggestions(2));
  let enabled = true;
  let failed = false;
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: true,
      whatsNew: true,
      offers: true,
      systemUpdates: enabled,
    });
  });
  context.mocks.api(feedContract.updateSources, ({ body, respond }) => {
    if (!failed) {
      failed = true;
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Source preference could not be saved",
        },
      });
    }
    enabled = body.systemUpdates ?? enabled;
    return respond(200, {
      suggestions: true,
      whatsNew: true,
      offers: true,
      systemUpdates: enabled,
    });
  });
  await setupPage({
    context,
    path: suggestionPath,
    featureSwitches: features,
  });
  await activeForYouCard("Suggested action 1");
  const dialog = await openSourceSettings();
  const toggle = await within(dialog).findByRole("switch", {
    name: "System updates",
  });
  click(toggle);
  await screen.findByText("Source preference could not be saved");
  expect(toggle).toHaveAttribute("aria-checked", "true");
  await waitFor(() => {
    return expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});

test("For you marks only displayed cards as read and new deliveries restore its unread dot", async () => {
  const items = numberedSuggestions(4);
  const pool = mockPool(items.slice(0, 3));
  await setupPage({ context, path: homePath, featureSwitches: features });
  await within(link(suggestionPath)).findByText("Unread");
  click(link(suggestionPath));
  await activeForYouCard("Suggested action 1");
  click(link(`/for-you?suggestion=${items[1].id}`));
  await activeForYouCard("Suggested action 2");
  expect(within(link(suggestionPath)).getByText("Unread")).toBeInTheDocument();
  click(link(`/for-you?suggestion=${items[2].id}`));
  await activeForYouCard("Suggested action 3");
  await waitFor(() => {
    expect(
      within(link(suggestionPath)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("3 to go")).toBeInTheDocument();
  expect(pool.consumed).toStrictEqual([]);
  click(link("/workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  click(link(suggestionPath));
  await activeForYouCard("Suggested action 1");
  expect(
    within(link(suggestionPath)).queryByText("Unread"),
  ).not.toBeInTheDocument();
  pool.publish(items[3]);
  notifySuggestionsChanged();
  await within(link(suggestionPath)).findByText("Unread");
});

test("For you source choices persist without removing delivered cards and only enabled sources alert", async () => {
  mockPool(numberedSuggestions(3));
  await setupPage({
    context,
    path: suggestionPath,
    featureSwitches: features,
  });
  await activeForYouCard("Suggested action 1");
  let row = link(suggestionPath);
  await within(row).findByText("Unread");
  const dialog = await openSourceSettings();
  const suggestions = await within(dialog).findByRole("switch", {
    name: "Suggestions",
  });
  await waitFor(() => {
    return expect(suggestions).not.toHaveAttribute("aria-disabled", "true");
  });
  click(suggestions);
  await waitFor(() => {
    return expect(suggestions).toHaveAttribute("aria-checked", "false");
  });
  await waitFor(() => {
    return expect(within(row).queryByText("Unread")).not.toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(suggestions).not.toHaveAttribute("aria-disabled", "true");
  });
  click(within(dialog).getByRole("switch", { name: "Offers" }));
  await waitFor(() => {
    return expect(
      within(dialog).getByRole("switch", { name: "Offers" }),
    ).toHaveAttribute("aria-checked", "false");
  });
  await waitFor(() => {
    return expect(suggestions).not.toHaveAttribute("aria-disabled", "true");
  });
  const systemUpdates = within(dialog).getByRole("switch", {
    name: "System updates",
  });
  expect(systemUpdates).toHaveAttribute("aria-checked", "true");
  click(systemUpdates);
  await waitFor(() => {
    return expect(systemUpdates).toHaveAttribute("aria-checked", "false");
  });
  await waitFor(() => {
    return expect(systemUpdates).not.toHaveAttribute("aria-disabled", "true");
  });
  click(button("Close", "button", dialog));
  await activeForYouCard("Suggested action 1");
  click(link("/workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  click(link(suggestionPath));
  await activeForYouCard("Suggested action 1");
  row = link(suggestionPath);
  const reopened = await openSourceSettings();
  const toggle = await within(reopened).findByRole("switch", {
    name: "Suggestions",
  });
  await waitFor(() => {
    return expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(
    within(reopened).getByRole("switch", { name: "Offers" }),
  ).toHaveAttribute("aria-checked", "false");
  expect(
    within(reopened).getByRole("switch", { name: "System updates" }),
  ).toHaveAttribute("aria-checked", "false");
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toHaveAttribute("aria-checked", "true");
  });
  await within(row).findByText("Unread");
});

test("System updates remain unread with optional sources off until their card is displayed", async () => {
  mockPool([]);
  const event = makePlatformEvent();
  let read = false;
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: false,
      whatsNew: false,
      offers: false,
      systemUpdates: true,
    });
  });
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [event] });
  });
  context.mocks.api(feedContract.summary, ({ respond }) => {
    return respond(200, { hasUnread: !read });
  });
  context.mocks.api(feedContract.markRead, ({ respond }) => {
    read = true;
    notifySuggestionsChanged();
    return respond(200, { readAt: nowDate().toISOString() });
  });
  await setupPage({ context, path: homePath, featureSwitches: features });
  await within(link(suggestionPath)).findByText("Unread");
  click(link(suggestionPath));
  await screen.findByRole("heading", { name: "Automation paused" });
  await waitFor(() => {
    expect(
      within(link(suggestionPath)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText(event.content.automationName)).toBeInTheDocument();
  expect(screen.getByText("1 to go")).toBeInTheDocument();
  const dialog = await openSourceSettings();
  const suggestions = await within(dialog).findByRole("switch", {
    name: "Suggestions",
  });
  expect(suggestions).toHaveAttribute("aria-checked", "false");
  expect(
    within(dialog).getByRole("switch", { name: "System updates" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("Don't nudge records the no-repeat direction and Undo targets that feedback", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  const writes: {
    id: string;
    kind: string;
    targetId: string | null;
    note: string;
  }[] = [];
  context.mocks.api(feedContract.feedback, ({ body, respond }) => {
    writes.push(body);
    return respond(200, { restored: body.kind === "undo" });
  });
  await openForYou();
  const first = await activeForYouCard(items[0].content.title);
  click(button("Don’t nudge me", "button", first));
  await activeForYouCard(items[1].content.title);
  await screen.findByText("Noted — please don’t nudge me about this again");
  expect(writes[0]).toMatchObject({
    kind: "not_planned",
    note: "Do not nudge me about this again.",
    targetId: null,
  });
  await undoSuggestionFeedback();
  await activeForYouCard(items[0].content.title);
  await waitFor(() => {
    expect(writes[1]).toMatchObject({ kind: "undo", targetId: writes[0].id });
  });
});

test("Cover and card artwork stay fixed through browsing, feedback and Undo", async () => {
  const items = numberedSuggestions(10);
  mockPool(items);
  await openForYou();
  await activeForYouCard(items[0].content.title);
  const cover = document
    .querySelector('[data-slot="for-you-cover"]')
    ?.getAttribute("src");
  expect(cover).toBe(forYouCovers[0].src);
  const illustrations: string[] = [];
  for (const item of items) {
    click(link(`/for-you?suggestion=${item.id}`));
    const card = await activeForYouCard(item.content.title);
    await waitFor(() => {
      expect(
        card.querySelector('[data-slot="for-you-illustration"]'),
      ).toBeInTheDocument();
    });
    const src = card
      .querySelector('[data-slot="for-you-illustration"]')
      ?.getAttribute("src");
    if (!src) {
      throw new Error("Missing illustration source");
    }
    illustrations.push(src);
    expect(
      document.querySelector('[data-slot="for-you-cover"]'),
    ).toHaveAttribute("src", cover);
  }
  expect(new Set(illustrations).size).toBe(items.length);
  click(link(`/for-you?suggestion=${items[0].id}`));
  const first = await activeForYouCard(items[0].content.title);
  click(button("Dismiss", "button", first));
  const second = await activeForYouCard(items[1].content.title);
  await waitFor(() => {
    expect(
      second.querySelector('[data-slot="for-you-illustration"]'),
    ).toHaveAttribute("src", illustrations[1]);
  });
  await screen.findByText("Suggestion dismissed");
  await undoSuggestionFeedback();
  const restored = await activeForYouCard(items[0].content.title);
  await waitFor(() => {
    expect(
      restored.querySelector('[data-slot="for-you-illustration"]'),
    ).toHaveAttribute("src", illustrations[0]);
  });
  expect(document.querySelector('[data-slot="for-you-cover"]')).toHaveAttribute(
    "src",
    cover,
  );
});

test("The member picks a For you cover, keeps it after reload and can return to the default", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  const resetPage$ = resetSignal();
  const signal = context.store.set(resetPage$, context.signal);
  await setupPage({
    context: { ...context, signal },
    path: suggestionPath,
    featureSwitches: features,
  });
  await activeForYouCard(items[0].content.title);
  const cover = () => {
    return document
      .querySelector('[data-slot="for-you-cover"]')
      ?.getAttribute("src");
  };
  expect(cover()).toBe(forYouCovers[0].src);

  click(button("Change cover"));
  const picker = await screen.findByRole("dialog", { name: "Change cover" });
  expect(button("Cover 1", "radio", picker)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  click(button("Cover 8", "radio", picker));
  await waitFor(() => {
    expect(cover()).toBe(forYouCovers[7].src);
  });
  expect(button("Cover 8", "radio", picker)).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // A fresh app store reads the cover back from browser storage.
  context.store.set(resetPage$);
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  await setupPage({
    context: reloadedContext,
    path: suggestionPath,
    featureSwitches: features,
  });
  await activeForYouCard(items[0].content.title);
  expect(cover()).toBe(forYouCovers[7].src);

  click(button("Change cover"));
  const reopened = await screen.findByRole("dialog", { name: "Change cover" });
  click(button("Cover 1", "radio", reopened));
  await waitFor(() => {
    expect(cover()).toBe(forYouCovers[0].src);
  });

  // The gallery is a radio group: arrow keys move the selection.
  const user = userEvent.setup();
  button("Cover 1", "radio", reopened).focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(cover()).toBe(forYouCovers[1].src);
  });
  expect(button("Cover 2", "radio", reopened)).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("Horizontal swipes browse without consuming while vertical and control gestures stay local", async () => {
  const items = numberedSuggestions(3);
  const pool = mockPool(items);
  await openForYou();
  const first = await activeForYouCard(items[0].content.title);
  fireEvent.pointerDown(first, {
    clientX: 200,
    clientY: 100,
    pointerId: 1,
    button: 0,
  });
  fireEvent.pointerUp(first, {
    clientX: 100,
    clientY: 100,
    pointerId: 1,
    button: 0,
  });
  const second = await activeForYouCard(items[1].content.title);
  fireEvent.pointerDown(second, {
    clientX: 200,
    clientY: 100,
    pointerId: 2,
    button: 0,
  });
  fireEvent.pointerUp(second, {
    clientX: 100,
    clientY: 300,
    pointerId: 2,
    button: 0,
  });
  const input = button(DIRECTION, "button", second);
  fireEvent.pointerDown(input, {
    clientX: 200,
    clientY: 100,
    pointerId: 3,
    button: 0,
  });
  fireEvent.pointerUp(input, {
    clientX: 100,
    clientY: 100,
    pointerId: 3,
    button: 0,
  });
  expect(second).toBeInTheDocument();
  expect(pool.consumed).toStrictEqual([]);
  expect(new URLSearchParams(window.location.search).get("suggestion")).toBe(
    items[1].id,
  );
});
