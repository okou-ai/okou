import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";
import { artifactReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatLifecycleHelpers,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  createChatRunFixtures,
  expectTextOrder,
  findButton,
  NEW_CHAT_PATH,
  promptEvent,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const { mockPushBrowserSupport } = createChatLifecycleHelpers(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000701";
const IMAGE_FILE_ID = "a0000000-0000-4000-a000-000000000702";
const PUSH_ENDPOINT = "https://push.example.test/subscriptions/chat-send";
const VAPID_PUBLIC_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

function userTurnCount(text: string): number {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-role="user"]'),
  ).filter((turn) => {
    return turn.textContent?.includes(text) === true;
  }).length;
}

function selectFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  fireEvent.change(input, { target: { files: [file] } });
}

test("Enable completion notifications after a visible send", async () => {
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY_PREVIEW", VAPID_PUBLIC_KEY);
  mockPushBrowserSupport();
  const runs: (string | undefined)[] = [];
  installRunChat({
    onRunCreate: (body) => {
      runs.push(body.prompt);
    },
  });
  const subscriptions: string[] = [];
  context.mocks.api(pushSubscriptionsContract.register, ({ body, respond }) => {
    subscriptions.push(body.endpoint);
    return respond(201, { success: true });
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();

  await sendText("Notify me when the launch review is complete.");

  await waitFor(() => {
    expect(userTurnCount("Notify me when the launch review is complete.")).toBe(
      1,
    );
  });
  expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe("");
  expect(runs).toStrictEqual(["Notify me when the launch review is complete."]);
  await waitFor(() => {
    expect(subscriptions).toStrictEqual([PUSH_ENDPOINT]);
  });
});

test("Send a large image with Auto", async () => {
  context.mocks.data.availableRunModels([]);
  const sentMessages: (UserMessageDocument | undefined)[] = [];
  const threadModels: unknown[] = [];
  installRunChat({
    selectedModel: null,
    onThreadCreate: (body) => {
      threadModels.push(body.modelSelection);
    },
    onSendRequest: (body) => {
      sentMessages.push(body.userMessage);
    },
  });
  context.mocks.upload.success({
    id: IMAGE_FILE_ID,
    filename: "launch-board.png",
    contentType: "image/png",
    size: 12_000_000,
    url: artifactReferencePath(IMAGE_FILE_ID, "launch-board.png"),
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  selectFile(
    new File([new Uint8Array(12_000_000)], "launch-board.png", {
      type: "image/png",
    }),
  );
  await expect(findButton("Remove launch-board.png")).resolves.toBeVisible();

  await sendText("Review this launch board");

  await waitFor(() => {
    expect(sentMessages).toHaveLength(1);
  });
  // Auto is the only choice, so the composer sends without a model selection.
  expect(threadModels).toStrictEqual([null]);
  expect(sentMessages[0]?.parts).toContainEqual({
    type: "file",
    fileId: IMAGE_FILE_ID,
    filenameSnapshot: "launch-board.png",
    contentType: "image/png",
  });
  await waitFor(() => {
    expect(userTurnCount("Review this launch board")).toBe(1);
  });
});

test("Show follow-up instructions in the active conversation", async () => {
  const queued: (string | undefined)[] = [];
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "plan-request",
        runId: RUN_ID,
        seqId: 1,
        text: "Draft the launch plan",
      }),
      assistantEvent({
        id: "plan-update",
        runId: RUN_ID,
        seqId: 2,
        text: "Launch plan update",
      }),
      promptEvent({
        id: "dates-steer",
        runId: RUN_ID,
        seqId: 3,
        text: "Keep the dates flexible",
      }),
      {
        id: "recap-automation",
        eventType: "input.automation",
        role: "user",
        content: null,
        runId: undefined,
        seqId: 4,
        createdAt: "2026-08-01T10:00:04.000Z",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "launch-recap",
              automationBrief: "Send the launch recap tomorrow",
            },
          ],
        },
      },
    ],
    activeRunIds: [RUN_ID],
    onQueuedEventAppend: (body) => {
      queued.push(body.content);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const automation = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(automation).toHaveTextContent("Send the launch recap tomorrow");

  await sendText("Keep the owner names in the plan.");

  await waitFor(() => {
    expect(queued).toStrictEqual(["Keep the owner names in the plan."]);
  });
  await waitFor(() => {
    expect(userTurnCount("Keep the owner names in the plan.")).toBe(1);
  });
  expectTextOrder(
    "Launch plan update",
    "Keep the dates flexible",
    "Keep the owner names in the plan.",
  );
  expect(
    screen.getByRole("listitem", { name: "Pending automation event" }),
  ).toHaveTextContent("Send the launch recap tomorrow");
  await expect(findButton("Stop")).resolves.toBeVisible();
});
