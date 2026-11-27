import {
  projectsContract,
  type Project,
  type ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  chatListAuth,
  chatListThread,
  chatListEvent,
  installChatListStream,
  cachedChatListEvents,
} from "./chat-list-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext(),
  old = "Earlier title",
  updated = "Updated while away",
  missed = "Reply received while away";
async function conversation() {
  const member = chatListAuth(854),
    chat = chatListThread(31, old);
  const replies: MockChatEventInput[] = [
    {
      role: "assistant",
      content: "Original reply",
      seqId: 1,
      createdAt: "2026-08-01T09:00:00Z",
      runId: "d0000000-0000-4000-a000-000000000103",
      runEventId: "start",
      sequenceNumber: 1,
    },
  ];
  mockChatLifecycle(context, {
    threadId: chat.id,
    threadTitle: old,
    chatEvents: replies,
  });
  const list = installChatListStream(context, {
    caseId: 854,
    snapshot: [chat],
  });
  await setupPage({
    context,
    path: "/chats/" + chat.id,
    auth: member,
    cachedChatThreadEvents: cachedChatListEvents(854, [chat]),
  });
  await screen.findByText("Original reply");
  await findFastControl("link", new RegExp(old));
  return {
    rename() {
      list.setEvents([
        chatListEvent(854, 2, "renamed", chat.id, { title: updated }),
      ]);
    },
    replies,
  };
}
async function renamed() {
  await findFastControl("link", new RegExp(updated));
  expect(queryFastControl("link", new RegExp(old))).toBeNull();
}
test("chat-sync-recovery-001 a hidden browser tab applies the ordinary title update before the member returns", async () => {
  const page = await conversation(),
    visibility = context.mocks.browser.visibilityState("visible");
  visibility.changeTo("hidden");
  page.rename();
  changeChatThreadList();
  await renamed();
  visibility.changeTo("visible");
  await renamed();
  expect(document.visibilityState).toBe("visible");
});
test("chat-sync-recovery-003 reconnecting after a continuity gap retrieves both the renamed chat and its missed reply", async () => {
  const page = await conversation();
  context.mocks.ably.triggerConnectionState("suspended");
  page.rename();
  page.replies.push({
    role: "assistant",
    content: missed,
    seqId: 3,
    runId: "d0000000-0000-4000-a000-000000000104",
    runEventId: "missed",
    sequenceNumber: 1,
    createdAt: "2026-08-01T09:10:00Z",
  });
  context.mocks.ably.triggerConnectionState("connected");
  await renamed();
  await expect(screen.findByText(missed)).resolves.toBeInTheDocument();
});
test("chat-sync-recovery-006 a credential gap reconciles renamed, retired and new Projects on the home route", async () => {
  const now = "2026-08-02T09:00:00Z";
  const project = (name: string, sortOrder: string): Project => {
    return {
      name,
      sortOrder,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
  };
  const first = project("Earlier Project", "a0"),
    retired = project("Retired Project", "a1"),
    created = project("New Project", "a2");
  let events: ProjectEvent[] = [];
  const seed = crypto.randomUUID();
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [first, retired],
      latestEventId: seed,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((e) => {
        return e.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  await setupPage({
    context,
    path: "/",
    auth: chatListAuth(855),
  });
  const row = (name: string) => {
    return "Show or hide chats in " + name;
  };
  await findFastControl("button", row(first.name));
  await findFastControl("button", row(retired.name));
  context.mocks.ably.triggerConnectionState("suspended", {
    code: 40_142,
    statusCode: 401,
    message: "Credential expired",
  });
  events = [
    {
      projectId: first.id,
      kind: "renamed",
      name: "Renamed Project",
      sortOrder: "a0",
    },
    { projectId: retired.id, kind: "deleted", name: null, sortOrder: null },
    {
      projectId: created.id,
      kind: "created",
      name: created.name,
      sortOrder: created.sortOrder,
    },
  ].map((event, index) => {
    return {
      ...event,
      seqId: index + 2,
      id: crypto.randomUUID(),
      createdAt: now,
    };
  }) as ProjectEvent[];
  context.mocks.ably.triggerConnectionState("connected");
  await findFastControl("button", row("Renamed Project"));
  await findFastControl("button", row(created.name));
  await waitFor(() => {
    expect(queryFastControl("button", row(first.name))).toBeNull();
    expect(queryFastControl("button", row(retired.name))).toBeNull();
  });
  expect(screen.queryByText(missed)).toBeNull();
  expect(location.pathname).toBe("/");
});
