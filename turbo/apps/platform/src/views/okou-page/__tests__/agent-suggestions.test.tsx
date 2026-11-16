import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
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
  [FeatureSwitchKey.ProactiveLearning]: false,
} as const;
// Suggestions live independently of the default Agent's new-chat draft.
const suggestionPath = "/for-you";
const homePath = `/agents/${agentId}/chat`;
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
async function openCustomDirection(
  container: ParentNode = document.body,
): Promise<{
  dialog: HTMLElement;
  note: HTMLElement;
}> {
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
test("The For you row's count follows committed suggestion changes", async () => {
  const pool = mockPool(numberedSuggestions(2));
  await openSuggestions();
  await within(link(suggestionPath)).findByLabelText("2 waiting");
  click(button("Dismiss"));
  await within(link(suggestionPath)).findByLabelText("1 waiting");
  pool.publish(numberedSuggestions(3)[2]);
  notifySuggestionsChanged();
  await within(link(suggestionPath)).findByLabelText("2 waiting");
  pool.withdrawAll();
  notifySuggestionsChanged();
  const emptyCount = await within(link(suggestionPath)).findByLabelText(
    "0 waiting",
  );
  expect(emptyCount).toBeInTheDocument();
});
test("Each For you visit loads new suggestions", async () => {
  const [first, second] = numberedSuggestions(2);
  const pool = mockPool([first]);
  await openSuggestions();
  await screen.findByText(first.content.title);
  click(link("/agents"));
  await screen.findByRole("heading", { name: "Agents" });
  pool.publish(second);
  click(link(suggestionPath));
  await screen.findByText("2 to go");
  click(link(`/for-you?suggestion=${second.id}`));
  const card = await screen.findByRole("article", {
    name: second.content.title,
  });
  expect(card).toBeInTheDocument();
});
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
test("Suggestion options start in the default Agent after visiting a secondary Agent", async () => {
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
  click(link(suggestionPath));
  await screen.findByText(makeSuggestion().content.title);
  expect(pathname()).toBe(suggestionPath);
  click(button(makeOption().label));
  await screen.findByText(SENT);
  await expect(sender.promise).resolves.toBe(agentId);
  expect(pathname()).toBe(suggestionPath);
});
test("Custom direction opens a dialog composer for the default Agent without touching its home draft", async () => {
  const pool = mockPool();
  await openSuggestionsWithDraft("Keep my original draft");
  await screen.findByText(makeSuggestion().content.title);
  const custom = button("I’d like to…");
  expect(custom).toHaveTextContent(
    "Ask a question or describe what you’d like to do.",
  );
  expect(
    custom.compareDocumentPosition(button("Dismiss")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const { dialog, note } = await openCustomDirection();
  expect(pathname()).toBe(suggestionPath);
  expect(composer(dialog)).toHaveTextContent(makeSuggestion().content.title);
  expect(composer(dialog)).not.toHaveTextContent("launch-plan-v2");
  expect(composer(dialog)).not.toHaveTextContent("Keep my original draft");
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
    screen.getByRole("article", { name: makeSuggestion().content.title }),
  ).toBeInTheDocument();
  click(okouRow());
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Keep my original draft");
  });
  expect(composer()).not.toHaveTextContent(makeSuggestion().content.title);
});
test("Each custom direction dialog starts from its own card's background", async () => {
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
  expect(composer(opened.dialog)).toHaveTextContent(first.content.title);
  await writeDirection(opened.note, "Assess the risks first");
  click(within(opened.dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(link(`/for-you?suggestion=${second.id}`));
  await screen.findByRole("article", { name: second.content.title });
  const reopened = await openCustomDirection(
    screen.getByRole("article", { name: second.content.title }),
  );
  expect(composer(reopened.dialog)).toHaveTextContent(second.content.title);
  expect(composer(reopened.dialog)).not.toHaveTextContent(first.content.title);
  expect(composer(reopened.dialog)).not.toHaveTextContent(
    "Assess the risks first",
  );
  click(within(screen.getByRole("dialog")).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(
    screen.getByRole("article", { name: second.content.title }),
  ).toBeInTheDocument();
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
  await openSuggestions();
  await screen.findByText(makeSuggestion().content.title);
  const { dialog, note } = await openCustomDirection();
  await writeDirection(note, "Assess the budget risk first");
  await waitFor(() => {
    return expect(button("Send", "button", dialog)).not.toBeDisabled();
  });
  click(button("Send", "button", dialog));
  await screen.findByText("Follow-up temporarily unavailable");
  expect(pathname()).toBe(suggestionPath);
  expect(composer(dialog)).toHaveTextContent("Assess the budget risk first");
  expect(composer(dialog)).toHaveTextContent(makeSuggestion().content.title);
  failing = false;
  click(button("Send", "button", dialog));
  await retryRequested.promise;
  expect(composer(dialog)).toHaveTextContent("Assess the budget risk first");
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
  expect(pathname()).toBe(suggestionPath);
  expect(
    screen.queryByRole("article", { name: makeSuggestion().content.title }),
  ).not.toBeInTheDocument();
  await screen.findByRole("heading", { name: "All caught up" });
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
  click(link(suggestionPath));
  await screen.findByText(suggestion.content.title);
  const { dialog, note } = await openCustomDirection();
  await within(dialog).findByText("suggestion-background.txt");
  expect(within(dialog).queryByText("my-original.txt")).not.toBeInTheDocument();
  expect(composer(dialog)).not.toHaveTextContent("My saved draft");
  await writeDirection(note, "Keep my own requirements");
  await waitFor(() => {
    expect(button("Send", "button", dialog)).toBeEnabled();
  });
  click(button("Send", "button", dialog));
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
  click(button("Undo"));
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
  click(button("Undo"));
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
  click(button("Undo"));
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
    featureSwitches: {
      ...features,
      [FeatureSwitchKey.HomeCapabilities]: true,
    },
  });
  await screen.findByTestId("chat-tagline");
  const row = link("/for-you");
  await within(row).findByLabelText("3 waiting");
  click(row);
  const card = await activeForYouCard("Suggested action 1");
  expect(within(card).getByText("A response is needed")).toBeInTheDocument();
  expect(pathname()).toBe("/for-you");
  expect(link("/for-you")).toHaveAttribute("aria-current", "page");
});

test("For you browses without consuming and restores a card from its URL", async () => {
  const items = numberedSuggestions(3);
  const pool = mockPool(items);
  await openForYou(`/for-you?suggestion=${items[1].id}`);
  await activeForYouCard("Suggested action 2");
  pool.publish(numberedSuggestions(4)[3]);
  click(link(`/for-you?suggestion=${items[2].id}`));
  await activeForYouCard("Suggested action 3");
  expect(new URLSearchParams(window.location.search).get("suggestion")).toBe(
    items[2].id,
  );
  click(link(`/for-you?suggestion=${items[1].id}`));
  await activeForYouCard("Suggested action 2");
  expect(pool.consumed).toStrictEqual([]);
  await screen.findByText("3 to go");
  await within(link("/for-you")).findByLabelText("3 waiting");
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
  click(button("Undo"));
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

test("For you keeps custom directions in the existing composer and advances after sending", async () => {
  mockPool(numberedSuggestions(2));
  const sent = captureSend();
  await openForYou();
  const card = await activeForYouCard("Suggested action 1");
  const { dialog, note } = await openCustomDirection(card);
  await writeDirection(note, "Summarize the open budget question first");
  await waitFor(() => {
    expect(button("Send", "button", dialog)).toBeEnabled();
  });
  click(button("Send", "button", dialog));
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
  const count = await within(link("/for-you")).findByLabelText("0 waiting");
  expect(count).toBeInTheDocument();
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
  await screen.findByRole("heading", { name: "Automation disabled" });
  expect(screen.getByText("Platform event")).toBeInTheDocument();
  click(button("Dismiss"));
  await screen.findByRole("heading", { name: "All caught up" });
  expect(pool.consumed).toStrictEqual([suggestion.id]);
  expect(dismissed).toBeTruthy();
});

const sourceFeatures = {
  ...features,
  [FeatureSwitchKey.ForYouSources]: true,
} as const;

test("A hidden For you page leaves its card unread until the member sees it", async () => {
  mockPool();
  const visibility = context.mocks.browser.visibilityState("hidden");
  await setupPage({
    context,
    path: suggestionPath,
    featureSwitches: sourceFeatures,
  });
  await activeForYouCard("Review the pending decision");
  click(link("/agents"));
  await screen.findByRole("heading", { name: "Agents" });
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
    featureSwitches: sourceFeatures,
  });
  await activeForYouCard("Suggested action 1");
  click(button("For you sources"));
  const dialog = await screen.findByRole("dialog", { name: "For you sources" });
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
  await setupPage({ context, path: homePath, featureSwitches: sourceFeatures });
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
  click(link("/agents"));
  await screen.findByRole("heading", { name: "Agents" });
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
    featureSwitches: sourceFeatures,
  });
  await activeForYouCard("Suggested action 1");
  let row = link(suggestionPath);
  await within(row).findByText("Unread");
  click(button("For you sources"));
  const dialog = await screen.findByRole("dialog", { name: "For you sources" });
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
  click(link("/agents"));
  await screen.findByRole("heading", { name: "Agents" });
  click(link(suggestionPath));
  await activeForYouCard("Suggested action 1");
  row = link(suggestionPath);
  click(button("For you sources"));
  const reopened = await screen.findByRole("dialog", {
    name: "For you sources",
  });
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
  await setupPage({ context, path: homePath, featureSwitches: sourceFeatures });
  await within(link(suggestionPath)).findByText("Unread");
  click(link(suggestionPath));
  await screen.findByRole("heading", { name: "Automation disabled" });
  await waitFor(() => {
    expect(
      within(link(suggestionPath)).queryByText("Unread"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText(event.content.automationName)).toBeInTheDocument();
  expect(screen.getByText("1 to go")).toBeInTheDocument();
  click(button("For you sources"));
  const dialog = await screen.findByRole("dialog", { name: "For you sources" });
  const suggestions = await within(dialog).findByRole("switch", {
    name: "Suggestions",
  });
  expect(suggestions).toHaveAttribute("aria-checked", "false");
  expect(
    within(dialog).getByRole("switch", { name: "System updates" }),
  ).toHaveAttribute("aria-checked", "true");
});
