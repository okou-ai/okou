import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  type ChatCommunication,
  type ChatRelationMessage,
  chatRelationsContract,
  type CreatedChatRelation,
} from "@okouai/api-contracts/contracts/chat-relations";
import type {
  ChatThreadSnapshotProjection,
  UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { openResources, resourceState } from "./chat-resources-test-helpers.ts";

const context = testContext();

const SLACK_MESSAGE = "https://acme.slack.com/archives/C123/p1712345678000100";
const PROMPT = "Coordinate the launch";
const AGENT_ID = "c7000000-0000-4000-a000-000000000001";

type Items<T> = readonly T[] | Promise<readonly T[]>;

function relatedId(slot: number): string {
  return `e5000000-0000-4000-a000-${slot.toString().padStart(12, "0")}`;
}

function runId(slot: number): string {
  return `e6000000-0000-4000-a000-${slot.toString().padStart(12, "0")}`;
}

function createdChat(
  threadId: string,
  title: string,
  createdAt: string,
  status: CreatedChatRelation["status"] = "idle",
): CreatedChatRelation {
  return {
    id: crypto.randomUUID(),
    threadId,
    title,
    status,
    sourceRunId: runId(900),
    createdAt,
  };
}

function communication(
  threadId: string,
  title: string | null,
  options: {
    readonly status?: ChatCommunication["status"];
    readonly sentCount?: number;
    readonly receivedCount?: number;
    readonly lastMessageAt: string;
  },
): ChatCommunication {
  return {
    threadId,
    title,
    status: options.status ?? "idle",
    sentCount: options.sentCount ?? 0,
    receivedCount: options.receivedCount ?? 0,
    lastMessageAt: options.lastMessageAt,
  };
}

function relationMessage(options: {
  readonly direction: ChatRelationMessage["direction"];
  readonly source: string;
  readonly target: string;
  readonly targetRunId: string | null;
  readonly text: string;
  readonly createdAt: string;
}): ChatRelationMessage {
  return {
    id: crypto.randomUUID(),
    direction: options.direction,
    sourceChatThreadId: options.source,
    targetChatThreadId: options.target,
    sourceRunId: runId(901),
    targetRunId: options.targetRunId,
    messageEventId: crypto.randomUUID(),
    createdAt: options.createdAt,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: options.text }],
    },
  };
}

/** The first run's launch prompt; the run takes its launch input's ID. */
function launchPrompt(
  caseId: number,
  threadId: string,
  source: UserMessagePart | null,
): ChatEventRow {
  const row = continuityEventRow(caseId, 1, threadId, "input.prompt", {
    payload: {
      userMessage: {
        version: 1,
        parts: [...(source ? [source] : []), { type: "text", text: PROMPT }],
      },
    },
  });
  return { ...row, runId: row.id };
}

function agentSource(parentId: string, parentRunId: string): UserMessagePart {
  return {
    type: "source",
    kind: "agent",
    runId: parentRunId,
    threadId: parentId,
    agentId: AGENT_ID,
    titleSnapshot: "Parent plan",
    href: `/chats/${parentId}#run-${parentRunId}`,
  };
}

function installRelationsChat(options: {
  readonly caseId: number;
  readonly threads: readonly ChatThreadSnapshotProjection[];
  readonly rows: readonly ChatEventRow[];
  readonly children?: (threadId: string) => Items<CreatedChatRelation>;
  readonly communications?: (threadId: string) => Items<ChatCommunication>;
  readonly messages?: (
    threadId: string,
    peerId: string,
  ) => readonly ChatRelationMessage[];
}) {
  context.mocks.browser.matchMedia(true);
  const workspace = installContinuityWorkspace(context, {
    caseId: options.caseId,
    threads: options.threads,
    chatEventRows: options.rows,
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });
  context.mocks.api(
    chatRelationsContract.children,
    async ({ params, respond }) => {
      return respond(200, {
        items: [...(await (options.children?.(params.id) ?? []))],
      });
    },
  );
  context.mocks.api(
    chatRelationsContract.communications,
    async ({ params, respond }) => {
      return respond(200, {
        items: [...(await (options.communications?.(params.id) ?? []))],
      });
    },
  );
  context.mocks.api(chatRelationsContract.messages, ({ params, respond }) => {
    return respond(200, {
      items: [...(options.messages?.(params.id, params.peerId) ?? [])],
    });
  });
  return workspace;
}

async function openChat(
  workspace: ReturnType<typeof installRelationsChat>,
  threadId: string,
) {
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${threadId}`,
  });
  await screen.findByText(PROMPT);
}

function linkTo(href: string, container: ParentNode): HTMLAnchorElement {
  const link = queryLinkTo(href, container);
  if (!link) {
    throw new Error(`Expected a link to ${href}`);
  }
  return link;
}

function queryLinkTo(
  href: string,
  container: ParentNode,
): HTMLAnchorElement | null {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.getAttribute("href") === href;
  });
  return link instanceof HTMLAnchorElement ? link : null;
}

function section(name: string, container: ParentNode): HTMLElement | null {
  return container.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
}

function chatsList(panel: HTMLElement): HTMLElement {
  const list = section("Chats", panel)?.querySelector("ul");
  if (!(list instanceof HTMLElement)) {
    throw new Error("Expected the Chats list");
  }
  return list;
}

function chatItems(panel: HTMLElement): HTMLElement[] {
  return [...chatsList(panel).children].filter(
    (child): child is HTMLElement => {
      return child instanceof HTMLElement;
    },
  );
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

function sectionToggle(name: string, panel: HTMLElement): HTMLElement {
  const toggle = section("Chats", panel)
    ? queryAllByRoleFast("button", section("Chats", panel) ?? panel).find(
        (candidate) => {
          return candidate.textContent?.trim() === name;
        },
      )
    : undefined;
  if (!toggle) {
    throw new Error(`Expected the Chats ${name} control`);
  }
  return toggle;
}

/**
 * Deliberate docs/testing.md#external-behavior exception: HappyDOM cannot lay
 * out CSS, so give the clipped title a measurable overflow of 74px.
 */
function overflowTitle(link: HTMLElement): HTMLElement {
  const clip = link.querySelector<HTMLElement>("[data-title-reveal]");
  const text = clip?.firstElementChild;
  if (!clip || !text) {
    throw new Error("Expected a clipped title");
  }
  clip.getBoundingClientRect = () => {
    return new DOMRect(0, 0, 160, 20);
  };
  text.getBoundingClientRect = () => {
    return new DOMRect(0, 0, 234, 20);
  };
  return clip;
}

async function expectTitleReveal(link: HTMLElement) {
  const user = userEvent.setup();
  const clip = overflowTitle(link);
  await user.hover(link);
  expect(clip).toHaveAttribute("data-title-revealing", "");
  expect(clip.style.getPropertyValue("--okou-nav-title-duration")).toBe(
    "925ms",
  );
  await user.unhover(link);
  expect(clip).not.toHaveAttribute("data-title-revealing");
}

test("Draw the source and related chats together once children answer", async () => {
  const current = continuityThread(31, 1, "Launch coordination");
  const childId = relatedId(311);
  const children = context.mocks.deferred<void>();
  const workspace = installRelationsChat({
    caseId: 31,
    threads: [current],
    rows: [
      launchPrompt(31, current.id, {
        type: "source",
        kind: "slack",
        href: SLACK_MESSAGE,
      }),
    ],
    children: async () => {
      await children.promise;
      return [
        createdChat(childId, "Research child", "2026-08-12T12:01:00.000Z"),
      ];
    },
  });
  await openChat(workspace, current.id);

  const panel = await openResources();

  expect(
    within(panel).getByRole("status", { name: "Loading artifacts" }),
  ).toBeInTheDocument();
  expect(queryLinkTo(SLACK_MESSAGE, panel)).toBeNull();

  children.resolve();
  await waitFor(() => {
    expect(
      linkTo(SLACK_MESSAGE, section("From", panel) ?? panel),
    ).toBeInTheDocument();
  });
  expect(linkTo(`/chats/${childId}`, chatsList(panel))).toHaveTextContent(
    "Research child",
  );
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
});

test("Start the next chat closed and draw its panel once its relationships answer", async () => {
  const first = continuityThread(32, 1, "First chat");
  const second = continuityThread(32, 2, "Second chat");
  const grandchildId = relatedId(321);
  const secondCommunications = context.mocks.deferred<void>();
  const workspace = installRelationsChat({
    caseId: 32,
    threads: [first, second],
    rows: [
      launchPrompt(32, first.id, null),
      continuityEventRow(32, 2, second.id, "input.prompt", {
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Second chat prompt" }],
          },
        },
      }),
    ],
    children: (threadId) => {
      return threadId === first.id
        ? [createdChat(second.id, "Second chat", "2026-08-13T12:01:00.000Z")]
        : [
            createdChat(
              grandchildId,
              "Second chat child",
              "2026-08-13T12:02:00.000Z",
            ),
          ];
    },
    communications: async (threadId) => {
      if (threadId === second.id) {
        await secondCommunications.promise;
      }
      return [];
    },
  });
  await openChat(workspace, first.id);
  const firstPanel = await openResources();
  await waitFor(() => {
    expect(linkTo(`/chats/${second.id}`, firstPanel)).toBeInTheDocument();
  });

  click(linkTo(`/chats/${second.id}`, firstPanel));
  await screen.findByText("Second chat prompt");
  expect(resourceState()).toStrictEqual({ open: false, visible: false });
  const secondPanel = await openResources();

  expect(
    within(secondPanel).getByRole("status", { name: "Loading artifacts" }),
  ).toBeInTheDocument();
  expect(queryLinkTo(`/chats/${second.id}`, secondPanel)).toBeNull();

  secondCommunications.resolve();
  await waitFor(() => {
    expect(linkTo(`/chats/${grandchildId}`, secondPanel)).toHaveTextContent(
      "Second chat child",
    );
  });
  expect(queryLinkTo(`/chats/${second.id}`, secondPanel)).toBeNull();
  expect(within(secondPanel).queryByRole("status")).not.toBeInTheDocument();
});

test("Show the first source and created chats with their status", async () => {
  const current = continuityThread(33, 1, "Launch coordination");
  const firstChild = relatedId(331);
  const secondChild = relatedId(332);
  const running = relatedId(333);
  const workspace = installRelationsChat({
    caseId: 33,
    threads: [current],
    rows: [
      launchPrompt(33, current.id, {
        type: "source",
        kind: "slack",
        href: SLACK_MESSAGE,
      }),
    ],
    children: () => {
      return [
        createdChat(firstChild, "Launch checklist", "2026-08-14T12:01:00.000Z"),
        createdChat(secondChild, "Press outreach", "2026-08-14T12:02:00.000Z"),
      ];
    },
    communications: () => {
      return [
        communication(running, "Pricing review", {
          status: "running",
          sentCount: 1,
          lastMessageAt: "2026-08-14T12:03:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);

  const panel = await openResources();
  await waitFor(() => {
    expect(linkTo(`/chats/${running}`, panel)).toBeInTheDocument();
  });

  expect(
    linkTo(SLACK_MESSAGE, section("From", panel) ?? panel),
  ).toHaveAttribute("href", SLACK_MESSAGE);
  for (const [threadId, title] of [
    [firstChild, "Launch checklist"],
    [secondChild, "Press outreach"],
  ] as const) {
    const link = linkTo(`/chats/${threadId}`, chatsList(panel));
    expect(link).toHaveTextContent(title);
    expect(link).not.toHaveTextContent("Running");
  }
  expect(linkTo(`/chats/${running}`, chatsList(panel))).toHaveTextContent(
    "Pricing reviewRunning",
  );
  expect(messagesButton("Pricing review", panel)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expectTitleReveal(linkTo(`/chats/${firstChild}`, chatsList(panel)));
});

test("Link the first-run agent source directly to its parent run", async () => {
  const current = continuityThread(34, 1, "Delegated research");
  const parentId = relatedId(341);
  const parentRunId = runId(341);
  const workspace = installRelationsChat({
    caseId: 34,
    threads: [current],
    rows: [launchPrompt(34, current.id, agentSource(parentId, parentRunId))],
  });
  await openChat(workspace, current.id);

  const panel = await openResources();
  const origin = await waitFor(() => {
    return linkTo(`/chats/${parentId}#run-${parentRunId}`, chatsList(panel));
  });

  expect(origin).toHaveTextContent("Parent planFrom");
  expect(chatItems(panel)).toHaveLength(1);
  expect(section("From", panel)).toBeNull();
  await expectTitleReveal(origin);
});

test("List an agent origin once when it is also a related chat", async () => {
  const current = continuityThread(35, 1, "Delegated research");
  const parentId = relatedId(351);
  const childId = relatedId(352);
  const workspace = installRelationsChat({
    caseId: 35,
    threads: [current],
    rows: [launchPrompt(35, current.id, agentSource(parentId, runId(351)))],
    children: () => {
      return [
        createdChat(childId, "Follow-up child", "2026-08-16T12:01:00.000Z"),
      ];
    },
    communications: () => {
      return [
        communication(parentId, "Parent plan", {
          receivedCount: 1,
          lastMessageAt: "2026-08-16T12:02:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);

  const panel = await openResources();
  await waitFor(() => {
    expect(chatItems(panel)).toHaveLength(2);
  });

  const parentLinks = queryAllByRoleFast("link", chatsList(panel)).filter(
    (link) => {
      return link.getAttribute("href")?.startsWith(`/chats/${parentId}`);
    },
  );
  expect(parentLinks).toHaveLength(1);
  expect(parentLinks[0]).toHaveAttribute("href", `/chats/${parentId}`);
  expect(parentLinks[0]).toHaveTextContent("Parent planFrom");
  expect(linkTo(`/chats/${childId}`, chatsList(panel))).toHaveTextContent(
    "Follow-up child",
  );
  expect(section("From", panel)).toBeNull();
});

test("Keep the agent origin first in the collapsed preview when it is the oldest related chat", async () => {
  const current = continuityThread(36, 1, "Delegated research");
  const parentId = relatedId(361);
  const children = [362, 363, 364].map((slot, index) => {
    return createdChat(
      relatedId(slot),
      `Child ${index + 1}`,
      `2026-08-17T12:0${3 - index}:00.000Z`,
    );
  });
  const workspace = installRelationsChat({
    caseId: 36,
    threads: [current],
    rows: [launchPrompt(36, current.id, agentSource(parentId, runId(361)))],
    children: () => {
      return children;
    },
    communications: () => {
      return [
        communication(parentId, "Parent plan", {
          receivedCount: 1,
          lastMessageAt: "2026-08-17T12:30:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);

  const panel = await openResources();
  await waitFor(() => {
    expect(chatItems(panel)).toHaveLength(3);
  });

  expect(chatItems(panel)[0]).toHaveTextContent("Parent planFrom");
  expect(
    queryLinkTo(`/chats/${children[2]?.threadId}`, chatsList(panel)),
  ).toBeNull();

  click(sectionToggle("Show more", panel));
  await waitFor(() => {
    expect(chatItems(panel)).toHaveLength(4);
  });
  expect(chatItems(panel)[0]).toHaveTextContent("Parent planFrom");
  expect(
    linkTo(`/chats/${children[2]?.threadId}`, chatsList(panel)),
  ).toHaveTextContent("Child 3");
});

test("Open a related chat's messages and link each to the run it started", async () => {
  const current = continuityThread(37, 1, "Launch coordination");
  const relatedChat = relatedId(371);
  const relatedRun = runId(371);
  const currentRun = runId(372);
  const workspace = installRelationsChat({
    caseId: 37,
    threads: [current],
    rows: [launchPrompt(37, current.id, null)],
    communications: () => {
      return [
        communication(relatedChat, "Design review", {
          sentCount: 2,
          receivedCount: 1,
          lastMessageAt: "2026-08-18T12:03:00.000Z",
        }),
      ];
    },
    messages: () => {
      return [
        relationMessage({
          direction: "sent",
          source: current.id,
          target: relatedChat,
          targetRunId: relatedRun,
          text: "Draft the brief",
          createdAt: "2026-08-18T12:01:00.000Z",
        }),
        relationMessage({
          direction: "received",
          source: relatedChat,
          target: current.id,
          targetRunId: currentRun,
          text: "The brief is ready",
          createdAt: "2026-08-18T12:02:00.000Z",
        }),
        relationMessage({
          direction: "sent",
          source: current.id,
          target: relatedChat,
          targetRunId: null,
          text: "Any updates?",
          createdAt: "2026-08-18T12:03:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);
  const panel = await openResources();
  const history = await waitFor(() => {
    return messagesButton("Design review", panel);
  });

  click(history);

  const sent = await waitFor(() => {
    return linkTo(`/chats/${relatedChat}#run-${relatedRun}`, panel);
  });
  expect(history).toHaveAttribute("aria-expanded", "true");
  expect(sent).toHaveTextContent("Sent");
  expect(sent).toHaveTextContent("Draft the brief");
  const received = linkTo(`/chats/${current.id}#run-${currentRun}`, panel);
  expect(received).toHaveTextContent("Received");
  expect(received).toHaveTextContent("The brief is ready");
  const pending = queryAllByRoleFast("link", panel).find((link) => {
    return link.textContent?.includes("Any updates?");
  });
  expect(pending).toHaveAttribute("href", `/chats/${relatedChat}`);

  click(history);
  await waitFor(() => {
    expect(within(panel).queryByText("Draft the brief")).toBeNull();
  });
  expect(within(panel).queryByText("The brief is ready")).toBeNull();
  expect(history).toHaveAttribute("aria-expanded", "false");
});

test("Follow a sent message card to the run it started in the other chat", async () => {
  const current = continuityThread(38, 1, "Launch coordination");
  const related = continuityThread(38, 2, "Design review");
  const relatedRun = runId(381);
  const workspace = installRelationsChat({
    caseId: 38,
    threads: [current, related],
    rows: [launchPrompt(38, current.id, null)],
    communications: (threadId) => {
      return threadId === current.id
        ? [
            communication(related.id, "Design review", {
              sentCount: 1,
              lastMessageAt: "2026-08-19T12:01:00.000Z",
            }),
          ]
        : [];
    },
    messages: () => {
      return [
        relationMessage({
          direction: "sent",
          source: current.id,
          target: related.id,
          targetRunId: relatedRun,
          text: "Draft the brief",
          createdAt: "2026-08-19T12:01:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);
  const panel = await openResources();
  click(
    await waitFor(() => {
      return messagesButton("Design review", panel);
    }),
  );
  const card = await waitFor(() => {
    return linkTo(`/chats/${related.id}#run-${relatedRun}`, panel);
  });

  click(card);

  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${related.id}`);
  });
  expect(location.hash).toBe(`#run-${relatedRun}`);
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Design review",
    );
  });
});

test("Open a related chat from its row in one click, while its caret opens the history", async () => {
  const current = continuityThread(39, 1, "Launch coordination");
  const related = continuityThread(39, 2, "Design review");
  const currentRun = runId(391);
  const workspace = installRelationsChat({
    caseId: 39,
    threads: [current, related],
    rows: [launchPrompt(39, current.id, null)],
    communications: (threadId) => {
      return threadId === current.id
        ? [
            communication(related.id, "Design review", {
              receivedCount: 1,
              lastMessageAt: "2026-08-20T12:01:00.000Z",
            }),
          ]
        : [];
    },
    messages: () => {
      return [
        relationMessage({
          direction: "received",
          source: related.id,
          target: current.id,
          targetRunId: currentRun,
          text: "The brief is ready",
          createdAt: "2026-08-20T12:01:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);
  const panel = await openResources();

  click(
    await waitFor(() => {
      return messagesButton("Design review", panel);
    }),
  );

  const received = await waitFor(() => {
    return linkTo(`/chats/${current.id}#run-${currentRun}`, panel);
  });
  expect(received).toHaveTextContent("The brief is ready");
  const row = linkTo(`/chats/${related.id}`, chatsList(panel));

  click(row);

  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${related.id}`);
  });
  expect(location.hash).toBe("");
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Design review",
    );
  });
});

test("Show a queued related chat's status as text", async () => {
  const current = continuityThread(40, 1, "Launch coordination");
  const queued = relatedId(401);
  const workspace = installRelationsChat({
    caseId: 40,
    threads: [current],
    rows: [launchPrompt(40, current.id, null)],
    communications: () => {
      return [
        communication(queued, "Inbox triage", {
          status: "queued",
          sentCount: 21,
          lastMessageAt: "2026-08-01T12:01:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);

  const panel = await openResources();
  const row = await waitFor(() => {
    return linkTo(`/chats/${queued}`, chatsList(panel));
  });

  expect(row).toHaveTextContent("Inbox triageQueued");
  expect(within(row).getByText("Queued")).toBeInTheDocument();
  expect(row).not.toHaveTextContent("Running");
});

test("Close an open message history when the Chats section collapses", async () => {
  const current = continuityThread(41, 1, "Launch coordination");
  const children = [411, 412, 413, 414].map((slot, index) => {
    return createdChat(
      relatedId(slot),
      `Child ${index + 1}`,
      `2026-08-02T12:0${4 - index}:00.000Z`,
    );
  });
  const exchanged = children[3];
  if (!exchanged) {
    throw new Error("Expected four created chats");
  }
  const workspace = installRelationsChat({
    caseId: 41,
    threads: [current],
    rows: [launchPrompt(41, current.id, null)],
    children: () => {
      return children;
    },
    communications: () => {
      return [
        communication(exchanged.threadId, exchanged.title, {
          sentCount: 1,
          lastMessageAt: "2026-08-02T12:00:00.000Z",
        }),
      ];
    },
    messages: () => {
      return [
        relationMessage({
          direction: "sent",
          source: current.id,
          target: exchanged.threadId,
          targetRunId: runId(411),
          text: "Check the venue",
          createdAt: "2026-08-02T12:00:00.000Z",
        }),
      ];
    },
  });
  await openChat(workspace, current.id);
  const panel = await openResources();
  click(
    await waitFor(() => {
      return sectionToggle("Show more", panel);
    }),
  );
  const history = await waitFor(() => {
    return messagesButton("Child 4", panel);
  });
  click(history);
  await expect(
    within(panel).findByText("Check the venue"),
  ).resolves.toBeInTheDocument();

  click(sectionToggle("Collapse", panel));

  await waitFor(() => {
    expect(within(panel).queryByText("Check the venue")).toBeNull();
  });
  expect(chatItems(panel)).toHaveLength(3);
});
