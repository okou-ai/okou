import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  suggestionsContract,
  type Suggestion,
} from "@okouai/api-contracts/contracts/suggestions";
import {
  chatThreadDraftContract,
  chatThreadByIdContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  agentsMainContract,
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
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
    threadId: null,
    priority: 20,
    status: "active",
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
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
  context.mocks.api(suggestionsContract.list, ({ respond }) => {
    return respond(200, { suggestions: items });
  });
  context.mocks.api(suggestionsContract.consume, ({ params, respond }) => {
    const found = items.find((entry) => {
      return entry.id === params.id;
    });
    if (!found) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Already consumed" },
      });
    }
    items = items.filter((entry) => {
      return entry.id !== params.id;
    });
    return respond(200, { ...found, status: "consumed" });
  });
  return {
    publish: (item: Suggestion) => {
      items = [...items, item];
    },
    withdrawAll: () => {
      items = [];
    },
  };
}
const features = { [FeatureSwitchKey.AgentSuggestion]: true } as const;

test("Suggestions is the default tab and browsing categories preserves the draft and keyboard focus", async () => {
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
  expect(button("Image", "tab")).toHaveAttribute("aria-selected", "true");
  await user.click(button("Suggestions", "tab"));
  await screen.findByText(makeSuggestion().title);
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    return expect(button("Workflow", "tab")).toHaveFocus();
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    return expect(button("Workflow", "tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  expect(composer()).toHaveTextContent("My draft stays here");
});
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
  expect(
    screen.queryByText("No suggestions right now."),
  ).not.toBeInTheDocument();
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
  await waitFor(() => {
    expect(queryTab("Suggestions")).toBeInTheDocument();
  });
  expect(button("Image", "tab")).toHaveAttribute("aria-selected", "true");
  expect(composer()).toHaveTextContent("Keep my draft");
  click(button("Suggestions", "tab"));
  await screen.findByText(makeSuggestion().title);
  expect(composer()).toHaveTextContent("Keep my draft");
});
test("Suggestions stays out of the row until the pool resolves with items", async () => {
  const requested = createDeferredPromise<void>(context.signal);
  const answer = createDeferredPromise<void>(context.signal);
  context.mocks.api(suggestionsContract.list, async ({ respond }) => {
    if (!requested.settled()) {
      requested.resolve();
    }
    await answer.promise;
    return respond(200, { suggestions: [makeSuggestion()] });
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await requested.promise;
  await waitFor(() => {
    expect(queryTab("Workflow")).toBeInTheDocument();
  });
  expect(queryTab("Suggestions")).not.toBeInTheDocument();
  answer.resolve();
  await screen.findByText(makeSuggestion().title);
  expect(button("Suggestions", "tab")).toHaveAttribute("aria-selected", "true");
});
test("A failed suggestion read stays silent until a realtime publication recovers the pool", async () => {
  let available = false;
  const failed = createDeferredPromise<void>(context.signal);
  context.mocks.api(suggestionsContract.list, ({ respond }) => {
    if (available) {
      return respond(200, { suggestions: [makeSuggestion()] });
    }
    if (!failed.settled()) {
      failed.resolve();
    }
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Suggestion service unavailable" },
    });
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await failed.promise;
  await waitFor(() => {
    expect(queryTab("Workflow")).toBeInTheDocument();
  });
  expect(queryTab("Suggestions")).not.toBeInTheDocument();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("agentSuggestionsChanged"),
    ).toBeTruthy();
  });
  available = true;
  context.mocks.ably.trigger("agentSuggestionsChanged");
  await screen.findByText(makeSuggestion().title);
  expect(button("Suggestions", "tab")).toHaveAttribute("aria-selected", "true");
  expect(
    screen.queryByText("Suggestion service unavailable"),
  ).not.toBeInTheDocument();
});
test("A new-chat suggestion is consumed and prepends its structured reference without sending", async () => {
  mockPool();
  let saved: unknown;
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    saved = body;
    return respond(204);
  });
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText(makeSuggestion().title);
  await fill(composer(), "My original draft");
  click(button(makeSuggestion().title));
  await waitFor(() => {
    expect(composer()).toHaveTextContent("Review the pending decision");
    expect(composer()).toHaveTextContent("Referenced decision");
    expect(composer()).toHaveTextContent("My original draft");
  });
  await waitFor(() => {
    expect(queryTab("Suggestions")).not.toBeInTheDocument();
    expect(composer()).toHaveFocus();
  });
  expect(
    screen.queryByText("No suggestions right now."),
  ).not.toBeInTheDocument();
  expect(button("Workflow", "tab")).toBeInTheDocument();
  expect(pathname()).toBe(`/agents/${agentId}/chat`);
  await waitFor(() => {
    return expect(saved).toMatchObject({
      draftUserMessage: {
        version: 1,
        parts: expect.arrayContaining([
          {
            type: "chat_thread",
            threadId,
            titleSnapshot: "Referenced decision",
          },
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("My original draft"),
          }),
        ]),
      },
    });
  });
});
test("An existing-thread suggestion preserves the remote draft without sending", async () => {
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
    threadId,
    draft: {
      draftUserMessage: {
        version: 1,
        parts: [
          ...(makeSuggestion().draft.draftUserMessage?.parts ?? []),
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
  };
  mockPool([suggestion]);
  const sends: string[] = [];
  mockPrivateUrlSequence(context, {
    [incoming.id]: [incoming.url],
    [original.id]: [original.url],
  });
  mockChatLifecycle(context, {
    threadId,
    onSendRequest: ({ prompt }) => {
      sends.push(prompt);
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
  click(button(makeSuggestion().title));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threadId}`);
    expect(composer()).toHaveTextContent("Referenced decision");
    expect(composer()).toHaveTextContent("Existing remote draft");
  });
  await expect(screen.findByText("suggested.txt")).resolves.toBeInTheDocument();
  await expect(screen.findByText("original.txt")).resolves.toBeInTheDocument();
  expect(sends).toStrictEqual([]);
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
  await waitFor(() => {
    expect(queryTab("Suggestions")).not.toBeInTheDocument();
  });
  expect(button("Image", "tab")).toHaveAttribute("aria-selected", "true");
  expect(
    screen.queryByText("No suggestions right now."),
  ).not.toBeInTheDocument();
});
test("The action list starts with five suggestions and expands without modifying the composer", async () => {
  mockPool(
    Array.from({ length: 10 }, (_, index) => {
      return {
        ...makeSuggestion(),
        id: `a0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
        title: `Suggested action ${index + 1}`,
      };
    }),
  );
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: features,
  });
  await screen.findByText("Suggested action 1");
  expect(screen.getByText("Suggested action 5")).toBeInTheDocument();
  expect(screen.queryByText("Suggested action 6")).not.toBeInTheDocument();
  await fill(composer(), "Keep this draft");
  click(button("View all 10"));
  await screen.findByText("Suggested action 10");
  expect(composer()).toHaveTextContent("Keep this draft");
  click(button("Show fewer"));
  await waitFor(() => {
    expect(screen.queryByText("Suggested action 6")).not.toBeInTheDocument();
  });
});
test("A deleted target shows the ordinary missing-thread state after consuming the suggestion", async () => {
  mockPool([{ ...makeSuggestion(), threadId }]);
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
  click(button(makeSuggestion().title));
  await waitFor(() => {
    expect(
      document.querySelector("[data-chat-thread-not-found]"),
    ).toHaveTextContent("Chat thread not found");
  });
  expect(pathname()).toBe(`/chats/${threadId}`);
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
