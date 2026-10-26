import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  suggestionsContract,
  type Suggestion,
  type SuggestionOption,
} from "@okouai/api-contracts/contracts/suggestions";
import {
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

const context = testContext();
const agentId = "c0000000-0000-4000-a000-000000000001";
const threadId = "b0000000-0000-4000-a000-000000000811";
function makeSuggestion(): Suggestion {
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    title: "Review the pending decision",
    rationale: "A response is needed",
    priority: 20,
    status: "active",
    selectedOptionId: null,
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
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
function queryTab(name: string) {
  return (
    queryAllByRoleFast("tab").find((element) => {
      return element.textContent?.trim() === name;
    }) ?? null
  );
}
function mockPool(initial: Suggestion[] = [makeSuggestion()]) {
  let items = initial;
  const consumed: string[] = [];
  const selections: { id: string; optionId: string | null }[] = [];
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
const features = { [FeatureSwitchKey.ProactiveAgent]: true } as const;

test("Selecting a task hides the categories, focuses the composer, and restores Suggestions when cleared", async () => {
  const user = userEvent.setup();
  mockPool();
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
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
        [FeatureSwitchKey.BuiltinDocumentTemplates]: true,
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

test("An empty pool hides Suggestions until a realtime publication without changing the chosen category or draft", async () => {
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
  click(button("Image", "tab"));
  await screen.findByText("Put my product in a new scene");
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("agentSuggestionsChanged"),
    ).toBeTruthy();
  });
  pool.publish(makeSuggestion());
  context.mocks.ably.trigger("agentSuggestionsChanged");
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(button("Remove Image")).toBeInTheDocument();
  expect(composer()).toHaveTextContent("Keep my draft");
  click(button("Remove Image"));
  await waitFor(() => {
    expect(queryTab("Suggestions")).toBeInTheDocument();
  });
  await screen.findByText(makeSuggestion().title);
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
test("A conflicting consumption does not send or change the home draft", async () => {
  mockPool();
  context.mocks.api(suggestionsContract.consume, ({ respond }) => {
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
});
test("Realtime removal hides Suggestions without changing another selected category", async () => {
  const pool = mockPool();
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  click(button("Image", "tab"));
  await screen.findByText("Put my product in a new scene");
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("agentSuggestionsChanged"),
    ).toBeTruthy();
  });
  pool.withdrawAll();
  context.mocks.ably.trigger("agentSuggestionsChanged");
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(button("Remove Image")).toBeInTheDocument();
  click(button("Remove Image"));
  await waitFor(() => {
    expect(queryTab("Image")).toBeInTheDocument();
    expect(queryTab("Suggestions")).not.toBeInTheDocument();
  });
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
test("The consume response owns the message and target, including updates since the card loaded", async () => {
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
    return expect(pathname()).toBe(`/chats/${threadId}`);
  });
  await screen.findByText("Updated action");
  expect(screen.queryByText("Referenced decision")).not.toBeInTheDocument();
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
    expect(queryTab("Suggestions")).not.toBeInTheDocument();
    expect(pool.consumed).toStrictEqual([
      "a0000000-0000-4000-a000-000000000001",
      "a0000000-0000-4000-a000-000000000002",
    ]);
  });
  expect(composer()).toHaveTextContent("Keep this draft");
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
});
test("A deleted suggestion target leaves the current draft in place", async () => {
  mockPool([{ ...makeSuggestion(), options: [makeOption({ threadId })] }]);
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
  click(button(makeOption().label));
  await waitFor(() => {
    expect(queryTab("Suggestions")).not.toBeInTheDocument();
  });
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
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
