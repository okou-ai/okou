import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000811";
const UPLOAD_ID = "b0000000-0000-4000-a000-000000000812";
const ACTIVE_RUN_ID = "d0000000-0000-4000-a000-000000000811";

function buttonsNamed(name: string): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return (
      button.getAttribute("aria-label") === name ||
      button.textContent?.trim() === name
    );
  });
}

function requiredButtonNamed(name: string): HTMLElement {
  const button = buttonsNamed(name)[0];
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

test("A follow-up during an active run appears immediately", async () => {
  const followup = "请继续检查发布计划，并确认所有风险项。";
  const appendDeferred = context.mocks.deferred<void>();
  const submittedFollowups: string[] = [];
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [ACTIVE_RUN_ID],
    appendGate: appendDeferred.promise,
    chatEvents: [
      {
        id: "b0000000-0000-4000-a000-000000000813",
        role: "user",
        content: "Prepare the release plan",
        runId: ACTIVE_RUN_ID,
        createdAt: "2026-08-01T10:00:00Z",
      },
      {
        id: "b0000000-0000-4000-a000-000000000814",
        role: "assistant",
        content: "I am reviewing the dependencies.",
        runId: ACTIVE_RUN_ID,
        createdAt: "2026-08-01T10:00:01Z",
      },
    ],
    onQueuedEventAppend: (body) => {
      if (body.content !== undefined) {
        submittedFollowups.push(body.content);
      }
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText("I am reviewing the dependencies.");
  await waitFor(() => {
    expect(buttonsNamed("Stop").length).toBeGreaterThan(0);
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });

  await fill(composer, followup);
  await waitFor(() => {
    expect(requiredButtonNamed("Send")).toBeEnabled();
  });
  click(requiredButtonNamed("Send"));

  await waitFor(() => {
    const userMessages = Array.from(
      document.querySelectorAll<HTMLElement>('[data-role="user"]'),
    );
    expect(
      userMessages.some((message) => {
        return message.textContent?.includes(followup) ?? false;
      }),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "",
    );
    expect(submittedFollowups).toStrictEqual([followup]);
  });
  expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
  appendDeferred.resolve(undefined);
});

test("A new message keeps its attachment, text, and selected model together", async () => {
  const sentRequests: {
    readonly prompt: string;
    readonly userMessage?: UserMessageDocument;
  }[] = [];
  context.mocks.data.userModelPreference({
    selectedModel: "deepseek-v4.1-flash",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    selectedVideoModel: null,
    updatedAt: "2026-08-01T09:00:00Z",
  });
  context.mocks.upload.success({
    id: UPLOAD_ID,
    filename: "brief.txt",
    contentType: "text/plain",
    size: 24,
    url: "https://cdn.vm0.io/artifacts/test/brief.txt",
  });
  mockChatLifecycle(context, {
    onSendRequest: (body) => {
      sentRequests.push({
        prompt: body.prompt,
        userMessage: body.userMessage,
      });
    },
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    host: "app.okou.ai",
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(buttonsNamed("Attach").length).toBeGreaterThan(0);
  });
  await screen.findByText("DeepSeek V4.1 Flash");
  const fileInput = document.querySelector('input[type="file"]');
  if (!(fileInput instanceof HTMLInputElement)) {
    throw new Error("Composer file input is not mounted");
  }

  const user = userEvent.setup({ delay: null });
  await user.upload(
    fileInput,
    new File(["Launch brief contents"], "brief.txt", { type: "text/plain" }),
  );
  await screen.findByText("brief.txt");
  await fill(composer, "Review the launch brief.");
  await waitFor(() => {
    expect(requiredButtonNamed("Send")).toBeEnabled();
  });
  click(requiredButtonNamed("Send"));

  await waitFor(() => {
    expect(sentRequests).toHaveLength(1);
  });
  expect(sentRequests[0]).toStrictEqual({
    prompt: "Review the launch brief.",
    userMessage: {
      version: 1,
      parts: [
        {
          type: "file",
          fileId: UPLOAD_ID,
          filenameSnapshot: "brief.txt",
          contentType: "text/plain",
        },
        { type: "text", text: "Review the launch brief." },
        { type: "model", selectedModel: "deepseek-v4.1-flash" },
      ],
    },
  });
});
