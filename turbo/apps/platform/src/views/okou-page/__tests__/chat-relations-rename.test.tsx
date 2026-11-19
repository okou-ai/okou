import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  type ChatCommunication,
  chatRelationsContract,
} from "@okouai/api-contracts/contracts/chat-relations";
import {
  type ChatThreadEvent,
  chatThreadsContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";

const context = testContext();

const PROMPT = "Research the launch market";
const PARENT_RUN_ID = "e7000000-0000-4000-a000-000000000001";

/** The child's first run was launched by a message from its parent's run. */
function launchedByParent(
  caseId: number,
  child: ChatThreadSnapshotProjection,
  parent: ChatThreadSnapshotProjection,
  titleSnapshot: string,
): ChatEventRow {
  const row = continuityEventRow(caseId, 1, child.id, "input.prompt", {
    payload: {
      userMessage: {
        version: 1,
        parts: [
          {
            type: "source",
            kind: "agent",
            runId: PARENT_RUN_ID,
            threadId: parent.id,
            agentId: parent.agentId,
            titleSnapshot,
            href: `/chats/${parent.id}#run-${PARENT_RUN_ID}`,
          },
          { type: "text", text: PROMPT },
        ],
      },
    },
  });
  return { ...row, runId: row.id };
}

function parentCommunication(
  parent: ChatThreadSnapshotProjection,
  title: string,
): ChatCommunication {
  return {
    threadId: parent.id,
    title,
    status: "idle",
    sentCount: 0,
    receivedCount: 1,
    lastMessageAt: "2026-08-03T12:00:00.000Z",
  };
}

function installParentAndChild(options: {
  readonly caseId: number;
  readonly parentTitle: string;
  readonly titleSnapshot: string;
  readonly communications: () =>
    readonly ChatCommunication[] | Promise<readonly ChatCommunication[]>;
}) {
  context.mocks.browser.matchMedia(true);
  const parent = continuityThread(options.caseId, 1, options.parentTitle);
  const child = continuityThread(options.caseId, 2, "Market research");
  const workspace = installContinuityWorkspace(context, {
    caseId: options.caseId,
    threads: [parent, child],
    chatEventRows: [
      launchedByParent(options.caseId, child, parent, options.titleSnapshot),
    ],
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [] });
  });
  context.mocks.api(
    chatRelationsContract.communications,
    async ({ params, respond }) => {
      return respond(200, {
        items:
          params.id === child.id ? [...(await options.communications())] : [],
      });
    },
  );
  return { parent, child, workspace };
}

function parentLinks(parentId: string, panel: HTMLElement): HTMLElement[] {
  return queryAllByRoleFast("link", panel).filter((link) => {
    return link.getAttribute("href")?.startsWith(`/chats/${parentId}`);
  });
}

function messagesButton(title: string, panel: HTMLElement): HTMLElement {
  const button = queryAllByRoleFast("button", panel).find((candidate) => {
    return candidate.getAttribute("aria-label") === `Messages with ${title}`;
  });
  if (!button) {
    throw new Error(`Expected the messages control for ${title}`);
  }
  return button;
}

test("Show the current parent title when loading historical sources", async () => {
  const { parent, child, workspace } = installParentAndChild({
    caseId: 51,
    parentTitle: "Launch roadmap",
    titleSnapshot: "Launch plan draft",
    communications: () => {
      return [parentCommunication(parent, "Launch roadmap")];
    },
  });
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${child.id}`,
  });
  await screen.findByText(PROMPT);

  const panel = await openResources();

  const links = await waitFor(() => {
    const found = parentLinks(parent.id, panel);
    expect(found).toHaveLength(1);
    return found;
  });
  expect(links[0]).toHaveAttribute("href", `/chats/${parent.id}`);
  expect(links[0]).toHaveTextContent("Launch roadmapFrom");
  expect(panel).not.toHaveTextContent("Launch plan draft");
  expect(messagesButton("Launch roadmap", panel)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(panel.querySelector('section[aria-label="From"]')).toBeNull();
});

test("Update the parent chat row when another tab renames the parent", async () => {
  let communicationReads = 0;
  const delayedRelations = context.mocks.deferred<void>();
  const { parent, child, workspace } = installParentAndChild({
    caseId: 52,
    parentTitle: "Launch roadmap",
    titleSnapshot: "Launch roadmap",
    communications: async () => {
      communicationReads += 1;
      if (communicationReads > 1) {
        await delayedRelations.promise;
      }
      return [parentCommunication(parent, "Launch roadmap")];
    },
  });
  let renamed: readonly ChatThreadEvent[] = [];
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: renamed.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${child.id}`,
  });
  await screen.findByText(PROMPT);
  const panel = await openResources();
  const row = await waitFor(() => {
    const [link] = parentLinks(parent.id, panel);
    expect(link).toHaveTextContent("Launch roadmapFrom");
    return link;
  });
  const readsBeforeRename = communicationReads;

  renamed = [
    chatListEvent(52, 2, "renamed", parent.id, {
      agentId: parent.agentId,
      title: "Launch roadmap v2",
    }),
  ];
  changeChatThreadList();

  await waitFor(() => {
    expect(row).toHaveTextContent("Launch roadmap v2From");
  });
  expect(communicationReads).toBeGreaterThan(readsBeforeRename);
  expect(delayedRelations.settled()).toBeFalsy();
  delayedRelations.resolve();
});
