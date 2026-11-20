import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  draftAttachment,
  draftForAttachment,
  mockAttachmentChat,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();

test("Recover saved draft attachments safely", async () => {
  const fileId = "e0000000-0000-4000-a000-000000000da1";
  const resolvedUrl = "https://files.example.test/uploads/brief-cover.png";
  mockAttachmentChat(context, {
    draft: draftForAttachment(
      draftAttachment("brief-cover.png", {
        id: fileId,
        url: privateAttachmentUrl(fileId),
      }),
      "Review the available brief",
    ),
  });
  // The saved upload still resolves, so the attachment is available.
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    expect(query.file_id).toBe(fileId);
    return respond(200, {
      url: resolvedUrl,
      downloadUrl: `${resolvedUrl}?download=1`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await expect(findComposerEditor()).resolves.toHaveTextContent(
    "Review the available brief",
  );
  const preview = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return (
        candidate.getAttribute("aria-label") ===
        "Open image preview for brief-cover.png"
      );
    });
    expect(button?.querySelector("img")).toHaveAttribute("src", resolvedUrl);
    return button;
  });
  expect(preview).toBeEnabled();
  expect(screen.queryByText(/is no longer available/u)).not.toBeInTheDocument();
});
