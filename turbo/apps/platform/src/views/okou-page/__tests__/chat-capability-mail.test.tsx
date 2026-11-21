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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const TIMESTAMP = "2026-08-01T10:00:00.000Z";
const PRIVATE_TOKEN = "private-token-5f2a91";

function mailUrl(id: string): string {
  return `https://app.okou.ai/mail/drafts/${id}`;
}

function gmailDraft(overrides: Partial<MailDraft> = {}): MailDraft {
  return {
    provider: "gmail",
    version: 3,
    gmailDraftId: "draft-1",
    gmailThreadId: "thread-1",
    gmailMessageId: "message-1",
    status: "draft",
    detailAvailable: true,
    from: "sender@example.com",
    to: ["reviewer@example.com"],
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

/** The Gmail drafts the API stores, by mail draft ID. */
function mockMailDrafts(drafts: Map<string, MailDraft>): void {
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    const draft = drafts.get(params.mailDraftId);
    if (!draft) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Mail draft not found" },
      });
    }
    return respond(200, {
      mailDraftId: params.mailDraftId,
      mailDraftUrl: mailUrl(params.mailDraftId),
      mailDraft: draft,
    });
  });
}

/** Attachment bytes as the API streams them for each Gmail part. */
function mockAttachments(parts: Record<string, BlobPart>): void {
  context.mocks.http.get(
    /\/api\/mail\/drafts\/[^/]+\/attachments\/[^/]+$/u,
    ({ request }) => {
      const partId = new URL(request.url).pathname.split("/").at(-1) ?? "";
      return new HttpResponse(new Blob([parts[partId] ?? ""]), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    },
  );
}

function mailCard(label: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
}

async function openMail(label: string): Promise<HTMLElement> {
  const card = await waitFor(() => {
    const found = mailCard(label);
    if (!found) {
      throw new Error(`Expected the mail card ${label}`);
    }
    return found;
  });
  click(card);
  return await screen.findByTestId("mail-draft-sidebar");
}

async function closeMail(details: HTMLElement): Promise<void> {
  click(labelledButton("Close email details", details));
  await waitFor(() => {
    expect(details).not.toBeInTheDocument();
  });
}

function labelledButton(label: string, container: ParentNode): HTMLElement {
  const found = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!found) {
    throw new Error(`Expected the ${label} button`);
  }
  return found;
}

function action(name: string, container: ParentNode): HTMLElement {
  const found = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Expected the ${name} action`);
  }
  return found;
}

test("Open a trusted email card with safe, complete details", async () => {
  const id = "a0000000-0000-4000-a000-000000000721";
  mockMailDrafts(
    new Map([
      [
        id,
        gmailDraft({
          status: "sent",
          gmailThreadId: "thread-quarterly",
          sentGmailMessageId: "sent-quarterly",
          sentAt: TIMESTAMP,
          fromName: "Sam Sender",
          to: ["reviewer@example.com"],
          cc: ["finance@example.com"],
          bcc: ["audit@example.com"],
          subject: "Quarterly launch",
          body: "Hello team",
          bodyHtml: [
            "<p>Hello <strong>team</strong></p>",
            '<img src="cid:logo@okou" alt="Okou logo">',
            '<img src="https://images.example.com/chart.png" alt="Launch chart">',
            `<script>window.__mailScriptRan = "${PRIVATE_TOKEN}"</script>`,
            `<iframe srcdoc="${PRIVATE_TOKEN}"></iframe>`,
            `<input value="${PRIVATE_TOKEN}">`,
            '<a href="javascript:alert(1)">Run setup</a>',
            `<img src="x" alt="Tracker" onerror="window.__mailScriptRan='${PRIVATE_TOKEN}'">`,
          ].join(""),
          inlineImages: [
            { contentId: "logo@okou", partId: "4", alt: "Okou logo" },
          ],
          attachments: [
            {
              filename: "plan.pdf",
              contentType: "application/pdf",
              size: 1200,
              partId: "2",
            },
            {
              filename: "notes.txt",
              contentType: "text/plain",
              size: 21,
              partId: "3",
            },
          ],
        }),
      ],
    ]),
  );
  mockAttachments({
    "2": "%PDF-1.4 launch plan",
    "3": "Launch notes for Q3",
    "4": new Uint8Array([137, 80, 78, 71]),
  });
  installCapabilityChat({ events: completedConversation(mailUrl(id)) });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  const details = await openMail("Open sent email: Quarterly launch");

  await expect(
    within(details).findByRole("heading", { name: "Quarterly launch" }),
  ).resolves.toBeInTheDocument();
  for (const text of [
    "Sam Sender",
    "sender@example.com",
    "to reviewer@example.com",
    "cc finance@example.com",
    "bcc audit@example.com",
  ]) {
    expect(within(details).getByText(text)).toBeInTheDocument();
  }
  expect(within(details).getByText("team").closest("strong")).not.toBeNull();
  await expect(
    within(details).findByRole("img", { name: "Okou logo" }),
  ).resolves.toHaveAttribute("src", expect.stringMatching(/^blob:/u));
  expect(
    within(details).getByRole("img", { name: "Launch chart" }),
  ).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(
    queryAllByRoleFast("link", details).find((link) => {
      return link.textContent?.trim() === "Open in Gmail";
    }),
  ).toHaveAttribute("href", expect.stringContaining("#all/thread-quarterly"));
  expect(within(details).getByText("Run setup")).not.toHaveAttribute("href");
  expect(within(details).queryByRole("img", { name: "Tracker" })).toBeNull();
  expect(details.querySelector("script, iframe, input")).toBeNull();
  expect(document.body).not.toHaveTextContent(PRIVATE_TOKEN);
  expect(Reflect.get(window, "__mailScriptRan")).toBeUndefined();

  click(await findPreview(details, "Open pdf preview for plan.pdf"));

  const pdf = await screen.findByRole("dialog", { name: "plan.pdf preview" });
  // The document frame loads the downloaded attachment, not a remote URL.
  expect(within(pdf).getByTitle("plan.pdf preview")).toHaveAttribute(
    "src",
    expect.stringMatching(/^blob:/u),
  );
  click(labelledButton("Close", pdf));
  await waitFor(() => {
    expect(pdf).not.toBeInTheDocument();
  });

  click(await findPreview(details, "Open text preview for notes.txt"));

  const text = await screen.findByRole("dialog", { name: "notes.txt preview" });
  await expect(
    within(text).findByText("Launch notes for Q3"),
  ).resolves.toBeInTheDocument();
});

async function findPreview(
  details: HTMLElement,
  label: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const preview = queryAllByRoleFast("button", details).find((button) => {
      return button.getAttribute("aria-label") === label;
    });
    if (!preview) {
      throw new Error(`Expected ${label}`);
    }
    return preview;
  });
}

test("Send, revisit, and delete mail drafts from chat", async () => {
  const launchId = "a0000000-0000-4000-a000-000000000731";
  const vendorId = "a0000000-0000-4000-a000-000000000732";
  const drafts = new Map([
    [
      launchId,
      gmailDraft({
        gmailThreadId: "thread-launch",
        subject: "Launch approval",
        body: "Please approve the launch.",
      }),
    ],
    [
      vendorId,
      gmailDraft({
        gmailDraftId: "draft-2",
        gmailThreadId: "thread-vendor",
        gmailMessageId: "message-2",
        subject: "Vendor follow-up",
        body: "Checking in on the contract.",
      }),
    ],
  ]);
  mockMailDrafts(drafts);
  context.mocks.api(mailContract.sendDraft, ({ params, respond }) => {
    const sent = {
      ...drafts.get(params.mailDraftId),
      status: "sent",
      sentGmailMessageId: "sent-launch",
      sentAt: TIMESTAMP,
    } as MailDraft;
    drafts.set(params.mailDraftId, sent);
    return respond(200, {
      mailDraftId: params.mailDraftId,
      mailDraftUrl: mailUrl(params.mailDraftId),
      mailDraft: sent,
    });
  });
  context.mocks.api(mailContract.deleteDraft, ({ params, respond }) => {
    drafts.delete(params.mailDraftId);
    return respond(204);
  });
  installCapabilityChat({
    events: completedConversation(
      `${mailUrl(launchId)}\n\n${mailUrl(vendorId)}`,
    ),
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  const launch = await openMail("Open draft email: Launch approval");

  click(action("Send", launch));

  await expect(screen.findByText("Email sent")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(mailCard("Open sent email: Launch approval")).toBeDefined();
  });
  await closeMail(launch);

  const vendor = await openMail("Open draft email: Vendor follow-up");
  expect(within(vendor).getByText("Draft")).toBeInTheDocument();
  await closeMail(vendor);
  const revisited = await openMail("Open sent email: Launch approval");
  expect(within(revisited).getByText("Sent")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("link", revisited).find((link) => {
      return link.textContent?.trim() === "Open in Gmail";
    }),
  ).toHaveAttribute("href", expect.stringContaining("#all/thread-launch"));
  await closeMail(revisited);
  const vendorAgain = await openMail("Open draft email: Vendor follow-up");

  click(action("Delete", vendorAgain));

  await waitFor(() => {
    expect(vendorAgain).not.toBeInTheDocument();
  });
  expect(mailCard("Open draft email: Vendor follow-up")).toBeUndefined();
  expect(mailCard("Open sent email: Launch approval")).toBeDefined();
});

test("Inline, table, and nested mail links keep their labels and open email details", async () => {
  const id = (suffix: number): string => {
    return `a0000000-0000-4000-a000-0000000007${suffix}`;
  };
  const subjects = new Map([
    [id(41), "Launch approval"],
    [id(42), "Launch draft"],
    [id(43), "Vendor note"],
    [id(44), "Budget review"],
    [id(45), "List follow-up"],
    [id(46), "Quoted reply"],
    [id(47), "Bare link mail"],
    [id(48), "Chinese sentence mail"],
  ]);
  mockMailDrafts(
    new Map(
      [...subjects].map(([draftId, subject]) => {
        return [draftId, gmailDraft({ subject, body: `${subject} body` })];
      }),
    ),
  );
  installCapabilityChat({
    events: completedConversation(
      [
        mailUrl(id(41)),
        `Please review [the launch draft](${mailUrl(id(42))}) and **[the vendor note](${mailUrl(id(43))})**.`,
        "| Mail | Owner |\n| --- | --- |",
        `| [Budget mail](${mailUrl(id(44))}) | Finance |`,
        `- Follow up with [the list mail](/mail/drafts/${id(45)})`,
        `> Quoted: ${mailUrl(id(46))}`,
        `Bare: ${mailUrl(id(47))} done`,
        `请查看 ${mailUrl(id(48))}。然后确认内容。`,
        `\`${mailUrl(id(49))}\``,
        `[Untrusted mail](https://mail.example.org/mail/drafts/${id(50)})`,
      ]
        .join("\n\n")
        .replace("|\n\n|", "|\n|"),
    ),
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const transcript = await readyChat();
  await waitFor(() => {
    expect(mailCard("Open draft email: Launch approval")).toBeDefined();
  });
  // Only the standalone URL becomes a card; inline links stay links.
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.getAttribute("aria-label")?.startsWith("Open draft email:");
    }),
  ).toHaveLength(1);
  const chatPath = location.pathname;

  for (const [label, subject] of [
    ["the launch draft", "Launch draft"],
    ["the vendor note", "Vendor note"],
    ["Budget mail", "Budget review"],
    ["the list mail", "List follow-up"],
    [mailUrl(id(46)), "Quoted reply"],
    [mailUrl(id(47)), "Bare link mail"],
    [mailUrl(id(48)), "Chinese sentence mail"],
  ] as const) {
    const link = queryAllByRoleFast("link", transcript).find((candidate) => {
      return candidate.textContent?.trim() === label;
    });
    if (!link) {
      throw new Error(`Expected the mail link ${label}`);
    }
    click(link);
    const details = await screen.findByTestId("mail-draft-sidebar");
    await expect(
      within(details).findByRole("heading", { name: subject }),
    ).resolves.toBeInTheDocument();
    expect(location.pathname).toBe(chatPath);
    await closeMail(details);
  }

  const untrusted = queryAllByRoleFast("link", transcript).find((link) => {
    return link.textContent?.trim() === "Untrusted mail";
  });
  if (!untrusted) {
    throw new Error("Expected the untrusted link");
  }
  // The page leaves an untrusted link to the browser's own navigation.
  const navigation: { defaultPrevented?: boolean } = {};
  window.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Node && untrusted.contains(event.target)) {
        navigation.defaultPrevented = event.defaultPrevented;
      }
    },
    { signal: context.signal },
  );

  click(untrusted);

  expect(navigation).toStrictEqual({ defaultPrevented: false });
  expect(untrusted).toHaveAttribute(
    "href",
    `https://mail.example.org/mail/drafts/${id(50)}`,
  );
  expect(screen.queryByTestId("mail-draft-sidebar")).toBeNull();
  expect(location.pathname).toBe(chatPath);
});
