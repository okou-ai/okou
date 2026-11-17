import type { ChatThreadArtifactFile } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedLink,
  getNamedButton,
  getNamedLink,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

function installMessage(
  content: string,
  artifacts?: readonly ChatThreadArtifactFile[],
) {
  mockAttachmentChat(context, {
    artifacts,
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

test("Artifact links show content-specific icons", async () => {
  const artifacts = [
    ["screenshot.png", "image"],
    ["walkthrough.mp4", "video"],
    ["dashboard.html", "website"],
    ["report.pdf", "document"],
    ["brief.docx", "document"],
    ["notes.md", "document"],
    ["readme.txt", "document"],
    ["budget.xlsx", "spreadsheet"],
    ["export.csv", "spreadsheet"],
    ["slides.pptx", "presentation"],
    ["recording.mp3", "audio"],
    ["data.json", "code"],
    ["script.py", "code"],
    ["app.tsx", "code"],
    ["config.yaml", "code"],
    ["assets.zip", "archive"],
    ["backup.7z", "archive"],
    ["attachment.bin", "file"],
  ] as const;
  const externalUrl = "https://media.example.com/reference.png";
  installMessage(
    [
      ...artifacts.map(([filename]) => {
        return `[${filename}](${publicArtifactUrl(filename)})`;
      }),
      `[Reference](${externalUrl})`,
    ].join("\n\n"),
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  await findNamedLink("screenshot.png");
  for (const [filename, iconKind] of artifacts) {
    const link = getNamedLink(filename);
    expect(link).toHaveAttribute("href", publicArtifactUrl(filename));
    expect(
      within(link).getByTestId(`markdown-artifact-link-icon-${iconKind}`),
    ).toBeInTheDocument();
  }
  expect(
    getNamedLink("Reference").querySelector(
      "[data-testid^='markdown-artifact-link-icon-']",
    ),
  ).toBeNull();
});

test("Artifact link icons follow the file rather than its label or URL parameters", async () => {
  const presentationUrl = `${publicArtifactUrl("slides.PPTX")}?download=1#page=2`;
  const dashboardUrl = "/artifacts/a1b2c3d4e5.html";
  installMessage(
    [
      `[Download file](${presentationUrl})`,
      `[Open private dashboard](${dashboardUrl})`,
    ].join("\n\n"),
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  const presentationLink = await findNamedLink("Download file");
  expect(presentationLink).toHaveAttribute("href", presentationUrl);
  expect(
    within(presentationLink).getByTestId(
      "markdown-artifact-link-icon-presentation",
    ),
  ).toBeInTheDocument();
  const dashboardLink = getNamedLink("Open private dashboard");
  expect(dashboardLink).toHaveAttribute("href", dashboardUrl);
  expect(
    within(dashboardLink).getByTestId("markdown-artifact-link-icon-website"),
  ).toBeInTheDocument();
});

test("HTML links keep website icons for presentations and ordinary sites", async () => {
  const hostedDeckUrl = "https://quarterly-deck.sites.vm7.io/";
  const privateDeckUrl = "/artifacts/a1b2c3d4e5.html";
  const websiteUrl = "https://ordinary-site.sites.vm7.io/";
  const unmarkedHtmlUrl = publicArtifactUrl("slides.html");
  const links = [
    ["Quarterly overview", `${hostedDeckUrl}#/2`, "website"],
    ["Private overview", `${privateDeckUrl}#slide-3`, "website"],
    ["Company website", websiteUrl, "website"],
    ["Unmarked HTML", unmarkedHtmlUrl, "website"],
  ] as const;
  installMessage(
    links
      .map(([label, url]) => {
        return `[${label}](${url})`;
      })
      .join("\n\n"),
    [
      artifactFile("index.html", {
        id: "html-presentation",
        url: hostedDeckUrl,
        aliasUrl: privateDeckUrl,
        artifactKind: "presentation-html",
        contentType: "text/html",
      }),
      artifactFile("index.html", {
        id: "html-website",
        url: websiteUrl,
        artifactKind: "hosted-site",
        contentType: "text/html",
      }),
    ],
  );

  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  for (const [label, url, iconKind] of links) {
    const link = await findNamedLink(label);
    await expect(
      within(link).findByTestId(`markdown-artifact-link-icon-${iconKind}`),
    ).resolves.toBeInTheDocument();
    expect(link).toHaveAttribute("href", url);
  }
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
