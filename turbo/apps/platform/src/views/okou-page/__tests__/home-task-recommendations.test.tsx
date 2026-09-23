import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { homeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/home-task-recommendations";
import {
  chatEventsContract,
  chatThreadDraftContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000811";
function connectorIconUrl(slug: string): string {
  return `https://static.example.test/connectors/${slug}.svg`;
}

function mockRecommendations(
  target:
    | { readonly kind: "new-thread" }
    | { readonly kind: "existing-thread"; readonly threadId: string },
  purpose: "task" | "workflow" = "task",
  connectors: string[] = [],
) {
  const requestedAgentIds: string[] = [];
  context.mocks.api(
    homeTaskRecommendationsContract.list,
    ({ query, respond }) => {
      requestedAgentIds.push(query.agentId);
      return respond(200, {
        status: "available",
        generatedAt: "2026-09-21T10:00:00.000Z",
        refreshAfterMs: 900_000,
        revision: "a".repeat(64),
        recommendations: [
          {
            id: "r1",
            purpose,
            title: "Prepare the launch follow-up",
            prompt: "Draft the launch follow-up for my review.",
            rationale: "A decision still needs a response",
            actionability: 83,
            target,
            connectors,
          },
        ],
        connectors: connectors.map((slug) => {
          return {
            slug,
            label: slug === "gmail" ? "Gmail" : slug,
            icon: { url: connectorIconUrl(slug), invertInDarkMode: false },
          };
        }),
      });
    },
  );
  return { requestedAgentIds };
}

function composer(): HTMLElement {
  const editor = document.querySelector(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Message composer not found");
  }
  return editor;
}

test("A new-chat recommendation prefills without sending", async () => {
  const user = userEvent.setup();
  const sends: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sends.push(body.prompt ?? "");
    return respond(201, {
      runId: "d0000000-0000-4000-a000-000000000001",
      threadId: "b0000000-0000-4000-a000-000000000001",
      status: "completed",
      createdAt: "2026-09-21T10:00:00.000Z",
    });
  });
  const { requestedAgentIds } = mockRecommendations({
    kind: "new-thread",
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.HomeTaskRecommendations]: true },
  });

  await screen.findByText("Prepare the launch follow-up");
  await user.click(composer());
  await user.type(composer(), "My saved draft");
  await user.click(screen.getByText("Prepare the launch follow-up"));

  await waitFor(() => {
    expect(composer()).toHaveTextContent(
      "Draft the launch follow-up for my review.",
    );
    expect(composer()).toHaveTextContent("My saved draft");
    const text = composer().textContent ?? "";
    expect(text.indexOf("Draft the launch follow-up")).toBeLessThan(
      text.indexOf("My saved draft"),
    );
  });
  expect(screen.getByText("New chat")).toBeInTheDocument();
  expect(requestedAgentIds).toContain(AGENT_ID);
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  expect(search()).toBe("");
  expect(sends).toStrictEqual([]);
});

test("A permission notice hides Gmail cards without reloading the home snapshot", async () => {
  const user = userEvent.setup();
  const { requestedAgentIds } = mockRecommendations(
    { kind: "new-thread" },
    "task",
    ["gmail"],
  );
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.HomeTaskRecommendations]: true },
  });

  await screen.findByText("Prepare the launch follow-up");
  expect(screen.getByText("Gmail")).toBeInTheDocument();
  expect(
    document.querySelector(
      `[data-slot="home-task-recommendation-card"] img[src="${connectorIconUrl("gmail")}"]`,
    ),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("connectorPermissionUpdated"),
    ).toBeTruthy();
  });
  const requestsBeforeNotice = requestedAgentIds.length;
  context.mocks.ably.trigger("connectorPermissionUpdated");
  await screen.findByText("New tasks available");
  expect(requestedAgentIds).toHaveLength(requestsBeforeNotice);
  expect(
    screen.queryByText("Prepare the launch follow-up"),
  ).not.toBeInTheDocument();

  const reloadButton = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Reload tasks";
  });
  if (!reloadButton) {
    throw new Error("Expected task reload button");
  }
  await user.click(reloadButton);
  await waitFor(() => {
    expect(requestedAgentIds.length).toBeGreaterThan(requestsBeforeNotice);
  });
  await screen.findByText("Prepare the launch follow-up");
  await waitFor(() => {
    expect(screen.queryByText("New tasks available")).not.toBeInTheDocument();
  });
});

test("An existing-thread recommendation navigates and prefills without sending", async () => {
  const user = userEvent.setup();
  const sends: string[] = [];
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    onSendRequest: ({ prompt }) => {
      sends.push(prompt);
    },
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "My existing thread draft" }],
      },
      draftAttachments: null,
    });
  });
  mockRecommendations({
    kind: "existing-thread",
    threadId: THREAD_ID,
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.HomeTaskRecommendations]: true },
  });

  await expect(screen.findByText("Continue chat")).resolves.toBeInTheDocument();
  await user.click(screen.getByText("Prepare the launch follow-up"));

  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${THREAD_ID}`);
    expect(composer()).toHaveTextContent(
      "Draft the launch follow-up for my review.",
    );
    expect(composer()).toHaveTextContent("My existing thread draft");
    const text = composer().textContent ?? "";
    expect(text.indexOf("Draft the launch follow-up")).toBeLessThan(
      text.indexOf("My existing thread draft"),
    );
  });
  expect(search()).toBe("");
  expect(sends).toStrictEqual([]);
});

test("A workflow suggestion sends its task to the Agent without sending the saved composer draft", async () => {
  const user = userEvent.setup();
  const sends: string[] = [];
  mockChatLifecycle(context, {
    onSendRequest: ({ prompt }) => {
      sends.push(prompt);
    },
  });
  mockRecommendations({ kind: "new-thread" }, "workflow");
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.HomeTaskRecommendations]: true },
  });

  await screen.findByText("Prepare the launch follow-up");
  await user.click(composer());
  await user.type(composer(), "Keep this unsent");
  await user.click(screen.getByText("Prepare the launch follow-up"));

  await waitFor(() => {
    expect(pathname()).toMatch(/^\/chats\//);
  });
  await waitFor(() => {
    expect(sends).toStrictEqual(["Draft the launch follow-up for my review."]);
  });
  expect(sends[0]).not.toContain("Keep this unsent");
  expect(pathname()).toMatch(/^\/chats\//);
});
