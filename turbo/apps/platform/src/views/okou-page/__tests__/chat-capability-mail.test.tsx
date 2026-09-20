import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { describe, expect, it, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const RECONNECT_MAIL_ID = "e0000000-0000-4000-a000-000000000851";
const FIRST_MAIL_ID = "e0000000-0000-4000-a000-000000000853";
const SECOND_MAIL_ID = "e0000000-0000-4000-a000-000000000854";
const DETAILS_MAIL_ID = "e0000000-0000-4000-a000-000000000855";
const GMAIL_CONNECTION_ID = "e0000000-0000-4000-a000-000000000856";
const DEFAULT_GMAIL_CONNECTION_ID = "e0000000-0000-4000-a000-000000000857";
const APP_HOST = "app.okou.ai";

function mailUrl(mailDraftId: string): string {
  return `https://${APP_HOST}/mail/drafts/${mailDraftId}`;
}

function mailCard(mailDraftId: string, label: string): string {
  return `[${label}](${mailUrl(mailDraftId)})`;
}

function mailDraft(
  mailDraftId: string,
  overrides: Partial<MailDraft> = {},
): MailDraft {
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

function findOpenMailCard(subject: string): Promise<HTMLElement> {
  return waitFor(() => {
    const cards = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label")?.includes(subject) === true;
    });
    const card = cards.find((candidate) => {
      return candidate.getAttribute("aria-label")?.startsWith("Open ") === true;
    });
    if (!card) {
      const labels = cards.map((candidate) => {
        return candidate.getAttribute("aria-label");
      });
      throw new Error(`Open mail card was not visible: ${labels.join(", ")}`);
    }
    return card;
  });
}

function connectorResponse(args: {
  readonly connectionId: string;
  readonly email: string;
  readonly reconnectRequired: boolean;
  readonly updatedAt: string;
}): BuiltinConnectorResponse {
  return {
    id: args.connectionId,
    slug: "gmail",
    authMethod: "oauth",
    externalId: `gmail-${args.connectionId}`,
    externalUsername: args.email,
    externalEmail: args.email,
    oauthScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    connectionStatus: args.reconnectRequired
      ? "reconnect-required"
      : "connected",
    reconnectReason: args.reconnectRequired
      ? "authorization_expired_or_revoked"
      : null,
    tokenExpiresAt: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: args.updatedAt,
  };
}

function openedAuthorizationWindow(): {
  readonly calls: ReturnType<typeof context.mocks.browser.open>["calls"];
  readonly complete: () => void;
  readonly navigations: string[];
} {
  const navigations: string[] = [];
  const authorizationWindow = context.mocks.browser.authWindow();
  const location = {
    hrefValue: "about:blank",
    get href(): string {
      return this.hrefValue;
    },
    set href(value: string) {
      this.hrefValue = value;
      navigations.push(value);
    },
  };
  Object.defineProperty(authorizationWindow, "location", {
    configurable: true,
    value: location,
  });
  const opened = context.mocks.browser.open(authorizationWindow);
  return {
    calls: opened.calls,
    complete: () => {
      authorizationWindow.close();
    },
    navigations,
  };
}

describe("reconnecting the exact Gmail account required by a persisted mail card", () => {
  async function prepareReconnect() {
    const subject = "Reconnect project mail";
    const attempt = {
      gmailReady: false,
      oauthAttemptId: crypto.randomUUID(),
      authorization: openedAuthorizationWindow(),
    };
    installCapabilityChat({
      events: completedConversation(mailCard(RECONNECT_MAIL_ID, subject)),
    });
    context.mocks.data.connectors([
      connectorResponse({
        connectionId: DEFAULT_GMAIL_CONNECTION_ID,
        email: "default@example.com",
        reconnectRequired: false,
        updatedAt: "2026-08-01T09:00:00.000Z",
      }),
      connectorResponse({
        connectionId: GMAIL_CONNECTION_ID,
        email: "sender@example.com",
        reconnectRequired: true,
        updatedAt: "2026-08-01T09:00:00.000Z",
      }),
    ]);
    context.mocks.api(mailContract.getDraft, ({ respond }) => {
      return respond(
        200,
        mailResponse(
          RECONNECT_MAIL_ID,
          mailDraft(RECONNECT_MAIL_ID, {
            subject,
            accessStatus: attempt.gmailReady ? "ready" : "reconnect",
            reconnectConnectionId: attempt.gmailReady
              ? undefined
              : GMAIL_CONNECTION_ID,
          }),
        ),
      );
    });
    const completedAttempts = mockOAuthCompletions(context);
    const oauthAccounts: ConnectorAccountMutationIntent[] = [];
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ body, respond }) => {
        oauthAccounts.push(body.account);
        return respond(200, {
          authorizationUrl: "https://accounts.example.test/gmail/authorize",
          oauthAttemptId: attempt.oauthAttemptId,
        });
      },
    );
    await setupPage({ context, path: RUN_PATH, host: APP_HOST });

    await readyChat();
    const reconnectCard = await findMailCard(subject);
    expect(reconnectCard).toHaveTextContent(subject);
    click(reconnectCard);

    await waitFor(() => {
      expect(attempt.authorization.calls).toHaveLength(1);
      expect(attempt.authorization.navigations).toContain(
        "https://accounts.example.test/gmail/authorize",
      );
      expect(oauthAccounts).toStrictEqual([
        { intent: "reconnect", connectionId: GMAIL_CONNECTION_ID },
      ]);
    });
    return {
      subject,
      attempt,
      reconnectCard,
      completedAttempts,
      oauthAccounts,
    };
  }

  async function expectCancelledReconnect() {
    const progress = screen.getByRole("dialog", {
      name: "Connecting your account",
    });
    click(await findControl("button", "Cancel", progress));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText("Reconnecting…")).toBeNull();
    });
  }

  it("cancelling reconnect clears progress for the required account", async () => {
    await prepareReconnect();
    await expectCancelledReconnect();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
  });

  it("retrying a cancelled reconnect opens mail from the same required account", async () => {
    const {
      subject,
      attempt,
      reconnectCard,
      completedAttempts,
      oauthAccounts,
    } = await prepareReconnect();
    await expectCancelledReconnect();
    attempt.oauthAttemptId = crypto.randomUUID();
    attempt.authorization = openedAuthorizationWindow();
    click(await findMailCard(subject));
    await waitFor(() => {
      expect(attempt.authorization.navigations).toContain(
        "https://accounts.example.test/gmail/authorize",
      );
      expect(oauthAccounts).toStrictEqual([
        { intent: "reconnect", connectionId: GMAIL_CONNECTION_ID },
        { intent: "reconnect", connectionId: GMAIL_CONNECTION_ID },
      ]);
    });
    expect(
      screen.getByRole("dialog", { name: "Connecting your account" }),
    ).toBeVisible();
    expect(reconnectCard).toHaveTextContent("Reconnecting…");
    expect(reconnectCard).toBeDisabled();

    attempt.gmailReady = true;
    context.mocks.data.connectors([
      connectorResponse({
        connectionId: DEFAULT_GMAIL_CONNECTION_ID,
        email: "default@example.com",
        reconnectRequired: false,
        updatedAt: "2026-08-01T09:00:00.000Z",
      }),
      connectorResponse({
        connectionId: GMAIL_CONNECTION_ID,
        email: "sender@example.com",
        reconnectRequired: false,
        updatedAt: "2026-08-01T10:00:00.000Z",
      }),
    ]);
    completedAttempts.set(attempt.oauthAttemptId, GMAIL_CONNECTION_ID);
    attempt.authorization.complete();
    context.mocks.ably.trigger("connector:changed", { connectorSlug: "gmail" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    click(await findOpenMailCard(subject));
    const sidebar = await screen.findByRole("complementary", {
      name: "Email details",
    });
    expect(within(sidebar).getByText(subject)).toBeVisible();
    expect(
      within(sidebar).getByText("A persisted email message."),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Connecting your account" }),
    ).not.toBeInTheDocument();
  });
});

test.each([404, 500] as const)(
  "Keep a mail card through a %s read and retry",
  async (status) => {
    const gate = context.mocks.deferred<void>();
    let available = false;
    const subject = "Recovered draft";
    installCapabilityChat({
      events: completedConversation(mailCard(FIRST_MAIL_ID, subject)),
    });
    context.mocks.api(
      mailContract.getDraft,
      async ({ respond, withSignal }) => {
        await withSignal(gate.promise);
        if (available) {
          return respond(
            200,
            mailResponse(FIRST_MAIL_ID, mailDraft(FIRST_MAIL_ID, { subject })),
          );
        }
        return respond(status, {
          error: {
            code: status === 404 ? "NOT_FOUND" : "INTERNAL_SERVER_ERROR",
            message: "Email unavailable",
          },
        });
      },
    );

    await setupPage({ context, path: RUN_PATH, host: APP_HOST });
    await readyChat();
    await expect(
      screen.findByTestId("mail-draft-card-loading"),
    ).resolves.toBeInTheDocument();
    gate.resolve();
    await expect(
      screen.findByText("This email is no longer available."),
    ).resolves.toBeInTheDocument();
    available = true;
    click(await findControl("button", "Retry"));
    await expect(screen.findByText(subject)).resolves.toBeInTheDocument();
    click(await findMailCard(subject));
    await expect(
      screen.findByRole("complementary", { name: "Email details" }),
    ).resolves.toBeInTheDocument();
  },
);

test("A rejected Gmail send shows correction guidance and keeps the draft", async () => {
  const subject = "Draft requiring review";
  const draft = mailDraft(FIRST_MAIL_ID, { subject });
  const message =
    "Gmail rejected this draft. Open it in Gmail and check its recipients and content before trying again.";
  installCapabilityChat({
    events: completedConversation(mailCard(FIRST_MAIL_ID, subject)),
  });
  context.mocks.api(mailContract.getDraft, ({ respond }) => {
    return respond(200, mailResponse(FIRST_MAIL_ID, draft));
  });
  context.mocks.api(mailContract.sendDraft, ({ respond }) => {
    return respond(400, { error: { code: "BAD_REQUEST", message } });
  });

  await setupPage({ context, path: RUN_PATH, host: APP_HOST });
  await readyChat();
  click(await findMailCard(subject));
  const sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  click(await findControl("button", "Send", sidebar));

  await expect(screen.findByText(message)).resolves.toBeInTheDocument();
  expect(within(sidebar).getByText("Draft")).toBeInTheDocument();
  expect(within(sidebar).getByText(draft.body)).toBeInTheDocument();
  expect(within(sidebar).queryByText("Sent")).not.toBeInTheDocument();
  await waitFor(() => {
    expect(queryControl("button", "Send", sidebar)).toBeEnabled();
  });
  await expect(
    findControl("link", "Open in Gmail", sidebar),
  ).resolves.toHaveAttribute(
    "href",
    `https://mail.google.com/mail/?authuser=sender%40example.com#drafts?compose=${draft.gmailMessageId}`,
  );
});

test("Send, revisit, and delete mail drafts from chat", async () => {
  const firstSubject = "Launch approval";
  const secondSubject = "Vendor follow-up";
  const firstBody = "Approve the launch plan before Friday.";
  const secondBody = "Confirm the vendor delivery date.";
  const sentThreadId = "gmail-sent-thread-853";
  const drafts = new Map<string, MailDraft>([
    [
      FIRST_MAIL_ID,
      mailDraft(FIRST_MAIL_ID, { subject: firstSubject, body: firstBody }),
    ],
    [
      SECOND_MAIL_ID,
      mailDraft(SECOND_MAIL_ID, { subject: secondSubject, body: secondBody }),
    ],
  ]);
  installCapabilityChat({
    events: completedConversation(
      `${mailCard(FIRST_MAIL_ID, firstSubject)}\n\n${mailCard(SECOND_MAIL_ID, secondSubject)}`,
    ),
  });
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    const draft = drafts.get(params.mailDraftId);
    return draft
      ? respond(200, mailResponse(params.mailDraftId, draft))
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Email not found" },
        });
  });
  context.mocks.api(mailContract.sendDraft, ({ params, respond }) => {
    const current = drafts.get(params.mailDraftId);
    if (!current) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Email not found" },
      });
    }
    const sent: MailDraft = {
      ...current,
      status: "sent",
      gmailThreadId: sentThreadId,
      sentGmailMessageId: "gmail-sent-message-853",
      sentAt: "2026-08-01T10:05:00.000Z",
      updatedAt: "2026-08-01T10:05:00.000Z",
    };
    drafts.set(params.mailDraftId, sent);
    return respond(200, mailResponse(params.mailDraftId, sent));
  });
  context.mocks.api(mailContract.deleteDraft, ({ params, respond }) => {
    drafts.delete(params.mailDraftId);
    return respond(204);
  });

  await setupPage({ context, path: RUN_PATH, host: APP_HOST });

  await readyChat();
  click(await findMailCard(firstSubject));
  let sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  expect(within(sidebar).getByText(firstBody)).toBeVisible();
  click(await findControl("button", "Send", sidebar));

  await findMailCard(firstSubject);
  sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  expect(within(sidebar).getByText("Sent")).toBeVisible();
  await expect(
    findControl("link", "Open in Gmail", sidebar),
  ).resolves.toHaveAttribute(
    "href",
    `https://mail.google.com/mail/?authuser=sender%40example.com#all/${sentThreadId}`,
  );

  click(await findMailCard(secondSubject));
  sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  expect(within(sidebar).getByText(secondBody)).toBeVisible();
  expect(within(sidebar).getByText("Draft")).toBeVisible();

  click(await findMailCard(firstSubject));
  sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  expect(within(sidebar).getByText(firstBody)).toBeVisible();
  expect(within(sidebar).getByText("Sent")).toBeVisible();

  click(await findMailCard(secondSubject));
  sidebar = await screen.findByRole("complementary", {
    name: "Email details",
  });
  click(await findControl("button", "Delete", sidebar));

  await waitFor(() => {
    expect(screen.queryByText(secondSubject)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Email details" }),
    ).not.toBeInTheDocument();
  });
  await expect(findMailCard(firstSubject)).resolves.toHaveTextContent("Sent");
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
