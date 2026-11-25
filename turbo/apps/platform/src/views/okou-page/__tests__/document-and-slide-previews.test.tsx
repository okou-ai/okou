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
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  deck,
  presentationPart,
  serveDeck,
} from "./template-submission-fixtures.ts";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";

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
  "Markdown documents preserve heading levels in every preview mode with Markdown-first output enabled: %s",
  async (markdownFirstOutputEnabled) => {
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
        [FeatureSwitchKey.MarkdownFirstOutput]: markdownFirstOutputEnabled,
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

async function secondSlide(html: string) {
  serveDeck(context, html);
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: { version: 1, parts: [presentationPart()] },
      draftAttachments: [],
    });
  });
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  const editor = await screen.findByLabelText("Message");
  await waitFor(() => {
    return expect(editor).toHaveTextContent(deck.title);
  });
  click(await findAction("button", "Presentation"));
  click(await findAction("button", "Preview template " + deck.title));
  const modal = await screen.findByRole("dialog");
  await within(modal).findByText("1 / 2");
  const choice = await findAction("button", "Preview slide 2", modal);
  click(choice);
  await within(modal).findByText("2 / 2");
  const frame = within(modal).getByTitle(
    deck.title + " HTML preview",
  ) as HTMLIFrameElement;
  return {
    choice,
    document: new DOMParser().parseFromString(frame.srcdoc, "text/html"),
  };
}

test("presentation-preview-001 selecting the hidden second slide preserves its authored layouts", async () => {
  const { choice, document: doc } = await secondSlide(
    '<section data-okou-slide>Before</section><div class="slide" id="layout" style="display:grid" hidden inert aria-hidden="true"><section data-okou-slide id="later" style="display:flex" hidden inert aria-hidden="true">Forecast</section></div>',
  );
  expect(choice).toHaveAttribute("aria-pressed", "true");
  expect(doc.body).toHaveTextContent("Forecast");
  expect(doc.body).not.toHaveTextContent("Before");
  for (const [id, display] of [
    ["layout", "grid"],
    ["later", "flex"],
  ]) {
    const node = doc.getElementById(id);
    expect(node?.style.display).toBe(display);
    expect(node).not.toHaveAttribute("hidden");
    expect(node).not.toHaveAttribute("inert");
    expect(node).toHaveAttribute("aria-hidden", "false");
  }
});

test("presentation-preview-002 generic slides isolate the selected page and expose editable content", async () => {
  const { document: doc } = await secondSlide(
    '<section class="slide"><h1>Scope</h1></section><section class="slide"><h1>Next steps</h1></section>',
  );
  expect(doc.querySelectorAll(".slide")).toHaveLength(1);
  const heading = doc.querySelector("h1");
  expect(heading).toHaveTextContent("Next steps");
  expect(doc.body).not.toHaveTextContent("Scope");
  expect(heading).toHaveAttribute("data-okou-editor-slide-id", "slide-2");
  expect(heading).toHaveAttribute("data-okou-editor-edit-id");
});
