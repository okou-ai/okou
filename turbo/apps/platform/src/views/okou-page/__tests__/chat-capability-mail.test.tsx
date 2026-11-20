import {
  getNamedButton,
  getNamedLink,
} from "./chat-attachment-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  findButton,
  readyChat,
  RUN_PATH,
  createChatCapabilityHelpers,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const FIRST_MAIL_ID = "e0000000-0000-4000-a000-000000000853";
const SECOND_MAIL_ID = "e0000000-0000-4000-a000-000000000854";
const DETAILS_MAIL_ID = "e0000000-0000-4000-a000-000000000855";
const APP_HOST = "app.okou.ai";

function mailUrl(mailDraftId: string): string {
  return `https://${APP_HOST}/mail/drafts/${mailDraftId}`;
}

function mailCard(mailDraftId: string, label: string): string {
  return `[${label}](${mailUrl(mailDraftId)})`;
}

function mailDraft(
  mailDraftId: string,
  overrides: Partial<Extract<MailDraft, { provider: "gmail" }>> = {},
): Extract<MailDraft, { provider: "gmail" }> {
  return {
    version: 3,
    provider: "gmail",
    from: "sender@example.com",
    fromName: "Example Sender",
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject: `Mail ${mailDraftId.slice(-3)}`,
    body: "A persisted email message.",
    accessStatus: "ready",
    references: [],
    status: "draft",
    detailAvailable: true,
    gmailDraftId: `gmail-draft-${mailDraftId}`,
    gmailThreadId: `gmail-thread-${mailDraftId}`,
    gmailMessageId: `gmail-message-${mailDraftId}`,
    attachments: [],
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:01:00.000Z",
    ...overrides,
  };
}

function mailResponse(mailDraftId: string, draft: MailDraft) {
  return {
    mailDraftId,
    mailDraftUrl: mailUrl(mailDraftId),
    mailDraft: draft,
  };
}

function normalizedText(element: HTMLElement): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function queryControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        normalizedText(element) === name
      );
    }) ?? null
  );
}

function findControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return waitFor(() => {
    const control = queryControl(role, name, container);
    if (!control) {
      throw new Error(`${name} ${role} was not visible`);
    }
    return control;
  });
}

function findMailCard(subject: string): Promise<HTMLElement> {
  return waitFor(() => {
    const card = queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label")?.includes(subject) === true;
    });
    if (!card) {
      throw new Error(`Mail card ${subject} was not usable`);
    }
    return card;
  });
}

test("Inline, table, and nested mail links keep their labels and open email details", async () => {
  const firstDraft = mailDraft(FIRST_MAIL_ID, {
    subject: "First candidate invitation",
    body: "The first candidate's email.",
  });
  const secondDraft = mailDraft(SECOND_MAIL_ID, {
    subject: "Second candidate invitation",
    body: "The second candidate's email.",
  });
  const chineseDraft = mailDraft(DETAILS_MAIL_ID, {
    subject: "Invitation from a Chinese sentence",
    body: "The email linked before Chinese punctuation.",
  });
  const relativeUrl = `/mail/drafts/${SECOND_MAIL_ID}`;
  const foreignUrl = `https://untrusted.example/mail/drafts/${SECOND_MAIL_ID}`;
  installCapabilityChat({
    events: completedConversation(
      [
        ` ${mailCard(FIRST_MAIL_ID, "Standalone draft")} `,
        "",
        `Review [**Inline draft**](${mailUrl(SECOND_MAIL_ID)}) before sending.`,
        "",
        "| Candidate | Email |",
        "| --- | --- |",
        `| First candidate | ${mailUrl(FIRST_MAIL_ID)} |`,
        "",
        `- [List draft](${mailUrl(SECOND_MAIL_ID)})`,
        "",
        `> [Quoted draft](${mailUrl(SECOND_MAIL_ID)})`,
        "",
        "A paragraph starts here",
        mailUrl(SECOND_MAIL_ID),
        "and continues after the URL.",
        "",
        `Also review [Relative draft](${relativeUrl}).`,
        "",
        `Relative path: **${relativeUrl}**`,
        "",
        `请查看 **${mailUrl(DETAILS_MAIL_ID)}。然后确认内容。**`,
        "",
        `A code example: \`${mailUrl(SECOND_MAIL_ID)}\`.`,
        "",
        `Untrusted: [External link](${foreignUrl}).`,
      ].join("\n"),
    ),
  });
  const drafts = new Map([
    [FIRST_MAIL_ID, firstDraft],
    [SECOND_MAIL_ID, secondDraft],
    [DETAILS_MAIL_ID, chineseDraft],
  ]);
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    const draft = drafts.get(params.mailDraftId);
    if (!draft) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Email not found" },
      });
    }
    return respond(200, mailResponse(params.mailDraftId, draft));
  });

  await setupPage({ context, path: RUN_PATH, host: APP_HOST });
  await readyChat();
  const card = await findMailCard(firstDraft.subject);
  expect(card).toBeInTheDocument();
  const inlineLink = await findControl("link", "Inline draft");
  expect(inlineLink.querySelector("strong")).toHaveTextContent("Inline draft");
  expect(inlineLink.closest("p")).toHaveTextContent(
    "Review Inline draft before sending.",
  );
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.getAttribute("aria-label")?.includes(secondDraft.subject);
    }),
  ).toHaveLength(0);
  const externalLink = await findControl("link", "External link");
  expect(externalLink).toHaveAttribute("href", foreignUrl);
  let nativeLinkNavigation = false;
  document.addEventListener(
    "click",
    (event) => {
      nativeLinkNavigation = !event.defaultPrevented;
      // Observe React's handling without leaving the test page.
      event.preventDefault();
    },
    { once: true },
  );
  click(externalLink);
  expect(nativeLinkNavigation).toBeTruthy();
  expect(
    screen.queryByRole("complementary", { name: "Email details" }),
  ).not.toBeInTheDocument();
  const chineseLink = await findControl("link", mailUrl(DETAILS_MAIL_ID));
  expect(chineseLink.closest("p")).toHaveTextContent(
    `请查看 ${mailUrl(DETAILS_MAIL_ID)}。然后确认内容。`,
  );

  const links = [
    {
      label: mailUrl(FIRST_MAIL_ID),
      href: mailUrl(FIRST_MAIL_ID),
      tag: "table",
      draft: firstDraft,
    },
    {
      label: "Inline draft",
      href: mailUrl(SECOND_MAIL_ID),
      tag: "p",
      draft: secondDraft,
    },
    {
      label: "List draft",
      href: mailUrl(SECOND_MAIL_ID),
      tag: "li",
      draft: secondDraft,
    },
    {
      label: "Quoted draft",
      href: mailUrl(SECOND_MAIL_ID),
      tag: "blockquote",
      draft: secondDraft,
    },
    {
      label: mailUrl(SECOND_MAIL_ID),
      href: mailUrl(SECOND_MAIL_ID),
      tag: "p",
      draft: secondDraft,
    },
    {
      label: "Relative draft",
      href: relativeUrl,
      tag: "p",
      draft: secondDraft,
    },
    {
      label: relativeUrl,
      href: relativeUrl,
      tag: "p",
      draft: secondDraft,
    },
    {
      label: mailUrl(DETAILS_MAIL_ID),
      href: mailUrl(DETAILS_MAIL_ID),
      tag: "p",
      draft: chineseDraft,
    },
  ];
  for (const { label, href, tag, draft } of links) {
    const link = await findControl("link", label);
    expect(link).toHaveAttribute("href", href);
    expect(link.closest(tag)).toBeInTheDocument();
    click(link);
    const sidebar = await screen.findByRole("complementary", {
      name: "Email details",
    });
    await expect(
      within(sidebar).findByText(draft.body),
    ).resolves.toBeInTheDocument();
    expect(within(sidebar).getByText(draft.subject)).toBeInTheDocument();
    expect(window.location.pathname).toBe(RUN_PATH);
  }
});

test("Send, revisit, and delete mail drafts from chat", async () => {
  const approvalId = "a0000000-0000-4000-a000-000000000617";
  const vendorId = "a0000000-0000-4000-a000-000000000618";
  const time = "2026-08-01T10:00:00.000Z";
  const url = (id: string) => {
    return `https://app.okou.ai/mail/drafts/${id}`;
  };
  const draft = (subject: string, id: string): MailDraft => {
    return {
      provider: "gmail",
      version: 3,
      gmailDraftId: `draft-${id}`,
      gmailThreadId: `thread-${id}`,
      gmailMessageId: `message-${id}`,
      status: "draft",
      detailAvailable: true,
      from: "sender@example.com",
      to: ["reviewer@example.com"],
      cc: [],
      bcc: [],
      references: [],
      attachments: [],
      subject,
      body: `Please review ${subject.toLowerCase()}.`,
      createdAt: time,
      updatedAt: time,
    };
  };
  const drafts = new Map([
    [approvalId, draft("Launch approval", "approval")],
    [vendorId, draft("Vendor follow-up", "vendor")],
  ]);
  installCapabilityChat({
    events: completedConversation(`${url(approvalId)}\n\n${url(vendorId)}`),
  });
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    const mailDraft = drafts.get(params.mailDraftId);
    if (!mailDraft) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Draft not found" },
      });
    }
    return respond(200, {
      mailDraftId: params.mailDraftId,
      mailDraftUrl: url(params.mailDraftId),
      mailDraft,
    });
  });
  context.mocks.api(mailContract.sendDraft, ({ params, respond }) => {
    const mailDraft = drafts.get(params.mailDraftId);
    if (params.mailDraftId !== approvalId || mailDraft?.provider !== "gmail") {
      throw new Error("Expected the approval draft to be sent");
    }
    const sent = {
      ...mailDraft,
      status: "sent" as const,
      sentAt: time,
      sentGmailMessageId: "sent-approval",
    };
    drafts.set(approvalId, sent);
    return respond(200, {
      mailDraftId: approvalId,
      mailDraftUrl: url(approvalId),
      mailDraft: sent,
    });
  });
  context.mocks.api(mailContract.deleteDraft, ({ params, respond }) => {
    expect(params.mailDraftId).toBe(vendorId);
    drafts.delete(vendorId);
    return respond(204);
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  const open = async (button: string, body: string) => {
    click(await findButton(button));
    const panel = await screen.findByTestId("mail-draft-sidebar");
    await expect(within(panel).findByText(body)).resolves.toBeInTheDocument();
    return panel;
  };

  const approval = await open(
    "Open draft email: Launch approval",
    "Please review launch approval.",
  );
  click(getNamedButton("Send", approval));
  const sentCard = await findButton("Open sent email: Launch approval");
  expect(getNamedLink("Open in Gmail", approval)).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=sender%40example.com#all/thread-approval",
  );

  await open(
    "Open draft email: Vendor follow-up",
    "Please review vendor follow-up.",
  );
  const revisited = await open(
    "Open sent email: Launch approval",
    "Please review launch approval.",
  );
  expect(getNamedLink("Open in Gmail", revisited)).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=sender%40example.com#all/thread-approval",
  );
  const vendor = await open(
    "Open draft email: Vendor follow-up",
    "Please review vendor follow-up.",
  );
  expect(getNamedButton("Send", vendor)).toBeEnabled();
  click(getNamedButton("Delete", vendor));

  await waitFor(() => {
    expect(screen.queryByTestId("mail-draft-sidebar")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").find((button) => {
        return button.getAttribute("aria-label")?.includes("Vendor follow-up");
      }),
    ).toBeUndefined();
  });
  expect(sentCard).toBeInTheDocument();
});

test("Open a trusted email card with safe, complete details", async () => {
  const subject = "Quarterly security summary";
  const remoteImageUrl = "https://cdn.example.test/security-chart.png";
  const gmailThreadId = "gmail-thread-details-855";
  context.mocks.browser.blobDownload();
  const bodyHtml = `
    <h2>Quarterly summary</h2>
    <p>Review the <strong>approved findings</strong>.</p>
    <img src="cid:security-chart" alt="Inline security chart">
    <img src="${remoteImageUrl}" alt="Remote security chart">
    <a href="javascript:globalThis.__privateMailExecuted = true">Unsafe action</a>
    <img src="javascript:globalThis.__privateMailExecuted = true" alt="Unsafe image">
    <script>globalThis.__privateMailExecuted = "LEAKED_PRIVATE_TOKEN"</script>
    <iframe srcdoc="LEAKED_PRIVATE_TOKEN"></iframe>
    <input value="LEAKED_PRIVATE_TOKEN">
  `;
  installCapabilityChat({
    events: completedConversation(mailCard(DETAILS_MAIL_ID, subject)),
  });
  context.mocks.api(mailContract.getDraft, ({ respond }) => {
    return respond(
      200,
      mailResponse(
        DETAILS_MAIL_ID,
        mailDraft(DETAILS_MAIL_ID, {
          from: "security@example.com",
          fromName: "Security Team",
          to: ["owner@example.com", "reviewer@example.com"],
          cc: ["audit@example.com"],
          bcc: ["archive@example.com"],
          subject,
          body: "Quarterly summary fallback",
          bodyHtml,
          status: "sent",
          sentGmailMessageId: "gmail-sent-details-855",
          gmailThreadId,
          inlineImages: [
            {
              contentId: "security-chart",
              partId: "inline-security-chart",
              alt: "Inline security chart",
            },
          ],
          attachments: [
            {
              filename: "brief.pdf",
              contentType: "application/pdf",
              size: 512,
              partId: "attachment-pdf",
            },
            {
              filename: "notes.txt",
              contentType: "text/plain",
              size: 128,
              partId: "attachment-text",
            },
          ],
        }),
      ),
    );
  });
  context.mocks.http.get(
    `*/api/mail/drafts/${DETAILS_MAIL_ID}/attachments/:partId`,
    ({ params }) => {
      const content =
        params.partId === "attachment-text"
          ? "Approved text attachment"
          : params.partId === "attachment-pdf"
            ? "%PDF-1.4 test preview"
            : "inline image bytes";
      return new HttpResponse(content, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
  );

  await setupPage({ context, path: RUN_PATH, host: APP_HOST });

  await readyChat();
  const card = await findMailCard(subject);
  expect(card).toHaveTextContent("owner@example.com +1");
  click(card);

  const sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  expect(within(sidebar).getByText(subject)).toBeVisible();
  expect(within(sidebar).getByText("Security Team")).toBeVisible();
  expect(within(sidebar).getByText("security@example.com")).toBeVisible();
  expect(
    within(sidebar).getByText(/owner@example\.com, reviewer@example\.com/u),
  ).toBeVisible();
  expect(within(sidebar).getByText(/cc audit@example\.com/iu)).toBeVisible();
  expect(within(sidebar).getByText(/bcc archive@example\.com/iu)).toBeVisible();
  expect(
    within(sidebar).getByRole("heading", { name: "Quarterly summary" }),
  ).toBeVisible();
  expect(within(sidebar).getByText("approved findings")).toBeVisible();

  const inlineImage = await within(sidebar).findByRole("img", {
    name: "Inline security chart",
  });
  expect(inlineImage.getAttribute("src")).toMatch(/^blob:/u);
  const remoteImage = within(sidebar).getByRole("img", {
    name: "Remote security chart",
  });
  expect(remoteImage).toHaveAttribute("src", remoteImageUrl);
  expect(remoteImage).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(
    findControl("link", "Open in Gmail", sidebar),
  ).resolves.toHaveAttribute(
    "href",
    `https://mail.google.com/mail/?authuser=security%40example.com#all/${gmailThreadId}`,
  );
  click(await findControl("button", "Open pdf preview for brief.pdf", sidebar));
  const pdfStage = await screen.findByTestId("artifact-dialog-document-frame");
  await waitFor(() => {
    const source = pdfStage.querySelector("iframe")?.getAttribute("src");
    if (!source) {
      throw new Error("PDF preview source was not ready");
    }
    expect(source.startsWith("blob:")).toBeTruthy();
  });
  click(await findControl("button", "Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });

  click(
    await findControl("button", "Open text preview for notes.txt", sidebar),
  );
  const textPreview = await screen.findByRole("dialog", {
    name: "notes.txt preview",
  });
  await expect(
    within(textPreview).findByText("Approved text attachment"),
  ).resolves.toBeVisible();
  click(await findControl("button", "Close", textPreview));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "notes.txt preview" }),
    ).toBeNull();
  });

  expect(sidebar.querySelector("script")).toBeNull();
  expect(sidebar.querySelector("iframe")).toBeNull();
  expect(sidebar.querySelector("input")).toBeNull();
  expect(sidebar).not.toHaveTextContent("LEAKED_PRIVATE_TOKEN");
  expect(within(sidebar).getByText("Unsafe action")).not.toHaveAttribute(
    "href",
  );
  expect(
    within(sidebar).queryByRole("img", { name: "Unsafe image" }),
  ).not.toBeInTheDocument();
  expect(Reflect.get(globalThis, "__privateMailExecuted")).toBeUndefined();
});
