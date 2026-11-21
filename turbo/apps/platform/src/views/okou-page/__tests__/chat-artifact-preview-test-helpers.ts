import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  findNamedLink,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

export const chatPath = "/chats/" + ATTACHMENT_THREAD_ID;

export async function openMessageFile(
  context: TestContext,
  file: ChatThreadArtifactFile,
  {
    host = "localhost",
    groupedActions = false,
    relatedFiles = [],
  }: {
    host?: string;
    groupedActions?: boolean;
    relatedFiles?: readonly ChatThreadArtifactFile[];
  } = {},
) {
  mockAttachmentChat(context, {
    artifacts: [file, ...relatedFiles],
    chatEvents: [
      {
        role: "assistant",
        content: [
          `[Inspect attachment](${file.url})`,
          ...relatedFiles.map((f) => {
            return `[${f.filename}](${f.url})`;
          }),
        ].join("\n\n"),
        createdAt: "2026-03-11T08:30:00Z",
        runId: ATTACHMENT_RUN_ID,
        runEventId: "deliverable",
        sequenceNumber: 1,
      },
    ],
  });
  await setupPage({
    context,
    host,
    path: chatPath,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: false,
      [FeatureSwitchKey.ArtifactPreviewActionGroup]: groupedActions,
    },
  });
  click(await findNamedLink("Inspect attachment"));
  return await screen.findByRole("dialog", {
    name: (file.title ?? file.filename) + " preview",
  });
}
