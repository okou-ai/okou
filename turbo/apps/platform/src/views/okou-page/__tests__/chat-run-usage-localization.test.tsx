import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  parseChatClipboardPayload,
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-clipboard-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  creditUsage,
  findButton,
  findLink,
  promptEvent,
  queryButton,
  RUN_PATH,
  RUN_THREAD_ID,
  usageEvent,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_A = "a0000000-0000-4000-a000-000000000401";
const RUN_B = "a0000000-0000-4000-a000-000000000402";

test("Return to the conversation that started a chat message", async () => {
  const user = userEvent.setup({ delay: null });
  const sources = [
    {
      id: "source-slack",
      kind: "slack" as const,
      label: "Open original message in Slack",
      href: "https://slack.com/archives/C123/p456",
    },
    {
      id: "source-feishu",
      kind: "feishu" as const,
      label: "Open original chat in Feishu",
      href: "https://open.feishu.cn/chat/ch_123",
    },
    {
      id: "source-teams",
      kind: "teams" as const,
      label: "Open original message in Microsoft Teams",
      href: "https://teams.microsoft.com/l/message/19:abc/123",
    },
    {
      id: "source-github",
      kind: "github" as const,
      label: "Open original issue or pull request in GitHub",
      href: "https://github.com/okou-ai/okou/issues/123",
    },
    {
      id: "source-telegram",
      kind: "telegram" as const,
      label: "Open original message in Telegram",
      href: "https://t.me/example/123",
    },
    {
      id: "source-telegram-dm",
      kind: "telegram" as const,
      label: "Open chat in Telegram",
      href: "https://t.me/okou_bot",
    },
    {
      id: "source-teams-personal",
      kind: "teams" as const,
      label: "Open chat in Microsoft Teams",
      href: "https://teams.microsoft.com/l/chat/0/0?tenantId=tenant-1&users=28%3Abot-1",
    },
    {
      id: "source-agentphone-dm",
      kind: "agentphone" as const,
      label: "Open Messages",
      href: "sms:+15551234567",
    },
    {
      id: "source-whatsapp-dm",
      kind: "agentphone" as const,
      label: "Open chat in WhatsApp",
      href: "https://wa.me/12025550199",
    },
  ];
  const events: MockChatEventInput[] = sources.map((source, index) => {
    return {
      id: source.id,
      eventType: "input.prompt",
      role: "user",
      content: null,
      runId: RUN_A,
      seqId: index + 1,
      createdAt: `2026-08-01T10:00:0${String(index)}.000Z`,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: `Request from ${source.kind}` },
          { type: "source", kind: source.kind, href: source.href },
        ],
      },
    };
  });
  events.push(
    {
      id: "source-agentphone",
      eventType: "input.prompt",
      role: "user",
      content: null,
      runId: RUN_A,
      seqId: sources.length + 1,
      createdAt: "2026-08-01T10:00:08.000Z",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Request from agentphone" },
          { type: "source", kind: "agentphone" },
        ],
      },
    },
    assistantEvent({
      id: "source-answer",
      runId: RUN_A,
      seqId: sources.length + 2,
      text: "All imported requests were reviewed.",
    }),
    completedEvent({
      id: "source-complete",
      runId: RUN_A,
      seqId: sources.length + 3,
    }),
  );
  installRunChat({ chatEvents: events });

  await setupPage({ context, path: RUN_PATH });

  await expect(
    screen.findByText("All imported requests were reviewed."),
  ).resolves.toBeVisible();
  for (const source of sources) {
    const link = await findLink(source.label);
    expect(link).toHaveAttribute("href", source.href);
    expect(link).toHaveAttribute("target", "_blank");
  }
  const slackLink = await findLink("Open original message in Slack");
  await user.click(slackLink);
  expect(slackLink).toHaveAttribute(
    "href",
    "https://slack.com/archives/C123/p456",
  );

  await expect(findLink("Open chat in Telegram")).resolves.toHaveTextContent(
    "Open chat",
  );
  await expect(
    findLink("Open chat in Microsoft Teams"),
  ).resolves.toHaveTextContent("Open chat");
  await expect(
    findLink("Open original message in Telegram"),
  ).resolves.toHaveTextContent("Open message");
  const unlinkedPhoneLabel = screen.getAllByText("iMessage").find((label) => {
    return label.closest("a") === null;
  });
  expect(unlinkedPhoneLabel).toBeInTheDocument();
});

test("Label existing Email messages from their raw context without adding a mail-provider link", async () => {
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWrite();
  const events: MockChatEventInput[] = [
    promptEvent({
      id: "email-source-prompt",
      runId: RUN_A,
      seqId: 1,
      text: "Subject: Travel report\n\nPlease review this email.",
    }),
    promptEvent({
      id: "web-source-prompt",
      runId: RUN_B,
      seqId: 2,
      text: "A follow-up sent from the Web app.",
    }),
    completedEvent({ id: "email-source-complete", runId: RUN_B, seqId: 3 }),
  ];
  installRunChat({ chatEvents: events });
  const rows = mockChatEventRows(
    normalizeMockChatEvents(events, RUN_THREAD_ID),
  ).map((row) => {
    return row.id === "email-source-prompt"
      ? { ...row, contextType: "email" as const, contextId: "email-context" }
      : row;
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(
      200,
      chatEventRowsResponse(
        rows.filter((row) => {
          return row.seqId > query.sinceSeqId;
        }),
        query,
      ),
    );
  });

  await setupPage({ context, path: RUN_PATH });

  const label = await screen.findByText("Email");
  const emailMessage = label.closest<HTMLElement>("[data-role='user']");
  if (!emailMessage) {
    throw new Error("Email user message was not available");
  }
  expect(emailMessage).toHaveTextContent("Please review this email.");
  expect(label.closest("a")).toBeNull();
  const webMessage = screen.getByText("A follow-up sent from the Web app.");
  expect(webMessage.closest("[data-role='user']")).not.toHaveTextContent(
    "Email",
  );
  const copyButton = queryButton("Copy message", emailMessage);
  if (!copyButton) {
    throw new Error("Email copy action was not available");
  }
  await user.click(copyButton);
  const item = await readSingleRichClipboardWrite(clipboard);
  const copied = parseChatClipboardPayload(
    await readClipboardItemText(item, "text/html"),
  );
  expect(copied.userMessage).toStrictEqual({
    version: 1,
    parts: [
      {
        type: "text",
        text: "Subject: Travel report\n\nPlease review this email.",
      },
    ],
  });
});

test.each([
  {
    description: "canonical Lark source with a chat link",
    kind: "lark" as const,
    href: "https://open.larksuite.com/chat/ch_123",
    label: "Lark",
  },
  {
    description: "historical Feishu source with a Lark chat link",
    kind: "feishu" as const,
    href: "https://applink.larksuite.com/client/chat/open?openChatId=oc_123",
    label: "Lark",
  },
])("Show the $description", async ({ kind, href, label }) => {
  installRunChat({
    chatEvents: [
      {
        id: "platform-source-prompt",
        eventType: "input.prompt",
        role: "user",
        content: null,
        runId: RUN_A,
        seqId: 1,
        createdAt: "2026-08-01T10:00:01.000Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "A platform-specific message." },
            { type: "source", kind, ...(href ? { href } : {}) },
          ],
        },
      },
      completedEvent({
        id: "platform-source-complete",
        runId: RUN_A,
        seqId: 2,
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await expect(
    screen.findByText("A platform-specific message."),
  ).resolves.toBeInTheDocument();
  const sourceLabel = screen.getByText(label);
  expect(sourceLabel).toBeInTheDocument();
  const link = sourceLabel.closest("a");
  expect(Boolean(link)).toBe(Boolean(href));
  expect(link?.getAttribute("href")).toBe(href);
  expect(link?.getAttribute("aria-label")).toBe(
    href ? `Open original chat in ${label}` : undefined,
  );
});

test("Show the current usage settlement on the correct run", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({
    runUsage: {
      [RUN_A]: creditUsage(8, [
        {
          kind: "model",
          credits: 8,
          providers: [{ provider: "gpt-5.6-sol", credits: 8 }],
        },
      ]),
      [RUN_B]: creditUsage(3, [
        {
          kind: "connector",
          credits: 3,
          providers: [{ provider: "slack", credits: 3 }],
        },
      ]),
    },
    chatEvents: [
      promptEvent({
        id: "settlement-a-user",
        runId: RUN_A,
        seqId: 1,
        text: "First costed run",
      }),
      assistantEvent({
        id: "settlement-a-answer",
        runId: RUN_A,
        seqId: 2,
        text: "First answer",
      }),
      completedEvent({ id: "settlement-a-complete", runId: RUN_A, seqId: 3 }),
      usageEvent({
        id: "settlement-old",
        runId: RUN_A,
        seqId: 4,
        usage: creditUsage(5, [
          {
            kind: "model",
            credits: 5,
            providers: [{ provider: "gpt-5.6-sol", credits: 5 }],
          },
        ]),
      }),
      usageEvent({
        id: "settlement-replacement",
        runId: RUN_A,
        seqId: 5,
        usage: creditUsage(999, [
          {
            kind: "model",
            credits: 8,
            providers: [{ provider: "gpt-5.6-sol", credits: 8 }],
          },
        ]),
      }),
      promptEvent({
        id: "settlement-b-user",
        runId: RUN_B,
        seqId: 6,
        text: "Second connector run",
      }),
      assistantEvent({
        id: "settlement-b-answer",
        runId: RUN_B,
        seqId: 7,
        text: "Second answer",
      }),
      completedEvent({ id: "settlement-b-complete", runId: RUN_B, seqId: 8 }),
      usageEvent({
        id: "settlement-b-usage",
        runId: RUN_B,
        seqId: 9,
        usage: creditUsage(3, [
          {
            kind: "connector",
            credits: 3,
            providers: [{ provider: "slack", credits: 3 }],
          },
        ]),
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await expect(screen.findByText("First answer")).resolves.toBeVisible();
  await expect(screen.findByText("Second answer")).resolves.toBeVisible();
  expect(queryButton("Credit usage 5")).toBeNull();
  expect(queryButton("Credit usage 999")).toBeNull();
  await expect(findButton("Credit usage 8")).resolves.toBeVisible();
  const secondUsage = await findButton("Credit usage 3");
  expect(secondUsage).toBeVisible();

  await user.click(secondUsage);

  const slackUsage = await screen.findByText("Slack");
  expect(slackUsage).toBeVisible();
  expect(slackUsage.parentElement).toHaveTextContent("3");
  expect(screen.queryByText("GPT 5.6 Sol")).not.toBeInTheDocument();
});
