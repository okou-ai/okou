import {
  projectsContract,
  type ProjectEvent,
} from "@okouai/api-contracts/contracts/projects";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, cleanup } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  membershipPage,
  checkLocation,
} from "./project-chat-membership-fixtures.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";
const context = testContext();
test("projects-006 Both Project fold choices survive a full App replacement under the same signed-in member", async () => {
  const first = createTestRuntime(context);
  const ws = await membershipPage(first);
  await ws.fold("Research", false);
  await ws.fold("Launch", false);
  await ws.fold("Research", true);
  await findFastControl("link", ws.review.title!);
  expect(queryFastControl("link", ws.member.title!)).toBeNull();
  cleanup();
  if (vi.isMockFunction(history.replaceState)) {
    vi.mocked(history.replaceState).mockRestore();
  }
  const next = createTestRuntime(context);
  await setupPage({ context: next, ...ws.pageOptions, path: ws.path });
  first.dispose();
  await expect(
    findFastControl("button", "Show or hide chats in Launch"),
  ).resolves.toHaveAttribute("aria-expanded", "false");
  await expect(
    findFastControl("button", "Show or hide chats in Research"),
  ).resolves.toHaveAttribute("aria-expanded", "true");
  expect(queryFastControl("link", ws.member.title!)).toBeNull();
  await expect(
    findFastControl("link", ws.review.title!),
  ).resolves.toBeVisible();
});
test("projects-003 An expanded Project and its planning chat remain visible while a pending refresh spans navigation Home and a server rename", async () => {
  const ws = await membershipPage(context),
    begun = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const changed: ProjectEvent = {
    kind: "renamed",
    name: "Launch updated",
    projectId: ws.launch.id,
    id: crypto.randomUUID(),
    seqId: 1,
    createdAt: "2026-08-21T00:00:00Z",
  };
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    begun.resolve();
    await release.promise;
    return respond(200, {
      events: query.sinceSeqId < 1 ? [changed] : [],
      hasMore: false,
    });
  });
  const owner = ws.pageOptions.auth!;
  context.mocks.ably.triggerOnChannel(
    "user-org:" + owner.user.id + ":" + owner.organization!.activeOrg!.id,
    "threadListChanged",
  );
  await begun.promise;
  checkLocation(ws.member.title!, ws.launch.id);
  click(await findFastControl("link", "Chat"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await expect(
    findFastControl("button", "Show or hide chats in Launch"),
  ).resolves.toBeVisible();
  checkLocation(ws.member.title!, ws.launch.id);
  release.resolve();
  await expect(
    findFastControl("button", "Show or hide chats in Launch updated"),
  ).resolves.toHaveAttribute("aria-expanded", "true");
  checkLocation(ws.member.title!, ws.launch.id);
});
test("projects-026 Deleting a Project closes the dialog before membership sync returns and leaves the former member in the ordinary chat list", async () => {
  const ws = await membershipPage(context),
    sync = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  let removed: ProjectEvent | undefined;
  context.mocks.api(projectsContract.delete, ({ body, params, respond }) => {
    removed = {
      id: body.eventId,
      seqId: 1,
      kind: "deleted",
      name: null,
      projectId: params.id,
      createdAt: "2026-08-21T11:00:00Z",
    };
    return respond(204);
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: removed && query.sinceSeqId === 0 ? [removed] : [],
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadsContract.events, async ({ query, respond }) => {
    if (!removed) {
      return respond(200, { events: [], hasMore: false });
    }
    sync.resolve();
    await release.promise;
    const events = [
      chatListEvent(482, 2, "project_updated", ws.member.id, {
        projectId: null,
      }),
      chatListEvent(482, 3, "renamed", ws.member.id, {
        title: "Planning outside Launch",
      }),
    ];
    return respond(200, {
      events: events.filter((e) => {
        return e.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  click(await findFastControl("button", "Options for Launch"));
  click(await screen.findByText("Delete", { exact: true }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Project?" });
  click(await findFastControl("button", "Delete project only", dialog));
  await sync.promise;
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(queryFastControl("button", "Show or hide chats in Launch")).toBeNull();
  expect(location.pathname).toBe(ws.path);
  release.resolve();
  await findFastControl("link", "Planning outside Launch");
  checkLocation("Planning outside Launch", null);
  expect(location.pathname).toBe(ws.path);
});
