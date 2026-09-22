import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { homeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000811";

function mockRecommendations(
  target:
    | { readonly kind: "new-thread" }
    | { readonly kind: "existing-thread"; readonly threadId: string },
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
        recommendations: [
          {
            id: "r1",
            title: "Prepare the launch follow-up",
            prompt: "Draft the launch follow-up for my review.",
            rationale: "A decision still needs a response",
            actionability: 83,
            target,
            connectors: [],
          },
        ],
      });
    },
  );
  return requestedAgentIds;
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
  const requestedAgentIds = mockRecommendations({ kind: "new-thread" });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.HomeTaskRecommendations]: true },
  });

  await screen.findByText("Prepare the launch follow-up");
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("homeTaskRecommendationsChanged"),
    ).toBeTruthy();
  });
  const requestsBeforePush = requestedAgentIds.length;
  context.mocks.ably.trigger("homeTaskRecommendationsChanged", {
    agentId: AGENT_ID,
  });
  await waitFor(() => {
    expect(requestedAgentIds.length).toBeGreaterThan(requestsBeforePush);
  });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("connectorPermissionUpdated"),
    ).toBeTruthy();
  });
  const requestsBeforePermissionPush = requestedAgentIds.length;
  context.mocks.ably.trigger("connectorPermissionUpdated");
  await waitFor(() => {
    expect(requestedAgentIds.length).toBeGreaterThan(
      requestsBeforePermissionPush,
    );
  });

  await user.click(screen.getByText("Prepare the launch follow-up"));

  await waitFor(() => {
    expect(composer()).toHaveTextContent(
      "Draft the launch follow-up for my review.",
    );
  });
  expect(screen.getByText("New chat")).toBeInTheDocument();
  expect(requestedAgentIds).toContain(AGENT_ID);
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  expect(search()).toBe("");
  expect(sends).toStrictEqual([]);
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
  mockRecommendations({ kind: "existing-thread", threadId: THREAD_ID });
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
  });
  expect(search()).toBe("");
  expect(sends).toStrictEqual([]);
});
