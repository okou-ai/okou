import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  findNamedLink,
  getNamedButton,
  getNamedLink,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

function installMessage(content: string) {
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "markdown-artifact-message",
        role: "assistant",
        content,
        runId: "markdown-artifact-run",
        runEventId: "markdown-artifact-output",
        sequenceNumber: 1,
        createdAt: "2026-09-07T00:00:00Z",
      },
    ],
  });
}

async function closePreview() {
  click(getNamedButton("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
}

async function setupRepeatedImageMessage(): Promise<string> {
  const url = publicArtifactUrl("evidence.png");
  installMessage(
    [
      `Before [**Key screenshot**](${url}) after.`,
      "",
      `![Embedded screenshot](${url})`,
      "",
      `![Repeated screenshot](${url})`,
      "",
      `- [List screenshot](${url})`,
      "",
      `> [Quoted screenshot](${url})`,
      "",
      "| Evidence | Result |",
      "| --- | --- |",
      `| [Table screenshot](${url}) | Passed |`,
      "",
      "[Reference screenshot][evidence]",
      "",
      `[evidence]: ${url}`,
    ].join("\n"),
  );
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  return url;
}

test("One image keeps distinct labels for every text link", async () => {
  const url = await setupRepeatedImageMessage();
  const link = await findNamedLink("Key screenshot");
  expect(link).toHaveAttribute("href", url);
  expect(link.querySelector("strong")).toHaveTextContent("Key screenshot");
  expect(link.closest("p")).toHaveTextContent("Before Key screenshot after.");
  expect(getNamedLink("List screenshot").closest("li")).toBeVisible();
  expect(getNamedLink("Quoted screenshot").closest("blockquote")).toBeVisible();
  expect(getNamedLink("Table screenshot").closest("td")).toBeVisible();
  expect(getNamedLink("Reference screenshot")).toHaveAttribute("href", url);
  click(link);
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
  await closePreview();
});

test("Repeated images share load state and open an image preview", async () => {
  const url = await setupRepeatedImageMessage();
  const embedded = await screen.findByAltText("Embedded screenshot");
  const repeated = screen.getByAltText("Repeated screenshot");
  expect(screen.getAllByTestId("markdown-image-preview-loading")).toHaveLength(
    2,
  );
  fireEvent.load(embedded);
  expect(screen.queryByTestId("markdown-image-preview-loading")).toBeNull();
  expect(embedded).toBeVisible();
  expect(repeated).toBeVisible();
  const imageAction = embedded.closest("button");
  if (!imageAction) {
    throw new Error("Expected an image preview action");
  }
  click(imageAction);
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
});

test("Artifact links show image, video, and file kinds", async () => {
  const imageUrl = publicArtifactUrl("screenshot.png");
  const videoUrl = publicArtifactUrl("walkthrough.mp4");
  const fileUrl = publicArtifactUrl("report.pdf");
  const externalUrl = "https://media.example.com/reference.png";
  installMessage(
    [
      `[Screenshot](${imageUrl})`,
      `[Walkthrough](${videoUrl})`,
      `[Report](${fileUrl})`,
      `[Reference](${externalUrl})`,
    ].join("\n\n"),
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  expect(
    within(await findNamedLink("Screenshot")).getByTestId(
      "markdown-artifact-link-icon-image",
    ),
  ).toBeVisible();
  expect(
    within(getNamedLink("Walkthrough")).getByTestId(
      "markdown-artifact-link-icon-video",
    ),
  ).toBeVisible();
  expect(
    within(getNamedLink("Report")).getByTestId(
      "markdown-artifact-link-icon-file",
    ),
  ).toBeVisible();
  expect(
    getNamedLink("Reference").querySelector(
      "[data-testid^='markdown-artifact-link-icon-']",
    ),
  ).toBeNull();
});

test("An artifact text link uses the already-open artifacts sidebar", async () => {
  const url = publicArtifactUrl("sidebar-evidence.png");
  installMessage(`[Supporting evidence](${url})`);
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const link = await findNamedLink("Supporting evidence");
  click(getNamedButton("Open artifacts"));
  await expect(
    screen.findByTestId("thread-sidebar-artifacts"),
  ).resolves.toBeVisible();
  click(link);
  await expect(
    screen.findByTestId("artifact-sidebar-body-image"),
  ).resolves.toHaveAttribute("src", url);
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
});

test("Bare platform URLs stay links and fenced URLs stay code", async () => {
  const url = publicArtifactUrl("bare-evidence.png");
  const site = "https://literal-site.sites.vm7.io";
  installMessage(
    ["Evidence URL:", "", url, "", "```text", site, "```"].join("\n"),
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const link = await findNamedLink(url);
  expect(link).toHaveAttribute("href", url);
  const code = screen.getByText(site);
  expect(code.closest("pre")).toBeVisible();
  click(link);
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
});

test("A platform document has both a text link and an explicit preview card", async () => {
  const url = "https://a.okou.io/a1b2c3d4e5.pdf";
  installMessage(
    `Read [the brief](${url}) before approving.\n\n![Brief preview](${url})`,
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const link = await findNamedLink("the brief");
  const card = getNamedLink("Open pdf preview for a1b2c3d4e5.pdf");
  expect(link.closest("p")).toHaveTextContent(
    "Read the brief before approving.",
  );
  expect(card).toBeVisible();
  click(link);
  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTitle("a1b2c3d4e5.pdf preview"),
  ).resolves.toHaveAttribute("src", `${url}#navpanes=0`);
  await closePreview();
  click(card);
  await expect(
    screen.findByTitle("a1b2c3d4e5.pdf preview"),
  ).resolves.toHaveAttribute("src", `${url}#navpanes=0`);
});
