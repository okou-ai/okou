import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  findNamedLink,
  getNamedLink,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

async function openMessage(content: string) {
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
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
}

test("Every text link to one image keeps its own label and context", async () => {
  const url = publicArtifactUrl("evidence.png");
  await openMessage(
    [
      `Before [**Key screenshot**](${url}) after.`,
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

  const key = await findNamedLink("Key screenshot");
  expect(key.querySelector("strong")).toHaveTextContent("Key screenshot");
  expect(key.closest("p")).toHaveTextContent("Before Key screenshot after.");
  const list = getNamedLink("List screenshot");
  expect(list.closest("li")).toBeVisible();
  const quoted = getNamedLink("Quoted screenshot");
  expect(quoted.closest("blockquote")).toBeVisible();
  const table = getNamedLink("Table screenshot");
  expect(table.closest("td")).toBeVisible();
  const reference = getNamedLink("Reference screenshot");
  for (const link of [key, list, quoted, table, reference]) {
    expect(link).toHaveAttribute("href", url);
  }

  click(key);

  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
});

test("Artifact links show icons for their file content", async () => {
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

  await openMessage(
    [
      ...artifacts.map(([filename]) => {
        return `[${filename}](${publicArtifactUrl(filename)})`;
      }),
      `[Reference](${externalUrl})`,
    ].join("\n\n"),
  );

  await findNamedLink("screenshot.png");
  for (const [filename, iconKind] of artifacts) {
    const link = getNamedLink(filename);
    expect(
      within(link).getByTestId(`markdown-artifact-link-icon-${iconKind}`),
    ).toBeInTheDocument();
  }
  const reference = getNamedLink("Reference");
  expect(
    reference.querySelector("[data-testid^='markdown-artifact-link-icon-']"),
  ).toBeNull();
});

test("Artifact link icons follow the file rather than its label or URL parameters", async () => {
  const presentationUrl = `${publicArtifactUrl("slides.PPTX")}?download=1#page=2`;
  const dashboardUrl = "/artifacts/a1b2c3d4e5.html";

  await openMessage(
    [
      `[Download file](${presentationUrl})`,
      `[Open private dashboard](${dashboardUrl})`,
    ].join("\n\n"),
  );

  const presentation = await findNamedLink("Download file");
  expect(presentation).toHaveAttribute("href", presentationUrl);
  expect(
    within(presentation).getByTestId(
      "markdown-artifact-link-icon-presentation",
    ),
  ).toBeInTheDocument();
  const dashboard = getNamedLink("Open private dashboard");
  expect(dashboard).toHaveAttribute("href", dashboardUrl);
  expect(
    within(dashboard).getByTestId("markdown-artifact-link-icon-website"),
  ).toBeInTheDocument();
});

test("A bare platform URL stays a link while a fenced URL stays code", async () => {
  const url = publicArtifactUrl("bare-evidence.png");
  const site = "https://literal-site.sites.vm7.io";
  await openMessage(
    ["Evidence URL:", "", url, "", "```text", site, "```"].join("\n"),
  );

  const link = await findNamedLink(url);
  expect(link).toHaveAttribute("href", url);
  const code = screen.getByText(site);
  expect(code.closest("pre")).toBeVisible();
  expect(code.closest("a")).toBeNull();

  click(link);

  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", url);
});
