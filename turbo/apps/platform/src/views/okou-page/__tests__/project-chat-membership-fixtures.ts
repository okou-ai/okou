import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread, chatListEvent } from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { project } from "./project-editor-fixtures.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
export async function membershipPage(
  context: TestContext,
  current: "outside" | "member" = "outside",
) {
  const launch = project("Launch"),
    research = project("Research");
  const outside = chatListThread(7, "Ordinary discussion"),
    member = chatListThread(8, "Campaign planning", { projectId: launch.id }),
    review = chatListThread(9, "Research notes", { projectId: research.id });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 482,
    threads: [outside, member, review],
  });
  const changes: ChatThreadEvent[] = [],
    requests: { chat: string; project: string | null }[] = [];
  const save = context.mocks.deferred<void>(),
    received = context.mocks.deferred<void>();
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [launch, research],
      latestEventId: null,
      latestSeqId: 0,
    });
  });
  context.mocks.api(projectsContract.threads, ({ params, respond }) => {
    return respond(200, {
      threads: [member, review].filter((row) => {
        return row.projectId === params.id;
      }),
      nextAfter: null,
    });
  });
  context.mocks.api(
    projectsContract.membership,
    async ({ params, body, respond }) => {
      requests.push({ chat: params.id, project: body.projectId });
      received.resolve();
      await save.promise;
      const name = (params.id === member.id ? member : outside).title;
      changes.push(
        chatListEvent(482, 2, "project_updated", params.id, {
          id: body.eventId,
          projectId: body.projectId,
        }),
        chatListEvent(482, 3, "renamed", params.id, {
          title: name + " confirmed",
        }),
      );
      return respond(200, { threadId: params.id, projectId: body.projectId });
    },
  );
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: changes.filter((c) => {
        return c.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  const path = "/chats/" + (current === "member" ? member.id : outside.id);
  await setupPage({ context, ...pageOptions, path });
  async function fold(name: string, expanded: boolean) {
    const toggle = await findFastControl(
      "button",
      "Show or hide chats in " + name,
    );
    if (toggle.getAttribute("aria-expanded") !== String(expanded)) {
      click(toggle);
    }
    await waitFor(() => {
      return expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
    });
    return toggle;
  }
  await fold("Launch", true);
  await findFastControl("link", member.title!);
  return {
    outside,
    member,
    review,
    launch,
    research,
    save,
    received: received.promise,
    requests,
    path,
    fold,
    pageOptions,
  };
}
export async function drag(
  source: string,
  target: string,
  role: "link" | "button" = "link",
) {
  const from = await findFastControl("link", source),
    to = await findFastControl(role, target);
  const data = new DataTransfer();
  fireEvent.dragStart(from, { dataTransfer: data });
  fireEvent.dragOver(to, { dataTransfer: data, clientX: 32, clientY: 48 });
  return {
    from,
    to,
    data,
    drop: () => {
      return fireEvent.drop(to, { dataTransfer: data });
    },
  };
}
export function checkLocation(title: string, folder: string | null) {
  const row = queryFastControl("link", title);
  expect(row).toBeVisible();
  expect(row?.closest("[data-project-drop-id]")).toHaveAttribute(
    "data-project-drop-id",
    folder ?? "",
  );
}
export async function indicator(text: string) {
  const hint = await screen.findByRole("tooltip");
  expect(hint).toHaveTextContent(text);
  return hint;
}
