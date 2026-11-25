import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { cleanup } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import { chatListAuth } from "./chat-list-test-helpers.ts";
const context = testContext();
test("worker-runtime-012 A project refreshed after cursor expiration is cached at the new sequence for its owner", async () => {
  const owner = chatListAuth(816);
  const item = {
    id: crypto.randomUUID(),
    name: "East access",
    createdAt: "2026-08-04T10:00:00Z",
    updatedAt: "2026-08-04T10:00:00Z",
  };
  const stamp = crypto.randomUUID(),
    next = crypto.randomUUID(),
    renamed = "Covered east entrance";
  let expired = false,
    offline = false;
  const denied = context.mocks.deferred<void>(),
    refresh = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>(),
    network = context.mocks.deferred<void>();
  context.mocks.api(projectsContract.snapshot, async ({ respond }) => {
    if (offline) {
      await network.promise;
    }
    if (expired) {
      if (!refresh.settled()) {
        refresh.resolve();
      }
      await release.promise;
    }
    return respond(200, {
      projects: [{ ...item, name: expired ? renamed : item.name }],
      latestSeqId: expired ? 5 : 1,
      latestEventId: expired ? next : stamp,
    });
  });
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    if (offline) {
      await network.promise;
    }
    if (expired && query.sinceSeqId === 1) {
      if (!denied.settled()) {
        denied.resolve();
      }
      return respond(410, {
        error: { code: "CURSOR_EXPIRED", message: "Reload the project list" },
      });
    }
    return respond(200, { events: [], hasMore: false });
  });
  const start = (auth: typeof owner) => {
    return startPage({
      context: createTestRuntime(context),
      path: "/",
      auth,
      sharedWorkerTestTransport: "message-port",
    });
  };
  const title = (name: string) => {
    return findFastControl("button", "Show or hide chats in " + name);
  };
  function unmount() {
    cleanup();
    if (vi.isMockFunction(history.replaceState)) {
      vi.mocked(history.replaceState).mockRestore();
    }
  }
  const first = await start(owner);
  await first.ready;
  await expect(title(item.name)).resolves.toBeVisible();
  expired = true;
  context.mocks.ably.triggerOnChannel(
    "user-org:" + owner.user.id + ":" + owner.organization!.activeOrg!.id,
    "threadListChanged",
  );
  await denied.promise;
  await refresh.promise;
  expect(
    queryFastControl("button", "Show or hide chats in " + renamed),
  ).toBeNull();
  release.resolve();
  await expect(title(renamed)).resolves.toBeVisible();
  unmount();
  offline = true;
  const checked = context.mocks.deferred<number>();
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    if (!checked.settled()) {
      checked.resolve(query.sinceSeqId);
    }
    await network.promise;
    return respond(200, { events: [], hasMore: false });
  });
  const reopened = await start(owner);
  await reopened.content;
  await expect(title(renamed)).resolves.toBeVisible();
  await expect(checked.promise).resolves.toBe(5);
  unmount();
  const visitorSeen = context.mocks.deferred<void>();
  context.mocks.api(projectsContract.snapshot, async ({ respond }) => {
    if (!visitorSeen.settled()) {
      visitorSeen.resolve();
    }
    await network.promise;
    return respond(200, { projects: [], latestSeqId: 0, latestEventId: null });
  });
  const visitor = await start({
    ...owner,
    user: { ...owner.user, id: "separate-project-reader" },
  });
  await visitor.content;
  await visitorSeen.promise;
  expect(
    queryFastControl("button", "Show or hide chats in " + renamed),
  ).toBeNull();
  network.resolve();
  await Promise.all([reopened.ready, visitor.ready]);
  expect(
    queryFastControl("button", "Show or hide chats in " + renamed),
  ).toBeNull();
});
