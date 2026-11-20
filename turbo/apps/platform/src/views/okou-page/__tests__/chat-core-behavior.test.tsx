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

const UPLOAD_ID = "b0000000-0000-4000-a000-000000000812";

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

test("A new message keeps its attachment, text, and selected model together", async () => {
  const sentRequests: {
    readonly prompt: string;
    readonly userMessage?: UserMessageDocument;
  }[] = [];
  context.mocks.data.personalModelProviders([
    {
      id: "00000000-0000-4000-a000-000000000811",
      type: "codex-oauth-token",
      framework: "codex",
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2026-08-01T09:00:00Z",
      updatedAt: "2026-08-01T09:00:00Z",
    },
  ]);
  context.mocks.data.userModelPreference({
    selectedModel: "gpt-6-luna",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
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
    expect(screen.getByLabelText("Attach")).toBeInTheDocument();
  });
  await screen.findByText("GPT 6 Luna");
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
        { type: "model", selectedModel: "gpt-6-luna" },
      ],
    },
  });
});
