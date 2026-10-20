import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatRelationsContract,
  type ChatRelationMessage,
  type ChatCommunication,
  type CreatedChatRelation,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
  "Keep the source visible while %s are still loading",
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
    const sourcePanel = await screen.findByRole("region", {
      name: "Resources",
    });
    expect(
      within(sourcePanel).getByRole("region", { name: "From" }),
    ).toHaveTextContent("Slack");
    expect(within(sourcePanel).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(sourcePanel).queryByRole("region", { name: "Chats" }),
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

test("Keep loaded relationships visible while retrying a failed source", async () => {
  const requested = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  let retrying = false;
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, async ({ respond }) => {
        if (retrying) {
          if (!requested.settled()) {
            requested.resolve();
          }
          await response.promise;
        }
        return respond(200, {
          items: [
            createdChat(CHILD, retrying ? "Updated child" : "Research child"),
          ],
        });
      });
      context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
        return retrying
          ? respond(200, { items: [] })
          : respond(500, {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Temporarily unavailable",
              },
            });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Research child");
  expect(within(panel).queryByLabelText("Refresh")).not.toBeInTheDocument();
  retrying = true;
  click(buttonNamed("Try again", panel));
  await requested.promise;
  expect(within(panel).getByText("Research child")).toBeInTheDocument();
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
  response.resolve();
  await within(panel).findByText("Updated child");
});

test("Keep the resources popup and trigger when the last resource disappears", async () => {
  let empty = false;
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: empty ? [] : [createdChat()],
        });
      });
      context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
        return empty
          ? respond(200, { items: [] })
          : respond(500, {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Temporarily unavailable",
              },
            });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Research child");
  expect(within(panel).queryByText("No artifacts yet")).not.toBeInTheDocument();
  empty = true;
  click(buttonNamed("Try again", panel));
  await within(panel).findByText("No artifacts found");
  expect(within(panel).queryByText("Research child")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Resources" }),
  ).toBeInTheDocument();
  expect(buttonNamed("Open artifacts")).toBeEnabled();
});

test("Keep the next chat's popup available while its relationships load", async () => {
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
  const panel = await screen.findByRole("region", { name: "Resources" });
  await expect(within(panel).findByRole("status")).resolves.toHaveTextContent(
    "Loading",
  );
  expect(
    within(panel).queryByText("Next related chat"),
  ).not.toBeInTheDocument();
  expect(within(panel).queryByText("Research child")).not.toBeInTheDocument();
  response.resolve();
  await within(panel).findByText("Research child");
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
});

test("Show the first source and created chats, then open message rows in their receiving chat", async () => {
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
      context.mocks.api(chatRelationsContract.messages, ({ respond }) => {
        return respond(200, {
          items: [
            message(),
            message({
              id: EVENT,
              direction: "received",
              sourceChatThreadId: PEER,
              targetChatThreadId: THREAD,
              sourceRunId: OTHER_RUN,
              targetRunId: null,
              userMessage: null,
            }),
          ],
        });
      });
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
  expect(
    within(panel).getByRole("img", { name: "Running" }),
  ).toBeInTheDocument();
  await userEvent.click(
    buttonNamed("Messages with Existing planning chat", panel),
  );
  await expect(
    within(panel).findByText("Please check the launch plan"),
  ).resolves.toBeInTheDocument();
  expect(panel.querySelector("[title]")).toBeNull();
  expect(within(panel).getAllByText("Sent", { exact: true })).toHaveLength(1);
  expect(within(panel).getAllByText("Received", { exact: true })).toHaveLength(
    1,
  );
  expect(
    within(panel).getByText("Please check the launch plan").closest("a"),
  ).toHaveAttribute("href", `/chats/${PEER}#run-${OTHER_RUN}`);
  expect(
    within(panel).getByText("Message unavailable").closest("a"),
  ).toHaveAttribute("href", `/chats/${THREAD}`);
  await userEvent.click(
    buttonNamed("Messages with Existing planning chat", panel),
  );
  expect(
    within(panel).queryByText("Please check the launch plan"),
  ).not.toBeInTheDocument();
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
  expect(
    (await within(panel).findByText("Parent planning chat")).closest("a"),
  ).toHaveAttribute("href", `/chats/${PEER}#run-${OTHER_RUN}`);
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

test("Retry a failed relationship list without hiding the other sections", async () => {
  let fail = true;
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return fail
          ? respond(500, {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Temporarily unavailable",
              },
            })
          : respond(200, { items: [createdChat()] });
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
  fail = false;
  await userEvent.click(buttonNamed("Try again", panel));
  await expect(
    within(panel).findByText("Research child"),
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

test.each(["artifacts", "links"] as const)(
  "Show %s without an empty related chats section",
  async (resource) => {
    await setupRelations({
      events:
        resource === "links"
          ? [
              {
                id: RUN,
                role: "user",
                content: "[Reference](https://example.test/reference)",
                runId: RUN,
                createdAt: WHEN,
              },
            ]
          : [prompt()],
      mock: () => {
        if (resource === "artifacts") {
          context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
            return respond(200, {
              artifacts: [artifactSummary(EVENT, "file", "report.pdf")],
              nextCursor: null,
            });
          });
        }
      },
    });
    const popup = await screen.findByRole("region", { name: "Resources" });
    await within(popup).findByText(
      resource === "artifacts" ? "report.pdf" : "Reference",
    );
    expect(
      within(popup).queryByRole("region", { name: "Chats" }),
    ).not.toBeInTheDocument();
  },
);

test("Keep received messages accessible when the peer is unavailable and avoid linking sent messages to it", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications(1, { title: null, status: "unavailable" });
      context.mocks.api(chatRelationsContract.messages, ({ respond }) => {
        return respond(200, {
          items: [
            message(),
            message({
              id: EVENT,
              direction: "received",
              sourceChatThreadId: PEER,
              targetChatThreadId: THREAD,
              targetRunId: RUN,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "The reply is still here" }],
              },
            }),
          ],
        });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Unavailable");
  click(buttonNamed("Messages with Unavailable", panel));
  const reply = await within(panel).findByText("The reply is still here");
  expect(reply.closest("a")).toHaveAttribute(
    "href",
    `/chats/${THREAD}#run-${RUN}`,
  );
  expect(
    within(panel).getByText("Please check the launch plan").closest("a"),
  ).toBeNull();
});

test("Show complete message history with metadata and queued status", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications(21, { status: "queued", receivedCount: 0 });
      context.mocks.api(chatRelationsContract.messages, ({ respond }) => {
        return respond(200, {
          items: Array.from({ length: 21 }, (_, index) => {
            return message({
              id: `d0000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
              targetRunId: index === 20 ? null : OTHER_RUN,
              userMessage: {
                version: 1,
                parts: [
                  { type: "text", text: `Planning message ${index + 1}` },
                ],
              },
            });
          }),
        });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Existing planning chat");
  expect(
    within(panel).getByRole("img", { name: "Queued" }),
  ).toBeInTheDocument();
  expect(
    within(panel).queryByText("Sent", { exact: true }),
  ).not.toBeInTheDocument();
  click(buttonNamed("Messages with Existing planning chat", panel));
  const pending = await within(panel).findByText("Planning message 21");
  expect(within(panel).getAllByText("Sent", { exact: true })).toHaveLength(21);
  expect(
    within(panel).getByText("Planning message 1").closest("a"),
  ).toHaveAttribute("href", `/chats/${PEER}#run-${OTHER_RUN}`);
  expect(pending.closest("a")).toHaveAttribute("href", `/chats/${PEER}`);
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
    expect(buttonNamed("Open artifacts")).toBeEnabled();
  });
  const trigger = buttonNamed("Open artifacts");
  expect(trigger).toHaveAttribute("aria-pressed", "false");
  click(trigger);
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Existing planning chat");
  await userEvent.keyboard("{Escape}");
  expect(trigger).toHaveAttribute("aria-pressed", "false");
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
      context.mocks.api(
        chatRelationsContract.messages,
        ({ params, respond }) => {
          return respond(200, {
            items: params.peerId.endsWith("200") ? [message()] : [],
          });
        },
      );
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  const messages = await within(panel).findByRole("region", {
    name: "Chats",
  });
  expect(within(messages).getAllByRole("listitem")).toHaveLength(3);
  expect(within(messages).getAllByText("Child 1")).toHaveLength(1);
  expect(
    within(messages).getByRole("img", { name: "Running" }),
  ).toBeInTheDocument();
  expect(within(messages).queryByText("Created")).not.toBeInTheDocument();
  click(buttonNamed("Expand", messages));
  expect(within(messages).getByText("Child 51")).toBeInTheDocument();
  expect(within(messages).getAllByRole("listitem")).toHaveLength(count);
  click(buttonNamed("Collapse", messages));
  expect(within(messages).queryByText("Child 4")).not.toBeInTheDocument();
  click(buttonNamed("Messages with Child 1", messages));
  await within(messages).findByText("Please check the launch plan");
  click(buttonNamed("Messages with Child 2", messages));
  await waitFor(() => {
    expect(
      within(messages).queryByLabelText("Messages with Child 2"),
    ).not.toBeInTheDocument();
  });
  expect(
    within(messages).queryByText("No messages yet"),
  ).not.toBeInTheDocument();
  expect(
    within(messages).queryByText("Please check the launch plan"),
  ).not.toBeInTheDocument();
  expect(within(panel).getByRole("region", { name: "From" })).toHaveTextContent(
    "Slack",
  );
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
  const messages = await screen.findByRole("region", { name: "Chats" });
  expect(within(messages).getAllByRole("listitem")).toHaveLength(3);
  expect(within(messages).queryByText("Expand")).not.toBeInTheDocument();
});

test("Keep an empty or pending message preview out of the resource layout", async () => {
  const response = createDeferredPromise<void>(context.signal);
  await setupRelations({
    mock: () => {
      mockCommunications();
      context.mocks.api(chatRelationsContract.messages, async ({ respond }) => {
        await response.promise;
        return respond(200, { items: [] });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Existing planning chat");
  click(buttonNamed("Messages with Existing planning chat", panel));
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
  expect(within(panel).getAllByRole("list")).toHaveLength(1);
  response.resolve();
  await waitFor(() => {
    expect(
      within(panel).queryByLabelText("Messages with Existing planning chat"),
    ).not.toBeInTheDocument();
  });
  expect(within(panel).getAllByRole("list")).toHaveLength(1);
  expect(within(panel).queryByText("No messages yet")).not.toBeInTheDocument();
});
