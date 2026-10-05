import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithAuthMethod,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { createRouteMocks } from "./helpers/route-test";
import {
  readConnectorCredentialStorageState,
  seedBuiltinThreadConnectorSelection,
  seedConnectorStorageRow,
  setBuiltinOAuthScopeFacts,
  setConnectorDefaultState,
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

async function seedGmailMailCardFixture(
  registerCleanup?: (cleanup: () => Promise<void>) => void,
) {
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
  registerCleanup?.(async () => {
    await bdd.deleteAgent(actor, agent.agentId);
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
  registerCleanup?.(async () => {
    await connectors.deleteDefaultBuiltinConnectorAccount(actor, "gmail");
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
  async function preparePinnedNonDefaultGmailDraft() {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi();
    const linked = await linkDraft(fixture);
    const connectorId = fixture.gmail.id;
    await selectGmailAccount(fixture, connectorId);
    const defaultAccessToken = "replacement-default-gmail-token";
    const defaultConnectorId = await addGmailAccount(fixture, {
      accessToken: defaultAccessToken,
      email: "replacement-default@example.com",
      subject: "replacement-default-gmail-account",
    });
    await connectors.setDefaultBuiltinConnectorAccount(
      fixture.actor,
      "gmail",
      defaultConnectorId,
    );

    return {
      fixture,
      linked,
      connectorId,
      defaultConnectorId,
      defaultAccessToken,
    };
  }

  // Connector credential storage exception: no public flow leaves Gmail
  // accounts without a default, so this unchanged case keeps the documented
  // test-state boundary.
  async function prepareGmailDraftWithoutDefaultAccount() {
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

    return { fixture, linked, connectorId };
  }

  it("does not refresh a known mismatched Gmail storage version", async () => {
    const catalog = createPublicConnectorCatalog(context);
    const versionTwo = catalogWithAuthMethod(
      { connectorSlug: "gmail", authMethodId: "oauth" },
      (method) => {
        return { ...method, storage: { ...method.storage, version: 2 } };
      },
    );
    await catalog.publish(versionTwo);
    const fixture = await seedGmailMailCardFixture(catalog.onCleanup);
    catalog.onCleanup(async () => {
      await catalog.publish(versionTwo);
    });
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.json({
          access_token: "gmail-mail-card-token",
          refresh_token: "gmail-refresh-token",
          expires_in: 0,
          token_type: "Bearer",
          scope: GMAIL_MODIFY_SCOPE,
        });
      }),
    );
    const started = await connectors.startOauth(
      fixture.actor,
      "gmail",
      "oauth",
      undefined,
      {
        intent: "reconnect",
        connectionId: fixture.gmail.id,
      },
    );
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Gmail reconnect state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "expired-version-two",
      state,
    });
    // The real OAuth response makes the token expired without a private date write.
    // Catalog publication leaves the account at version2 while selecting version1.
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);
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
    await catalog.cleanup();
  });
});
