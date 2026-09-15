import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill } from "../../../__tests__/page-helper.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockPushBrowserSupport,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import { buildModelPolicy } from "./chat-composer-test-helpers.ts";
import {
  assistantEvent,
  context,
  expectTextOrder,
  findButton,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
  promptEvent,
  readyChat,
  RUN_PATH,
  sendText,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";

const ACTIVE_RUN_ID = "a0000000-0000-4000-a000-000000000501";

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Composer file input was not mounted");
  }
  return input;
}

async function uploadFile(
  user: ReturnType<typeof userEvent.setup>,
  file: File,
): Promise<void> {
  await user.click(await findButton("Attach"));
  await user.upload(composerFileInput(), file);
  await expect(findButton(`Remove ${file.name}`)).resolves.toBeVisible();
}

function fileParts(document: UserMessageDocument | undefined) {
  return (document?.parts ?? []).filter((part) => {
    return part.type === "file";
  });
}

test("Register the notification worker when the chat opens", async () => {
  const push = mockPushBrowserSupport();
  installRunChat();

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    env: { VITE_VAPID_PUBLIC_KEY_PREVIEW: "AQIDBA" },
  });

  await readyChat();
  await waitFor(() => {
    expect(push.register).toHaveBeenCalledWith("/sw.js", {
      updateViaCache: "none",
    });
  });
});

test("Enable completion notifications after a visible send", async () => {
  mockPushBrowserSupport();
  let registeredEndpoint: string | null = null;
  let runStarted = false;
  context.mocks.api(pushSubscriptionsContract.register, ({ body, respond }) => {
    registeredEndpoint = body.endpoint;
    return respond(201, { success: true });
  });
  installRunChat({
    onRunCreate() {
      runStarted = true;
    },
  });

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    env: { VITE_VAPID_PUBLIC_KEY_PREVIEW: "AQIDBA" },
  });

  await readyChat();
  const composer = screen.getByRole("textbox", { name: "Message" });
  await fill(composer, "Notify me when the launch review is complete");
  click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(
      screen.getByRole("textbox", { name: "Message" }).textContent?.trim(),
    ).toBe("");
    expect(
      screen.getByText("Notify me when the launch review is complete"),
    ).toBeVisible();
    expect(runStarted).toBeTruthy();
    expect(registeredEndpoint).toBe(
      "https://push.example.test/subscriptions/chat-send",
    );
  });
});

test("Finish text composition before queueing a follow-up", async () => {
  const queuedMessages: UserMessageDocument[] = [];
  installRunChat({
    activeRunIds: [ACTIVE_RUN_ID],
    chatEvents: [
      promptEvent({
        id: "composition-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Prepare the launch summary",
      }),
      thinkingEvent({
        id: "composition-progress",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: "Preparing the launch summary",
      }),
    ],
    onQueuedEventAppend(body) {
      if (body.userMessage) {
        queuedMessages.push(body.userMessage);
      }
    },
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const composer = screen.getByRole("textbox", { name: "Message" });
  fireEvent.compositionStart(composer);
  await fill(composer, "未完成の指");
  click(await findButton("Send"));

  expect(queuedMessages).toHaveLength(0);
  expect(
    screen.queryByRole("listitem", { name: "Queued message" }),
  ).not.toBeInTheDocument();

  await fill(composer, "完成した指示");
  fireEvent.compositionEnd(composer);

  await waitFor(() => {
    expect(queuedMessages).toHaveLength(1);
  });
  await expect(screen.findByText("完成した指示")).resolves.toBeVisible();
  expect(queuedMessages[0]?.parts).toContainEqual({
    type: "text",
    text: "完成した指示",
  });
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(
      "",
    );
  });
});

test("Queue a visual attachment without requiring text", async () => {
  const user = userEvent.setup({ delay: null });
  let queuedMessage:
    | {
        readonly hasTextContent?: boolean;
        readonly userMessage?: UserMessageDocument;
      }
    | undefined;
  installRunChat({
    activeRunIds: [ACTIVE_RUN_ID],
    chatEvents: [
      promptEvent({
        id: "video-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Prepare the campaign",
      }),
      thinkingEvent({
        id: "video-progress",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: "Preparing the campaign",
      }),
    ],
    onQueuedEventAppend(body) {
      queuedMessage = body;
    },
  });
  context.mocks.upload.success({
    id: "video-only-upload",
    filename: "launch-cut.mp4",
    contentType: "video/mp4",
    size: 24,
    url: "https://files.example.test/launch-cut.mp4",
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await uploadFile(
    user,
    new File(["video fixture"], "launch-cut.mp4", { type: "video/mp4" }),
  );
  await user.click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(queuedMessage).toBeDefined();
  });
  expect(queuedMessage?.hasTextContent).toBeFalsy();
  expect(fileParts(queuedMessage?.userMessage)).toContainEqual({
    type: "file",
    fileId: "video-only-upload",
    filenameSnapshot: "launch-cut.mp4",
    contentType: "video/mp4",
  });
  await expect(findButton("Preview launch-cut.mp4")).resolves.toBeVisible();
  expect(document.body).not.toHaveTextContent("(see attached files)");
});

test("Send a large image with a fallback-enabled text model", async () => {
  const user = userEvent.setup({ delay: null });
  let sentMessage:
    | {
        readonly model?: string;
        readonly userMessage?: UserMessageDocument;
      }
    | undefined;
  installRunChat({
    selectedModel: "deepseek-v4-pro",
    onRunCreate(body) {
      sentMessage = { model: body.model, userMessage: body.userMessage };
    },
  });
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      model: "deepseek-v4-pro",
      modelLabel: "DeepSeek V4 Pro",
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    }),
  ]);
  context.mocks.upload.success({
    id: "large-image-upload",
    filename: "launch-board.png",
    contentType: "image/png",
    size: 12_000_000,
    url: "https://files.example.test/launch-board.png",
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyChat();
  await expect(
    screen.findByRole("combobox", { name: "DeepSeek V4 Pro" }),
  ).resolves.toBeVisible();
  await uploadFile(
    user,
    new File([new Uint8Array(12_000_000)], "launch-board.png", {
      type: "image/png",
    }),
  );
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Review this launch board",
  );
  await user.click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(sentMessage).toBeDefined();
  });
  expect(fileParts(sentMessage?.userMessage)).toContainEqual({
    type: "file",
    fileId: "large-image-upload",
    filenameSnapshot: "launch-board.png",
    contentType: "image/png",
  });
  await expect(
    screen.findByText("Review this launch board"),
  ).resolves.toBeVisible();
});

test("Continue an existing chat with a fallback-enabled text model", async () => {
  const user = userEvent.setup({ delay: null });
  let sentMessage:
    | {
        readonly model?: string;
        readonly userMessage?: UserMessageDocument;
      }
    | undefined;
  installRunChat({
    onRunCreate(body) {
      sentMessage = { model: body.model, userMessage: body.userMessage };
    },
  });
  context.mocks.upload.success({
    id: "existing-video-upload",
    filename: "launch-demo.mp4",
    contentType: "video/mp4",
    size: 32,
    url: "https://files.example.test/launch-demo.mp4",
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByRole("combobox", { name: "Claude Sonnet 4.6" }),
  ).resolves.toBeVisible();
  await uploadFile(
    user,
    new File(["video fixture"], "launch-demo.mp4", { type: "video/mp4" }),
  );
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Summarize this launch demo",
  );
  await user.click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(sentMessage).toBeDefined();
  });
  expect(fileParts(sentMessage?.userMessage)).toContainEqual({
    type: "file",
    fileId: "existing-video-upload",
    filenameSnapshot: "launch-demo.mp4",
    contentType: "video/mp4",
  });
  await expect(
    screen.findByText("Summarize this launch demo"),
  ).resolves.toBeVisible();
  await expect(findButton("Preview launch-demo.mp4")).resolves.toBeVisible();
});

test("Show follow-up instructions in the active conversation", async () => {
  const queuedMessages: UserMessageDocument[] = [];
  installRunChat({
    activeRunIds: [ACTIVE_RUN_ID],
    chatEvents: [
      promptEvent({
        id: "active-request",
        runId: ACTIVE_RUN_ID,
        seqId: 1,
        text: "Prepare the launch plan",
      }),
      assistantEvent({
        id: "active-update",
        runId: ACTIVE_RUN_ID,
        seqId: 2,
        text: "I have mapped the launch risks.",
      }),
      promptEvent({
        id: "immediate-steer",
        runId: ACTIVE_RUN_ID,
        seqId: 3,
        text: "Prioritize the reversible steps",
      }),
      {
        id: "pending-automation",
        eventType: "input.automation",
        role: "user",
        runId: undefined,
        content: null,
        seqId: 4,
        createdAt: "2026-08-01T10:00:04.000Z",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "Launch follow-up",
              automationBrief: "Send the launch recap tomorrow",
            },
          ],
        },
      },
    ],
    onQueuedEventAppend(body) {
      if (body.userMessage) {
        queuedMessages.push(body.userMessage);
      }
    },
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expectTextOrder(
    "I have mapped the launch risks.",
    "Prioritize the reversible steps",
  );
  expect(
    screen.getByRole("listitem", { name: "Pending automation event" }),
  ).toHaveTextContent("Send the launch recap tomorrow");

  await sendText("Keep the owner names in the plan");

  await waitFor(() => {
    expect(queuedMessages).toHaveLength(1);
  });
  await expect(
    screen.findByText("Keep the owner names in the plan"),
  ).resolves.toBeVisible();
  expectTextOrder(
    "I have mapped the launch risks.",
    "Prioritize the reversible steps",
    "Keep the owner names in the plan",
  );
  await expect(findButton("Stop")).resolves.toBeVisible();
});

test("Show a newly sent message while history is still loading", async () => {
  const historyRequested = context.mocks.deferred<void>();
  const historyAvailable = context.mocks.deferred<void>();
  installRunChat();
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ query, respond }) => {
      if (!historyRequested.settled()) {
        historyRequested.resolve(undefined);
      }
      await historyAvailable.promise;
      return respond(200, chatEventRowsResponse([], query));
    },
  );

  await setupPage({ context, path: NEW_CHAT_PATH });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  expect(composer).toBeVisible();
  await sendText("Start before the earlier history arrives");
  await historyRequested.promise;

  const message = await screen.findByText(
    "Start before the earlier history arrives",
  );
  expect(message).toBeVisible();
  const chat = await screen.findByRole("region", { name: "Chat thread" });
  expect(chat).toContainElement(message);
  historyAvailable.resolve(undefined);
});
