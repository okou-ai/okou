import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  ADA_AGENT_ID,
  context,
  findFastControl,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
  SOURCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const CREATED_AT = "2026-08-20T12:00:00.000Z";
const SOURCE_THREAD_ID = "b0000000-0000-4000-a000-000000000052";
const SECOND_THREAD_ID = "b0000000-0000-4000-a000-000000000053";
const SOURCE_RUN_ID = "d0000000-0000-4000-a000-000000000052";

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

function assertBefore(first: Element, second: Element): void {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

test("Agent mentions are recognizable links in messages and feedback", async () => {
  const userMessage = {
    version: 1,
    parts: [
      { type: "text", text: "Ask " },
      { type: "agent", agentId: ADA_AGENT_ID, nameSnapshot: "Ada" },
      { type: "text", text: " to review this." },
      {
        type: "feedback",
        quote: "The launch plan needs a second look.",
        note: [
          { type: "text", text: "Please have " },
          { type: "agent", agentId: ADA_AGENT_ID, nameSnapshot: "Ada" },
          { type: "text", text: " check the dates." },
        ],
      },
    ],
  } satisfies UserMessageDocument;
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [userEventWith(userMessage)],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  const message = await waitFor(() => {
    const element = documentRoot();
    expect(element).toHaveTextContent("Ask Ada to review this.");
    return element;
  });
  const mentions = queryAllByRoleFast("link", message).filter((link) => {
    return link.getAttribute("aria-label") === "Open agent Ada";
  });
  expect(mentions).toHaveLength(2);
  for (const mention of mentions) {
    expect(mention).toHaveAttribute("href", `/agents/${ADA_AGENT_ID}/chat`);
    expect(mention).toHaveTextContent("Ada");
    expect(mention.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.vm7.io/avatars/ada.png",
    );
  }
  expect(message).not.toHaveTextContent(ADA_AGENT_ID);
});

test("Delegated work links back to its source run", async () => {
  const userMessage = {
    version: 1,
    parts: [
      {
        type: "source",
        kind: "agent",
        runId: SOURCE_RUN_ID,
        threadId: SOURCE_THREAD_ID,
        agentId: SOURCE_AGENT_ID,
        titleSnapshot: "Source thread",
        href: `/chats/${SOURCE_THREAD_ID}#run-${SOURCE_RUN_ID}`,
      },
      { type: "text", text: "Prepare the delegated launch analysis." },
    ],
  } satisfies UserMessageDocument;
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [userEventWith(userMessage)],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  const sourceLink = await findFastControl("link", "Open chat Source thread");
  expect(sourceLink).toHaveTextContent("Source thread");
  expect(sourceLink).toHaveAttribute(
    "href",
    `/chats/${SOURCE_THREAD_ID}#run-${SOURCE_RUN_ID}`,
  );
  expect(sourceLink.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.vm7.io/avatars/source-agent.png",
  );
  const prompt = await screen.findByText(
    "Prepare the delegated launch analysis.",
  );
  expect(prompt.closest('[data-role="user"]')).toHaveAttribute(
    "id",
    `run-${SOURCE_RUN_ID}`,
  );
});

test("Related feedback notes are grouped with clear source links", async () => {
  const userMessage = {
    version: 1,
    parts: [
      { type: "text", text: "Context before feedback.\n" },
      {
        type: "feedback",
        quote: "The audience is not specific enough.",
        note: [
          { type: "text", text: "Use the audience from " },
          {
            type: "chat_thread",
            threadId: SOURCE_THREAD_ID,
            titleSnapshot: "Project Alpha",
          },
          { type: "text", text: "." },
        ],
      },
      {
        type: "feedback",
        quote: "The timing needs more detail.",
        note: [
          { type: "text", text: "Match the milestones in " },
          {
            type: "chat_thread",
            threadId: SOURCE_THREAD_ID,
            titleSnapshot: "Project Alpha",
          },
          { type: "text", text: "." },
        ],
      },
      { type: "text", text: "\nContext after feedback." },
    ],
  } satisfies UserMessageDocument;
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [userEventWith(userMessage)],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  const before = await screen.findByText("Context before feedback.");
  const after = screen.getByText("Context after feedback.");
  const group = document.querySelector<HTMLElement>(
    "[data-structured-feedback-group]",
  );
  if (!group) {
    throw new Error("Structured feedback group not found");
  }
  expect(group).toHaveTextContent("Feedback on 2 parts of your reply:");
  const quotes = group.querySelectorAll("[data-structured-feedback-quote]");
  expect(quotes).toHaveLength(2);
  expect(quotes[0]).toHaveTextContent("The audience is not specific enough.");
  expect(quotes[1]).toHaveTextContent("The timing needs more detail.");
  const links = queryAllByRoleFast("link", group).filter((link) => {
    return link.getAttribute("aria-label") === "Open chat Project Alpha";
  });
  expect(links).toHaveLength(2);
  for (const link of links) {
    expect(link).toHaveTextContent("Project Alpha");
    expect(link).toHaveAttribute("href", `/chats/${SOURCE_THREAD_ID}`);
    expect(link).not.toHaveTextContent(SOURCE_THREAD_ID);
  }
  assertBefore(before, group);
  assertBefore(group, after);
});

async function openStructuredContextChat() {
  const userMessage = {
    version: 1,
    parts: [
      {
        type: "source",
        kind: "agent",
        runId: SOURCE_RUN_ID,
        threadId: SOURCE_THREAD_ID,
        agentId: SOURCE_AGENT_ID,
        titleSnapshot: "Source thread",
        href: `/chats/${SOURCE_THREAD_ID}#run-${SOURCE_RUN_ID}`,
      },
      {
        type: "file",
        fileId: "source-context-file",
        filenameSnapshot: "source-context.bin",
        contentType: "application/octet-stream",
      },
      { type: "text", text: "Continue the delegated analysis." },
    ],
  } satisfies UserMessageDocument;
  const control = installMessageExperienceChat({
    threadId: context.resourceId,
    threadTitle: "Delegated work",
    chatEvents: [userEventWith(userMessage)],
  });
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

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(
    findFastControl("link", "Open chat Source thread"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("source-context.bin"),
  ).resolves.toBeInTheDocument();
}

test("Structured message context survives navigation away and back", async () => {
  await openStructuredContextChat();
  fireEvent.click(await findFastControl("link", "Agents"));
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  window.history.back();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${context.resourceId}`);
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeEnabled();
  await expect(
    findFastControl("link", "Open chat Source thread"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Page not found")).not.toBeInTheDocument();
  await expect(screen.findByText("source-context.bin")).resolves.toBeVisible();
});

test("Structured message context stays in its pane when a companion chat opens", async () => {
  await openStructuredContextChat();
  fireEvent.click(await findFastControl("link", "Companion chat"), {
    altKey: true,
  });
  await waitFor(() => {
    expect(
      document.querySelectorAll("[data-chat-thread-container-id]"),
    ).toHaveLength(2);
  });
  const originalPane = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${context.resourceId}"]`,
  );
  if (!originalPane) {
    throw new Error("Original chat pane not found");
  }
  await waitFor(() => {
    expect(
      queryAllByRoleFast("link", originalPane).some((link) => {
        return link.getAttribute("aria-label") === "Open chat Source thread";
      }),
    ).toBeTruthy();
    expect(within(originalPane).getByText("source-context.bin")).toBeVisible();
    expect(
      within(originalPane).getByRole("textbox", { name: "Message" }),
    ).toBeEnabled();
  });
  const secondPane = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${SECOND_THREAD_ID}"]`,
  );
  if (!secondPane) {
    throw new Error("Companion chat pane not found");
  }
  await expect(
    within(secondPane).findByRole("textbox", { name: "Message" }),
  ).resolves.toBeEnabled();
});

test("A structured user message keeps its saved order and snapshots", async () => {
  const userMessage = {
    version: 1,
    parts: [
      { type: "text", text: "Begin with " },
      {
        type: "template",
        titleSnapshot: "Original Illustration Style",
        template: {
          type: "illustration",
          selection: { illustrationStyleId: "saved-watercolor" },
        },
      },
      { type: "text", text: ", then use " },
      {
        type: "file",
        fileId: "launch-image",
        filenameSnapshot: "original-launch.png",
        contentType: "image/png",
      },
      { type: "text", text: " and consult " },
      {
        type: "chat_thread",
        threadId: SOURCE_THREAD_ID,
        titleSnapshot: "Saved Source Chat",
      },
      { type: "text", text: " before the documents." },
      {
        type: "file",
        fileId: "launch-pdf",
        filenameSnapshot: "original-brief.pdf",
        contentType: "application/pdf",
      },
      {
        type: "file",
        fileId: "deleted-text",
        filenameSnapshot: "deleted-notes.txt",
        contentType: "text/plain",
      },
      {
        type: "text",
        text: " Literal **bold** <script>alert('never')</script> text.",
      },
    ],
  } satisfies UserMessageDocument;
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [userEventWith(userMessage)],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  const structured = await waitFor(documentRoot);
  const begin = within(structured).getByText("Begin with");
  const template = within(structured).getByText("Original Illustration Style");
  const consult = within(structured).getByText("and consult");
  const chat = await findFastControl(
    "link",
    "Open chat Saved Source Chat",
    structured,
  );
  const documents = within(structured).getByText("before the documents.");
  assertBefore(begin, template);
  assertBefore(template, consult);
  assertBefore(consult, chat);
  assertBefore(chat, documents);
  expect(chat).toHaveAttribute("href", `/chats/${SOURCE_THREAD_ID}`);
  const imageAttachment = await findFastControl(
    "link",
    "Preview original-launch.png",
  );
  expect(imageAttachment).toHaveAttribute(
    "aria-label",
    "Preview original-launch.png",
  );
  expect(imageAttachment.querySelector("img")).toHaveAttribute(
    "alt",
    "original-launch.png",
  );
  await expect(screen.findByText("original-brief.pdf")).resolves.toBeVisible();
  expect(screen.getByText("deleted-notes.txt")).toBeVisible();
  expect(screen.getByText(/Literal \*\*bold\*\*/u)).toHaveTextContent(
    "Literal **bold** <script>alert('never')</script> text.",
  );
  expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByText("Conflicting legacy message text")).toBeNull();
  expect(screen.queryByText("New Illustration Style")).toBeNull();
  expect(screen.queryByText("renamed-launch.png")).toBeNull();
});

test("Sent template references stay inline and read-only", async () => {
  const templatePart = {
    type: "template" as const,
    titleSnapshot: "Editorial Collage",
    template: {
      type: "illustration" as const,
      selection: { illustrationStyleId: "editorial-collage" },
    },
  };
  const userMessage = {
    version: 1,
    parts: [
      { type: "text", text: "Use " },
      templatePart,
      { type: "text", text: " for the cover." },
      {
        type: "feedback",
        quote: "The illustration feels generic.",
        note: [
          { type: "text", text: "Keep " },
          templatePart,
          { type: "text", text: " but strengthen the contrast." },
        ],
      },
    ],
  } satisfies UserMessageDocument;
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [userEventWith(userMessage)],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  const references = await waitFor(() => {
    const elements = document.querySelectorAll<HTMLElement>(
      "[data-structured-template-reference]",
    );
    expect(elements).toHaveLength(2);
    return [...elements];
  });
  const mainMessage = documentRoot();
  const use = within(mainMessage).getByText("Use");
  const cover = within(mainMessage).getByText("for the cover.");
  assertBefore(use, references[0]!);
  assertBefore(references[0]!, cover);
  const note = screen.getByText("but strengthen the contrast.");
  assertBefore(references[1]!, note);
  for (const reference of references) {
    expect(reference).toHaveTextContent("Editorial Collage");
    expect(
      reference.matches("button, a, [role='button'], [role='link']"),
    ).toBeFalsy();
    fireEvent.click(reference);
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Create")).toBeNull();
});

function documentRoot(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    "[data-structured-user-message]",
  );
  if (!element) {
    throw new Error("Structured user message not found");
  }
  return element;
}
