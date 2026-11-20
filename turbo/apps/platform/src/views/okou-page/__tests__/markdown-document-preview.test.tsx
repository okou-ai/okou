import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedLink,
  getNamedButton,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

function expectDocumentHeadings(preview: HTMLElement) {
  const document = within(preview).getByRole("document");
  for (let level = 1; level <= 6; level++) {
    expect(
      within(document).getByRole("heading", {
        level,
        name: `Document heading ${level}`,
      }),
    ).toBeInTheDocument();
  }
  expect(within(document).getByText("Document body copy.")).toBeInTheDocument();
}

test("Markdown documents preserve heading levels in dialog, fullscreen and sidebar previews", async () => {
  const url = publicArtifactUrl("heading-hierarchy.md");
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      [
        ...Array.from({ length: 6 }, (_, index) => {
          const level = index + 1;
          return `${"#".repeat(level)} Document heading ${level}`;
        }),
        "Document body copy.",
      ].join("\n\n"),
    );
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "heading-hierarchy-message",
        role: "assistant",
        content: `# Chat heading\n\nChat body copy.\n\n[Heading hierarchy](${url})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "heading-hierarchy-output",
        sequenceNumber: 1,
        createdAt: "2026-11-20T00:00:00Z",
      },
    ],
    artifacts: [
      artifactFile("heading-hierarchy.md", { contentType: "text/markdown" }),
    ],
  });

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const chatHeading = await screen.findByRole("heading", {
    level: 1,
    name: "Chat heading",
  });
  click(await findNamedLink("Heading hierarchy"));
  const dialog = await screen.findByTestId("attachment-lightbox");
  await within(dialog).findByRole("heading", {
    level: 1,
    name: "Document heading 1",
  });
  expectDocumentHeadings(dialog);

  click(getNamedButton("Enter fullscreen", dialog));
  await waitFor(() => {
    expect(dialog).toHaveAttribute("data-mode", "fullscreen");
  });
  expectDocumentHeadings(dialog);

  click(getNamedButton("Open in split view", dialog));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await within(sidebar).findByRole("heading", {
    level: 1,
    name: "Document heading 1",
  });
  expectDocumentHeadings(sidebar);
  expect(chatHeading).toBeInTheDocument();
  expect(screen.getByText("Chat body copy.")).toBeInTheDocument();
});
