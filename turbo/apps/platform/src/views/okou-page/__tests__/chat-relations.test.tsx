import { screen, within } from "@testing-library/react";
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
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID as THREAD,
} from "./chat-navigation-artifact-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

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
async function setupRelations(
  options: {
    readonly events?: MockChatEventInput[];
    readonly enabled?: boolean;
    readonly narrow?: boolean;
    readonly locale?: "de-DE";
    readonly mock?: () => void;
  } = {},
) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "scrollContainer")) {
        return new DOMRect(0, 80, 1800, 700);
      }
      if (Object.hasOwn(this.dataset, "messageContainer")) {
        return new DOMRect(options.narrow ? 800 : 420, 80, 900, 700);
      }
      return original.call(this);
    },
  );
  context.mocks.browser.matchMedia(true);
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
                  items: [{ ...createdChat(PEER, "Older child"), id: EVENT }],
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
  const panel = await screen.findByRole("region", { name: "Related chats" });
  await expect(within(panel).findByText("Slack")).resolves.toBeInTheDocument();
  expect(
    within(panel).getByLabelText("Open original message in Slack"),
  ).toHaveAttribute("href", SLACK);
  const child = await within(panel).findByText("Research child");
  expect(child.closest("a")).toHaveAttribute("href", `/chats/${CHILD}`);
  await userEvent.click(buttonNamed("Show more", panel));
  await expect(
    within(panel).findByText("Older child"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByTitle("Sent")).toHaveTextContent("Sent 1");
  expect(within(panel).getByTitle("Received")).toHaveTextContent("Received 1");
  expect(
    within(panel).getByRole("img", { name: "Running" }),
  ).toBeInTheDocument();
  await userEvent.click(
    buttonNamed("Messages with Existing planning chat", panel),
  );
  await expect(
    within(panel).findByText("Please check the launch plan"),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).getByText("Please check the launch plan").closest("a"),
  ).toHaveAttribute("href", `/chats/${PEER}#run-${OTHER_RUN}`);
  expect(
    within(panel).getByText("Original message unavailable").closest("a"),
  ).toHaveAttribute("href", `/chats/${THREAD}`);
  expect(within(panel).queryByTitle("Sent")).not.toBeInTheDocument();
  expect(within(panel).queryByTitle("Received")).not.toBeInTheDocument();
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
  });
  const panel = await screen.findByRole("region", { name: "Related chats" });
  await expect(
    within(panel).findByText(
      "Give different tasks to multiple chats to work in parallel and spend less time waiting.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).queryByRole("region", { name: "Started from" }),
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
  const panel = await screen.findByRole("region", { name: "Related chats" });
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
  const panel = await screen.findByRole("region", { name: "Related chats" });

  expect(
    (await within(panel).findByText("Chat unavailable")).closest("a"),
  ).toBeNull();
  expect(
    within(panel).queryByRole("region", { name: "Started from" }),
  ).not.toBeInTheDocument();
  expect(
    within(panel).queryByRole("region", { name: "Communication" }),
  ).not.toBeInTheDocument();
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
  const panel = await screen.findByRole("region", { name: "Related chats" });
  await expect(
    within(panel).findByText("Could not load relationships"),
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
    },
  });
  const panel = await screen.findByRole("region", { name: "Related chats" });
  await expect(within(panel).findByTitle("Sent")).resolves.toHaveTextContent(
    "Sent 1.000",
  );
  expect(document.documentElement).toHaveAttribute("lang", "de-DE");
});

test("Keep the relationship panel hidden while the feature is disabled", async () => {
  await setupRelations({ enabled: false });
  await screen.findByText("Plan the launch");
  expect(
    screen.queryByRole("region", { name: "Related chats" }),
  ).not.toBeInTheDocument();
});

test("Offer parallel chats in the upper resource panel without artifacts, links, or a first run", async () => {
  await setupRelations({ events: [] });
  const popup = await screen.findByRole("region", { name: "Resources" });
  const panel = await within(popup).findByRole("region", {
    name: "Related chats",
  });
  await expect(
    within(panel).findByText(
      "Give different tasks to multiple chats to work in parallel and spend less time waiting.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).queryByRole("region", { name: "Created by this chat" }),
  ).not.toBeInTheDocument();
  expect(
    within(panel).queryByRole("region", { name: "Communication" }),
  ).not.toBeInTheDocument();
  expect(within(popup).queryByText("View all")).not.toBeInTheDocument();
});

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
  const panel = await screen.findByRole("region", { name: "Related chats" });
  await within(panel).findByText("Chat unavailable");
  click(buttonNamed("Messages with Chat unavailable", panel));
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
  const panel = await screen.findByRole("region", { name: "Related chats" });
  await within(panel).findByText("Existing planning chat");
  expect(
    within(panel).getByRole("img", { name: "Queued" }),
  ).toBeInTheDocument();
  expect(within(panel).queryByTitle("Sent")).not.toBeInTheDocument();
  expect(within(panel).getByTitle("Received")).toHaveTextContent("Received 21");
  click(buttonNamed("Messages with Existing planning chat", panel));
  await within(panel).findByText("Please check the launch plan");
  click(buttonNamed("Show more", panel));
  const pending = await within(panel).findByText(
    "Waiting in the receiving chat",
  );
  expect(pending.closest("a")).toHaveAttribute("href", `/chats/${PEER}`);
});

test("Open and dismiss the relations-only floating panel on a narrow chat", async () => {
  await setupRelations({ events: [], narrow: true });
  const trigger = buttonNamed("Open artifacts");
  expect(trigger).toHaveAttribute("aria-pressed", "false");
  click(trigger);
  const panel = await screen.findByRole("region", { name: "Related chats" });
  await within(panel).findByText(
    "Give different tasks to multiple chats to work in parallel and spend less time waiting.",
  );
  await userEvent.keyboard("{Escape}");
  expect(trigger).toHaveAttribute("aria-pressed", "false");
});
