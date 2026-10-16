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
import {
  chatThreadArtifactsContract,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  artifactRun,
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
      nextCursor: null,
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
    readonly locale?: "de-DE";
    readonly mock?: () => void;
  } = {},
) {
  installRelationsGeometry(options.narrow);
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: options.events ?? [prompt()],
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [], nextCursor: null });
  });
  context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
    return respond(200, { items: [], nextCursor: null });
  });
  options.mock?.();
  await setupPage({
    context,
    path: `/chats/${THREAD}`,
    locale: options.locale,
    featureSwitches: {
      [FeatureSwitchKey.ChatResourcePanel]: true,
      [FeatureSwitchKey.ChatRelations]: options.enabled ?? true,
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
            return respond(200, { items: [createdChat()], nextCursor: null });
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
            return respond(200, { items: [], nextCursor: null });
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
    expect(
      within(sourcePanel).getByRole("status", { name: "Loading…" }),
    ).toBeInTheDocument();

    response.resolve();
    const panel = await screen.findByRole("region", { name: "Resources" });
    await within(panel).findByText("Research child");
    expect(within(panel).getByText("Slack")).toBeInTheDocument();
    expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(panel).getByRole("region", { name: "Messages" }),
    ).toBeInTheDocument();
  },
);

test("Keep loaded relationships visible while refreshing", async () => {
  const requested = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  let refreshing = false;
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, async ({ respond }) => {
        if (refreshing) {
          if (!requested.settled()) {
            requested.resolve();
          }
          await response.promise;
        }
        return respond(200, {
          items: [
            createdChat(CHILD, refreshing ? "Updated child" : "Research child"),
          ],
          nextCursor: null,
        });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Research child");
  refreshing = true;
  click(buttonNamed("Refresh", panel));
  await requested.promise;
  expect(within(panel).getByText("Research child")).toBeInTheDocument();
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
  response.resolve();
  await within(panel).findByText("Updated child");
});

test("Hide the resources popup when refreshed relationships are empty", async () => {
  let empty = false;
  await setupRelations({
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: empty ? [] : [createdChat()],
          nextCursor: null,
        });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Research child");
  empty = true;
  click(buttonNamed("Refresh", panel));
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Resources" }),
    ).not.toBeInTheDocument();
  });
});

test("Hide the previous chat's popup until the next chat's relationships load", async () => {
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
      nextCursor: null,
    });
  });
  context.mocks.api(
    chatRelationsContract.communications,
    async ({ params, respond }) => {
      if (params.id === second.id) {
        await response.promise;
      }
      return respond(200, { items: [], nextCursor: null });
    },
  );
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${first.id}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatResourcePanel]: true,
      [FeatureSwitchKey.ChatRelations]: true,
    },
  });
  const previous = await screen.findByRole("region", { name: "Resources" });
  click((await within(previous).findByText("Next related chat")).closest("a")!);
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Next related chat",
    );
  });
  expect(
    screen.queryByRole("region", { name: "Resources" }),
  ).not.toBeInTheDocument();
  response.resolve();
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Research child");
  expect(within(panel).queryByRole("status")).not.toBeInTheDocument();
});

test("Show the first source and created chats, then open message rows in their receiving chat", async () => {
  await setupRelations({
    events: [prompt({ type: "source", kind: "slack", href: SLACK })],
    mock: () => {
      context.mocks.api(
        chatRelationsContract.children,
        ({ query, respond }) => {
          return respond(
            200,
            query.beforeId
              ? {
                  items: [{ ...createdChat(EVENT, "Older child"), id: EVENT }],
                  nextCursor: null,
                }
              : {
                  items: [createdChat()],
                  nextCursor: { createdAt: WHEN, id: RELATION },
                },
          );
        },
      );
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
          nextCursor: null,
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
  click(
    buttonNamed(
      "Expand",
      within(panel).getByRole("region", { name: "Messages" }),
    ),
  );
  await userEvent.click(buttonNamed("More", panel));
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
  expect(within(panel).getByTitle("Sent")).toHaveTextContent("Sent 1");
  expect(within(panel).getByTitle("Received")).toHaveTextContent("Received 1");
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
          nextCursor: null,
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
    within(panel).getByRole("region", { name: "Messages" }),
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
          : respond(200, { items: [createdChat()], nextCursor: null });
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

test("Format communication counts using the German locale", async () => {
  await setupRelations({
    locale: "de-DE",
    mock: () => {
      mockCommunications(1000);
      context.mocks.api(chatRelationsContract.messages, ({ respond }) => {
        return respond(200, { items: [], nextCursor: null });
      });
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Existing planning chat");
  click(buttonNamed("Messages with Existing planning chat", panel));
  await expect(within(panel).findByTitle("Sent")).resolves.toHaveTextContent(
    "Sent 1.000",
  );
  expect(document.documentElement).toHaveAttribute("lang", "de-DE");
});

test("Keep the relationship panel hidden while the feature is disabled", async () => {
  await setupRelations({ enabled: false });
  await screen.findByText("Plan the launch");
  expect(
    screen.queryByRole("region", { name: "Resources" }),
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
          context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
            return respond(200, {
              runs: [
                artifactRun({
                  fileId: EVENT,
                  filename: "report.pdf",
                  contentType: "application/pdf",
                  url: "https://files.example.test/report.pdf",
                }),
              ],
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
      within(popup).queryByRole("region", { name: "Messages" }),
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
          nextCursor: null,
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

test("Hide zero counts, retain queued status, and page through message history", async () => {
  await setupRelations({
    mock: () => {
      mockCommunications(0, { status: "queued", receivedCount: 21 });
      context.mocks.api(
        chatRelationsContract.messages,
        ({ query, respond }) => {
          return respond(
            200,
            query.beforeId
              ? {
                  items: [
                    message({
                      id: EVENT,
                      targetRunId: null,
                      userMessage: {
                        version: 1,
                        parts: [
                          {
                            type: "text",
                            text: "Waiting in the receiving chat",
                          },
                        ],
                      },
                    }),
                  ],
                  nextCursor: null,
                }
              : {
                  items: [message()],
                  nextCursor: { createdAt: WHEN, id: RELATION },
                },
          );
        },
      );
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  await within(panel).findByText("Existing planning chat");
  expect(
    within(panel).getByRole("img", { name: "Queued" }),
  ).toBeInTheDocument();
  expect(within(panel).queryByTitle("Sent")).not.toBeInTheDocument();
  click(buttonNamed("Messages with Existing planning chat", panel));
  await within(panel).findByText("Please check the launch plan");
  expect(within(panel).queryByTitle("Sent")).not.toBeInTheDocument();
  expect(within(panel).getByTitle("Received")).toHaveTextContent("Received 21");
  click(buttonNamed("More", panel));
  const pending = await within(panel).findByText(
    "Waiting in the receiving chat",
  );
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

test("Preview three unique chats and expand the remaining chat", async () => {
  const count = 4;
  await setupRelations({
    events: [prompt({ type: "source", kind: "slack", href: SLACK })],
    mock: () => {
      context.mocks.api(chatRelationsContract.children, ({ respond }) => {
        return respond(200, {
          items: Array.from({ length: count }, (_, index) => {
            return {
              ...createdChat(
                `d0000000-0000-4000-a000-00000000020${index}`,
                `Child ${index + 1}`,
              ),
              id: `d0000000-0000-4000-a000-00000000030${index}`,
            };
          }),
          nextCursor: null,
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
            nextCursor: null,
          });
        },
      );
    },
  });
  const panel = await screen.findByRole("region", { name: "Resources" });
  const messages = await within(panel).findByRole("region", {
    name: "Messages",
  });
  expect(within(messages).getAllByRole("listitem")).toHaveLength(3);
  expect(within(messages).getAllByText("Child 1")).toHaveLength(1);
  expect(
    within(messages).getByRole("img", { name: "Running" }),
  ).toBeInTheDocument();
  expect(within(messages).queryByText("Created")).not.toBeInTheDocument();
  click(buttonNamed("Expand", messages));
  expect(within(messages).getByText("Child 4")).toBeInTheDocument();
  expect(within(messages).getAllByRole("listitem")).toHaveLength(4);
  click(buttonNamed("Collapse", messages));
  expect(within(messages).queryByText("Child 4")).not.toBeInTheDocument();
  click(buttonNamed("Messages with Child 1", messages));
  await within(messages).findByText("Please check the launch plan");
  click(buttonNamed("Messages with Child 2", messages));
  await within(messages).findByText("No messages yet");
  expect(
    within(messages).queryByText("Please check the launch plan"),
  ).not.toBeInTheDocument();
  expect(within(panel).getByRole("region", { name: "From" })).toHaveTextContent(
    "Slack",
  );
});

test("Deduplicate later relationship pages and keep their count marked as incomplete until exhausted", async () => {
  await setupRelations({
    mock: () => {
      context.mocks.api(
        chatRelationsContract.children,
        ({ query, respond }) => {
          return respond(
            200,
            query.beforeId
              ? {
                  items: [
                    { ...createdChat(EVENT, "Older child"), id: EVENT },
                    createdChat(PEER, "Created peer"),
                  ],
                  nextCursor: null,
                }
              : {
                  items: [createdChat()],
                  nextCursor: { createdAt: WHEN, id: RELATION },
                },
          );
        },
      );
      mockCommunications();
    },
  });
  const messages = await screen.findByRole("region", { name: "Messages" });
  expect(within(messages).getByText("2+")).toBeInTheDocument();
  click(buttonNamed("Expand", messages));
  click(buttonNamed("More", messages));
  await within(messages).findByText("Older child");
  expect(within(messages).getAllByText("Existing planning chat")).toHaveLength(
    1,
  );
  expect(within(messages).queryByText("Created peer")).not.toBeInTheDocument();
  expect(within(messages).getByText("3")).toBeInTheDocument();
  expect(within(messages).queryByText("More")).not.toBeInTheDocument();
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
          nextCursor: null,
        });
      });
    },
  });
  const messages = await screen.findByRole("region", { name: "Messages" });
  expect(within(messages).getAllByRole("listitem")).toHaveLength(3);
  expect(within(messages).queryByText("Expand")).not.toBeInTheDocument();
});
