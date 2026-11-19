import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ADA_AGENT_ID,
  createMessageExperienceHelpers,
  findFastControl,
  MESSAGE_EXPERIENCE_AGENT_ID,
  SOURCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

const CREATED_AT = "2026-08-20T12:00:00.000Z";
const SOURCE_THREAD_ID = "b0000000-0000-4000-a000-000000000052";
const SECOND_THREAD_ID = "b0000000-0000-4000-a000-000000000053";
const SOURCE_RUN_ID = "d0000000-0000-4000-a000-000000000052";
const SOURCE_HREF = `/chats/${SOURCE_THREAD_ID}#run-${SOURCE_RUN_ID}`;

function userEventWith(
  userMessage: UserMessageDocument,
  runId = SOURCE_RUN_ID,
) {
  return {
    id: `message-${runId}`,
    role: "user" as const,
    content: "Conflicting legacy message text",
    userMessage,
    runId,
    createdAt: CREATED_AT,
  };
}

function installMessages(...messages: [UserMessageDocument, string?][]) {
  return installMessageExperienceChat({
    threadId: context.resourceId,
    threadTitle: "Delegated work",
    chatEvents: messages.map(([message, runId]) => {
      return userEventWith(message, runId);
    }),
  });
}

async function openChat(): Promise<void> {
  await setupPage({ context, path: `/chats/${context.resourceId}` });
}

async function userMessageWith(text: string): Promise<HTMLElement> {
  const message = (await screen.findByText(text)).closest<HTMLElement>(
    '[data-role="user"]',
  );
  if (!message) {
    throw new Error(`User message not found for "${text}"`);
  }
  return message;
}

function linksLabeled(container: ParentNode, label: string): HTMLElement[] {
  return queryAllByRoleFast("link", container).filter((link) => {
    return link.getAttribute("aria-label") === label;
  });
}

function expectBefore(first: Element, second: Element): void {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

test("Agent mentions are recognizable links in messages and feedback", async () => {
  const ada = {
    type: "agent",
    agentId: ADA_AGENT_ID,
    nameSnapshot: "Ada",
  } as const;
  installMessages([
    {
      version: 1,
      parts: [
        { type: "text", text: "Ask " },
        ada,
        { type: "text", text: " to review this." },
        {
          type: "feedback",
          quote: "The launch plan needs a second look.",
          note: [
            { type: "text", text: "Please have " },
            ada,
            { type: "text", text: " check the dates." },
          ],
        },
      ],
    } satisfies UserMessageDocument,
  ]);

  await openChat();

  const message = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      "[data-structured-user-message]",
    );
    expect(element).toHaveTextContent("Ask Ada to review this.");
    return element;
  });
  if (!message) {
    throw new Error("Structured user message not found");
  }
  const mentions = linksLabeled(message, "Open agent Ada");
  expect(mentions).toHaveLength(2);
  for (const mention of mentions) {
    expect(mention).toHaveAttribute("href", `/agents/${ADA_AGENT_ID}/chat`);
    expect(mention.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.vm7.io/avatars/ada.png",
    );
  }
  expect(message).not.toHaveTextContent(ADA_AGENT_ID);
});

test("MCP messages show the saved client name or generic marker with a local icon", async () => {
  const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
  const longName = "Long MCP Client ".repeat(7).trim();
  installMessages(
    [
      {
        version: 1,
        parts: [
          { type: "text", text: "Review the MCP launch notes." },
          { type: "source", kind: "mcp", clientId, clientName: "Claude Code" },
        ],
      },
    ],
    [
      {
        version: 1,
        parts: [
          { type: "text", text: "Review the fallback source." },
          { type: "source", kind: "mcp", clientId: "client_public" },
        ],
      },
      "d0000000-0000-4000-a000-000000000054",
    ],
    [
      {
        version: 1,
        parts: [
          { type: "text", text: "Review the long client name." },
          {
            type: "source",
            kind: "mcp",
            clientId: "client_long",
            clientName: longName,
          },
        ],
      },
      "d0000000-0000-4000-a000-000000000055",
    ],
  );

  await openChat();

  const named = await userMessageWith("Review the MCP launch notes.");
  const namedBadge = within(named).getByText("Claude Code").parentElement;
  expect(namedBadge?.querySelector("svg")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(queryAllByRoleFast("link", named)).toHaveLength(0);
  expect(named).not.toHaveTextContent(clientId);

  const unnamed = await userMessageWith("Review the fallback source.");
  expect(
    within(unnamed).getByText("MCP").parentElement?.querySelector("svg"),
  ).toBeInTheDocument();

  const long = await userMessageWith("Review the long client name.");
  expect(within(long).getByText(longName)).toHaveTextContent(longName);
});

test("Delegated work links back to its source run", async () => {
  installMessages([
    {
      version: 1,
      parts: [
        {
          type: "source",
          kind: "agent",
          runId: SOURCE_RUN_ID,
          threadId: SOURCE_THREAD_ID,
          agentId: SOURCE_AGENT_ID,
          titleSnapshot: "Source thread",
          href: SOURCE_HREF,
        },
        { type: "text", text: "Prepare the delegated launch analysis." },
      ],
    },
  ]);

  await openChat();

  const sourceLink = await findFastControl("link", "Open chat Source thread");
  expect(sourceLink).toHaveTextContent("Source thread");
  expect(sourceLink).toHaveAttribute("href", SOURCE_HREF);
  expect(sourceLink.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.vm7.io/avatars/source-agent.png",
  );
  await expect(
    userMessageWith("Prepare the delegated launch analysis."),
  ).resolves.toHaveAttribute("id", `run-${SOURCE_RUN_ID}`);
});

test("Related feedback notes are grouped with clear source links", async () => {
  const projectAlpha = {
    type: "chat_thread",
    threadId: SOURCE_THREAD_ID,
    titleSnapshot: "Project Alpha",
  } as const;
  installMessages([
    {
      version: 1,
      parts: [
        { type: "text", text: "Context before feedback.\n" },
        {
          type: "feedback",
          quote: "The audience is not specific enough.",
          note: [
            { type: "text", text: "Use the audience from " },
            projectAlpha,
            { type: "text", text: "." },
          ],
        },
        {
          type: "feedback",
          quote: "The timing needs more detail.",
          note: [
            { type: "text", text: "Match the milestones in " },
            projectAlpha,
            { type: "text", text: "." },
          ],
        },
        { type: "text", text: "\nContext after feedback." },
      ],
    } satisfies UserMessageDocument,
  ]);

  await openChat();

  const before = await screen.findByText("Context before feedback.");
  const after = screen.getByText("Context after feedback.");
  const group = document.querySelector<HTMLElement>(
    "[data-structured-feedback-group]",
  );
  if (!group) {
    throw new Error("Structured feedback group not found");
  }
  expect(group).toHaveTextContent("Quoted 2 parts of your reply");
  const quotes = group.querySelectorAll("[data-structured-feedback-quote]");
  expect(quotes).toHaveLength(2);
  expect(quotes[0]).toHaveTextContent("The audience is not specific enough.");
  expect(quotes[1]).toHaveTextContent("The timing needs more detail.");
  const links = linksLabeled(group, "Open chat Project Alpha");
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link).toHaveTextContent("Project Alpha");
    expect(link).toHaveAttribute("href", `/chats/${SOURCE_THREAD_ID}`);
  }
  expectBefore(before, group);
  expectBefore(group, after);
});

test("Structured message context stays in its pane when a companion chat opens", async () => {
  const control = installMessages([
    {
      version: 1,
      parts: [
        {
          type: "source",
          kind: "agent",
          runId: SOURCE_RUN_ID,
          threadId: SOURCE_THREAD_ID,
          agentId: SOURCE_AGENT_ID,
          titleSnapshot: "Source thread",
          href: SOURCE_HREF,
        },
        {
          type: "file",
          fileId: "source-context-file",
          filenameSnapshot: "source-context.bin",
          contentType: "application/octet-stream",
        },
        { type: "text", text: "Continue the delegated analysis." },
      ],
    },
  ]);
  control.setThreadList([
    {
      id: context.resourceId,
      title: "Delegated work",
      agent: { id: MESSAGE_EXPERIENCE_AGENT_ID, avatarUrl: null },
      createdAt: CREATED_AT,
      updatedAt: "2026-08-20T12:02:00.000Z",
    },
    {
      id: SECOND_THREAD_ID,
      title: "Companion chat",
      agent: { id: MESSAGE_EXPERIENCE_AGENT_ID, avatarUrl: null },
      createdAt: CREATED_AT,
      updatedAt: "2026-08-20T12:01:00.000Z",
    },
  ]);
  await openChat();
  await findFastControl("link", "Open chat Source thread");
  await screen.findByText("source-context.bin");

  fireEvent.click(await findFastControl("link", "Companion chat"), {
    altKey: true,
  });

  const secondPane = await waitFor(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${SECOND_THREAD_ID}"]`,
    );
    if (!pane) {
      throw new Error("Companion chat pane not found");
    }
    return pane;
  });
  await expect(
    within(secondPane).findByRole("textbox", { name: "Message" }),
  ).resolves.toBeEnabled();
  const originalPane = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${context.resourceId}"]`,
  );
  if (!originalPane) {
    throw new Error("Original chat pane not found");
  }
  expect(
    within(originalPane).getByRole("textbox", { name: "Message" }),
  ).toBeEnabled();
  expect(linksLabeled(originalPane, "Open chat Source thread")).toHaveLength(1);
  expect(within(originalPane).getByText("source-context.bin")).toBeVisible();
});
