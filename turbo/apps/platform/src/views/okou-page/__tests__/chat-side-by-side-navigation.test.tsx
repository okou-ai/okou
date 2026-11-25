import { test, expect } from "vitest";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  assistantRow,
  conversation,
  attachment,
  userRow,
  fileParts,
  serveUploaded,
} from "./attachment-preview-boundaries.ts";
import {
  findAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
import {
  artifactSummary,
  hostedSiteArtifactDetail,
  fileArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import {
  ATTACHMENT_THREAD_ID,
  findNamedButton,
  getNamedButton,
  mockAttachmentChat,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

test.each([
  ["chat-navigation-artifact-sidebar-002", "docx"],
  ["chat-navigation-artifact-sidebar-003", "pptx"],
  ["chat-navigation-artifact-sidebar-004", "xlsx"],
] as const)(
  "%s preserves the Office viewer source when moving the generated file to the sidebar",
  async (_id, ext) => {
    const url = "https://cdn.okou.io/artifacts/field/outputs/brief." + ext;
    await conversation(context, {
      chatEvents: [assistantRow("[Generated brief](" + url + ")")],
    });
    click(await findAction("link", "Generated brief"));
    const dialog = await screen.findByTestId("artifact-sidebar");
    const frame = await within(dialog).findByTitle("brief." + ext + " preview");
    expect(frame).toBeVisible();
    const viewer = new URL(frame.getAttribute("src")!);
    expect(viewer.origin + viewer.pathname).toBe(
      "https://view.officeapps.live.com/op/embed.aspx",
    );
    expect(viewer.searchParams.get("src")).toBe(url);
    expect(frame.tagName).toBe("IFRAME");
    expect(
      Number(frame.getAttribute("tabindex") ?? "0"),
    ).toBeGreaterThanOrEqual(0);
    expect(frame.closest("[inert]")).toBeNull();
    frame.focus();
    expect(frame).toHaveFocus();
  },
);
test("chat-navigation-artifact-sidebar-007 the embedded thumbnail transforms the public image but opens its original", async () => {
  const url = "https://a.okou.io/a1b2c3d4e5.png";
  await conversation(context, {
    chatEvents: [assistantRow("![Lookout](" + url + ")")],
  });
  const img = await screen.findByAltText("Lookout");
  const source = new URL(img.getAttribute("src")!);
  expect(source.origin + source.pathname).toBe(url);
  expect(Object.fromEntries(source.searchParams)).toMatchObject({
    thumbnail: "1",
    width: "800",
    height: "720",
    fit: "scale-down",
    quality: "85",
  });
  fireEvent.load(img);
  click(img);
  const dialog = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(dialog.querySelector("img")).toHaveAttribute("src", url);
  });
});
const launchUrl = "https://summit.okou.app/";
const title = "Launch dashboard";
async function loadCatalog(mobile = false) {
  const item = artifactSummary(crypto.randomUUID(), "hosted-site", title);
  const details = hostedSiteArtifactDetail(item, {
    slug: "summit",
    siteId: crypto.randomUUID(),
    url: launchUrl,
  });
  if (mobile) {
    context.mocks.browser.matchMedia((q) => {
      return q.includes("standalone") || q.includes("max-width");
    });
  }
  context.mocks.api(hostContract.sitePreview, ({ respond }) => {
    return respond(200, { url: launchUrl, expiresAt: null });
  });
  mockArtifactConversation(context, {
    catalog: [item],
    details: new Map([[item.id, details]]),
  });
  await setupPage({
    context,
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
  });
}
test("chat-navigation-artifact-sidebar-011 fullscreen and list navigation keep the hosted site address", async () => {
  await loadCatalog();
  await openResourceArtifact(title);
  async function preview() {
    const side = await screen.findByTestId("artifact-sidebar");
    const frame = await within(side).findByTitle(title + " preview");
    expect(frame).toBeVisible();
    expect(frame.getAttribute("src")).toBe(launchUrl);
    return side;
  }
  const side = await preview();
  click(await findAction("button", "Back to all artifacts", side));
  const list = await screen.findByTestId("thread-sidebar-fullscreen-toggle");
  click(list);
  await expect(findAction("button", "Exit fullscreen")).resolves.toBeVisible();
  click(list);
  click((await screen.findByText(title)).closest("button")!);
  const reopened = await preview();
  click(await findAction("button", "Enter fullscreen", reopened));
  await preview();
  click(await findAction("button", "Exit fullscreen", reopened));
  await preview();
  click(await findAction("button", "Close artifact", reopened));
  await waitFor(() => {
    return expect(reopened).not.toBeInTheDocument();
  });
  await expect(
    findAction("button", "Artifacts and chats"),
  ).resolves.toBeVisible();
});
test("chat-navigation-artifact-sidebar-013 a standalone mobile reader follows Back to chats from the site", async () => {
  await loadCatalog(true);
  await openResourceArtifact(title);
  const side = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(side.querySelector("iframe")?.src).toBe(launchUrl);
  });
  const back = await findAction("link", "Back to chats");
  const destination = new URL(back.getAttribute("href")!, location.href);
  click(back);
  await waitFor(() => {
    return expect(location.pathname).toBe(destination.pathname);
  });
  await waitFor(() => {
    return expect(side).not.toBeInTheDocument();
  });
  expect(screen.queryByTitle(/Launch dashboard preview/i)).toBeNull();
  await expect(
    screen.findByRole("navigation", { name: "Main navigation" }),
  ).resolves.toBeVisible();
});
test("chat-navigation-artifact-sidebar-014 the resources dialog lists the release notes for this thread", async () => {
  const item = artifactSummary(crypto.randomUUID(), "file", "Release notes");
  const other = artifactSummary(
    crypto.randomUUID(),
    "file",
    "Earlier project notes",
  );
  mockArtifactConversation(context, { catalog: [] });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts:
        query.chatThreadId === NAVIGATION_ARTIFACT_THREAD_ID ? [item] : [other],
      nextCursor: null,
    });
  });
  await setupPage({ context, path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID });
  click(await findAction("button", "Artifacts and chats"));
  const list = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  await expect(within(list).findByText(item.title)).resolves.toBeVisible();
  expect(list).not.toHaveTextContent(other.title);
});
test("chat-navigation-artifact-sidebar-010 an expanded diagram owns its image while fullscreen keeps the source open", async () => {
  const browser = context.mocks.browser.blobDownload(),
    url = "https://cdn.okou.io/artifacts/field/document/deployment.md";
  const item = artifactSummary(crypto.randomUUID(), "file", "Deployment flow");
  const file = fileArtifactDetail(item, {
    fileId: crypto.randomUUID(),
    filename: "deployment.md",
    contentType: "text/markdown",
    url,
  });
  mockArtifactConversation(context, {
    catalog: [item],
    details: new Map([[item.id, file]]),
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Deployment flow\n\n```mermaid\nflowchart TD\nBuild-->Release\n```",
    );
  });
  await setupPage({
    context,
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
  });
  await openResourceArtifact(item.title);
  const side = await screen.findByTestId("artifact-sidebar");
  click(await findAction("button", "Enter fullscreen", side));
  click(await within(side).findByText("Diagram source"));
  const source = side.querySelector("details")!;
  expect(source.open).toBeTruthy();
  const inline = await within(side).findByRole("img", { name: "Diagram" });
  const original = inline.getAttribute("src")!;
  const expand = await findAction("button", "Expand diagram", side);
  click(expand);
  const layer = await screen.findByTestId("artifact-diagram-lightbox");
  const image = await within(layer).findByRole("img");
  const enlarged = image.getAttribute("src")!;
  expect(enlarged).not.toBe(original);
  const svg = browser.blobForUrl(original);
  expect(svg).toBeTruthy();
  await expect(browser.blobForUrl(enlarged)?.text()).resolves.toBe(
    await svg!.text(),
  );
  click(await findAction("button", "Close", layer));
  await waitFor(() => {
    return expect(browser.revokedUrls).toContain(enlarged);
  });
  expect(browser.revokedUrls).not.toContain(original);
  await waitFor(() => {
    return expect(expand).toHaveFocus();
  });
  expect(source.open).toBeTruthy();
  await expect(
    findAction("button", "Exit fullscreen", side),
  ).resolves.toBeVisible();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(within(side).getByRole("document")).toHaveFocus();
  });
  await expect(
    findAction("button", "Exit fullscreen", side),
  ).resolves.toBeVisible();
});

const { installCapabilityChat } = createChatCapabilityHelpers(context);
const DELETED_ID = "a0000000-0000-4000-a000-000000000e21";
const RECONNECT_ID = "a0000000-0000-4000-a000-000000000e22";
const TIMESTAMP = "2026-11-21T10:00:00.000Z";

function gmailDraft(overrides: Partial<MailDraft>): MailDraft {
  return {
    provider: "gmail",
    version: 3,
    gmailDraftId: "draft-access",
    gmailThreadId: "thread-access",
    gmailMessageId: "message-access",
    status: "draft",
    detailAvailable: true,
    from: "auditor@example.com",
    to: ["security@example.com"],
    cc: [],
    bcc: [],
    references: [],
    attachments: [],
    subject: "Untitled",
    body: "",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  } as MailDraft;
}

test("Explain unavailable email cards in a conversation", async () => {
  const drafts = new Map<string, MailDraft>([
    [
      DELETED_ID,
      gmailDraft({
        status: "deleted",
        detailAvailable: false,
        subject: "Vendor contract follow-up",
      }),
    ],
    [
      RECONNECT_ID,
      gmailDraft({
        subject: "Quarterly access review",
        accessStatus: "reconnect",
        reconnectConnectionId: "e0000000-0000-4000-a000-000000000e23",
      }),
    ],
  ]);
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    const draft = drafts.get(params.mailDraftId);
    if (!draft) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Mail draft not found" },
      });
    }
    return respond(200, {
      mailDraftId: params.mailDraftId,
      mailDraftUrl: `https://app.okou.ai/mail/drafts/${params.mailDraftId}`,
      mailDraft: draft,
    });
  });
  installCapabilityChat({
    events: completedConversation(
      [
        "Both emails from earlier:",
        "",
        `https://app.okou.ai/mail/drafts/${DELETED_ID}`,
        "",
        `https://app.okou.ai/mail/drafts/${RECONNECT_ID}`,
      ].join("\n"),
    ),
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const deleted = await waitFor(() => {
    const card = document.querySelector<HTMLElement>(
      '[aria-label="Deleted email: Vendor contract follow-up"]',
    );
    expect(card).toBeInTheDocument();
    return card as HTMLElement;
  });
  expect(deleted).toBeVisible();
  expect(deleted).toHaveAttribute("aria-disabled", "true");
  expect(deleted).toHaveTextContent("Deleted");
  const reconnect = await waitFor(() => {
    const card = queryAllByRoleFast("button").find((button) => {
      return (
        button.getAttribute("aria-label") ===
        "Reconnect Gmail to access email: Quarterly access review"
      );
    });
    expect(card).toBeDefined();
    return card as HTMLElement;
  });
  expect(reconnect).toHaveTextContent("Need reconnect");
});

test("chat-artifact-sidebar-preview-001 reopening a PDF directly restores the sidebar document", async () => {
  const url = "https://cdn.okou.io/artifacts/review/session/estimate.pdf";
  await conversation(context, {
    chatEvents: [assistantRow("[Estimate](" + url + ")")],
  });
  const open = await findAction("link", "Estimate");
  expect(screen.queryByTestId("artifact-sidebar")).toBeNull();
  click(open);
  const side = await screen.findByTestId("artifact-sidebar");
  const frame = await within(side).findByTitle("estimate.pdf preview");
  expect(frame.getAttribute("src")).toContain(url);
  expect(frame.getAttribute("src")).toContain("navpanes=0");
  click(await findAction("button", "Close artifact", side));
  await waitFor(() => {
    return expect(side).not.toBeInTheDocument();
  });
  click(open);
  const reopened = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(reopened).findByTitle("estimate.pdf preview"),
  ).resolves.toHaveAttribute("src", frame.getAttribute("src"));
  expect(screen.queryByTestId("attachment-lightbox-panel")).toBeNull();
});

test("chat-artifact-sidebar-preview-002 a private uploaded text file opens its content in the sidebar", async () => {
  const file = attachment("upload.txt", "text/plain");
  serveUploaded(context, [file]);
  context.mocks.http.get(file.url.split("?")[0], () => {
    return HttpResponse.text("Only the expedition team has this file.");
  });
  await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
  click(await findAction("button", "Open text preview for upload.txt"));
  const side = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(side).findByText("Only the expedition team has this file."),
  ).resolves.toBeVisible();
  expect(queryAction("button", "Share artifact", side)).toBeNull();
  expect(queryAction("button", "Share", side)).toBeNull();
  expect(screen.queryByTestId("attachment-lightbox-panel")).toBeNull();
});

test("chat-artifact-sidebar-preview-003 the CSV sidebar preserves repeated records and quoted fields", async () => {
  const file = attachment("observations.csv", "text/csv");
  serveUploaded(context, [file]);
  const record = '"East, West","Line one\nLine two","She said ""go""",';
  context.mocks.http.get(file.url.split("?")[0], () => {
    return HttpResponse.text(
      ["Area,Notes,Quote,Spare", record, record].join("\r\n"),
    );
  });
  await conversation(context, { chatEvents: [userRow(fileParts([file]))] });
  click(await findAction("button", "Open csv preview for observations.csv"));
  const side = await screen.findByTestId("artifact-sidebar");
  const table = await within(side).findByRole("table");
  const data = Array.from(table.querySelectorAll("tbody tr"), (row) => {
    return Array.from(row.querySelectorAll("td"), (cell) => {
      return cell.textContent;
    });
  });
  const expected = ["East, West", "Line one\nLine two", 'She said "go"', ""];
  expect(data).toStrictEqual([expected, expected]);
});

async function preview(filename: string, body: string, totalBytes?: number) {
  const id = "export-" + filename;
  const url = "https://files.example.org/private/" + filename;
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    if (query.file_id !== id) {
      return respond(404, {
        error: { code: "FILE_NOT_FOUND", message: "Unknown export" },
      });
    }
    return respond(200, {
      url,
      downloadUrl: url + "?download=1",
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  context.mocks.http.get(url, () => {
    return new HttpResponse(body, {
      status: totalBytes === undefined ? 200 : 206,
      headers: {
        "Content-Type": "application/json",
        ...(totalBytes === undefined
          ? {}
          : { "Content-Range": `bytes 0-${body.length - 1}/${totalBytes}` }),
      },
    });
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: null,
        createdAt: "2026-10-09T11:00:00Z",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Inspect export" },
            {
              type: "file",
              fileId: id,
              filenameSnapshot: filename,
              contentType: "application/json",
            },
          ],
        },
      },
    ],
  });
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
  });
  const turn = (await screen.findByText("Inspect export")).closest<HTMLElement>(
    "[data-role=user]",
  )!;
  click(within(turn).getByText(filename));
  const panel = await screen.findByTestId("artifact-sidebar");
  return await within(panel).findByTestId("json-preview");
}

test("chat-json-preview-001 reads the nested ledger number and empty object, then the original private file", async () => {
  const body =
    '{\n  "items": [{"ledger":9223372036854775807,"overrides":{}}]\n}';
  const viewer = await preview("balances.json", body);
  click(await findNamedButton('Expand "items"', viewer));
  click(await findNamedButton("Expand [0]", viewer));
  const ledger = await within(viewer).findByText('"ledger"');
  expect(ledger.parentElement).toHaveTextContent(
    '"ledger": 9223372036854775807',
  );
  expect(
    within(viewer).getByText('"overrides"').parentElement,
  ).toHaveTextContent('"overrides": {}');
  click(getNamedButton("Source", viewer));
  const source = await within(viewer).findByText((_, element) => {
    return element?.tagName === "PRE" && element.textContent === body;
  });
  expect(source).toBeInTheDocument();
});

test("chat-json-preview-003 discloses a partial response even when the received export parses", async () => {
  const prefix = '{"account":"reserve","closed":true}';
  const viewer = await preview("reserve.json", prefix, 8400);
  const notice = await within(viewer).findByRole("status");
  expect(notice).toHaveTextContent("Only part of this file is loaded");
  expect(getNamedButton("Tree", viewer)).toBeDisabled();
  expect(
    within(viewer).getByText(prefix, { selector: "pre" }),
  ).toBeInTheDocument();
});
