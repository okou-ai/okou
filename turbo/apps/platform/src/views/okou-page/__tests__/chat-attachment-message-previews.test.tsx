import type {
  ChatThreadArtifactFile,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedMenuItem,
  getNamedButton,
  getNamedLink,
  mockAttachmentChat,
  mockPrivateUrlSequence,
  privateAttachmentUrl,
  publicArtifactUrl,
  userMessage,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const CREATED_AT = "2026-03-10T00:00:01Z";
const PRESENTATION_URL = "https://private-files.example/quarterly-deck.html";

function sentUserMessage(document: UserMessageDocument): AttachmentChatEvent {
  return {
    id: "attachment-user-message",
    role: "user",
    content: null,
    runId: ATTACHMENT_RUN_ID,
    createdAt: CREATED_AT,
    userMessage: document,
  };
}

function filePart(
  fileId: string,
  filenameSnapshot: string,
  contentType: string,
): Extract<UserMessageDocument["parts"][number], { type: "file" }> {
  return { type: "file", fileId, filenameSnapshot, contentType };
}

async function setupPersistedAttachmentMessage(): Promise<void> {
  const specifications = [
    ["private-video", "demo.mp4", "video/mp4"],
    ["private-pdf", "brief.pdf", "application/pdf"],
    ["private-presentation", "quarterly-deck.html", "text/html"],
  ] as const;
  const artifacts: ChatThreadArtifactFile[] = specifications.map(
    ([id, filename, contentType]) => {
      return artifactFile(filename, {
        id,
        contentType,
        url: privateAttachmentUrl(id),
        ...(id === "private-presentation"
          ? { artifactKind: "presentation-html" as const }
          : {}),
      });
    },
  );
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage([
          ...specifications.map(([id, filename, contentType]) => {
            return filePart(id, filename, contentType);
          }),
          { type: "text", text: "Files from the completed review" },
        ]),
      ),
    ],
    artifacts,
  });
  mockPrivateUrlSequence(
    context,
    Object.fromEntries(
      specifications.map(([id, filename]) => {
        return [id, [`https://private-files.example/${filename}`]];
      }),
    ),
  );
  context.mocks.http.get(PRESENTATION_URL, () => {
    return HttpResponse.html("<main>Quarterly presentation</main>");
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await expect(
    screen.findByText("Files from the completed review"),
  ).resolves.toBeVisible();
}

test("Only a complete artifact address becomes a rich preview", async () => {
  const complete = publicArtifactUrl("complete-video.mp4");
  const incomplete = complete.slice(0, complete.lastIndexOf("/"));
  const rootRelative = "/complete-video.mp4";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "attachment-assistant-message",
        role: "assistant",
        content: [
          `Incomplete: ${incomplete}`,
          `Root relative: ${rootRelative}`,
          "Complete:",
          `![Complete video](${complete})`,
        ].join("\n\n"),
        runId: ATTACHMENT_RUN_ID,
        runEventId: "attachment-event-1",
        sequenceNumber: 1,
        createdAt: CREATED_AT,
      },
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const preview = await findNamedButton("Preview complete-video.mp4");
  expect(preview).toBeVisible();
  const message = preview.closest<HTMLElement>('[data-role="assistant"]');
  if (!message) {
    throw new Error("Expected the assistant message containing the preview");
  }
  const previewControls = [
    ...queryAllByRoleFast("button", message),
    ...queryAllByRoleFast("link", message),
  ].filter((control) => {
    return /preview/iu.test(control.getAttribute("aria-label") ?? "");
  });
  expect(previewControls).toStrictEqual([preview]);
  expect(message).toHaveTextContent(`Incomplete: ${incomplete}`);
  expect(message).toHaveTextContent(`Root relative: ${rootRelative}`);
});

test("A persisted video attachment opens in the sidebar and closes from it", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Preview demo.mp4"));
  await expect(
    screen.findByLabelText("Video preview for demo.mp4"),
  ).resolves.toBeVisible();
  click(getNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByTestId("artifact-sidebar-body-video"),
  ).resolves.toBeVisible();

  click(getNamedButton("Close artifact", sidebar));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar-body-video")).toBeNull();
  });
});

test("A persisted PDF attachment opens in the document sidebar and closes from it", async () => {
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open pdf preview for brief.pdf"));
  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByTestId("artifact-sidebar-body-pdf"),
  ).resolves.toBeVisible();

  click(getNamedButton("Close artifact", sidebar));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar-body-pdf")).toBeNull();
  });
});

test("A persisted presentation keeps its file through fullscreen and downloads once", async () => {
  const browser = context.mocks.browser.blobDownload();
  await setupPersistedAttachmentMessage();

  click(getNamedButton("Open html preview for quarterly-deck.html"));
  const preview = await screen.findByTestId("attachment-lightbox");
  const expectPresentation = () => {
    const frame = within(preview).getByTitle("quarterly-deck.html preview");
    expect(frame).toHaveAttribute("src", PRESENTATION_URL);
    expect(
      within(preview).getByTestId("presentation-artifact-viewport"),
    ).toContainElement(frame);
  };
  await waitFor(expectPresentation);

  click(getNamedButton("Enter fullscreen", preview));
  await findNamedButton("Exit fullscreen", preview);
  expectPresentation();
  click(getNamedButton("Exit fullscreen", preview));
  await findNamedButton("Enter fullscreen", preview);
  expectPresentation();

  click(getNamedButton("Download options", preview));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    expect(browser.downloads).toMatchObject([
      { filename: "quarterly-deck.html" },
    ]);
  });
});

test("A Slack-originated message keeps its source link and renders its Markdown attachment", async () => {
  const fileId = "slack-review-markdown";
  const resolvedUrl = "https://private-files.example/slack-review.md";
  const slackMessage = "https://acme.slack.com/archives/C123/p1712345678000100";
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage([
          { type: "source", kind: "slack", href: slackMessage },
          filePart(fileId, "slack-review.md", "text/markdown"),
          { type: "text", text: "Please review the launch notes" },
        ]),
      ),
    ],
    artifacts: [
      artifactFile("slack-review.md", {
        id: fileId,
        contentType: "text/markdown",
        url: privateAttachmentUrl(fileId),
      }),
    ],
  });
  mockPrivateUrlSequence(context, { [fileId]: [resolvedUrl] });
  context.mocks.http.get(resolvedUrl, () => {
    return HttpResponse.text(
      "# Slack launch review\n\nThe attachment is intact.",
    );
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await expect(
    screen.findByText("Please review the launch notes"),
  ).resolves.toBeVisible();
  expect(getNamedLink("Open original message in Slack")).toHaveAttribute(
    "href",
    slackMessage,
  );

  click(getNamedButton("Open markdown preview for slack-review.md"));
  const preview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(preview).findByRole("heading", { name: "Slack launch review" }),
  ).resolves.toBeVisible();
  expect(within(preview).getByText("The attachment is intact.")).toBeVisible();
});

test("A Lark image stored as a binary object shows a thumbnail and opens its original", async () => {
  const fileId = "lark-image";
  const originalUrl =
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/artifacts/lark-image.bin` +
    "?X-Amz-Signature=image-signature";
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage([
          {
            type: "source",
            kind: "feishu",
            href: "https://applink.larksuite.com/client/chat/open?chatId=chat-1",
          },
          filePart(fileId, "image", "image/jpeg"),
          { type: "text", text: "Describe this image" },
        ]),
      ),
    ],
  });
  mockPrivateUrlSequence(context, { [fileId]: [originalUrl] });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const thumbnail = await screen.findByAltText("image");
  expect(thumbnail).toHaveAttribute(
    "src",
    `https://cdn.vm7.io/cdn-cgi/image/width=800,height=720,fit=scale-down,format=auto,quality=85,metadata=none/${originalUrl}`,
  );
  const open = thumbnail.closest<HTMLElement>("a, button");
  if (!open) {
    throw new Error("Expected the image thumbnail to open its preview");
  }
  click(open);
  const preview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(preview).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", originalUrl);
});

test("User media and file attachments appear in order before their message text", async () => {
  const files = [
    ["ordered-image", "compact.png", "image/png"],
    ["ordered-video", "compact.mp4", "video/mp4"],
    ["ordered-pdf", "details.pdf", "application/pdf"],
    ["ordered-text", "details.txt", "text/plain"],
  ] as const;
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(
        userMessage([
          ...files.map(([id, filename, contentType]) => {
            return filePart(id, filename, contentType);
          }),
          { type: "text", text: "Original message beneath the files" },
        ]),
      ),
    ],
    artifacts: files.map(([id, filename, contentType]) => {
      return artifactFile(filename, {
        id,
        contentType,
        url: privateAttachmentUrl(id),
      });
    }),
  });
  mockPrivateUrlSequence(
    context,
    Object.fromEntries(
      files.map(([id, filename]) => {
        return [id, [`https://private-files.example/${filename}`]];
      }),
    ),
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const text = await screen.findByText("Original message beneath the files");
  const bubble = text.closest<HTMLElement>('[data-slot="chat-user-message"]');
  if (!bubble) {
    throw new Error("Expected the message text bubble");
  }
  const media = screen.getByTestId("message-media-attachments");
  const documents = screen.getByTestId("message-file-attachments");
  expect(media).toContainElement(getNamedLink("Preview compact.png"));
  expect(media).toContainElement(getNamedButton("Preview compact.mp4"));
  expect(documents).toContainElement(
    getNamedButton("Open pdf preview for details.pdf"),
  );
  expect(documents).toContainElement(
    getNamedButton("Open text preview for details.txt"),
  );
  expect(media.compareDocumentPosition(documents)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(documents.compareDocumentPosition(bubble)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("A user's Markdown image syntax stays literal with a linked destination", async () => {
  const url = "https://cdn.vm7.io/artifacts/tests/chat-attachments/chart.png";
  const markdown = `![quarterly chart](${url})`;
  mockAttachmentChat(context, {
    chatEvents: [
      sentUserMessage(userMessage([{ type: "text", text: markdown }])),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const message = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-role="user"]');
    if (!element?.textContent?.includes(markdown)) {
      throw new Error("Expected the literal Markdown in the user message");
    }
    return element;
  });
  expect(message).toBeVisible();
  const link = queryAllByRoleFast("link", message).find((candidate) => {
    return candidate.getAttribute("href") === url;
  });
  expect(link).toBeVisible();
  expect(message.querySelector("img")).toBeNull();
  expect(
    message.querySelector('[data-testid^="attachment-preview-"]'),
  ).toBeNull();
});
