import { test, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
test("discord-source-presentation-001 message sources distinguish a guild, a direct message and an unlinked origin", async () => {
  const threadId = crypto.randomUUID();
  const sources = [
    ["Quay meeting", "https://discord.com/channels/937615/862473/606147"],
    ["Private note", "https://discord.com/channels/@me/778911/337685"],
    ["Offline relay", null],
  ] as const;
  mockChatLifecycle(context, {
    threadId,
    chatEvents: sources.map(([text, href], index) => {
      return {
        role: "user",
        content: text,
        createdAt: new Date(Date.UTC(2026, 3, 10, 12, index)).toISOString(),
        userMessage: {
          version: 1,
          parts: [
            { type: "source", kind: "discord", ...(href ? { href } : {}) },
            { type: "text", text },
          ],
        },
      };
    }),
  });
  await setupPage({ context, path: "/chat/" + threadId });
  await screen.findByText("Offline relay");
  const sourceLink = (text: string) => {
    const message = screen
      .getByText(text)
      .closest<HTMLElement>("[data-chat-scroll-anchor-event-id]");
    if (!message) {
      throw new Error("Missing message row for " + text);
    }
    return within(message).getByText("Discord", { exact: true }).closest("a");
  };
  expect(sourceLink("Offline relay")).toBeNull();
  for (const [text, href] of [sources[0], sources[1]]) {
    const link = sourceLink(text);
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  }
});

test("A completed activity identifies Discord as its trigger", async () => {
  const id = crypto.randomUUID();
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      sessionId: "harbor-session",
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "discord",
      status: "completed",
      prompt: "Summarize the tide gauge",
      appendSystemPrompt: null,
      createdAt: "2026-04-10T12:00:00Z",
      startedAt: "2026-04-10T12:00:01Z",
      completedAt: "2026-04-10T12:00:30Z",
    });
  });
  await setupPage({ context, path: "/activities/" + id });
  const source = await screen.findByText("Source");
  expect(screen.getByRole("heading", { name: "Okou" })).toBeVisible();
  expect(source.parentElement).toHaveTextContent("Discord");
});
