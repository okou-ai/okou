import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatRelationsContract,
  type ChatRelationMessage,
  type CreatedChatRelation,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
function mockCommunications(sentCount = 1) {
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
        return new DOMRect(420, 80, 900, 700);
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

test("Show the first Slack source, page through created chats, and expand communication with run links", async () => {
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
  expect(within(panel).getByText("Sent 1 · Received 1")).toBeInTheDocument();
  await userEvent.click(
    buttonNamed("Messages with Existing planning chat", panel),
  );
  await expect(
    within(panel).findByText("Please check the launch plan"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("Receiving run")).toHaveAttribute(
    "href",
    `/chats/${PEER}#run-${OTHER_RUN}`,
  );
  expect(within(panel).getAllByText("Source run")[0]).toHaveAttribute(
    "href",
    `/chats/${THREAD}#run-${RUN}`,
  );
  expect(within(panel).getByText("Not consumed by a run")).toBeInTheDocument();
  expect(
    within(panel).getByText(
      "Original message unavailable; open the receiving chat",
    ),
  ).toBeInTheDocument();
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
    within(panel).findByText("Origin unknown"),
  ).resolves.toBeInTheDocument();
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
  await expect(
    within(panel).findByText("No run started yet"),
  ).resolves.toBeInTheDocument();
  expect(
    (await within(panel).findByText("Chat unavailable")).closest("a"),
  ).toBeNull();
  await expect(
    within(panel).findByText("No relationship records yet"),
  ).resolves.toBeInTheDocument();
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
  await expect(
    screen.findByText("Sent 1.000 · Received 1"),
  ).resolves.toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("lang", "de-DE");
});

test("Keep the relationship panel hidden while the feature is disabled", async () => {
  await setupRelations({ enabled: false });
  await screen.findByRole("region", { name: "Resources" });
  expect(
    screen.queryByRole("region", { name: "Related chats" }),
  ).not.toBeInTheDocument();
});
