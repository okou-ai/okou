import {
  agentDraftContract,
  type AgentDraftRequest,
} from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatThreadsContract,
  type ChatThreadSnapshotProjection,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const WEEKLY_SYNC_THREAD_ID = "b0000000-0000-4000-a000-000000000091";
const UNTITLED_THREAD_ID = "b0000000-0000-4000-a000-000000000092";
const SPECIAL_TITLE_THREAD_ID = "b0000000-0000-4000-a000-000000000093";
const CREATED_AT = "2026-08-01T10:00:00.000Z";

const context = testContext();

function referencedThread(
  id: string,
  title: string | null,
): ChatThreadSnapshotProjection {
  return {
    id,
    agentId: AGENT_ID,
    title,
    sortAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    modelSettings: {},
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
}

function configureAgentDraft(
  draft: UserMessageInputDocument,
  referencedThreads: readonly ChatThreadSnapshotProjection[],
): void {
  context.mocks.data.agents([{ agentId: AGENT_ID }]);
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    modelSettings: {},
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: null,
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: draft,
      draftAttachments: null,
    });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [...referencedThreads],
      latestEventId: null,
      latestSeqId: null,
    });
  });
}

function conversationChips(composer: HTMLElement): HTMLElement[] {
  return Array.from(
    composer.querySelectorAll<HTMLElement>("[data-chat-thread-mention]"),
  );
}

function conversationChip(
  composer: HTMLElement,
  threadId: string,
): HTMLElement {
  const chip = conversationChips(composer).find((candidate) => {
    return candidate.dataset.chatThreadMention === threadId;
  });
  if (!chip) {
    throw new Error(`Could not find conversation chip for ${threadId}`);
  }
  return chip;
}

function getLink(name: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!link) {
    throw new Error(`Could not find link named ${name}`);
  }
  return link;
}

test("A conversation reference renders as a recognizable chip", async () => {
  configureAgentDraft(
    {
      version: 1,
      parts: [
        { type: "text", text: "Review " },
        {
          type: "chat_thread",
          threadId: WEEKLY_SYNC_THREAD_ID,
          titleSnapshot: "Weekly sync",
        },
        { type: "text", text: " before planning." },
      ],
    },
    [referencedThread(WEEKLY_SYNC_THREAD_ID, "Weekly sync")],
  );

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(composer).toHaveTextContent("Review Weekly sync before planning.");
  });

  const chips = conversationChips(composer);
  expect(chips).toHaveLength(1);
  expect(chips[0]).toHaveTextContent("Weekly sync");
  expect(chips[0]).toHaveAttribute(
    "data-chat-thread-mention",
    WEEKLY_SYNC_THREAD_ID,
  );
  expect(chips[0]).toHaveAttribute("contenteditable", "false");
  expect(composer.textContent).toBe("Review Weekly sync before planning.");
});

test("Ordinary links are not mistaken for conversation mentions", async () => {
  const externalLink = "https://example.com/launch-notes";
  const agentLink = `/agents/${AGENT_ID}/chat`;
  const invalidConversationLink = "[Broken](/chats/not-a-conversation)";
  const conversationWithoutTitle = `/chats/${UNTITLED_THREAD_ID}`;
  const ordinaryText = [
    externalLink,
    agentLink,
    invalidConversationLink,
    conversationWithoutTitle,
  ].join(" | ");

  configureAgentDraft(
    {
      version: 1,
      parts: [
        { type: "text", text: `${ordinaryText} | ` },
        {
          type: "chat_thread",
          threadId: WEEKLY_SYNC_THREAD_ID,
          titleSnapshot: "Weekly sync",
        },
      ],
    },
    [
      referencedThread(WEEKLY_SYNC_THREAD_ID, "Weekly sync"),
      referencedThread(UNTITLED_THREAD_ID, null),
    ],
  );

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(composer).toHaveTextContent(externalLink);
    expect(composer).toHaveTextContent(agentLink);
    expect(composer).toHaveTextContent(invalidConversationLink);
    expect(composer).toHaveTextContent(conversationWithoutTitle);
    expect(composer).toHaveTextContent("Weekly sync");
  });

  const chips = conversationChips(composer);
  expect(chips).toHaveLength(1);
  expect(chips[0]).toHaveTextContent("Weekly sync");
  expect(chips[0]).toHaveAttribute(
    "data-chat-thread-mention",
    WEEKLY_SYNC_THREAD_ID,
  );
});

test("Special characters in a conversation title survive saving and restoring", async () => {
  const specialTitle = String.raw`Release [QA] \ notes`;
  let savedDraft: AgentDraftRequest | undefined;

  configureAgentDraft(
    {
      version: 1,
      parts: [
        { type: "text", text: "Review " },
        {
          type: "chat_thread",
          threadId: SPECIAL_TITLE_THREAD_ID,
          titleSnapshot: specialTitle,
        },
        { type: "text", text: " tomorrow" },
      ],
    },
    [referencedThread(SPECIAL_TITLE_THREAD_ID, specialTitle)],
  );
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    savedDraft = body;
    return respond(204);
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  const initialChip = await waitFor(() => {
    return conversationChip(composer, SPECIAL_TITLE_THREAD_ID);
  });
  expect(initialChip.textContent).toBe(specialTitle);

  const user = userEvent.setup({ delay: null });
  await user.click(composer);
  await user.keyboard(" reviewed");
  await waitFor(() => {
    expect(savedDraft).toBeDefined();
  });
  const savedMention = savedDraft?.draftUserMessage?.parts.find((part) => {
    return part.type === "chat_thread";
  });
  expect(savedMention).toStrictEqual({
    type: "chat_thread",
    threadId: SPECIAL_TITLE_THREAD_ID,
    titleSnapshot: specialTitle,
  });

  const agentsLink = await waitFor(() => {
    return getLink("Agents");
  });
  click(agentsLink);
  await waitFor(() => {
    expect(pathname()).toBe("/agents");
  });
  window.history.back();
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  });

  const restoredComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  const restoredChip = await waitFor(() => {
    return conversationChip(restoredComposer, SPECIAL_TITLE_THREAD_ID);
  });
  expect(restoredChip).toHaveAttribute(
    "data-chat-thread-mention",
    SPECIAL_TITLE_THREAD_ID,
  );
  expect(restoredChip.textContent).toBe(specialTitle);
});
