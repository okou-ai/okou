import { modelMenuOption } from "./chat-model-menu-test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import {
  chatEventsContract,
  chatThreadArtifactsContract,
  chatThreadDraftContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  cachedChatListEvents,
  chatListAuth,
  chatListEvent,
  chatListThread,
  fastButton,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListModelPolicies,
  installChatListStream,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

const context = testContext();

async function selectClaudeSonnet(): Promise<void> {
  click(await composerModelTrigger("GPT 5.6 Luna"));
  const chatModels = await screen.findByRole("menu", {
    name: "Chat models",
  });
  click(modelMenuOption(/Claude Sonnet 4\.6/u, chatModels));
}

async function sendComposerMessage(message: string): Promise<void> {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, message);
  await waitFor(() => {
    expect(fastButton("Send")).toBeEnabled();
  });
  click(fastButton("Send"));
}

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Composer file input was not mounted");
  }
  return input;
}

function installNewThreadDefaults(): void {
  installChatListAgent(context);
  installChatListModelPolicies(context);
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-5.6-luna",
    serviceTier: null,
    modelSettings: {},
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  installActiveChatBoundaries(context);
}

async function openUnconfirmedConversation(
  options: { readonly headerActionsEnabled?: boolean } = {},
) {
  const auth = chatListAuth(9);
  const confirmation = context.mocks.deferred<void>();
  const requests: {
    threadId: string | undefined;
    eventId: string | undefined;
    model: string | undefined;
    draftRequested: boolean;
  } = {
    threadId: undefined,
    eventId: undefined,
    model: undefined,
    draftRequested: false,
  };
  installNewThreadDefaults();
  const stream = installChatListStream(context, { caseId: 9, snapshot: [] });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, []);
    },
  );
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    requests.threadId = body.clientThreadId;
    requests.eventId = body.eventId;
    requests.model = body.model;
    await confirmation.promise;
    return respond(201, {
      id: body.clientThreadId ?? "b7000000-0000-4000-a000-000000000009",
      title: null,
      createdAt: "2026-08-01T03:00:00.000Z",
      selectedModel: body.model ?? "claude-sonnet-4-6",
      serviceTier: body.serviceTier ?? null,
    });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    requests.draftRequested = true;
    return respond(200, {
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    return respond(201, {
      runId: "a7000000-0000-4000-a000-000000000009",
      threadId: body.threadId ?? "b7000000-0000-4000-a000-000000000009",
      status: "pending",
      createdAt: "2026-08-01T03:00:01.000Z",
    });
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(9, []),
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadHeaderActions]:
        options.headerActionsEnabled ?? false,
    },
  });
  return { confirmation, requests, stream };
}

test("A new conversation appears before server confirmation", async () => {
  const { confirmation, requests } = await openUnconfirmedConversation();
  await expect(composerModelTrigger("GPT 5.6 Luna")).resolves.toBeVisible();
  await sendComposerMessage("Start the local conversation");

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
    expect(requests.threadId).toBeDefined();
  });
  expect(sidebarThreadLinks()).toHaveLength(1);
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "data-sidebar-chat-thread-id",
    requests.threadId,
  );
  expect(requests.draftRequested).toBeFalsy();
  expect(confirmation.settled()).toBeFalsy();
});

test("An optimistic QuickTime preview does not list artifacts before thread creation", async () => {
  const fileId = "optimistic-recording";
  context.mocks.upload.success({
    id: fileId,
    filename: "recording.mov",
    contentType: "video/quicktime",
    size: 24,
    url: `http://localhost/api/web/download-file?file_id=${fileId}`,
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(404, {
      error: { code: "THREAD_NOT_FOUND", message: "Chat thread not found" },
    });
  });
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      url: "https://private-files.example/recording.mov",
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
      previewImageUrl: null,
    });
  });
  const { confirmation, requests } = await openUnconfirmedConversation();
  const user = userEvent.setup({ delay: null });
  await user.click(fastButton("Attach"));
  await user.upload(
    composerFileInput(),
    new File(["video fixture"], "recording.mov", {
      type: "video/quicktime",
    }),
  );
  await expect(fastButton("Remove recording.mov")).toBeVisible();

  await user.click(fastButton("Send"));

  await waitFor(() => {
    expect(fastButton("Preview recording.mov")).toBeVisible();
  });
  await expect(
    screen.findByTestId("chat-video-preview-fallback"),
  ).resolves.toHaveAttribute(
    "src",
    "https://private-files.example/recording.mov#t=0.001",
  );
  expect(requests.threadId).toBeDefined();
  expect(confirmation.settled()).toBeFalsy();
  expect(
    screen.queryAllByText("Chat thread not found").find((candidate) => {
      return candidate.closest('[data-sonner-toast][data-visible="true"]');
    }),
  ).toBeUndefined();
});

test.each([true, false])(
  "Thread actions wait for optimistic creation to settle (desktop: %s)",
  async (desktop) => {
    context.mocks.browser.matchMedia(desktop);
    const { confirmation, requests, stream } =
      await openUnconfirmedConversation({ headerActionsEnabled: true });

    await sendComposerMessage("Create a thread before showing its actions");
    await waitFor(() => {
      expect(requests.threadId).toBeDefined();
      expect(requests.eventId).toBeDefined();
    });
    expect(screen.queryByLabelText("Change icon")).toBeNull();
    expect(screen.queryByLabelText("Pin chat")).toBeNull();
    expect(screen.queryByLabelText("Share messages")).toBeNull();
    expect(
      screen.queryByLabelText(desktop ? "Open artifacts" : "More actions"),
    ).toBeNull();
    if (!requests.threadId || !requests.eventId) {
      throw new Error("Expected optimistic thread identifiers");
    }
    confirmation.resolve();
    stream.setEvents([
      chatListEvent(9, 2, "created", requests.threadId, {
        id: requests.eventId,
        title: "Confirmed conversation",
        selectedModel: requests.model ?? "gpt-5.6-luna",
        createdAt: "2026-08-01T03:00:00.000Z",
      }),
    ]);
    context.mocks.ably.trigger("threadListChanged");

    await waitFor(() => {
      expect(screen.getByLabelText("Change icon")).toBeVisible();
      expect(screen.queryAllByLabelText("Pin chat")).toHaveLength(
        desktop ? 1 : 0,
      );
      expect(screen.getByLabelText("Share messages")).toBeVisible();
      expect(
        screen.getByLabelText(desktop ? "Open artifacts" : "More actions"),
      ).toBeVisible();
    });
  },
);

test("The changed model survives the first send before server confirmation", async () => {
  const { confirmation, requests } = await openUnconfirmedConversation();
  await expect(composerModelTrigger("GPT 5.6 Luna")).resolves.toBeVisible();
  await selectClaudeSonnet();
  await sendComposerMessage("Start the local conversation");
  await waitFor(() => {
    expect(requests.model).toBe("claude-sonnet-4-6");
  });
  await expect(
    composerModelTrigger("Claude Sonnet 4.6"),
  ).resolves.toBeVisible();
  expect(requests.draftRequested).toBeFalsy();
  expect(confirmation.settled()).toBeFalsy();
});

test("Sending in an older conversation moves it to the top", async () => {
  const auth = chatListAuth(12);
  const older = chatListThread(45, "Older cached thread");
  const newer = chatListThread(46, "Newer cached thread");
  const send = context.mocks.deferred<void>();
  let sentPrompt: string | undefined;
  installChatListAgent(context);
  installChatListModelPolicies(context);
  installChatListStream(context, {
    caseId: 12,
    snapshot: [older, newer],
  });
  installActiveChatBoundaries(context, { metadata: older });
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    sentPrompt = body.prompt;
    await send.promise;
    return respond(201, {
      runId: "a7000000-0000-4000-a000-000000000012",
      threadId: body.threadId ?? older.id,
      status: "pending",
      createdAt: "2026-08-01T03:00:02.000Z",
    });
  });

  await setupPage({
    context,
    path: `/chats/${older.id}`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(12, [older, newer]),
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Newer cached thread",
      "Older cached thread",
    ]);
  });
  await sendComposerMessage("Continue the older work");

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Older cached thread",
      "Newer cached thread",
    ]);
    expect(sentPrompt).toBe("Continue the older work");
  });
  const optimisticMessage = await screen.findByText("Continue the older work");
  expect(optimisticMessage).toBeVisible();
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "data-sidebar-chat-thread-id",
    older.id,
  );
  expect(send.settled()).toBeFalsy();
});

test("Server confirmation settles a new conversation without duplication", async () => {
  const auth = chatListAuth(13);
  const confirmation = context.mocks.deferred<void>();
  let createdThreadId: string | undefined;
  let createdEventId: string | undefined;
  installNewThreadDefaults();
  const stream = installChatListStream(context, {
    caseId: 13,
    snapshot: [],
  });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    createdThreadId = body.clientThreadId;
    createdEventId = body.eventId;
    await confirmation.promise;
    return respond(201, {
      id: body.clientThreadId ?? "b7000000-0000-4000-a000-000000000013",
      title: null,
      createdAt: "2026-08-01T03:00:03.000Z",
      selectedModel: body.model ?? "claude-sonnet-4-6",
      serviceTier: body.serviceTier ?? null,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    return respond(201, {
      runId: "a7000000-0000-4000-a000-000000000013",
      threadId: body.threadId ?? "b7000000-0000-4000-a000-000000000013",
      status: "pending",
      createdAt: "2026-08-01T03:00:04.000Z",
    });
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(13, []),
  });

  await selectClaudeSonnet();
  await sendComposerMessage("Create one confirmed conversation");
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
    expect(createdThreadId).toBeDefined();
    expect(createdEventId).toBeDefined();
  });
  expect(sidebarThreadLinks()).toHaveLength(1);

  if (!createdThreadId || !createdEventId) {
    throw new Error("Expected the optimistic create request identifiers");
  }
  confirmation.resolve();
  const persistedCreate = chatListEvent(13, 2, "created", createdThreadId, {
    id: createdEventId,
    title: "Confirmed conversation",
    selectedModel: "claude-sonnet-4-6",
    createdAt: "2026-08-01T03:00:03.000Z",
  });
  stream.setEvents([persistedCreate]);
  context.mocks.ably.trigger("threadListChanged");

  await waitFor(() => {
    const matchingLinks = sidebarThreadLinks().filter((link) => {
      return link.dataset.sidebarChatThreadId === createdThreadId;
    });
    expect(matchingLinks).toHaveLength(1);
    expect(sidebarThreadTitles()).toStrictEqual(["Confirmed conversation"]);
  });
});
