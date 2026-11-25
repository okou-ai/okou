import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import {
  feedContract,
  type Suggestion,
  type SuggestionOption,
  type FeedSources,
} from "@okouai/api-contracts/contracts/feed";
import {
  chatEventsContract,
  chatThreadDraftContract,
  chatThreadByIdContract,
  type ChatThreadDraft,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
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
import { nowDate } from "../../../lib/time.ts";
vi.hoisted(() => {
  window.location.href = "https://app.okou.ai/";
});
const context = testContext();
beforeEach(() => {
  context.mocks.posthog();
});
function cardEvents(name: string) {
  return context.mocks
    .posthog()
    .events.filter((event) => {
      return event.name === name;
    })
    .map((event) => {
      return event.properties;
    });
}
const reloadedContext = createTestRuntime(context);
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
// Suggestions live independently of the workspace new-chat draft.
const suggestionPath = "/for-you";
const homePath = "/";
async function openSuggestions(): Promise<void> {
  await setupPage({ context, path: suggestionPath });
}
async function openSuggestionsWithDraft(draft: string): Promise<void> {
  await setupPage({ context, path: homePath });
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
): Promise<{
  editor: HTMLElement;
  note: HTMLElement;
}> {
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
  const [shown] = cardEvents("suggestion_card_shown");
  const impression = {
    suggestion_id: suggestion.id,
    impression_id: shown?.impression_id,
    surface: "home_suggestions",
  };
  expect(shown).toStrictEqual({
    ...impression,
    impression_id: expect.any(String),
    option_ids: ["review", "prepare", "summarize"],
    option_count: 3,
  });
  const preset = { ...impression, option_id: "prepare", option_position: 2 };
  expect(cardEvents("suggestion_card_action_clicked")).toStrictEqual([
    { ...preset, action: "select_option" },
  ]);
  expect(cardEvents("suggestion_card_message_sent")).toStrictEqual([
    { ...preset, direction_type: "preset" },
  ]);
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
test("A saved suggestion keeps its attribution when the reloaded composer joins a running chat", async () => {
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
  let saved: ChatThreadDraft = {
    draftUserMessage: null,
    draftAttachments: null,
  };
  context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
    saved = { ...body, draftAttachments: body.draftAttachments ?? null };
    return respond(204);
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, saved);
  });
  const resetPage$ = resetSignal();
  const signal = context.store.set(resetPage$, context.signal);
  await setupPage({
    context: { ...context, signal },
    path: suggestionPath,
  });
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
  await waitFor(() => {
    expect(saved.suggestionPreset?.option_id).toBe("review");
  });
  expect(cardEvents("suggestion_card_message_sent")).toHaveLength(0);
  click(link("/workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  context.store.set(resetPage$);
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  await setupPage({
    context: reloadedContext,
    path: `/chats/${threadId}`,
  });
  await screen.findByText("Referenced decision");
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    return expect(queued).toHaveLength(1);
  });
  const [selection] = cardEvents("suggestion_card_action_clicked");
  await waitFor(() => {
    expect(cardEvents("suggestion_card_message_sent")).toStrictEqual([
      {
        surface: "home_suggestions",
        suggestion_id: makeSuggestion().id,
        impression_id: selection?.impression_id,
        direction_type: "preset",
        option_id: "review",
        option_position: 1,
      },
    ]);
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "chat_thread",
    threadId,
    titleSnapshot: "Referenced decision",
  });
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
test("agent-suggestions-021 A custom follow-up retains its editor on failure and reuses its identities until acceptance", async () => {
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
  expect(attempts[0].threadId).toBeTruthy();
  expect(attempts[0].clientEventId).toBeTruthy();
  expect(attempts[1]).toStrictEqual(attempts[0]);
  const [quote] = suggestionFeedbacks(
    attempts[1].userMessage ?? { version: 1, parts: [] },
  );
  expect(quote.part.quote).toContain("launch-plan-v2");
  expect(JSON.stringify(quote.part.note)).toContain(
    "Assess the budget risk first",
  );
  expect(cardEvents("suggestion_card_message_sent")).toStrictEqual([]);
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
  const [open] = cardEvents("suggestion_card_action_clicked");
  expect(open?.action).toBe("open_custom");
  expect(cardEvents("suggestion_card_message_sent")).toStrictEqual([
    {
      surface: "home_suggestions",
      suggestion_id: makeSuggestion().id,
      impression_id: open?.impression_id,
      direction_type: "custom",
    },
  ]);
  // The API records the custom follow-up when it accepts the input.
  expect(pool.consumed).toStrictEqual([]);
});
async function openForYou(path = "/for-you"): Promise<void> {
  await setupPage({ context, path });
}
async function activeForYouCard(title: string): Promise<HTMLElement> {
  return await screen.findByRole("article", { name: title });
}
test("A hidden For you page leaves its card unread until the member sees it", async () => {
  mockPool();
  const visibility = context.mocks.browser.visibilityState("hidden");
  const Observer = window.IntersectionObserver;
  vi.spyOn(window, "IntersectionObserver").mockImplementation(
    class extends Observer {
      constructor(private readonly notify: IntersectionObserverCallback) {
        super(notify);
      }
      override observe(target: Element) {
        const bounds = target.getBoundingClientRect();
        this.notify(
          [
            {
              target,
              isIntersecting: true,
              intersectionRatio: 1,
              boundingClientRect: bounds,
              intersectionRect: bounds,
              rootBounds: null,
              time: 0,
            },
          ],
          this,
        );
      }
    },
  );
  await setupPage({
    context,
    path: suggestionPath,
  });
  await activeForYouCard("Review the pending decision");
  click(link("/workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  await within(link(suggestionPath)).findByText("Unread");
  click(link(suggestionPath));
  await activeForYouCard("Review the pending decision");
  expect(cardEvents("suggestion_card_shown")).toHaveLength(0);
  visibility.changeTo("visible");
  await waitFor(() => {
    return expect(
      within(link(suggestionPath)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  const [first] = cardEvents("suggestion_card_shown");
  expect(first?.impression_id).toStrictEqual(expect.any(String));
  visibility.changeTo("hidden");
  visibility.changeTo("visible");
  expect(cardEvents("suggestion_card_shown")).toHaveLength(1);
  click(link("/workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  click(link(suggestionPath));
  await activeForYouCard("Review the pending decision");
  const impressions = cardEvents("suggestion_card_shown");
  expect(impressions).toHaveLength(2);
  expect(impressions[1]?.impression_id).not.toBe(first?.impression_id);
  expect(screen.getByText("1 to go")).toBeInTheDocument();
  click(screen.getByLabelText("View source"));
  expect(cardEvents("suggestion_card_action_clicked")).toStrictEqual([
    {
      surface: "home_suggestions",
      suggestion_id: makeSuggestion().id,
      impression_id: impressions[1]?.impression_id,
      action: "view_source",
    },
  ]);
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
    const [shown] = cardEvents("suggestion_card_shown");
    const context = {
      surface: "home_suggestions",
      suggestion_id: items[0].id,
      impression_id: shown?.impression_id,
      feedback_kind: "dont_nudge",
    };
    expect(cardEvents("suggestion_card_feedback_recorded")).toStrictEqual([
      { ...context, operation: "apply" },
      { ...context, operation: "undo" },
    ]);
  });
});
