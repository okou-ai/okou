import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatRelationsContract,
  type ChatCommunication,
  type ChatRelationMessage,
  type CreatedChatRelation,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { hash, pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  artifactSummary,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID as THREAD,
} from "./chat-navigation-artifact-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const PEER = "d0000000-0000-4000-a000-000000000101";
const CHILD = "d0000000-0000-4000-a000-000000000102";
const RUN = "d0000000-0000-4000-a000-000000000103";
const OTHER_RUN = "d0000000-0000-4000-a000-000000000104";
const RELATION = "d0000000-0000-4000-a000-000000000105";
const EVENT = "d0000000-0000-4000-a000-000000000106";
const WHEN = "2026-09-01T10:00:00.000Z";
const SLACK = "https://example.slack.com/archives/C123/p456";

function prompt(source?: UserMessagePart, runId = RUN): MockChatEventInput {
  return {
    id: runId,
    role: "user",
    content: null,
    runId,
    createdAt: WHEN,
    userMessage: {
      version: 1,
      parts: [
        { type: "text", text: "Plan the launch" },
        ...(source ? [source] : []),
      ],
    },
  };
}
function createdChat(
  threadId = CHILD,
  title = "Research child",
): CreatedChatRelation {
  return {
    id: RELATION,
    threadId,
    title,
    status: "idle",
    sourceRunId: RUN,
    createdAt: WHEN,
  };
}
function mockCommunications(
  sentCount = 1,
  overrides: Partial<ChatCommunication> = {},
) {
  context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
    return respond(200, {
      items: [
        {
          threadId: PEER,
          title: "Existing planning chat",
          status: "running",
          sentCount,
          receivedCount: 1,
          lastMessageAt: WHEN,
          ...overrides,
        },
      ],
    });
  });
}
function message(
  overrides: Partial<ChatRelationMessage> = {},
): ChatRelationMessage {
  return {
    id: RELATION,
    direction: "sent",
    sourceChatThreadId: THREAD,
    targetChatThreadId: PEER,
    sourceRunId: RUN,
    targetRunId: OTHER_RUN,
    messageEventId: EVENT,
    createdAt: WHEN,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "Please check the launch plan" }],
    },
    ...overrides,
  };
}
function receivedMessage(text: string): ChatRelationMessage {
  return message({
    id: EVENT,
    direction: "received",
    sourceChatThreadId: PEER,
    targetChatThreadId: THREAD,
    sourceRunId: OTHER_RUN,
    targetRunId: RUN,
    userMessage: { version: 1, parts: [{ type: "text", text }] },
  });
}
function mockMessages(items: readonly ChatRelationMessage[]) {
  context.mocks.api(chatRelationsContract.messages, ({ respond }) => {
    return respond(200, { items: [...items] });
  });
}
function messagesCaret(container: HTMLElement, title: string) {
  return queryAllByRoleFast("button", container).find((button) => {
    return button.getAttribute("aria-label") === `Messages with ${title}`;
  });
}
async function openMessages(title: string) {
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText(title);
  const row = messagesCaret(panel, title);
  if (!row) {
    throw new Error(`Expected a messages caret for ${title}`);
  }
  click(row);
  return { panel, row };
}

function installRelationsGeometry(narrow = false) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "scrollContainer")) {
        return new DOMRect(0, 80, 1800, 700);
      }
      if (Object.hasOwn(this.dataset, "messageContainer")) {
        return new DOMRect(narrow ? 800 : 420, 80, 900, 700);
      }
      return original.call(this);
    },
  );
  context.mocks.browser.matchMedia(true);
}

async function setupRelations(
  options: {
    readonly events?: MockChatEventInput[];
    readonly enabled?: boolean;
    readonly narrow?: boolean;
    readonly mock?: () => void;
  } = {},
) {
  installRelationsGeometry(options.narrow);
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: options.events ?? [prompt()],
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [] });
  });
  context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
    return respond(200, { items: [] });
  });
  options.mock?.();
  await setupPage({
    context,
    path: `/chats/${THREAD}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatResourcePanel]: options.enabled ?? true,
    },
  });
}

test.each(["children", "communications"] as const)(
  "Draw the source and related chats together once %s answer",
  async (pending) => {
    const requested = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<void>(context.signal);
    await setupRelations({
      events: [prompt({ type: "source", kind: "slack", href: SLACK })],
      mock: () => {
        context.mocks.api(
          chatRelationsContract.children,
          async ({ respond }) => {
            if (pending === "children") {
              if (!requested.settled()) {
                requested.resolve();
              }
              await response.promise;
            }
            return respond(200, { items: [createdChat()] });
          },
        );
        context.mocks.api(
          chatRelationsContract.communications,
          async ({ respond }) => {
            if (pending === "communications") {
              if (!requested.settled()) {
                requested.resolve();
              }
              await response.promise;
            }
            return respond(200, { items: [] });
          },
        );
      },
    });
    await requested.promise;
    await screen.findByText("Plan the launch");
    // The source alone would draw a half-filled panel that then grows.
    expect(
      screen.queryByRole("region", { name: "Resources" }),
    ).not.toBeInTheDocument();

    response.resolve();
    const panel = await screen.findByRole("region", { name: "Resources" });
    await within(panel).findByText("Research child");
    expect(within(panel).getByText("Slack")).toBeInTheDocument();
    expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(panel).getByRole("region", { name: "Chats" }),
    ).toBeInTheDocument();
  },
);

test("Keep loaded relationships visible when another source fails", async () => {
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: [createdChat(CHILD, "Research child")],
        });
      });
      context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Temporarily unavailable",
          },
        });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(
    within(panel).findByText("Research child"),
  ).resolves.toBeInTheDocument();
});

test("Draw the next chat's panel only once its relationships answer", async () => {
  installRelationsGeometry();
  const first = continuityThread(96, 1, "First related chat");
  const second = continuityThread(96, 2, "Next related chat");
  const response = createDeferredPromise<void>(context.signal);
  const workspace = installContinuityWorkspace(context, {
    caseId: 96,
    threads: [first, second],
    chatEventRows: [],
  });
  context.mocks.api(chatRelationsContract.children, ({ params, respond }) => {
    return respond(200, {
      items:
        params.id === first.id
          ? [createdChat(second.id, "Next related chat")]
          : [createdChat()],
    });
  });
  context.mocks.api(
    chatRelationsContract.communications,
    async ({ params, respond }) => {
      if (params.id === second.id) {
        await response.promise;
      }
      return respond(200, { items: [] });
    },
  );
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${first.id}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatResourcePanel]: true,
    },
  });
  const previous = await screen.findByRole("region", { name: "Resources" });
  click((await within(previous).findByText("Next related chat")).closest("a")!);
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Next related chat",
    );
  });
  // No placeholder and nothing from the previous chat while this one loads.
  await waitFor(() => {
    expect(buttonNamed("Resources")).toHaveAttribute("aria-busy", "true");
  });
  expect(
    screen.queryByRole("region", { name: "Resources" }),
  ).not.toBeInTheDocument();
  response.resolve();
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Research child");
  expect(
    within(panel).queryByText("Next related chat"),
  ).not.toBeInTheDocument();
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
});

test("Show the first source and created chats with their status", async () => {
  await setupRelations({
    events: [prompt({ type: "source", kind: "slack", href: SLACK })],
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: [
            createdChat(),
            { ...createdChat(EVENT, "Older child"), id: EVENT },
          ],
        });
      });
      mockCommunications();
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(within(panel).findByText("Slack")).resolves.toBeInTheDocument();
  expect(
    within(panel).getByLabelText("Open original message in Slack"),
  ).toHaveAttribute("href", SLACK);
  const child = await within(panel).findByText("Research child");
  expect(child.closest("a")).toHaveAttribute("href", `/chats/${CHILD}`);
  await expect(
    within(panel).findByText("Older child"),
  ).resolves.toBeInTheDocument();
  // The peer row opens the chat; a separate caret opens its message history.
  const peer = within(panel).getByText("Existing planning chat").closest("a");
  expect(peer).toHaveAttribute("href", `/chats/${PEER}`);
  expect(peer).toHaveTextContent("Running");
  expect(messagesCaret(panel, "Existing planning chat")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(child.closest("a")).not.toHaveTextContent("Running");
  expect(panel.querySelector("[title]")).toBeNull();
});

test("Keep an unknown first-run origin when a later run has a Slack source", async () => {
  await setupRelations({
    events: [
      prompt(),
      prompt({ type: "source", kind: "slack", href: SLACK }, OTHER_RUN),
    ],
    mock: () => {
      mockCommunications();
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(
    within(panel).findByText("Existing planning chat"),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).queryByRole("region", { name: "From" }),
  ).not.toBeInTheDocument();
  expect(
    within(panel).queryByLabelText("Open original message in Slack"),
  ).not.toBeInTheDocument();
});

test("Link the first-run agent source directly to its parent run", async () => {
  await setupRelations({
    events: [
      prompt({
        type: "source",
        kind: "agent",
        threadId: PEER,
        runId: OTHER_RUN,
        titleSnapshot: "Parent planning chat",
        agentId: "c0000000-0000-4000-a000-000000000001",
        href: `https://app.okou.ai/chats/${PEER}#run-${OTHER_RUN}`,
      }),
    ],
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  const row = (await within(panel).findByText("Parent planning chat")).closest(
    "a",
  );
  expect(row).toHaveAttribute("href", `/chats/${PEER}#run-${OTHER_RUN}`);
  expect(row).toHaveTextContent("From");
  expect(
    within(within(panel).getByRole("region", { name: "Chats" })).getAllByRole(
      "listitem",
    ),
  ).toHaveLength(1);
  expect(
    within(panel).queryByRole("region", { name: "From" }),
  ).not.toBeInTheDocument();
});

test("List an agent origin once when it is also a related chat", async () => {
  await setupRelations({
    events: [
      prompt({
        type: "source",
        kind: "agent",
        threadId: PEER,
        runId: OTHER_RUN,
        titleSnapshot: "Parent planning chat",
        agentId: "c0000000-0000-4000-a000-000000000001",
        href: `https://app.okou.ai/chats/${PEER}#run-${OTHER_RUN}`,
      }),
    ],
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, { items: [createdChat()] });
      });
      mockCommunications();
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  const chats = await within(panel).findByRole("region", { name: "Chats" });
  await within(chats).findByText("Research child");
  const parent = within(chats).getByText("Existing planning chat").closest("a");
  expect(parent).toHaveAttribute("href", `/chats/${PEER}`);
  expect(parent).toHaveTextContent("From");
  expect(within(chats).getAllByText("From", { exact: true })).toHaveLength(1);
  expect(within(chats).getAllByRole("listitem")).toHaveLength(2);
  expect(
    within(chats).queryByText("Parent planning chat"),
  ).not.toBeInTheDocument();
  expect(
    within(panel).queryByRole("region", { name: "From" }),
  ).not.toBeInTheDocument();
});

test("Keep the agent origin first in the collapsed preview when it is the oldest related chat", async () => {
  await setupRelations({
    events: [
      prompt({
        type: "source",
        kind: "agent",
        threadId: PEER,
        runId: OTHER_RUN,
        titleSnapshot: "Parent planning chat",
        agentId: "c0000000-0000-4000-a000-000000000001",
        href: `https://app.okou.ai/chats/${PEER}#run-${OTHER_RUN}`,
      }),
    ],
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: [
            createdChat(CHILD, "First child"),
            // Equal creation times sort by thread ID: CHILD, RELATION, EVENT.
            { ...createdChat(RELATION, "Second child"), id: RUN },
            { ...createdChat(EVENT, "Third child"), id: OTHER_RUN },
          ],
        });
      });
      mockCommunications(1, { lastMessageAt: "2026-08-01T10:00:00.000Z" });
    },
  });
  const chats = await screen.findByRole("region", { name: "Chats" });
  await within(chats).findByText("First child");
  const rows = within(chats).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("Existing planning chat");
  expect(rows[0]).toHaveTextContent("From");
  expect(within(chats).queryByText("Third child")).not.toBeInTheDocument();
  click(buttonNamed("Show more", chats));
  expect(within(chats).getByText("Third child")).toBeInTheDocument();
  expect(within(chats).getAllByRole("listitem")).toHaveLength(4);
});

test("Open a related chat's messages and link each to the run it started", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications();
      mockMessages([
        message(),
        receivedMessage("The plan looks ready"),
        message({
          id: CHILD,
          targetRunId: null,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Queue the next review" }],
          },
        }),
      ]);
    },
  });
  const { panel, row } = await openMessages("Existing planning chat");
  const sent = (
    await within(panel).findByText("Please check the launch plan")
  ).closest("a");
  expect(row).toHaveAttribute("aria-expanded", "true");
  // A sent message opens the other chat where it started a run.
  expect(sent).toHaveAttribute("href", `/chats/${PEER}#run-${OTHER_RUN}`);
  expect(sent).toHaveTextContent("Sent");
  // A received message locates the run it started in this chat.
  const received = within(panel).getByText("The plan looks ready").closest("a");
  expect(received).toHaveAttribute("href", `/chats/${THREAD}#run-${RUN}`);
  expect(received).toHaveTextContent("Received");
  // A message that has not started a run yet opens its chat.
  expect(
    within(panel).getByText("Queue the next review").closest("a"),
  ).toHaveAttribute("href", `/chats/${PEER}`);
  click(row);
  await waitFor(() => {
    expect(row).toHaveAttribute("aria-expanded", "false");
  });
  expect(
    within(panel).queryByText("Please check the launch plan"),
  ).not.toBeInTheDocument();
});

test("Follow a sent message card to the run it started in the other chat", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications();
      mockMessages([message()]);
    },
  });
  const { panel } = await openMessages("Existing planning chat");
  const card = (
    await within(panel).findByText("Please check the launch plan")
  ).closest("a");
  if (!card) {
    throw new Error("Expected the sent message card to be a link");
  }
  click(card);
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${PEER}`);
  });
  expect(hash()).toBe(`#run-${OTHER_RUN}`);
});

test("Open a related chat from its row in one click, while its caret opens the history", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications(0, { receivedCount: 1 });
      mockMessages([receivedMessage("The launch plan is ready")]);
    },
  });
  const { panel, row: caret } = await openMessages("Existing planning chat");
  const reply = await within(panel).findByText("The launch plan is ready");
  expect(caret).toHaveAttribute("aria-expanded", "true");
  expect(reply.closest("a")).toHaveAttribute(
    "href",
    `/chats/${THREAD}#run-${RUN}`,
  );
  const row = within(panel).getByText("Existing planning chat").closest("a");
  if (!row) {
    throw new Error("Expected the related chat row to be a link");
  }
  expect(row).toHaveAttribute("href", `/chats/${PEER}`);
  click(row);
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${PEER}`);
  });
});

test("Keep received messages usable when the other chat is unavailable", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications(1, { title: null, status: "unavailable" });
      mockMessages([message(), receivedMessage("The reply is still here")]);
    },
  });
  const { panel, row } = await openMessages("Unavailable");
  const reply = await within(panel).findByText("The reply is still here");
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(within(panel).getByText("Unavailable").closest("a")).toBeNull();
  expect(reply.closest("a")).toHaveAttribute(
    "href",
    `/chats/${THREAD}#run-${RUN}`,
  );
  expect(
    within(panel).getByText("Please check the launch plan").closest("a"),
  ).toBeNull();
});

test("Show empty chats and unavailable relationship targets without inventing an origin", async () => {
  await setupRelations({
    events: [],
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: [{ ...createdChat(), title: null, status: "unavailable" }],
        });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });

  expect(
    (await within(panel).findByText("Unavailable")).closest("a"),
  ).toBeNull();
  expect(
    within(panel).queryByRole("region", { name: "From" }),
  ).not.toBeInTheDocument();
  expect(
    within(panel).getByRole("region", { name: "Chats" }),
  ).toBeInTheDocument();
});

test("Keep other sections visible when a relationship list fails", async () => {
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Temporarily unavailable",
          },
        });
      });
      mockCommunications();
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(
    within(panel).findByText("Could not load"),
  ).resolves.toBeInTheDocument();
  await expect(
    within(panel).findByText("Existing planning chat"),
  ).resolves.toBeInTheDocument();
});

test("Keep resources and relationships hidden while chat resources are disabled", async () => {
  await setupRelations({ enabled: false });
  await screen.findByText("Plan the launch");
  expect(
    screen.queryByRole("region", { name: "Resources" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Chats" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "From" }),
  ).not.toBeInTheDocument();
});

test("Show artifacts without an empty related chats section", async () => {
  await setupRelations({
    events: [prompt()],
    mock: () => {
      context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
        return respond(200, {
          artifacts: [artifactSummary(EVENT, "file", "report.pdf")],
          nextCursor: null,
        });
      });
    },
  });
  const popup = await screen.findByRole("region", { name: "Resources" });
  await within(popup).findByText("report.pdf");
  expect(
    within(popup).queryByRole("region", { name: "Chats" }),
  ).not.toBeInTheDocument();
});

test("Show a queued related chat's status as text", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications(21, { status: "queued", receivedCount: 0 });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  const row = (
    await within(panel).findByText("Existing planning chat")
  ).closest("a");
  expect(row).toHaveTextContent("Queued");
  expect(row).not.toHaveTextContent("Running");
});

test("Open and dismiss the relations-only floating panel on a narrow chat", async () => {
  await setupRelations({
    events: [],
    narrow: true,
    mock: () => {
      mockCommunications();
    },
  });
  await waitFor(() => {
    expect(buttonNamed("Resources")).toBeEnabled();
  });
  const trigger = buttonNamed("Resources");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  click(trigger);
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Existing planning chat");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

test("Preview three unique chats and expand the complete list", async () => {
  const count = 51;
  await setupRelations({
    events: [prompt({ type: "source", kind: "slack", href: SLACK })],
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: Array.from({ length: count }, (_, index) => {
            return {
              ...createdChat(
                `d0000000-0000-4000-a000-${String(200 + index).padStart(12, "0")}`,
                `Child ${index + 1}`,
              ),
              id: `d0000000-0000-4000-a000-${String(300 + index).padStart(12, "0")}`,
            };
          }),
        });
      });
      mockCommunications(2, {
        threadId: "d0000000-0000-4000-a000-000000000200",
        title: "Child 1",
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  const chats = await within(panel).findByRole("region", { name: "Chats" });
  expect(within(chats).getAllByRole("listitem")).toHaveLength(3);
  expect(within(chats).getAllByText("Child 1")).toHaveLength(1);
  expect(within(chats).getByText("Child 1").closest("a")).toHaveTextContent(
    "Running",
  );
  expect(within(chats).queryByText("Created")).not.toBeInTheDocument();
  click(buttonNamed("Show more", chats));
  expect(within(chats).getByText("Child 51")).toBeInTheDocument();
  expect(within(chats).getAllByRole("listitem")).toHaveLength(count);
  click(buttonNamed("Collapse", chats));
  expect(within(chats).queryByText("Child 4")).not.toBeInTheDocument();
  expect(within(panel).getByRole("region", { name: "From" })).toHaveTextContent(
    "Slack",
  );
});

test("Close an open message history when the Chats section collapses", async () => {
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: Array.from({ length: 4 }, (_, index) => {
            return {
              ...createdChat(
                `d0000000-0000-4000-a000-${String(200 + index).padStart(12, "0")}`,
                `Child ${index + 1}`,
              ),
              id: `d0000000-0000-4000-a000-${String(300 + index).padStart(12, "0")}`,
            };
          }),
        });
      });
      mockCommunications(1, {
        threadId: "d0000000-0000-4000-a000-000000000200",
        title: "Child 1",
      });
      mockMessages([message()]);
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  const chats = await within(panel).findByRole("region", { name: "Chats" });
  click(buttonNamed("Show more", chats));
  const { row } = await openMessages("Child 1");
  await within(chats).findByText("Please check the launch plan");
  click(buttonNamed("Collapse", chats));
  await waitFor(() => {
    expect(row).toHaveAttribute("aria-expanded", "false");
  });
  expect(
    within(chats).queryByText("Please check the launch plan"),
  ).not.toBeInTheDocument();
});

test("Show exactly three related chats without an expand control", async () => {
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: [
            createdChat(CHILD, "First"),
            createdChat(PEER, "Second"),
            createdChat(EVENT, "Third"),
          ],
        });
      });
    },
  });
  const chats = await screen.findByRole("region", { name: "Chats" });
  expect(within(chats).getAllByRole("listitem")).toHaveLength(3);
  expect(within(chats).queryByText("Show more")).not.toBeInTheDocument();
});
