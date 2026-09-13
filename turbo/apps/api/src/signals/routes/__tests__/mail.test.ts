import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { testMailDraftStateContract } from "@okouai/api-contracts/contracts/test-mail-draft-state";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { testMailDraftStateRoutes } from "../test-mail-draft-state";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import {
  readConnectorCredentialStorageState,
  readCustomConnectorCredentialStorageParent,
  readThreadConnectorSelectionState,
  seedConnectorStorageRow,
  seedBuiltinThreadConnectorSelection,
  seedCustomConnectorRuntimeConnectors,
  seedCustomThreadConnectorSelection,
  setConnectorAccountState,
  setBuiltinOAuthScopeFacts,
  setConnectorDefaultState,
  setConnectorCredentialStorageState,
  setConnectorSecretOwner,
} from "./helpers/connector-credential-storage-state";
import { mailRoutes } from "../mail";
import { chatThreadRoutes } from "../chat-threads";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_DRAFT_ID = "r-test-draft";
const GMAIL_THREAD_ID = "gmail-thread-id";
const GMAIL_MESSAGE_ID = "gmail-draft-message-id";
const GMAIL_SENT_MESSAGE_ID = "gmail-sent-message-id";
const GMAIL_IMAGE_ATTACHMENT_ID = "attachment-image";
const GMAIL_IMAGE_BYTES = Buffer.from("mail draft image");
const GMAIL_PDF_BYTES = Buffer.from("mail draft pdf");
const GMAIL_TEXT_BYTES = Buffer.from("mail draft decision");
const GMAIL_HTML_BODY =
  '<div>Mail body <strong>before</strong></div><img src="cid:email-test-illustration" alt="Cheerful envelope illustration"><ul><li>Mail body after</li></ul><a href="https://example.com/review">Review</a>';

function encodedBody(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailPayload(
  imageAttachmentId: string | null = GMAIL_IMAGE_ATTACHMENT_ID,
  pdfAttachmentId: string | null = "attachment-1",
  includeTextAttachment = false,
  subject: string | null = "Attachment review",
  body = "Mail body",
) {
  return {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      { name: "From", value: "Sender <sender@example.com>" },
      { name: "To", value: "recipient@example.com" },
      { name: "Cc", value: "copy@example.com" },
      ...(subject === null ? [] : [{ name: "Subject", value: subject }]),
    ],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [],
        body: { size: 0 },
        parts: [
          {
            partId: "0.0",
            mimeType: "text/plain",
            filename: "",
            headers: [],
            body: {
              size: Buffer.byteLength(body),
              data: encodedBody(body),
            },
          },
          {
            partId: "0.1",
            mimeType: "text/html",
            filename: "",
            headers: [],
            body: {
              size: 180,
              data: encodedBody(GMAIL_HTML_BODY),
            },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "report.pdf",
        headers: [],
        body:
          pdfAttachmentId === null
            ? {
                size: GMAIL_PDF_BYTES.byteLength,
                data: GMAIL_PDF_BYTES.toString("base64url"),
              }
            : { attachmentId: pdfAttachmentId, size: 248_192 },
      },
      {
        partId: "2",
        mimeType: "image/png",
        filename: "email-test-illustration.png",
        headers: [
          {
            name: "Content-ID",
            value: "<email-test-illustration>",
          },
          {
            name: "Content-Disposition",
            value: 'inline; filename="email-test-illustration.png"',
          },
        ],
        body:
          imageAttachmentId === null
            ? {
                size: GMAIL_IMAGE_BYTES.byteLength,
                data: GMAIL_IMAGE_BYTES.toString("base64url"),
              }
            : {
                attachmentId: imageAttachmentId,
                size: GMAIL_IMAGE_BYTES.byteLength,
              },
      },
      ...(includeTextAttachment
        ? [
            {
              partId: "3",
              mimeType: "text/plain",
              filename: "decision.txt",
              headers: [],
              body: {
                size: GMAIL_TEXT_BYTES.byteLength,
                data: GMAIL_TEXT_BYTES.toString("base64url"),
              },
            },
          ]
        : []),
    ],
  };
}

interface GmailDraftTestState {
  exists: boolean;
  insufficientScope: boolean;
  permissionDenied: boolean;
  unauthorized: boolean;
  subject: string | null;
  body: string;
  draftReadCount: number;
  sendCount: number;
  deleteCount: number;
  sentBody: unknown;
}

function mockGmailDraftApi(options?: {
  readonly accessToken?: string;
  readonly inlineImageData?: boolean;
  readonly regularAttachmentData?: boolean;
  readonly textAttachmentData?: boolean;
}): GmailDraftTestState {
  const accessToken = options?.accessToken ?? "gmail-mail-card-token";
  const state: GmailDraftTestState = {
    exists: true,
    insufficientScope: false,
    permissionDenied: false,
    unauthorized: false,
    subject: "Attachment review",
    body: "Mail body",
    draftReadCount: 0,
    sendCount: 0,
    deleteCount: 0,
    sentBody: null,
  };
  let currentImageAttachmentId = GMAIL_IMAGE_ATTACHMENT_ID;
  server.use(
    http.get(`${GMAIL_API_BASE}/drafts/:draftId`, ({ params, request }) => {
      expect(params.draftId).toBe(GMAIL_DRAFT_ID);
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${accessToken}`,
      );
      expect(new URL(request.url).searchParams.get("format")).toBe("full");
      state.draftReadCount += 1;
      if (state.unauthorized) {
        return HttpResponse.json(
          { error: { message: "Invalid Credentials" } },
          { status: 401 },
        );
      }
      if (state.insufficientScope) {
        return HttpResponse.json(
          {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
                  domain: "googleapis.com",
                  metadata: { service: "gmail.googleapis.com" },
                },
              ],
            },
          },
          { status: 403 },
        );
      }
      if (state.permissionDenied) {
        return HttpResponse.json(
          {
            error: {
              code: 403,
              message: "The caller does not have permission.",
              status: "PERMISSION_DENIED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "PERMISSION_DENIED",
                  domain: "googleapis.com",
                },
              ],
            },
          },
          { status: 403 },
        );
      }
      if (!state.exists) {
        return new HttpResponse(null, { status: 404 });
      }
      currentImageAttachmentId = `${GMAIL_IMAGE_ATTACHMENT_ID}-${state.draftReadCount}`;
      return HttpResponse.json({
        id: GMAIL_DRAFT_ID,
        message: {
          id: GMAIL_MESSAGE_ID,
          threadId: GMAIL_THREAD_ID,
          payload: gmailPayload(
            options?.inlineImageData ? null : currentImageAttachmentId,
            options?.regularAttachmentData ? null : "attachment-1",
            options?.textAttachmentData,
            state.subject,
            state.body,
          ),
        },
      });
    }),
    http.post(`${GMAIL_API_BASE}/drafts/send`, async ({ request }) => {
      state.sentBody = await request.json();
      state.exists = false;
      state.sendCount += 1;
      return HttpResponse.json({
        id: GMAIL_SENT_MESSAGE_ID,
        threadId: GMAIL_THREAD_ID,
      });
    }),
    http.get(`${GMAIL_API_BASE}/messages/:messageId`, ({ params, request }) => {
      expect(params.messageId).toBe(GMAIL_SENT_MESSAGE_ID);
      expect(new URL(request.url).searchParams.get("format")).toBe("full");
      return HttpResponse.json({
        id: GMAIL_SENT_MESSAGE_ID,
        threadId: GMAIL_THREAD_ID,
        payload: gmailPayload(),
      });
    }),
    http.get(
      `${GMAIL_API_BASE}/messages/:messageId/attachments/:attachmentId`,
      ({ params, request }) => {
        expect(params.messageId).toBe(GMAIL_MESSAGE_ID);
        expect(params.attachmentId).toBe(currentImageAttachmentId);
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${accessToken}`,
        );
        return HttpResponse.json({
          size: GMAIL_IMAGE_BYTES.byteLength,
          data: GMAIL_IMAGE_BYTES.toString("base64url"),
        });
      },
    ),
    http.delete(`${GMAIL_API_BASE}/drafts/:draftId`, ({ params }) => {
      expect(params.draftId).toBe(GMAIL_DRAFT_ID);
      state.exists = false;
      state.deleteCount += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

async function seedGmailMailCardFixture() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const actorWithOrg = { ...actor, orgId: actor.orgId };
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Nova Mail agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Mail review",
  });
  mockGmailConnectorOAuth({
    accessToken: "gmail-mail-card-token",
    email: "sender@example.com",
  });
  const start = await connectors.startOauth(actor, "gmail", "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth state");
  }
  await connectors.completeOauthCallback("gmail", {
    code: "okou-mail-code",
    state,
  });
  const gmail = await connectors.readConnectorBySlug(actor, "gmail");
  await runs.enableAgentConnectors(actor, agent.agentId, ["gmail"]);
  mocks.clerk.session(actor.userId, actorWithOrg.orgId);
  return { actor, agent, thread, gmail };
}

function client(options?: { readonly rethrowErrors?: boolean }) {
  return setupApp({ context, routes: mailRoutes, ...options })(mailContract);
}

function connectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function stateClient() {
  return setupApp({ context, routes: testMailDraftStateRoutes })(
    testMailDraftStateContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function linkDraft(
  fixture: Awaited<ReturnType<typeof seedGmailMailCardFixture>>,
  headers = authHeaders(),
) {
  return await accept(
    client().linkDraft({
      headers,
      body: {
        threadId: fixture.thread.id,
        agentId: fixture.agent.agentId,
        gmailDraftId: GMAIL_DRAFT_ID,
      },
    }),
    [200],
  );
}

async function setGmailOAuthScopeFacts(
  fixture: Awaited<ReturnType<typeof seedGmailMailCardFixture>>,
  oauthGrantedScopes: readonly string[] | null,
): Promise<void> {
  await setBuiltinOAuthScopeFacts(context, {
    orgId: fixture.actor.orgId ?? "",
    userId: fixture.actor.userId,
    connectorSlug: "gmail",
    connectorId: fixture.gmail.id,
    oauthScopes: [GMAIL_MODIFY_SCOPE],
    oauthGrantedScopes,
  });
}

async function addGmailAccount(
  fixture: Awaited<ReturnType<typeof seedGmailMailCardFixture>>,
  args: {
    readonly accessToken: string;
    readonly email: string;
    readonly subject: string;
  },
): Promise<string> {
  await connectors.updateFeatureSwitches(fixture.actor, {});
  mockGmailConnectorOAuth(args);
  const start = await connectors.startOauth(
    fixture.actor,
    "gmail",
    "oauth",
    fixture.agent.agentId,
    { intent: "add", displayName: "Selected Gmail" },
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth state");
  }
  await connectors.completeOauthCallback("gmail", {
    code: "selected-gmail-code",
    state,
  });
  const account = (
    await connectors.listBuiltinConnectorAccounts(fixture.actor, "gmail")
  ).find((candidate) => {
    return candidate.externalEmail === args.email;
  });
  if (!account) {
    throw new Error("Expected the selected Gmail account");
  }
  return account.id;
}

async function selectGmailAccount(
  fixture: Awaited<ReturnType<typeof seedGmailMailCardFixture>>,
  connectorId: string,
): Promise<void> {
  await accept(
    connectorSelectionsClient().update({
      headers: authHeaders(),
      params: { id: fixture.thread.id },
      body: {
        connectionId: connectorId,
        target: { kind: "builtin", connectorSlug: "gmail" },
      },
    }),
    [200],
  );
}

describe("POST /api/mail/drafts/link", () => {
  it("uses the thread-selected Gmail account without probing the default", async () => {
    const fixture = await seedGmailMailCardFixture();
    const selectedAccessToken = "selected-gmail-token";
    const selectedConnectorId = await addGmailAccount(fixture, {
      accessToken: selectedAccessToken,
      email: "selected@example.com",
      subject: "selected-gmail-account",
    });
    await selectGmailAccount(fixture, selectedConnectorId);
    const gmail = mockGmailDraftApi({ accessToken: selectedAccessToken });

    const linked = await linkDraft(fixture);
    expect(gmail.draftReadCount).toBe(1);

    await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(gmail.draftReadCount).toBe(2);

    gmail.unauthorized = true;
    const reconnect = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(reconnect.body.mailDraft.reconnectConnectionId).toBe(
      selectedConnectorId,
    );
    expect(reconnect.body.mailDraft.reconnectConnectionId).not.toBe(
      fixture.gmail.id,
    );
  });

  it("does not fall back from a reconnect-required thread selection", async () => {
    const fixture = await seedGmailMailCardFixture();
    const selectedConnectorId = await addGmailAccount(fixture, {
      accessToken: "unavailable-selected-gmail-token",
      email: "unavailable-selected@example.com",
      subject: "unavailable-selected-gmail-account",
    });
    await selectGmailAccount(fixture, selectedConnectorId);
    const orgId = fixture.actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped mail fixture");
    }
    await setConnectorAccountState(context, {
      orgId,
      userId: fixture.actor.userId,
      connectorId: selectedConnectorId,
      needsReconnect: true,
    });
    const gmail = mockGmailDraftApi({
      accessToken: "unavailable-selected-gmail-token",
    });

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Connect and authorize Gmail for this agent first",
    );
    expect(gmail.draftReadCount).toBe(0);
  });

  it("uses a healthy Gmail connection with unknown historical grants", async () => {
    const fixture = await seedGmailMailCardFixture();
    await setGmailOAuthScopeFacts(fixture, null);
    await connectors.updateFeatureSwitches(fixture.actor, {});
    const gmail = mockGmailDraftApi();

    await expect(
      connectors.readConnectorBySlug(fixture.actor, "gmail"),
    ).resolves.toMatchObject({
      oauthScopes: null,
      connectionStatus: "connected",
    });
    await expect(
      connectors.listBuiltinConnectorAccounts(fixture.actor, "gmail"),
    ).resolves.toMatchObject([
      {
        oauthScopes: null,
        connectionStatus: "connected",
      },
    ]);
    await expect(linkDraft(fixture)).resolves.toMatchObject({ status: 200 });
    expect(gmail.draftReadCount).toBe(1);
  });

  it("rejects a known-insufficient Gmail grant before provider access", async () => {
    const fixture = await seedGmailMailCardFixture();
    await setGmailOAuthScopeFacts(fixture, []);
    const gmail = mockGmailDraftApi();

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Connect and authorize Gmail for this agent first",
    );
    expect(gmail.draftReadCount).toBe(0);
  });

  it("requires reconnect when Gmail reports an insufficient token scope", async () => {
    const fixture = await seedGmailMailCardFixture();
    await setGmailOAuthScopeFacts(fixture, null);
    const gmail = mockGmailDraftApi();
    gmail.insufficientScope = true;

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Reconnect Gmail before continuing",
    );
    expect(gmail.draftReadCount).toBe(1);
    await expect(
      connectors.readConnectorBySlug(fixture.actor, "gmail"),
    ).resolves.toMatchObject({ connectionStatus: "reconnect-required" });
  });

  it("does not require reconnect for an unrelated Gmail permission denial", async () => {
    const fixture = await seedGmailMailCardFixture();
    await setGmailOAuthScopeFacts(fixture, null);
    const gmail = mockGmailDraftApi();
    gmail.permissionDenied = true;

    await expect(
      client({ rethrowErrors: true }).linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
    ).rejects.toThrow("Failed to read Gmail draft (HTTP 403)");

    expect(gmail.draftReadCount).toBe(1);
    await expect(
      connectors.readConnectorBySlug(fixture.actor, "gmail"),
    ).resolves.toMatchObject({ connectionStatus: "connected" });
  });

  it("uses the default for new drafts while preserving and deleting an exact pinned account", async () => {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi();
    const linked = await linkDraft(fixture);
    const storage = await readConnectorCredentialStorageState(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      connectorSlug: "gmail",
    });
    const connectorId = storage.connector?.id;
    if (!connectorId) {
      throw new Error("Expected a stored Gmail connector account");
    }
    await seedBuiltinThreadConnectorSelection(context, {
      chatThreadId: fixture.thread.id,
      connectorId,
      connectorSlug: "gmail",
    });
    await setConnectorDefaultState(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      connectorId,
      isDefault: false,
    });

    await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );

    const newThread = await chat.createThread(fixture.actor, {
      agentId: fixture.agent.agentId,
      title: "Default Gmail projection",
    });
    const newDraft = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: newThread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(newDraft.body.error.message).toBe(
      "Connect and authorize Gmail for this agent first",
    );

    await connectors.deleteBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
      connectorId,
    );
    await expect(
      readThreadConnectorSelectionState(context, {
        chatThreadId: fixture.thread.id,
        connectorId,
      }),
    ).resolves.toBeFalsy();

    const deleteDefaultCustomConnectorAccountId = randomUUID();
    const deleteCustomConnectorId = randomUUID();
    await seedCustomConnectorRuntimeConnectors(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      agentId: fixture.agent.agentId,
      customConnectors: [
        {
          id: deleteDefaultCustomConnectorAccountId,
          slug: "_disconnect-selection-cleanup",
          displayName: "Disconnect selection cleanup",
          prefixTemplate: "https://disconnect-selection.example.com/",
        },
        {
          id: deleteCustomConnectorId,
          slug: "_delete-selection-cleanup",
          displayName: "Delete selection cleanup",
          prefixTemplate: "https://delete-selection.example.com/",
        },
      ],
    });
    const disconnectCustomStorage =
      await readCustomConnectorCredentialStorageParent(context, {
        orgId: fixture.actor.orgId ?? "",
        userId: fixture.actor.userId,
        customConnectorId: deleteDefaultCustomConnectorAccountId,
      });
    const disconnectMemberConnectorId = disconnectCustomStorage.connector?.id;
    if (!disconnectMemberConnectorId) {
      throw new Error("Expected a custom connector account to disconnect");
    }
    await seedCustomThreadConnectorSelection(context, {
      chatThreadId: fixture.thread.id,
      connectorId: disconnectMemberConnectorId,
      customConnectorId: deleteDefaultCustomConnectorAccountId,
    });
    await connectors.deleteDefaultCustomConnectorAccount(
      fixture.actor,
      deleteDefaultCustomConnectorAccountId,
    );
    await expect(
      readThreadConnectorSelectionState(context, {
        chatThreadId: fixture.thread.id,
        connectorId: disconnectMemberConnectorId,
      }),
    ).resolves.toBeFalsy();

    const deleteCustomStorage =
      await readCustomConnectorCredentialStorageParent(context, {
        orgId: fixture.actor.orgId ?? "",
        userId: fixture.actor.userId,
        customConnectorId: deleteCustomConnectorId,
      });
    const deleteMemberConnectorId = deleteCustomStorage.connector?.id;
    if (!deleteMemberConnectorId) {
      throw new Error("Expected a custom connector account to delete");
    }
    await seedCustomThreadConnectorSelection(context, {
      chatThreadId: fixture.thread.id,
      connectorId: deleteMemberConnectorId,
      customConnectorId: deleteCustomConnectorId,
    });
    await connectors.deleteCustomConnector(
      fixture.actor,
      deleteCustomConnectorId,
    );
    await expect(
      readThreadConnectorSelectionState(context, {
        chatThreadId: fixture.thread.id,
        connectorId: deleteMemberConnectorId,
      }),
    ).resolves.toBeFalsy();
    await connectors.deleteCustomConnector(
      fixture.actor,
      deleteDefaultCustomConnectorAccountId,
    );
  });

  it("links without injecting a duplicate card and sends without rebuilding MIME", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();

    const okouToken = runs.okouTokenForRunWithCapabilities(
      fixture.actor,
      randomUUID(),
      ["connector:read"],
    );
    const linked = await linkDraft(fixture, {
      authorization: `Bearer ${okouToken}`,
    });
    expect(linked.body.mailDraftUrl).toBe(
      `https://app.okou.ai/mail/drafts/${linked.body.mailDraftId}`,
    );

    const duplicateLink = await linkDraft(fixture);
    expect(duplicateLink.body).toStrictEqual({
      mailDraftId: linked.body.mailDraftId,
      mailDraftUrl: `https://app.okou.ai/mail/drafts/${linked.body.mailDraftId}`,
    });

    const loaded = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(loaded.body.mailDraftUrl).toBe(
      `https://app.okou.ai/mail/drafts/${linked.body.mailDraftId}`,
    );
    expect(loaded.body.mailDraft).toMatchObject({
      version: 3,
      provider: "gmail",
      from: "sender@example.com",
      fromName: "Sender",
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      subject: "Attachment review",
      body: "Mail body",
      bodyHtml: GMAIL_HTML_BODY,
      inlineImages: [
        {
          contentId: "email-test-illustration",
          partId: "2",
          alt: "Cheerful envelope illustration",
        },
      ],
      status: "draft",
      attachments: [
        {
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 248_192,
          partId: "1",
        },
      ],
    });

    const attachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "2",
        },
      }),
      [200],
    );
    expect(attachment.body).toBeInstanceOf(Blob);
    expect(
      Buffer.from(await attachment.body.arrayBuffer()).equals(
        GMAIL_IMAGE_BYTES,
      ),
    ).toBeTruthy();
    expect(attachment.headers.get("content-type")).toBe("image/png");
    expect(attachment.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''email-test-illustration.png",
    );

    const sent = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(sent.body.mailDraft.status).toBe("sent");
    expect(sent.body.mailDraft.sentGmailMessageId).toBe(GMAIL_SENT_MESSAGE_ID);
    expect(gmail.sentBody).toStrictEqual({ id: GMAIL_DRAFT_ID });
    expect(gmail.sendCount).toBe(1);

    const duplicateSend = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [409],
    );
    expect(duplicateSend.body.error.message).toContain("can no longer be sent");
    expect(gmail.sendCount).toBe(1);

    const page = await chat.listThreadEvents(fixture.actor, fixture.thread.id);
    expect(page.events).toHaveLength(0);
  });

  it("refreshes a linked draft whose subject was initially empty", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    gmail.subject = null;
    gmail.body = "";

    const linked = await linkDraft(fixture);
    expect(gmail.draftReadCount).toBe(1);

    gmail.subject = "Updated subject";
    gmail.body = "Updated body";

    const loaded = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );

    expect(gmail.draftReadCount).toBe(2);
    expect(loaded.body.mailDraft).toMatchObject({
      subject: "Updated subject",
      body: "Updated body",
      status: "draft",
    });
  });

  it("serves an inline image stored directly in the Gmail MIME body", async () => {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi({ inlineImageData: true });

    const linked = await linkDraft(fixture);
    const attachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "2",
        },
      }),
      [200],
    );

    expect(
      Buffer.from(await attachment.body.arrayBuffer()).equals(
        GMAIL_IMAGE_BYTES,
      ),
    ).toBeTruthy();
  });

  it("serves regular attachments stored directly in the Gmail MIME body", async () => {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi({
      regularAttachmentData: true,
      textAttachmentData: true,
    });

    const linked = await linkDraft(fixture);
    const loaded = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(loaded.body.mailDraft.attachments).toContainEqual({
      filename: "report.pdf",
      contentType: "application/pdf",
      size: GMAIL_PDF_BYTES.byteLength,
      partId: "1",
    });

    const attachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "1",
        },
      }),
      [200],
    );
    expect(
      Buffer.from(await attachment.body.arrayBuffer()).equals(GMAIL_PDF_BYTES),
    ).toBeTruthy();

    const textAttachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "3",
        },
      }),
      [200],
    );
    expect(textAttachment.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(
      Buffer.from(await textAttachment.body.arrayBuffer()).equals(
        GMAIL_TEXT_BYTES,
      ),
    ).toBeTruthy();
  });

  it("returns cached mail details and requires reconnect after Gmail rejects access", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);
    gmail.unauthorized = true;

    const unavailable = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(unavailable.body.mailDraft).toMatchObject({
      accessStatus: "reconnect",
      detailAvailable: false,
      status: "draft",
      subject: "Attachment review",
    });

    const gmailReadsAfterUnauthorized = gmail.draftReadCount;
    const cached = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(cached.body.mailDraft.accessStatus).toBe("reconnect");
    expect(gmail.draftReadCount).toBe(gmailReadsAfterUnauthorized);
  });

  it("restores a draft after its Gmail connector is reconnected", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    await connectors.deleteDefaultBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
    );
    const start = await connectors.startOauth(fixture.actor, "gmail", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Gmail OAuth state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "okou-mail-reconnect-code",
      state,
    });

    const restored = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(restored.body.mailDraft).toMatchObject({
      accessStatus: "ready",
      detailAvailable: true,
      from: "sender@example.com",
      status: "draft",
      subject: "Attachment review",
    });
    expect(gmail.draftReadCount).toBe(2);
  });

  it("does not attach an existing draft to a different Gmail account", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    mockGmailConnectorOAuth({
      accessToken: "replacement-gmail-token",
      subject: "replacement-gmail-account",
      email: "replacement@example.com",
    });
    const start = await connectors.startOauth(fixture.actor, "gmail", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Gmail OAuth state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "okou-mail-replacement-account-code",
      state,
    });
    await connectors.deleteBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
      fixture.gmail.id,
    );

    const detached = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(detached.body.mailDraft).toMatchObject({
      accessStatus: "reconnect",
      detailAvailable: false,
      status: "draft",
      subject: "Attachment review",
    });
    expect(detached.body.mailDraft.reconnectConnectionId).toBeUndefined();
    expect(gmail.draftReadCount).toBe(1);
  });

  it("retains the resolved account when a legacy draft needs reconnect", async () => {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    mockGmailConnectorOAuth({
      accessToken: "replacement-gmail-token",
      subject: "replacement-gmail-account",
      email: "replacement@example.com",
    });
    const replacement = await connectors.startOauth(
      fixture.actor,
      "gmail",
      "oauth",
    );
    const replacementState = new URL(
      replacement.authorizationUrl,
    ).searchParams.get("state");
    if (!replacementState) {
      throw new Error("Expected Gmail OAuth state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "replace-original-mail-account",
      state: replacementState,
    });
    await connectors.deleteBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
      fixture.gmail.id,
    );

    const recoveredConnectorId = await addGmailAccount(fixture, {
      accessToken: "recovered-gmail-token",
      email: "sender@example.com",
      subject: "recovered-gmail-account",
    });
    await connectors.setDefaultBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
      recoveredConnectorId,
    );
    const orgId = fixture.actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped mail fixture");
    }
    await setConnectorAccountState(context, {
      orgId,
      userId: fixture.actor.userId,
      connectorId: recoveredConnectorId,
      needsReconnect: true,
    });

    const recovered = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(recovered.body.mailDraft).toMatchObject({
      accessStatus: "reconnect",
      reconnectConnectionId: recoveredConnectorId,
      subject: "Attachment review",
    });
    expect(recoveredConnectorId).not.toBe(fixture.gmail.id);
  });

  it("rejects a missing Gmail draft and cross-chat relinking", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    gmail.exists = false;

    const missing = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Gmail draft not found");

    gmail.exists = true;
    await linkDraft(fixture);
    const otherThread = await chat.createThread(fixture.actor, {
      agentId: fixture.agent.agentId,
      title: "Other mail review",
    });
    const conflict = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: otherThread.id,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(conflict.body.error.message).toContain("already linked");
  });

  it("does not refresh a known mismatched Gmail storage version", async () => {
    const fixture = await seedGmailMailCardFixture();
    await setConnectorCredentialStorageState(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      connectorSlug: "gmail",
      storageVersion: 2,
      tokenExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "must-not-be-written",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Connect and authorize Gmail for this agent first",
    );
    expect(refreshCalls).toBe(0);
  });

  it("requires reconnect when the Gmail token refresh fails", async () => {
    const fixture = await seedGmailMailCardFixture();
    await setConnectorCredentialStorageState(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      connectorSlug: "gmail",
      storageVersion: 1,
      tokenExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.error();
      }),
    );

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );

    expect(response.body.error.message).toBe(
      "Reconnect Gmail before continuing",
    );
  });

  it("does not read Gmail credentials owned by another connector", async () => {
    const fixture = await seedGmailMailCardFixture();
    const foreignConnectorId = await seedConnectorStorageRow(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      connectorSlug: "github",
      authMethod: "oauth",
      storageVersion: 1,
    });
    for (const name of ["GMAIL_ACCESS_TOKEN", "GMAIL_REFRESH_TOKEN"]) {
      await setConnectorSecretOwner(context, {
        connectorId: foreignConnectorId,
        name,
        orgId: fixture.actor.orgId ?? "",
        userId: fixture.actor.userId,
      });
    }
    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "must-not-be-written",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Reconnect Gmail before continuing",
    );
    expect(refreshCalls).toBe(0);
  });

  it("deletes Gmail without removing the linked mail draft", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    await accept(
      client().deleteDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [204],
    );
    expect(gmail.deleteCount).toBe(1);

    const preserved = await accept(
      stateClient().get({
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(preserved.body.exists).toBeTruthy();
  });

  it("only removes the link when its chat thread is deleted", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    await chat.deleteThread(fixture.actor, fixture.thread.id);
    expect(gmail.deleteCount).toBe(0);
    expect(gmail.exists).toBeTruthy();

    const unlinked = await accept(
      stateClient().get({
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(unlinked.body.exists).toBeFalsy();
  });
});
