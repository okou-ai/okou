import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import { fireEvent, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import {
  closeModelPanel,
  findModelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";
import {
  createChatRunFixtures,
  findButton,
  NEW_CHAT_PATH,
  readyChat,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const BRIEF_FILE_ID = "e0000000-0000-4000-a000-000000000de1";

test("A new message keeps its attachment, text, and selected model together", async () => {
  const sendRequest: {
    latest: { prompt: string; userMessage?: UserMessageDocument } | null;
  } = { latest: null };
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    ["gpt-6-luna", "claude-sonnet-5"].map((model) => {
      return buildRunModel({ model });
    }),
  );
  installRunChat({
    selectedModel: null,
    onSendRequest: (body) => {
      sendRequest.latest = {
        prompt: body.prompt,
        userMessage: body.userMessage,
      };
    },
  });
  context.mocks.upload.success({
    id: BRIEF_FILE_ID,
    filename: "brief.txt",
    contentType: "text/plain",
    size: 512,
    url: artifactReferencePath(BRIEF_FILE_ID, "brief.txt"),
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  const models = await openModelPanel("Auto");
  click(await findModelOption("GPT 6 Luna", models));
  await closeModelPanel();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  fireEvent.change(input as HTMLInputElement, {
    target: {
      files: [
        new File(["Launch on Monday."], "brief.txt", { type: "text/plain" }),
      ],
    },
  });
  await expect(findButton("Remove brief.txt")).resolves.toBeVisible();

  await sendText("Review the launch brief.");

  await waitFor(() => {
    expect(sendRequest.latest?.prompt).toBe("Review the launch brief.");
  });
  expect(sendRequest.latest?.userMessage?.parts).toMatchObject([
    {
      type: "file",
      fileId: BRIEF_FILE_ID,
      filenameSnapshot: "brief.txt",
      contentType: "text/plain",
    },
    { type: "text", text: "Review the launch brief." },
    { type: "model", selectedModel: "gpt-6-luna" },
  ]);
});
