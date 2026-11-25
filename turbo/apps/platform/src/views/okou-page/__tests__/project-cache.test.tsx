import {
  projectsContract,
  type Project,
} from "@okouai/api-contracts/contracts/projects";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { cleanup, screen } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  setupPage,
  startPage,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
  mockChatThreadSnapshotResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { chatListAuth, chatListThread } from "./chat-list-test-helpers.ts";
const context = testContext(),
  time = "2026-08-03T12:00:00Z";
function project(name: string): Project {
  return { id: crypto.randomUUID(), name, createdAt: time, updatedAt: time };
}
function title(name: string) {
  return findFastControl("button", "Show or hide chats in " + name);
}
function snapshot(item: Project, seq: number, reply?: () => Promise<void>) {
  const eventId = crypto.randomUUID();
  context.mocks.api(projectsContract.snapshot, async ({ respond }) => {
    await reply?.();
    return respond(200, {
      projects: [item],
      latestSeqId: seq,
      latestEventId: eventId,
    });
  });
}
test("project-cache-002 a thread list notification discovers a chat after an empty snapshot", async () => {
  const auth = chatListAuth(902),
    chat = chatListThread(22, "Planning conversation");
  let published = false;
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: published ? [chat] : [],
        latestEventId: published ? chat.id : null,
        latestSeqId: published ? 1 : null,
      }),
    );
  });
  snapshot(project("Launch"), 1);
  await setupPage({
    context,
    path: "/",
    auth,
    cachedChatThreadEvents: { snapshot: null, events: [] },
    sharedWorkerTestTransport: "message-port",
  });
  await title("Launch");
  expect(screen.queryByText("Planning conversation")).toBeNull();
  published = true;
  changeChatThreadList();
  await findFastControl("link", /Planning conversation/);
});
test("project-cache-006 an expired persisted project cursor rebuilds the visible project from a new snapshot", async () => {
  const first = createTestRuntime(context),
    second = createTestRuntime(context),
    auth = chatListAuth(906),
    launch = project("Launch"),
    event = {
      id: crypto.randomUUID(),
      seqId: 2,
      projectId: launch.id,
      kind: "renamed" as const,
      name: "Launch ready",
      createdAt: time,
    };
  snapshot(launch, 1);
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: query.sinceSeqId < 2 ? [event] : [],
      hasMore: false,
    });
  });
  await setupPage({
    context: first,
    path: "/",
    auth,
    sharedWorkerTestTransport: "message-port",
  });
  await title("Launch ready");
  cleanup();
  const gate = context.mocks.deferred<void>(),
    waiting = context.mocks.deferred<void>();
  snapshot({ ...launch, name: "Launch restored" }, 5);
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    if (query.sinceSeqId === 2) {
      if (!waiting.settled()) {
        waiting.resolve();
      }
      await gate.promise;
      return respond(410, {
        error: { code: "CURSOR_EXPIRED", message: "Expired sequence" },
      });
    }
    return respond(200, { events: [], hasMore: false });
  });
  const page = await startPage({
    context: second,
    path: "/",
    auth,
    sharedWorkerTestTransport: "message-port",
  });
  await waiting.promise;
  await title("Launch ready");
  expect(screen.queryByText("Launch restored")).toBeNull();
  gate.resolve();
  await page.ready;
  await title("Launch restored");
  expect(screen.queryByText("Launch ready")).toBeNull();
});
test.each([
  ["007", "account"],
  ["008", "workspace"],
] as const)(
  "project-cache-%s a different %s cannot inherit the previous owner's cached project",
  async (_id, kind) => {
    const first = createTestRuntime(context),
      second = createTestRuntime(context),
      firstAuth = chatListAuth(907);
    snapshot(project("Launch"), 1);
    await setupPage({
      context: first,
      path: "/",
      auth: firstAuth,
      sharedWorkerTestTransport: "message-port",
    });
    await title("Launch");
    cleanup();
    const auth: SetupPageAuth =
      kind === "account"
        ? {
            ...firstAuth,
            user: { id: "user_other_harbor", fullName: "New reader" },
          }
        : {
            ...firstAuth,
            organization: {
              activeOrg: { id: "org_other_harbor", name: "Other workspace" },
              memberships: [{ id: "org_other_harbor" }],
            },
          };
    const gate = context.mocks.deferred<void>(),
      waiting = context.mocks.deferred<void>();
    snapshot(project("Other owner's Project"), 1, async () => {
      if (!waiting.settled()) {
        waiting.resolve();
      }
      await gate.promise;
    });
    const next = await startPage({
      context: second,
      path: "/",
      auth,
      sharedWorkerTestTransport: "message-port",
    });
    await waiting.promise;
    await next.content;
    expect(
      queryFastControl("button", "Show or hide chats in Launch"),
    ).toBeNull();
    gate.resolve();
    await next.ready;
    await title("Other owner's Project");
    expect(
      queryFastControl("button", "Show or hide chats in Launch"),
    ).toBeNull();
  },
);
