import type { infer as zInfer } from "zod";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatEventsContract,
  chatThreadArtifactsContract,
  chatThreadDraftContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListAuth,
  chatListEvent,
  fastButton,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListRunModels,
  installChatListStream,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import {
  closeModelPanel,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const context = testContext();

type ThreadCreateBody = zInfer<typeof chatThreadsContract.create.body>;

interface NewChatStory {
  readonly creates: ThreadCreateBody[];
  readonly threadDraftReads: string[];
  readonly confirmCreation: () => void;
  readonly setRemoteEvents: ReturnType<
    typeof installChatListStream
  >["setEvents"];
}

function installNewChatStory(caseId: number): NewChatStory {
  const creates: ThreadCreateBody[] = [];
  const threadDraftReads: string[] = [];
  const confirmation = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListRunModels(context);
  const stream = installChatListStream(context, { caseId, snapshot: [] });
  installActiveChatBoundaries(context);
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadDraftContract.get, ({ params, respond }) => {
    threadDraftReads.push(params.id);
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    creates.push(body);
    await confirmation.promise;
    return respond(201, {
      id: body.clientThreadId ?? crypto.randomUUID(),
      title: null,
      selectedModel: body.model ?? null,
      serviceTier: body.serviceTier ?? null,
      createdAt: "2026-08-01T02:00:00.000Z",
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    return respond(201, {
      threadId: "threadId" in body && body.threadId ? body.threadId : "",
      createdAt: "2026-08-01T02:00:01.000Z",
    });
  });
  return {
    creates,
    threadDraftReads,
    confirmCreation: () => {
      confirmation.resolve();
    },
    setRemoteEvents: stream.setEvents,
  };
}

async function openNewChat(caseId: number): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: chatListAuth(caseId),
  });
  return await screen.findByRole("textbox", { name: "Message" });
}

async function sendFromComposer(
  composer: HTMLElement,
  text: string,
): Promise<void> {
  await fillComposer(composer, text);
  click(
    await waitFor(() => {
      return fastButton("Send");
    }),
  );
}

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  return input;
}

async function requestedThreadId(story: NewChatStory): Promise<string> {
  return await waitFor(() => {
    const threadId = story.creates[0]?.clientThreadId;
    if (!threadId) {
      throw new Error("Expected the creation request");
    }
    return threadId;
  });
}

test("A new conversation appears before server confirmation", async () => {
  const story = installNewChatStory(601);
  const composer = await openNewChat(601);

  await sendFromComposer(composer, "Start the local conversation");

  const threadId = await requestedThreadId(story);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
  });
  expect(sidebarThreadLinks()[0]?.dataset.sidebarChatThreadId).toBe(threadId);
  expect(story.creates).toHaveLength(1);
  expect(story.threadDraftReads).toStrictEqual([]);
});

test("An optimistic QuickTime preview does not list artifacts before thread creation", async () => {
  const user = userEvent.setup({ delay: null });
  const story = installNewChatStory(602);
  const artifactReads: string[] = [];
  context.mocks.api(chatThreadArtifactsContract.list, ({ params, respond }) => {
    artifactReads.push(params.threadId);
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });
  const fileId = "f7000000-0000-4000-a000-000000000602";
  const videoUrl = "https://cdn.vm7.io/chat-list/602/recording.mov";
  context.mocks.upload.success({
    id: fileId,
    filename: "recording.mov",
    contentType: "video/quicktime",
    size: 2048,
    url: videoUrl,
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    if (query.file_id !== fileId) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "File not found" },
      });
    }
    return respond(200, {
      downloadUrl: `${videoUrl}?download=1`,
      url: videoUrl,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: videoUrl,
      previewImageUrl: null,
    });
  });
  const composer = await openNewChat(602);

  await user.upload(
    composerFileInput(),
    new File(["quicktime"], "recording.mov", { type: "video/quicktime" }),
  );
  await sendFromComposer(composer, "Review the recording");

  const threadId = await requestedThreadId(story);
  const thread = await waitFor(() => {
    const container = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${threadId}"]`,
    );
    if (!container) {
      throw new Error("Expected the optimistic chat thread");
    }
    return container;
  });
  const preview = await waitFor(() => {
    const video = thread.querySelector("video");
    if (!video) {
      throw new Error("Expected the recording.mov preview");
    }
    return video;
  });
  expect(preview).toHaveAttribute("src", `${videoUrl}#t=0.001`);
  expect(artifactReads).toStrictEqual([]);
  expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
});

test("The changed model survives the first send before server confirmation", async () => {
  const user = userEvent.setup({ delay: null });
  const story = installNewChatStory(605);
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-5.6-luna",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const composer = await openNewChat(605);

  const panel = await openModelPanel("GPT 5.6 Luna");
  await user.click(modelOption(/^Claude Sonnet 5/u, panel));
  await closeModelPanel();
  await sendFromComposer(composer, "Use the changed model");

  await requestedThreadId(story);
  expect(story.creates[0]?.model).toBe("claude-sonnet-5");
  await expect(composerModelTrigger("Claude Sonnet 5")).resolves.toBeVisible();
  expect(story.creates).toHaveLength(1);
  expect(story.threadDraftReads).toStrictEqual([]);
  expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
});

test("Server confirmation settles a new conversation without duplication", async () => {
  const caseId = 607;
  const story = installNewChatStory(caseId);
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-5",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const composer = await openNewChat(caseId);
  await expect(composerModelTrigger("Claude Sonnet 5")).resolves.toBeVisible();

  await sendFromComposer(composer, "Confirm this conversation");

  const threadId = await requestedThreadId(story);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
  });

  const createdEventId = story.creates[0]?.eventId;
  expect(createdEventId).toBeDefined();
  story.setRemoteEvents([
    chatListEvent(caseId, 2, "created", threadId, {
      id: createdEventId,
      title: "Confirmed conversation",
      selectedModel: "claude-sonnet-5",
    }),
  ]);
  story.confirmCreation();
  changeChatThreadList();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Confirmed conversation"]);
  });
  expect(
    sidebarThreadLinks().map((link) => {
      return link.dataset.sidebarChatThreadId;
    }),
  ).toStrictEqual([threadId]);
});
