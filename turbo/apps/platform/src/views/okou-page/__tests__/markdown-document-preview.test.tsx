import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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

test.each([false, true])(
  "Markdown documents preserve heading levels in every preview mode with typography enabled: %s",
  async (typographyEnabled) => {
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

    const orgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    await setupPage({
      context,
      path: `/chats/${ATTACHMENT_THREAD_ID}`,
      auth: {
        user: { id: "markdown-typography-peer", fullName: "Peer" },
        organization: {
          activeOrg: { id: orgId, name: "Staff" },
          memberships: [{ id: orgId }],
        },
      },
      featureSwitches: {
        [FeatureSwitchKey.MarkdownDocumentTypography]: typographyEnabled,
      },
    });
    const chatHeading = await screen.findByRole("heading", {
      level: 1,
      name: "Chat heading",
    });
    click(await findNamedLink("Heading hierarchy"));
    const sidebar = await screen.findByTestId("artifact-sidebar");
    await within(sidebar).findByRole("heading", {
      level: 1,
      name: "Document heading 1",
    });
    expectDocumentHeadings(sidebar);
    click(getNamedButton("Enter fullscreen", sidebar));
    await waitFor(() => {
      expect(getNamedButton("Exit fullscreen", sidebar)).toBeInTheDocument();
    });
    expectDocumentHeadings(sidebar);
    click(getNamedButton("Exit fullscreen", sidebar));
    await waitFor(() => {
      expect(getNamedButton("Enter fullscreen", sidebar)).toBeInTheDocument();
    });
    expect(chatHeading).toBeInTheDocument();
    expect(screen.getByText("Chat body copy.")).toBeInTheDocument();
  },
);
