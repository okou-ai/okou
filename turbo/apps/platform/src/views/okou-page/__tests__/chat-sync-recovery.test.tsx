import {
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import {
  chatListEvent,
  chatListThread,
  chatListThreadId,
  installChatListStream,
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  promptEvent,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const OTHER_THREAD_ID = chatListThreadId(2);
const SYNC_FAILED = "Your chats may be out of date";

function installRecoveryChat(initialActive = false) {
  const visibility = context.mocks.browser.visibilityState("visible");
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
  let networkFailures = 0;
  let rejectNext = false;
  let holdNext = false;
  let holdNextIndicators = false;
  const heldStarted = context.mocks.deferred<void>();
  const releaseHeld = context.mocks.deferred<void>();
  const heldFinished = context.mocks.deferred<void>();
  const indicatorStarted = context.mocks.deferred<void>();
  const releaseIndicator = context.mocks.deferred<void>();
  context.mocks.http.get(
    `*${chatThreadsContract.events.path}`,
    async ({ request, withSignal }) => {
      if (holdNext) {
        holdNext = false;
        heldStarted.resolve();
        await withSignal(releaseHeld.promise);
        heldFinished.resolve();
        return HttpResponse.json(
          {
            error: { code: "FORBIDDEN", message: "The old read was rejected" },
          },
          { status: 403 },
        );
      }
      if (networkFailures > 0) {
        networkFailures -= 1;
        return HttpResponse.error();
      }
      if (rejectNext) {
        rejectNext = false;
        return HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "Chat access was denied" } },
          { status: 403 },
        );
      }
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
  context.mocks.api(
    chatThreadsContract.indicators,
    async ({ respond, withSignal }) => {
      const response = respond(200, {
        agents: unread ? { [AGENT_ID]: "unread" } : {},
        threads: unread
          ? { [OTHER_THREAD_ID]: "unread" }
          : initialActive
            ? { [OTHER_THREAD_ID]: "active" }
            : {},
        unreadAt: unread
          ? { [OTHER_THREAD_ID]: "2026-08-01T01:00:02.000Z" }
          : {},
      });
      if (holdNextIndicators) {
        holdNextIndicators = false;
        indicatorStarted.resolve();
        await withSignal(releaseIndicator.promise);
      }
      return response;
    },
  );
  return {
    visibility,
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
    failReads(count: number) {
      networkFailures = count;
    },
    setUnread(nextUnread: boolean) {
      unread = nextUnread;
    },
    rejectRead() {
      rejectNext = true;
    },
    holdRead() {
      holdNext = true;
      return {
        started: heldStarted.promise,
        release: releaseHeld.resolve,
        finished: heldFinished.promise,
      };
    },
    holdIndicatorRead() {
      holdNextIndicators = true;
      return {
        started: indicatorStarted.promise,
        release: releaseIndicator.resolve,
      };
    },
  };
}

async function findOtherThreadState(state: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const link = sidebarThreadLinks().find((candidate) => {
      return candidate.dataset.sidebarChatThreadId === OTHER_THREAD_ID;
    });
    if (!link) {
      throw new Error("The other conversation is not shown");
    }
    return within(link).getByText(state);
  });
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

function background(
  visibility: ReturnType<typeof installRecoveryChat>["visibility"],
) {
  act(() => {
    return visibility.changeTo("hidden");
  });
}

function foreground(
  visibility: ReturnType<typeof installRecoveryChat>["visibility"],
) {
  act(() => {
    return visibility.changeTo("visible");
  });
}

test.each(["direct", "message-port"] as const)(
  "Foreground catches up missed chats, unread state, and replies over %s",
  async (transport) => {
    const fixture = installRecoveryChat();
    await openChat(transport);
    background(fixture.visibility);
    fixture.advance();
    foreground(fixture.visibility);
    await expect(
      screen.findByText("Updated while away"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByText("Reply received while away"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      const link = sidebarThreadLinks().find((candidate) => {
        return candidate.dataset.sidebarChatThreadId === OTHER_THREAD_ID;
      });
      expect(link).toBeDefined();
      expect(within(link!).getByText("Unread")).toBeInTheDocument();
    });
  },
);

test("PWA chat list updates after returning from the background", async () => {
  const fixture = installRecoveryChat();
  context.mocks.browser.matchMedia(() => {
    return false;
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    sharedWorkerTestTransport: "message-port",
    featureSwitches: { [FeatureSwitchKey.PwaNavigation]: true },
  });
  await expect(screen.findByText("Earlier title")).resolves.toBeInTheDocument();
  background(fixture.visibility);
  fixture.advance();
  foreground(fixture.visibility);
  await expect(
    screen.findByText("Updated while away"),
  ).resolves.toBeInTheDocument();
});

test("Transient network failures recover without interrupting a draft", async () => {
  const fixture = installRecoveryChat();
  await openChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Unsent draft survives");
  background(fixture.visibility);
  fixture.advance();
  fixture.failReads(2);
  foreground(fixture.visibility);
  await expect(
    screen.findByText("Updated while away"),
  ).resolves.toBeInTheDocument();
  expect(composer).toHaveTextContent("Unsent draft survives");
  expect(screen.queryByText(SYNC_FAILED)).not.toBeInTheDocument();
  expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
});

test("Three failed reads retain chats until a manual retry", async () => {
  const fixture = installRecoveryChat();
  await openChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Keep this draft through retry");
  background(fixture.visibility);
  fixture.advance();
  fixture.failReads(3);
  foreground(fixture.visibility);
  await expect(screen.findByText(SYNC_FAILED)).resolves.toBeInTheDocument();
  expect(screen.getByText("Earlier title")).toBeInTheDocument();
  expect(screen.getByText("Already loaded reply")).toBeInTheDocument();
  expect(composer).toHaveTextContent("Keep this draft through retry");
  fixture.failReads(0);
  click(await findButton("Try again"));
  await expect(
    screen.findByText("Updated while away"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(screen.queryByText(SYNC_FAILED)).not.toBeInTheDocument();
  });
  expect(composer).toHaveTextContent("Keep this draft through retry");
});

test("HTTP rejection is not retried as a transient network failure", async () => {
  const fixture = installRecoveryChat();
  await openChat();
  background(fixture.visibility);
  fixture.advance();
  fixture.rejectRead();
  foreground(fixture.visibility);
  await expect(screen.findByText(SYNC_FAILED)).resolves.toBeInTheDocument();
  expect(screen.getByText("Earlier title")).toBeInTheDocument();
  click(await findButton("Try again"));
  await expect(
    screen.findByText("Updated while away"),
  ).resolves.toBeInTheDocument();
});

test("A suspended read cannot hold up the next foreground refresh", async () => {
  const fixture = installRecoveryChat();
  await openChat();
  const held = fixture.holdRead();
  background(fixture.visibility);
  foreground(fixture.visibility);
  await held.started;
  background(fixture.visibility);
  fixture.advance();
  foreground(fixture.visibility);
  await expect(
    screen.findByText("Updated while away"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Reply received while away"),
  ).resolves.toBeInTheDocument();
  held.release();
  await held.finished;
});

test("An older indicator refresh cannot block foreground unread updates", async () => {
  const fixture = installRecoveryChat(true);
  await openChat();
  await expect(findOtherThreadState("Running")).resolves.toBeInTheDocument();
  const held = fixture.holdIndicatorRead();
  act(() => {
    changeChatThreadList();
  });
  await held.started;
  background(fixture.visibility);
  fixture.advance();
  foreground(fixture.visibility);
  await expect(findOtherThreadState("Unread")).resolves.toBeInTheDocument();
  fixture.setUnread(false);
  act(() => {
    changeChatThreadList();
  });
  await expect(findOtherThreadState("Running")).resolves.toBeInTheDocument();
  held.release();
});

test("A realtime continuity gap catches up without another chat notification", async () => {
  const fixture = installRecoveryChat();
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

test("Restoring the network retries a failed refresh", async () => {
  const fixture = installRecoveryChat();
  const network = context.mocks.browser.networkState(true);
  await openChat();
  background(fixture.visibility);
  act(() => {
    network.changeTo(false);
  });
  fixture.advance();
  fixture.failReads(Number.POSITIVE_INFINITY);
  foreground(fixture.visibility);
  await expect(screen.findByText(SYNC_FAILED)).resolves.toBeInTheDocument();
  fixture.failReads(0);
  act(() => {
    network.changeTo(true);
  });
  await expect(
    screen.findByText("Updated while away"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(screen.queryByText(SYNC_FAILED)).not.toBeInTheDocument();
  });
});
