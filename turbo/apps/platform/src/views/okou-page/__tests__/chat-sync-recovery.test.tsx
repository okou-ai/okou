import {
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { act, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListEvent,
  chatListThread,
  chatListThreadId,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const OTHER_THREAD_ID = chatListThreadId(2);

function installChat() {
  context.mocks.browser.matchMedia(() => {
    return true;
  });
  const messages: MockChatEventInput[] = [
    promptEvent({ id: "sync-prompt", seqId: 1, text: "Keep our conversation" }),
    {
      id: "sync-reply",
      seqId: 2,
      role: "assistant",
      runId: undefined,
      content: "Already loaded reply",
      createdAt: "2026-08-01T10:00:02.000Z",
    },
  ];
  installRunChat({ chatEvents: messages });
  installChatListStream(context, {
    caseId: 91,
    snapshot: [
      chatListThread(1, "Run conversation", {
        id: RUN_THREAD_ID,
        agentId: AGENT_ID,
      }),
      chatListThread(2, "Earlier title", { agentId: AGENT_ID }),
    ],
  });
  let events: ChatThreadEvent[] = [];
  let unread = false;
  context.mocks.http.get(
    `*${chatThreadsContract.events.path}`,
    ({ request }) => {
      const after = Number(
        new URL(request.url).searchParams.get("sinceSeqId") ?? 0,
      );
      return HttpResponse.json({
        events: events.filter((event) => {
          return event.seqId > after;
        }),
        hasMore: false,
      });
    },
  );
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: unread ? { [AGENT_ID]: "unread" } : {},
      threads: unread ? { [OTHER_THREAD_ID]: "unread" } : {},
      unreadAt: unread ? { [OTHER_THREAD_ID]: "2026-08-01T01:00:02.000Z" } : {},
    });
  });
  return {
    advance(title = "Updated while away") {
      events = [
        chatListEvent(91, 2, "renamed", OTHER_THREAD_ID, {
          agentId: AGENT_ID,
          title,
        }),
      ];
      unread = true;
      messages.push({
        id: "sync-missed-reply",
        seqId: 3,
        role: "assistant",
        runId: undefined,
        content: "Reply received while away",
        createdAt: "2026-08-01T10:00:03.000Z",
      });
    },
  };
}

async function openChat(transport: "direct" | "message-port" = "message-port") {
  await setupPage({
    context,
    path: RUN_PATH,
    sharedWorkerTestTransport: transport,
  });
  await expect(
    screen.findByText("Already loaded reply"),
  ).resolves.toBeInTheDocument();
  await expect(screen.findByText("Earlier title")).resolves.toBeInTheDocument();
}

test.each(["direct", "message-port"] as const)(
  "Ordinary notifications update a hidden chat tab through %s",
  async (transport) => {
    const visibility = context.mocks.browser.visibilityState("visible");
    const fixture = installChat();
    await openChat(transport);
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscriptionOnChannel(
          "user:test-user-123",
          "userPreferenceChanged",
        ),
      ).toBeTruthy();
    });
    act(() => {
      visibility.changeTo("hidden");
    });
    fixture.advance();
    act(() => {
      context.mocks.ably.trigger("threadListChanged");
    });
    await expect(
      screen.findByText("Updated while away"),
    ).resolves.toBeInTheDocument();
    act(() => {
      visibility.changeTo("visible");
    });
    expect(screen.getByText("Updated while away")).toBeInTheDocument();
    expect(screen.queryByText("Earlier title")).not.toBeInTheDocument();
  },
);

test("A realtime continuity gap catches up without another chat notification", async () => {
  const fixture = installChat();
  await openChat();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "userPreferenceChanged",
      ),
    ).toBeTruthy();
  });
  fixture.advance();
  act(() => {
    context.mocks.ably.triggerSharedWorkerConnectionState("suspended");
    return context.mocks.ably.triggerSharedWorkerReconnect();
  });
  await expect(
    screen.findByText("Updated while away"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Reply received while away"),
  ).resolves.toBeInTheDocument();
});
