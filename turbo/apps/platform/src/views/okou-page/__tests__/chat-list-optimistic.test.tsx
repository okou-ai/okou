import { screen, waitFor } from "@testing-library/react";
import {
  chatEventsContract,
  chatThreadDraftContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
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

const context = testContext();

async function selectClaudeSonnet(): Promise<void> {
  click(await screen.findByRole("combobox"));
  let option: HTMLElement | undefined;
  await waitFor(() => {
    option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((candidate) => {
      return candidate.textContent?.includes("Claude Sonnet 4.6");
    });
    expect(option).toBeDefined();
  });
  click(option!);
}

async function sendComposerMessage(message: string): Promise<void> {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, message);
  await waitFor(() => {
    expect(fastButton("Send")).toBeEnabled();
  });
  click(fastButton("Send"));
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

async function openUnconfirmedConversation() {
  const auth = chatListAuth(9);
  const confirmation = context.mocks.deferred<void>();
  const requests: {
    threadId: string | undefined;
    model: string | undefined;
    draftRequested: boolean;
  } = { threadId: undefined, model: undefined, draftRequested: false };
  installNewThreadDefaults();
  installChatListStream(context, { caseId: 9, snapshot: [] });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    requests.threadId = body.clientThreadId;
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
  });
  return { confirmation, requests };
}

test("A new conversation appears before server confirmation", async () => {
  const { confirmation, requests } = await openUnconfirmedConversation();
  const defaultModel = await screen.findByRole("combobox", {
    name: "GPT 5.6 Luna",
  });
  expect(defaultModel).toBeVisible();
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

test("The changed model survives the first send before server confirmation", async () => {
  const { confirmation, requests } = await openUnconfirmedConversation();
  const defaultModel = await screen.findByRole("combobox", {
    name: "GPT 5.6 Luna",
  });
  expect(defaultModel).toBeVisible();
  await selectClaudeSonnet();
  await sendComposerMessage("Start the local conversation");
  await waitFor(() => {
    expect(requests.model).toBe("claude-sonnet-4-6");
  });
  const selectedModel = await screen.findByRole("combobox", {
    name: "Claude Sonnet 4.6",
  });
  expect(selectedModel).toBeVisible();
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
