import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  installMessageExperienceChat,
} from "./chat-message-experience-test-helpers.ts";

const RUN_ID = "d0000000-0000-4000-a000-000000000073";
const CREATED_AT = "2026-09-24T09:00:00.000Z";

test.each([
  { locale: "en-US" as const, label: "Open original message in Discord" },
  { locale: "zh-Hans" as const, label: "在 Discord 中打开原始消息" },
])(
  "Discord source links preserve guild and bot-DM destinations in $locale",
  async ({ locale, label }) => {
    const sources = [
      {
        id: "discord-guild-source",
        href: "https://discord.com/channels/123456789012345678/234567890123456789/345678901234567890",
        text: "Review the launch thread",
      },
      {
        id: "discord-dm-source",
        href: "https://discord.com/channels/@me/456789012345678901/567890123456789012",
        text: "Review my direct message",
      },
    ];
    installMessageExperienceChat({
      threadId: context.resourceId,
      chatEvents: [
        ...sources.map((source) => {
          return {
            id: source.id,
            role: "user" as const,
            content: null,
            runId: RUN_ID,
            createdAt: CREATED_AT,
            userMessage: {
              version: 1 as const,
              parts: [
                { type: "text" as const, text: source.text },
                {
                  type: "source" as const,
                  kind: "discord" as const,
                  href: source.href,
                },
              ],
            },
          };
        }),
        {
          id: "discord-source-without-permalink",
          role: "user",
          content: null,
          runId: RUN_ID,
          createdAt: CREATED_AT,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Review an imported Discord message" },
              { type: "source", kind: "discord" },
            ],
          },
        },
        {
          id: "discord-source-answer",
          role: "assistant",
          content: "The Discord requests were reviewed.",
          runId: RUN_ID,
          runLifecycleEvent: "completed",
          createdAt: "2026-09-24T09:00:03.000Z",
        },
      ],
    });

    await setupPage({
      context,
      path: `/chats/${context.resourceId}`,
      locale,
    });

    await expect(
      screen.findByText("The Discord requests were reviewed."),
    ).resolves.toBeInTheDocument();
    const links = queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("aria-label") === label;
    });
    expect(links).toHaveLength(2);
    for (const source of sources) {
      const link = links.find((candidate) => {
        return candidate.getAttribute("href") === source.href;
      });
      expect(link).toBeInTheDocument();
      expect(link).toHaveTextContent("Discord");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
    const unlinkedLabel = screen.getAllByText("Discord").find((element) => {
      return element.closest("a") === null;
    });
    expect(unlinkedLabel).toBeInTheDocument();
  },
);

test("Discord sources never link outside discord.com", async () => {
  const untrusted = [
    "https://discord.com.example.net/channels/123456789012345678/234567890123456789/345678901234567890",
    "https://example.net/channels/123456789012345678/234567890123456789/345678901234567890",
    "http://discord.com/channels/123456789012345678/234567890123456789/345678901234567890",
    "https://discord.com/invite/okou",
  ];
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      ...untrusted.map((href, index) => {
        return {
          id: `discord-untrusted-source-${String(index)}`,
          role: "user" as const,
          content: null,
          runId: RUN_ID,
          createdAt: CREATED_AT,
          userMessage: {
            version: 1 as const,
            parts: [
              {
                type: "text" as const,
                text: `Untrusted source ${String(index)}`,
              },
              { type: "source" as const, kind: "discord" as const, href },
            ],
          },
        };
      }),
      {
        id: "discord-untrusted-answer",
        role: "assistant",
        content: "The untrusted sources were reviewed.",
        runId: RUN_ID,
        runLifecycleEvent: "completed",
        createdAt: "2026-09-24T09:00:03.000Z",
      },
    ],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(
    screen.findByText("The untrusted sources were reviewed."),
  ).resolves.toBeInTheDocument();
  const hrefs = queryAllByRoleFast("link").map((link) => {
    return link.getAttribute("href");
  });
  for (const href of untrusted) {
    expect(hrefs).not.toContain(href);
  }
  const labels = screen.getAllByText("Discord").filter((element) => {
    return element.closest("a") === null;
  });
  expect(labels).toHaveLength(untrusted.length);
  expect(
    screen.queryByText("Open original message in Discord"),
  ).not.toBeInTheDocument();
});

test("Activity identifies a Discord run as its source", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: RUN_ID,
      sessionId: "discord-activity-session",
      agentId: "c0000000-0000-4000-a000-000000000051",
      displayName: "Discord launch review",
      framework: "codex",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "discord",
      status: "completed",
      prompt: "Review the launch thread",
      appendSystemPrompt: null,
      error: null,
      createdAt: CREATED_AT,
      startedAt: CREATED_AT,
      completedAt: "2026-09-24T09:00:03.000Z",
      artifact: { name: null, version: null },
    });
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [],
      hasMore: false,
      status: "completed",
      lastEventSequence: null,
    });
  });

  await setupPage({ context, path: `/activities/${RUN_ID}` });

  await expect(
    screen.findByRole("heading", { name: "Discord launch review" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Source")).toBeInTheDocument();
  expect(screen.getByText("Discord")).toBeInTheDocument();
});
