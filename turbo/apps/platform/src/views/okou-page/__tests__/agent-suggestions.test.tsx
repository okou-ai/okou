import {
  mockTaskChipLayout,
  taskMenuItem,
} from "./composer-task-chip-layout.ts";
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
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
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
    feedbackScope: { key: "project-review", label: "project review" },
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
function button(name: string, role: "button" | "tab" = "button") {
  const found = queryAllByRoleFast(role).find((element) => {
    return (
      element.textContent?.trim().startsWith(name) ||
      element.getAttribute("aria-label") === name
    );
  });
  if (!found) {
    throw new Error(
      `Missing ${role}: ${name}; available: ${queryAllByRoleFast(role)
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
function link(href: string) {
  const found = queryAllByRoleFast("link").find((element) => {
    return element.getAttribute("href") === href;
  });
  if (!found) {
    throw new Error(`Missing link: ${href}`);
  }
  return found;
}
function queryTab(name: string) {
  return (
    queryAllByRoleFast("tab").find((element) => {
      return element.textContent?.trim() === name;
    }) ?? null
  );
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
  context.mocks.api(proactiveJobsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
  });
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
  [FeatureSwitchKey.ProactiveAgent]: false,
} as const;

test("Selecting a cached card restores its draft after server cleanup", async () => {
  const suggestion = { ...makeSuggestion(), consumeToken: "a".repeat(64) };
  const pool = mockPool([suggestion]);
  context.mocks.api(suggestionsContract.consume, ({ body, respond }) => {
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(suggestion.title);
  await fill(composer(), "My original draft");
  pool.withdrawAll();
  click(button(makeOption().label));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Referenced decision");
    expect(composer()).toHaveTextContent("My original draft");
  });
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
});

test("Selecting a task hides the categories, focuses the composer, and restores Suggestions when cleared", async () => {
  const user = userEvent.setup();
  mockPool();
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  expect(
    screen.getByRole("tablist", { name: "Choose a task" }),
  ).toContainElement(button("Suggestions", "tab"));
  expect(button("Suggestions", "tab")).toHaveAttribute("aria-selected", "true");
  await fill(composer(), "My draft stays here");
  click(button("Image", "tab"));
  await screen.findByText("Put my product in a new scene");
  expect(composer()).toHaveTextContent("My draft stays here");
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(button("Remove Image")).toBeInTheDocument();
  await waitFor(() => {
    expect(composer()).toHaveFocus();
  });
  click(button("Remove Image"));
  await screen.findByText(makeSuggestion().title);
  await user.click(button("Suggestions", "tab"));
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    return expect(button("Workflow", "tab")).toHaveFocus();
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(button("Remove Workflow")).toBeInTheDocument();
    expect(composer()).toHaveFocus();
  });
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(composer()).toHaveTextContent("My draft stays here");
});

test.each([
  "Workflow",
  "Presentation",
  "Document",
  "Image",
  "Website",
  "Visualization",
])(
  "Selecting %s hides the entire row with an empty suggestion pool",
  async (task) => {
    mockPool([]);
    await setupPage({
      context,
      path: `/agents/${agentId}/chat`,
      featureSwitches: {
        ...features,
        [FeatureSwitchKey.ProactiveAgent]: true,
      },
    });
    await waitFor(() => {
      expect(queryTab(task)).toBeInTheDocument();
    });
    await fill(composer(), "Keep my draft");
    click(button(task, "tab"));
    await waitFor(() => {
      expect(button(`Remove ${task}`)).toBeInTheDocument();
      expect(composer()).toHaveFocus();
    });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Choose a task" }),
    ).not.toBeInTheDocument();
    expect(composer()).toHaveTextContent("Keep my draft");
    click(button(`Remove ${task}`));
    await waitFor(() => {
      expect(queryTab(task)).toBeInTheDocument();
    });
    expect(
      queryAllByRoleFast("tab").map((tab) => {
        return tab.textContent?.trim();
      }),
    ).toStrictEqual([
      "Tasks",
      "Workflow",
      "Presentation",
      "Document",
      "Image",
      "Website",
      "Visualization",
    ]);
    expect(composer()).toHaveTextContent("Keep my draft");
  },
);

test("Returning to the Agent home loads new suggestions and preserves the draft", async () => {
  const pool = mockPool([]);
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await waitFor(() => {
    expect(queryTab("Workflow")).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(queryTab("Suggestions")).not.toBeInTheDocument();
  });
  await fill(composer(), "Keep my draft");
  click(link("/agents"));
  await screen.findByRole("heading", { name: "Agents" });

  pool.publish(makeSuggestion());
  click(link(`/agents/${agentId}/chat`));
  await screen.findByText(makeSuggestion().title);
  expect(queryTab("Suggestions")).toBeInTheDocument();
  expect(composer()).toHaveTextContent("Keep my draft");
});
test("An expanded suggestion adds the selected option to the ordinary composer without replacing its draft", async () => {
  const user = userEvent.setup();
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
  const pool = mockPool([suggestion]);
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  await fill(composer(), "My original draft");
  expect(button("Review decision")).toBeInTheDocument();
  expect(button("Summarize the decision")).toBeInTheDocument();
  await user.click(button(selected.label));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Referenced decision");
    expect(composer()).toHaveTextContent("My original draft");
  });
  expect(pool.consumed).toStrictEqual([makeSuggestion().id]);
  expect(pool.selections).toStrictEqual([
    { id: suggestion.id, optionId: selected.id },
  ]);
  expect(composer()).not.toHaveTextContent("Unselected action");
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
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
test("A consumed suggestion reaches its saved draft before target metadata is available", async () => {
  const suggestion = {
    ...makeSuggestion(),
    options: [makeOption({ threadId })],
  };
  const pool = mockPool([suggestion]);
  mockChatLifecycle(context, { threadId });
  const saved: (UserMessageDocument | null | undefined)[] = [];
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Thread metadata is unavailable" },
    });
  });
  context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
    saved.push(body.draftUserMessage);
    return respond(204);
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(suggestion.title);
  click(button(suggestion.options[0].label));
  await waitFor(() => {
    expect(saved).toContainEqual(suggestion.options[0].draft.draftUserMessage);
  });
  expect(pool.consumed).toStrictEqual([suggestion.id]);
});
test("A choice keeps the locally prepared draft when another session consumed the card", async () => {
  const pool = mockPool();
  context.mocks.api(suggestionsContract.consume, ({ respond }) => {
    // Another session consumed it first and the API announced the change.
    pool.withdrawAll();
    notifySuggestionsChanged();
    return respond(409, {
      error: { code: "CONFLICT", message: "Already consumed" },
    });
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  await fill(composer(), "Keep this draft");
  click(button(makeOption().label));
  await waitFor(() => {
    return expect(queryTab("Suggestions")).not.toBeInTheDocument();
  });
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
  expect(composer()).toHaveTextContent("Keep this draft");
  expect(composer()).toHaveTextContent("Referenced decision");
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
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
  mockChatLifecycle(context, { threadId });
  context.mocks.api(suggestionsContract.consume, ({ respond }) => {
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  click(button(makeOption().label));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Referenced decision");
  });
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
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
test("Suggestions loop in both directions without modifying the composer", async () => {
  const user = userEvent.setup();
  mockPool(numberedSuggestions(3));
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText("Suggested action 1");
  expect(screen.getByText("1 of 3")).toBeInTheDocument();
  expect(screen.queryByText("Suggested action 2")).not.toBeInTheDocument();
  await fill(composer(), "Keep this draft");
  await user.click(button("Next suggestion"));
  await screen.findByText("Suggested action 2");
  expect(screen.getByText("2 of 3")).toBeInTheDocument();
  expect(screen.queryByText("Suggested action 1")).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  await screen.findByText("Suggested action 3");
  expect(screen.getByText("3 of 3")).toBeInTheDocument();
  await user.keyboard("{Enter}");
  await screen.findByText("Suggested action 1");
  expect(screen.getByText("1 of 3")).toBeInTheDocument();
  expect(button("Next suggestion")).toHaveFocus();
  await user.click(button("Previous suggestion"));
  await screen.findByText("Suggested action 3");
  expect(screen.getByText("3 of 3")).toBeInTheDocument();
  expect(button("Previous suggestion")).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByText("Suggested action 2");
  expect(composer()).toHaveTextContent("Keep this draft");
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
});
test("Dismissing a suggestion consumes it without opening it and brings up the next one", async () => {
  const pool = mockPool(numberedSuggestions(2));
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText("Suggested action 1");
  await fill(composer(), "Keep this draft");
  click(button("Dismiss"));
  await screen.findByText("Suggested action 2");
  expect(screen.getByText("1 of 1")).toBeInTheDocument();
  expect(button("Previous suggestion")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(button("Next suggestion")).toHaveAttribute("aria-disabled", "true");
  await waitFor(() => {
    expect(pool.consumed).toStrictEqual([
      "a0000000-0000-4000-a000-000000000001",
    ]);
  });
  expect(composer()).toHaveTextContent("Keep this draft");
  expect(composer()).not.toHaveTextContent("Referenced decision");
  expect(pool.selections).toStrictEqual([
    { id: makeSuggestion().id, optionId: null },
  ]);
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
  click(button("Dismiss"));
  await waitFor(() => {
    expect(pool.consumed).toStrictEqual([
      "a0000000-0000-4000-a000-000000000001",
      "a0000000-0000-4000-a000-000000000002",
    ]);
  });
  expect(queryTab("Suggestions")).toBeInTheDocument();
  await userEvent.setup().click(button("Close feedback"));
  await waitFor(() => {
    expect(queryTab("Suggestions")).not.toBeInTheDocument();
  });
  expect(composer()).toHaveTextContent("Keep this draft");
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  await fill(composer(), "Keep my home draft");
  click(button(makeOption().label));
  await screen.findByRole("heading", { name: "Chat thread not found" });
  expect(pathname()).toBe(`/chats/${threadId}`);
  click(link(`/agents/${agentId}/chat`));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Keep my home draft");
  });
});

test("The switch-off and secondary-Agent home retain their ordinary starting points", async () => {
  mockPool();
  await setupPage({ context, path: `/agents/${agentId}/chat` });
  expect(
    queryAllByRoleFast("tab").some((entry) => {
      return entry.textContent?.trim() === "Suggestions";
    }),
  ).toBeFalsy();
  expect(button("Workflow")).toBeInTheDocument();
});
test("An enabled secondary Agent does not display the user's suggestions", async () => {
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
  await setupPage({
    context,
    path: `/agents/${secondary}/chat`,
    featureSwitches: features,
  });
  expect(button("Workflow")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("tab").some((entry) => {
      return entry.textContent?.trim() === "Suggestions";
    }),
  ).toBeFalsy();
  expect(screen.queryByText(makeSuggestion().title)).not.toBeInTheDocument();
});

test("Custom direction stays expanded above the feedback actions and only prepares the saved composer", async () => {
  const pool = mockPool();
  const saved: UserMessageDocument[] = [];
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    if (body.draftUserMessage) {
      saved.push(body.draftUserMessage);
    }
    return respond(204);
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  const custom = button("I’d like to…");
  expect(custom).toHaveTextContent(
    "Ask a question or describe what you’d like to do.",
  );
  expect(
    custom.compareDocumentPosition(button("Dismiss")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await fill(composer(), "Keep my original draft");
  await userEvent.setup().click(custom);
  await waitFor(() => {
    return expect(button("Go on…")).toHaveAttribute("aria-pressed", "true");
  });
  expect(button("Go on…")).toHaveTextContent(
    "Add your message above, then send.",
  );
  expect(
    screen.getByRole("textbox", { name: "What do you have in mind?" }),
  ).toBeInTheDocument();
  expect(composer()).toHaveTextContent("Keep my original draft");
  expect(composer()).toHaveTextContent(makeSuggestion().title);
  expect(composer()).not.toHaveTextContent("launch-plan-v2");
  expect(button("Send")).toBeDisabled();
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
  expect(pool.consumed).toStrictEqual([]);
  await waitFor(() => {
    return expect(saved.length).toBeGreaterThan(0);
  });
  const quote = suggestionFeedbacks(
    saved.at(-1) ?? { version: 1, parts: [] },
  )[0];
  expect(quote.part.quote).toContain("source launch-plan-v2");
  expect(quote.part.note).toStrictEqual([]);
  await userEvent.setup().keyboard("What decision should I make first?");
  await waitFor(() => {
    return expect(button("Send")).not.toBeDisabled();
  });
  await userEvent.setup().click(button("Remove feedback"));
  expect(composer()).toHaveTextContent("What decision should I make first?");
  expect(composer()).toHaveTextContent("Keep my original draft");
  expect(composer()).not.toHaveTextContent(makeSuggestion().title);
  expect(pool.consumed).toStrictEqual([]);
});

test("Browsing preserves prepared context; explicitly choosing another card replaces it and keeps the note", async () => {
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
  const saved: UserMessageDocument[] = [];
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    if (body.draftUserMessage) {
      saved.push(body.draftUserMessage);
    }
    return respond(204);
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(first.title);
  await userEvent.setup().click(button("I’d like to…"));
  await waitFor(() => {
    return expect(button("Go on…")).not.toBeDisabled();
  });
  await userEvent.setup().keyboard("Assess the risks first");
  await userEvent.setup().click(button("Next suggestion"));
  expect(composer()).toHaveTextContent(first.title);
  expect(composer()).not.toHaveTextContent(second.title);
  await userEvent.setup().click(button("I’d like to…"));
  await waitFor(() => {
    return expect(composer()).toHaveTextContent(second.title);
  });
  expect(composer()).toHaveTextContent("Assess the risks first");
  await waitFor(() => {
    return expect(
      suggestionFeedbacks(saved.at(-1) ?? { version: 1, parts: [] })[0]?.part
        .quote,
    ).toContain("BUDGET-42");
  });
  expect(
    suggestionFeedbacks(saved.at(-1) ?? { version: 1, parts: [] }),
  ).toHaveLength(1);
  expect(
    suggestionFeedbacks(saved.at(-1) ?? { version: 1, parts: [] })[0].part
      .quote,
  ).not.toContain("launch-plan-v2");
});

test("A custom follow-up retains its draft on failure and reuses its identities until acceptance", async () => {
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  await userEvent.setup().click(button("I’d like to…"));
  await waitFor(() => {
    return expect(button("Go on…")).not.toBeDisabled();
  });
  await userEvent.setup().keyboard("Assess the budget risk first");
  await waitFor(() => {
    return expect(button("Send")).not.toBeDisabled();
  });
  await userEvent.setup().click(button("Send"));
  await screen.findByText("Follow-up temporarily unavailable");
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
  expect(composer()).toHaveTextContent("Assess the budget risk first");
  expect(composer()).toHaveTextContent(makeSuggestion().title);
  expect(pool.consumed).toStrictEqual([]);
  failing = false;
  await userEvent.setup().click(button("Send"));
  await retryRequested.promise;
  expect(composer()).toHaveTextContent("Assess the budget risk first");
  expect(attempts[1]).toStrictEqual(attempts[0]);
  expect(
    suggestionFeedbacks(attempts[1].userMessage ?? { version: 1, parts: [] })[0]
      .part.quote,
  ).toContain("launch-plan-v2");
  acceptRetry.resolve();
  await waitFor(() => {
    return expect(pathname()).toBe(`/chats/${attempts[1].threadId}`);
  });
  await expect(
    screen.findByText("Assess the budget risk first"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText(
      "Launch background: source launch-plan-v2. Budget and owner are not confirmed.",
    ),
  ).not.toBeInTheDocument();
});

test("Removing custom context preserves the member's original draft and files", async () => {
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(suggestion.title);
  await screen.findByText("my-original.txt");
  await userEvent.setup().click(button("I’d like to…"));
  await screen.findByText("suggestion-background.txt");
  await waitFor(() => {
    return expect(button("Go on…")).not.toBeDisabled();
  });
  await userEvent.setup().keyboard("Keep my own requirements");
  await userEvent.setup().click(button("Remove feedback"));
  await waitFor(() => {
    return expect(
      screen.queryByText("suggestion-background.txt"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByText("my-original.txt")).toBeInTheDocument();
  expect(composer()).toHaveTextContent("My saved draft");
  expect(composer()).toHaveTextContent("Keep my own requirements");
});

test("Suggestions stays outside More when Tasks and the creation categories overflow", async () => {
  mockTaskChipLayout(280);
  mockPool();
  const user = userEvent.setup();
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: { ...features, [FeatureSwitchKey.ProactiveAgent]: true },
  });
  await screen.findByText(makeSuggestion().title);
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.textContent?.trim();
    }),
  ).toStrictEqual(["Suggestions"]);
  await user.click(button("More"));
  expect(taskMenuItem("Tasks")).toBeInTheDocument();
  await user.click(taskMenuItem("Image"));
  await waitFor(() => {
    expect(button("Remove Image")).toBeInTheDocument();
    expect(composer()).toHaveFocus();
  });
});

test("Feedback stays available after the last card, accepts an optional reason, and undo restores the card", async () => {
  mockPool([{ ...makeSuggestion(), consumeToken: "a".repeat(64) }]);
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
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
  await screen.findByText(
    "You’ll see fewer suggestions like this (project review).",
  );
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
  await waitFor(() => {
    expect(queryTab("Suggestions")).toBeNull();
  });
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(item.title);
  click(button("Already done"));
  const error = await screen.findByRole("alert");
  expect(
    within(error).getByText(/Feedback could not be saved/),
  ).toBeInTheDocument();
  expect(screen.getByText("Noted — this is already done")).toBeInTheDocument();
  expect(screen.queryByText(item.title)).not.toBeInTheDocument();
  click(button("Close feedback"));
  expect(queryTab("Suggestions")).not.toBeInTheDocument();
  failing = false;
  click(button("Try again"));
  await retried.promise;
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(attemptedIds[1]).toBe(attemptedIds[0]);
});

test("Slow feedback leaves the next card usable and Undo restores the original card immediately", async () => {
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(items[0].title);
  click(button("Already done"));
  await requested.promise;
  await screen.findByText(items[1].title);
  expect(button("Not planned")).toBeEnabled();
  expect(button("Next suggestion")).toBeEnabled();
  click(button("Undo"));
  await screen.findByText(items[0].title);
  expect(screen.getByText("1 of 3")).toBeInTheDocument();
  // The restored card is interactive even while its original feedback waits.
  click(button("Next suggestion"));
  await screen.findByText(items[1].title);
  click(button("Not planned"));
  await screen.findByText(items[2].title);
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
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

test("Choosing an option fills and focuses the composer while consumption and draft saving wait", async () => {
  const items = numberedSuggestions(2);
  const pool = mockPool(items);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const saving = context.mocks.deferred<void>();
  const releaseSave = context.mocks.deferred<void>();
  context.mocks.api(suggestionsContract.consume, async ({ body, respond }) => {
    requested.resolve();
    await release.promise;
    return respond(200, {
      ...items[0],
      status: "consumed",
      selectedOptionId: body.optionId,
    });
  });
  context.mocks.api(agentDraftContract.patch, async ({ respond }) => {
    saving.resolve();
    await releaseSave.promise;
    return respond(204);
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(items[0].title);
  click(button(makeOption().label));
  await requested.promise;
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Referenced decision");
    expect(composer()).toHaveFocus();
  });
  await screen.findByText(items[1].title);
  expect(button("Already done")).toBeEnabled();
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
  pool.withdrawAll();
  notifySuggestionsChanged();
  await saving.promise;
  expect(screen.getByText(items[1].title)).toBeInTheDocument();
  releaseSave.resolve();
  release.resolve();
});

test("Custom direction focuses the composer and leaves browsing available during draft saving", async () => {
  const items = numberedSuggestions(2);
  mockPool(items);
  const saving = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(agentDraftContract.patch, async ({ respond }) => {
    saving.resolve();
    await release.promise;
    return respond(204);
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(items[0].title);
  click(button("I’d like to…"));
  await saving.promise;
  expect(button("Go on…")).toHaveAttribute("aria-pressed", "true");
  expect(button("Next suggestion")).toBeEnabled();
  click(button("Next suggestion"));
  await screen.findByText(items[1].title);
  expect(composer()).toHaveTextContent(items[0].title);
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
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
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

test("An immediate option choice supersedes custom preparation before it can change the composer", async () => {
  mockPool();
  const saved = context.mocks.deferred<UserMessageDocument>();
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    if (body.draftUserMessage) {
      saved.resolve(body.draftUserMessage);
    }
    return respond(204);
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  click(button("I’d like to…"));
  click(button(makeOption().label));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Referenced decision");
  });
  const document = await saved.promise;
  expect(suggestionFeedbacks(document)).toHaveLength(0);
  expect(button("Send")).toBeEnabled();
});
