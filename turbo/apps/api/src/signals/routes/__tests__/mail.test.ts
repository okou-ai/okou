import { randomUUID } from "node:crypto";
import {
  connectorAccountsContract,
  type ConnectorAccountSelection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  chatThreadByIdContract,
  chatThreadConnectorSelectionContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { mailDraftChangedEvent } from "@okouai/api-contracts/contracts/realtime";
import { runWebhookContract } from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadDeleteRoutes } from "../chat-threads-delete";
import { connectorAccountRoutes } from "../connector-accounts";
import { mailRoutes } from "../mail";
import { webhooksAgentGmailDraftUpdatedRoutes } from "../webhooks-agent-gmail-draft-updated";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const chats = createChatFilesBddApi(context);
const access = createChatConnectorAccessApi(context);
const mail = setupApp({ context, routes: mailRoutes })(mailContract);
const rawRequest = setupRawAppRequest({ context, routes: mailRoutes });
const threads = setupApp({ context, routes: chatThreadDeleteRoutes })(
  chatThreadByIdContract,
);
const selections = setupApp({
  context,
  routes: chatThreadConnectorSelectionRoutes,
})(chatThreadConnectorSelectionContract);
const connectorAccess = setupApp({
  context,
  routes: chatConnectorAccessRoutes,
})(chatConnectorAccessContract);
const accounts = setupApp({ context, routes: connectorAccountRoutes })(
  connectorAccountsContract,
);

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function as(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function gmailDraftResource(
  draftId: string,
  options: { readonly subject?: string; readonly body?: string } = {},
) {
  const body = options.body ?? "Please review the attachment.";
  return {
    id: draftId,
    message: {
      id: `${draftId}-message`,
      threadId: `${draftId}-thread`,
      payload: {
        partId: "",
        mimeType: "text/plain",
        filename: "",
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "recipient@example.com" },
          { name: "Subject", value: options.subject ?? "Attachment review" },
        ],
        body: { size: body.length, data: base64Url(body) },
      },
    },
  };
}

interface GmailRecorder {
  readonly sends: unknown[];
  readonly deletes: string[];
}

function mockGmail(
  token: string,
  drafts: Record<string, () => Response>,
  send: () => Response = () => {
    return HttpResponse.json({ id: "sent-message", threadId: "sent-thread" });
  },
): GmailRecorder {
  const recorder: GmailRecorder = { sends: [], deletes: [] };
  function owned(request: Request): boolean {
    return request.headers.get("authorization") === `Bearer ${token}`;
  }
  server.use(
    http.post(`${GMAIL}/drafts/send`, async ({ request }) => {
      if (!owned(request)) {
        return undefined;
      }
      recorder.sends.push(await request.json());
      return send();
    }),
    http.get(`${GMAIL}/drafts/:draftId`, ({ request, params }) => {
      if (!owned(request)) {
        return undefined;
      }
      const respond = drafts[String(params.draftId)];
      return respond
        ? respond()
        : HttpResponse.json({ error: { code: 404 } }, { status: 404 });
    }),
    http.get(`${GMAIL}/messages/:messageId`, ({ request, params }) => {
      if (!owned(request)) {
        return undefined;
      }
      const draft = gmailDraftResource(String(params.messageId));
      return HttpResponse.json(draft.message);
    }),
    http.delete(`${GMAIL}/drafts/:draftId`, ({ request, params }) => {
      if (!owned(request)) {
        return undefined;
      }
      recorder.deletes.push(String(params.draftId));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return recorder;
}

function gmailJson(draftId: string): () => Response {
  return () => {
    return HttpResponse.json(gmailDraftResource(draftId));
  };
}

function oauthState(authorizationUrl: string): string {
  const value = new URL(authorizationUrl).searchParams.get("state");
  if (!value) {
    throw new Error("Missing provider state");
  }
  return value;
}

async function connectGmail(
  actor: ApiTestUser,
  options: {
    readonly subject?: string;
    readonly email?: string;
    readonly grantedScope?: string;
    readonly expiringRefreshTo?: string;
  } = {},
): Promise<{ readonly connectionId: string; readonly token: string }> {
  const token = `gmail-token-${randomUUID()}`;
  mockGmailConnectorOAuth({
    subject: options.subject ?? `gmail-${actor.userId}`,
    email: options.email ?? "sender@example.com",
    accessToken: token,
  });
  const grantedScope = options.grantedScope;
  if (grantedScope !== undefined) {
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.json({
          access_token: token,
          refresh_token: "gmail-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: grantedScope,
        });
      }),
    );
  }
  const refreshTo = options.expiringRefreshTo;
  if (refreshTo !== undefined) {
    const refreshToken = `refresh-${token}`;
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        const body = new URLSearchParams(await request.clone().text());
        const grant = body.get("grant_type");
        if (
          grant === "refresh_token" &&
          body.get("refresh_token") !== refreshToken
        ) {
          return undefined;
        }
        return HttpResponse.json({
          access_token: grant === "refresh_token" ? refreshTo : token,
          refresh_token: refreshToken,
          expires_in: 30,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }),
    );
  }
  const started = await connectors.startOauth(actor, "gmail", "oauth");
  const callback = await connectors.completeOauthCallbackResult("gmail", {
    code: "authorized",
    state: oauthState(started.authorizationUrl),
  });
  expect(callback.body.status).toBe("success");
  const completed = await accept(
    accounts.oauthCompletion({
      headers: as(actor),
      params: { attemptId: started.oauthAttemptId },
      query: { kind: "builtin", connectorSlug: "gmail" },
    }),
    [200],
  );
  return { connectionId: completed.body.connectionId, token };
}

async function gmailMember() {
  const actor = bdd.user();
  const gmail = await connectGmail(actor);
  const thread = await chats.createThread(actor, { model: null });
  return { actor, gmail, thread };
}

async function link(
  actor: ApiTestUser,
  threadId: string,
  gmailDraftId: string,
) {
  return await accept(
    mail.linkDraft({ headers: as(actor), body: { threadId, gmailDraftId } }),
    [200, 400, 404, 409],
  );
}

async function linked(actor: ApiTestUser, threadId: string, draftId: string) {
  const response = await link(actor, threadId, draftId);
  if (response.status !== 200) {
    throw new Error(`Expected a linked draft, got ${response.status}`);
  }
  return response.body;
}

async function readDraft(actor: ApiTestUser, mailDraftId: string) {
  return await accept(
    mail.getDraft({ headers: as(actor), params: { mailDraftId } }),
    [200, 404],
  );
}

async function draftOf(actor: ApiTestUser, mailDraftId: string) {
  const response = await readDraft(actor, mailDraftId);
  if (response.status !== 200) {
    throw new Error(`Expected a mail draft, got ${response.status}`);
  }
  return response.body.mailDraft;
}

async function listThread(actor: ApiTestUser, threadId: string) {
  return await accept(
    mail.listThreadMail({ headers: as(actor), params: { threadId } }),
    [200, 404],
  );
}

async function send(actor: ApiTestUser, mailDraftId: string) {
  return await accept(
    mail.sendDraft({ headers: as(actor), params: { mailDraftId } }),
    [200, 400, 409],
  );
}

async function gmailAccounts(actor: ApiTestUser) {
  return (
    await accept(
      accounts.connections({
        headers: as(actor),
        query: { kind: "builtin", connectorSlug: "gmail" },
      }),
      [200],
    )
  ).body;
}

async function deleteAccount(actor: ApiTestUser, connectionId: string) {
  await accept(
    accounts.delete({
      headers: as(actor),
      params: { connectionId },
      body: { target: { kind: "builtin", connectorSlug: "gmail" } },
    }),
    [200],
  );
}

const GMAIL_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "gmail" as const,
});

async function selectAccount(
  actor: ApiTestUser,
  threadId: string,
  selection: ConnectorAccountSelection,
) {
  await accept(
    selections.update({
      headers: as(actor),
      params: { id: threadId },
      body: selection,
    }),
    [200],
  );
}

async function readSelections(actor: ApiTestUser, threadId: string) {
  return (
    await accept(
      selections.get({ headers: as(actor), params: { id: threadId } }),
      [200],
    )
  ).body;
}

async function pinnedWithReplacementDefault() {
  const { actor, gmail, thread } = await gmailMember();
  mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
  const { mailDraftId } = await linked(actor, thread.id, "r-draft");
  await selectAccount(actor, thread.id, {
    connectionId: gmail.connectionId,
    target: GMAIL_TARGET,
  });
  const replacement = await connectGmail(actor, {
    subject: `replacement-${actor.userId}`,
    email: "replacement@example.com",
  });
  await accept(
    accounts.setDefault({
      headers: as(actor),
      params: { connectionId: replacement.connectionId },
      body: { target: GMAIL_TARGET },
    }),
    [200],
  );
  return { actor, gmail, thread, mailDraftId, replacement };
}

function textPart(partId: string, mimeType: string, value: string) {
  return {
    partId,
    mimeType,
    filename: "",
    headers: [{ name: "Content-Type", value: mimeType }],
    body: { size: value.length, data: base64Url(value) },
  };
}

function multipartDraft(draftId: string, parts: readonly object[]) {
  const draft = gmailDraftResource(draftId);
  return {
    ...draft,
    message: {
      ...draft.message,
      payload: {
        ...draft.message.payload,
        mimeType: "multipart/mixed",
        body: { size: 0 },
        parts,
      },
    },
  };
}

async function download(
  actor: ApiTestUser,
  mailDraftId: string,
  partId: string,
) {
  const response = await accept(
    mail.getAttachment({ headers: as(actor), params: { mailDraftId, partId } }),
    [200],
  );
  if (!(response.body instanceof Blob)) {
    throw new Error("Expected attachment bytes");
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    content: new Uint8Array(await response.body.arrayBuffer()),
  };
}

async function setPolicy(
  actor: ApiTestUser,
  connectionId: string,
  policy: "deny" | "allow-always",
) {
  await accept(
    connectorAccess.updateAccountPolicy({
      headers: as(actor),
      params: { connectionId },
      body: { target: GMAIL_TARGET, policy },
    }),
    [200],
  );
}

async function reconnectRequiredSelection() {
  const { actor, thread } = await gmailMember();
  const second = await connectGmail(actor, {
    subject: `second-${actor.userId}`,
    email: "second@example.com",
  });
  let recovered = false;
  mockGmail(second.token, {
    "r-draft": () => {
      return recovered
        ? HttpResponse.json(gmailDraftResource("r-draft"))
        : HttpResponse.json({ error: { code: 401 } }, { status: 401 });
    },
  });
  await selectAccount(actor, thread.id, {
    connectionId: second.connectionId,
    target: GMAIL_TARGET,
  });
  return {
    actor,
    second,
    thread,
    recover: () => {
      recovered = true;
    },
  };
}

async function customSelection() {
  const actor = bdd.user();
  const connector = await connectors.createCustomConnector(
    actor,
    manualHttpCustomConnectorCreateBody({
      displayName: "Mail relay",
      prefixTemplates: ["https://mail-relay.example.test/"],
    }),
  );
  const account = await connectors.setCustomConnectorValues(
    actor,
    connector.id,
    [{ key: "secret", kind: "secret", value: `secret-${randomUUID()}` }],
  );
  const thread = await chats.createThread(actor, { model: null });
  const selection = {
    connectionId: account.connectionId,
    target: { kind: "custom" as const, customConnectorId: connector.id },
  };
  await selectAccount(actor, thread.id, selection);
  const before = await readSelections(actor, thread.id);
  expect(before.selections).toStrictEqual([selection]);
  expect(before.selectedConnections).toMatchObject([
    { id: account.connectionId },
  ]);
  return { actor, connector, thread };
}

describe("POST /api/mail/drafts/link", () => {
  it("mail-020 rejects a Gmail draft ID with extra text before reading the draft", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, {});
    const response = await link(actor, thread.id, "Draft r-test-draft");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message:
          "Invalid Gmail draft ID. Pass only the top-level id returned by Gmail when creating the draft.",
      },
    });
  });

  it("mail-064 rejects a missing Gmail draft", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, {});
    const response = await link(actor, thread.id, "r-missing-draft");
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: { message: "Gmail draft not found" },
    });
  });

  it("mail-066 deletes Gmail without removing the linked mail draft", async () => {
    const { actor, gmail, thread } = await gmailMember();
    const recorder = mockGmail(gmail.token, {
      "r-draft": gmailJson("r-draft"),
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    await accept(
      mail.deleteDraft({ headers: as(actor), params: { mailDraftId } }),
      [204],
    );
    expect(recorder.deletes).toStrictEqual(["r-draft"]);
    const response = await readDraft(actor, mailDraftId);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      mailDraftId,
      mailDraft: {
        status: "deleted",
        detailAvailable: false,
        subject: "Attachment review",
      },
    });
  });
  it("mail-022 (1/2) converges simultaneous same-chat links into one readable draft", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const [first, second] = await Promise.all([
      link(actor, thread.id, "r-draft"),
      link(actor, thread.id, "r-draft"),
    ]);
    expect(first.status).toBe(200);
    expect(second.body).toStrictEqual(first.body);
    if (!("mailDraftId" in first.body)) {
      throw new Error("Expected a linked draft");
    }
    const { mailDraftId } = first.body;
    expect(first.body.mailDraftUrl).toBe(
      `https://app.okou.ai/mail/drafts/${mailDraftId}`,
    );
    const draft = await draftOf(actor, mailDraftId);
    expect(draft).toMatchObject({
      provider: "gmail",
      gmailDraftId: "r-draft",
      gmailThreadId: "r-draft-thread",
      gmailMessageId: "r-draft-message",
      status: "draft",
      detailAvailable: true,
      from: "sender@example.com",
      subject: "Attachment review",
    });
  });

  it("mail-022 (2/2) preserves replay and rejects a cross-chat link of the same draft", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const original = await linked(actor, thread.id, "r-draft");
    await expect(link(actor, thread.id, "r-draft")).resolves.toMatchObject({
      status: 200,
      body: original,
    });
    const otherThread = await chats.createThread(actor, { model: null });
    const conflict = await link(actor, otherThread.id, "r-draft");
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { message: "This Gmail draft is already linked to another chat" },
    });
    await expect(link(actor, thread.id, "r-draft")).resolves.toMatchObject({
      status: 200,
      body: original,
    });
  });

  it("mail-029 requires reconnect when Gmail reports an insufficient token scope", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, {
      "r-draft": () => {
        return HttpResponse.json(
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Request had insufficient authentication scopes.",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  domain: "googleapis.com",
                  reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
                },
              ],
            },
          },
          { status: 403 },
        );
      },
    });
    const response = await link(actor, thread.id, "r-draft");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { message: "Reconnect Gmail before continuing" },
    });
    const saved = await gmailAccounts(actor);
    expect(saved.defaultConnection).toMatchObject({
      id: gmail.connectionId,
      connectionStatus: "reconnect-required",
    });
  });

  it("mail-030 does not require reconnect for an unrelated Gmail permission denial", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, {
      "r-draft": () => {
        return HttpResponse.json(
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "The caller does not have permission",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  domain: "gmail.googleapis.com",
                  reason: "PERMISSION_DENIED",
                },
              ],
            },
          },
          { status: 403 },
        );
      },
    });
    const response = await rawRequest("/api/mail/drafts/link", {
      method: "POST",
      headers: { ...as(actor), "content-type": "application/json" },
      body: JSON.stringify({ threadId: thread.id, gmailDraftId: "r-draft" }),
    });
    expect(response.status).toBe(500);
    const saved = await gmailAccounts(actor);
    expect(saved.defaultConnection).toMatchObject({
      id: gmail.connectionId,
      connectionStatus: "connected",
    });
  });

  it("mail-054 requires reconnect when Gmail rejects authorization during send with 401", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") }, () => {
      return HttpResponse.json({ error: { code: 401 } }, { status: 401 });
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    const response = await send(actor, mailDraftId);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { message: "Reconnect Gmail before continuing" },
    });
    const saved = await gmailAccounts(actor);
    expect(saved.defaultConnection).toMatchObject({
      id: gmail.connectionId,
      connectionStatus: "reconnect-required",
    });
  });

  it("mail-037 keeps a rejected Gmail draft available for correction and an explicit later send (status present: false)", async () => {
    const { actor, gmail, thread } = await gmailMember();
    let accepted = false;
    const recorder = mockGmail(
      gmail.token,
      { "r-draft": gmailJson("r-draft") },
      () => {
        return accepted
          ? HttpResponse.json({ id: "sent-message", threadId: "sent-thread" })
          : HttpResponse.json(
              {
                error: {
                  code: 400,
                  message: "Invalid To header",
                  errors: [
                    {
                      domain: "global",
                      reason: "badRequest",
                      message: "Invalid To",
                    },
                  ],
                },
              },
              { status: 400 },
            );
      },
    );
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    const rejected = await send(actor, mailDraftId);
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message:
          "Gmail rejected this draft. Open it in Gmail and check its recipients and content before trying again.",
      },
    });
    expect(recorder.sends).toStrictEqual([{ id: "r-draft" }]);
    const draft = await draftOf(actor, mailDraftId);
    expect(draft.status).toBe("draft");
    expect("sentGmailMessageId" in draft).toBeFalsy();
    const saved = await gmailAccounts(actor);
    expect(saved.defaultConnection?.connectionStatus).toBe("connected");
    accepted = true;
    const later = await send(actor, mailDraftId);
    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({ mailDraft: { status: "sent" } });
    expect(recorder.sends).toStrictEqual([
      { id: "r-draft" },
      { id: "r-draft" },
    ]);
  });

  it("mail-039 preserves a Gmail send failure for unknown reason", async () => {
    const { actor, gmail, thread } = await gmailMember();
    const recorder = mockGmail(
      gmail.token,
      { "r-draft": gmailJson("r-draft") },
      () => {
        return HttpResponse.json(
          {
            error: {
              code: 400,
              message: "Unknown failure",
              errors: [{ domain: "global", reason: "private@example.com" }],
            },
          },
          { status: 400 },
        );
      },
    );
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    const response = await rawRequest(`/api/mail/drafts/${mailDraftId}/send`, {
      method: "POST",
      headers: as(actor),
    });
    expect(response.status).toBe(500);
    expect(recorder.sends).toStrictEqual([{ id: "r-draft" }]);
    const draft = await draftOf(actor, mailDraftId);
    expect(draft.status).toBe("draft");
    expect("sentGmailMessageId" in draft).toBeFalsy();
    const saved = await gmailAccounts(actor);
    expect(saved.defaultConnection?.connectionStatus).toBe("connected");
  });

  it("mail-056 refreshes a linked draft whose subject was initially empty", async () => {
    const { actor, gmail, thread } = await gmailMember();
    let current = gmailDraftResource("r-draft", { subject: "", body: "" });
    mockGmail(gmail.token, {
      "r-draft": () => {
        return HttpResponse.json(current);
      },
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    current = gmailDraftResource("r-draft", {
      subject: "Updated subject",
      body: "Updated body",
    });
    const draft = await draftOf(actor, mailDraftId);
    expect(draft).toMatchObject({
      subject: "Updated subject",
      body: "Updated body",
      status: "draft",
    });
  });

  it("mail-059 returns cached mail details and requires reconnect after Gmail rejects access", async () => {
    const { actor, gmail, thread } = await gmailMember();
    let revoked = false;
    mockGmail(gmail.token, {
      "r-draft": () => {
        return revoked
          ? HttpResponse.json({ error: { code: 401 } }, { status: 401 })
          : HttpResponse.json(gmailDraftResource("r-draft"));
      },
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    revoked = true;
    const expected = {
      accessStatus: "reconnect",
      detailAvailable: false,
      status: "draft",
      subject: "Attachment review",
    };
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject(expected);
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject(expected);
  });

  it("mail-027 uses a healthy Gmail connection with its provider-granted scope", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const saved = await gmailAccounts(actor);
    const expected = {
      id: gmail.connectionId,
      oauthScopes: ["https://www.googleapis.com/auth/gmail.modify"],
      connectionStatus: "connected",
    };
    expect(saved.defaultConnection).toMatchObject(expected);
    expect(saved.connections).toHaveLength(1);
    expect(saved.connections[0]).toMatchObject(expected);
    const response = await link(actor, thread.id, "r-draft");
    expect(response.status).toBe(200);
  });
  it("mail-028 rejects a known-insufficient Gmail grant before provider access", async () => {
    const actor = bdd.user();
    const gmail = await connectGmail(actor, { grantedScope: "" });
    const thread = await chats.createThread(actor, { model: null });
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const response = await link(actor, thread.id, "r-draft");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { message: "Connect and allow Gmail in this Chat first" },
    });
  });

  it("mail-025 (1/2) hides the thread from callers outside the member's own workspace", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const colleague = bdd.user({ orgId: actor.orgId });
    const elsewhere = bdd.user({ userId: actor.userId });
    await expect(link(colleague, thread.id, "r-draft")).resolves.toMatchObject({
      status: 404,
    });
    await expect(link(elsewhere, thread.id, "r-draft")).resolves.toMatchObject({
      status: 404,
    });
  });

  it("mail-025 (2/2) links only after a thread override allows Gmail disabled by default", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const selection = {
      connectionId: gmail.connectionId,
      target: GMAIL_TARGET,
    };
    await access.setDefault(actor, selection, false);
    await expect(link(actor, thread.id, "r-draft")).resolves.toMatchObject({
      status: 409,
    });
    await access.setThreadOverride(actor, thread.id, selection, true);
    await expect(link(actor, thread.id, "r-draft")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("mail-067 only removes the link when its chat thread is deleted", async () => {
    const { actor, gmail, thread } = await gmailMember();
    const recorder = mockGmail(gmail.token, {
      "r-draft": gmailJson("r-draft"),
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    await accept(
      threads.delete({ headers: as(actor), params: { id: thread.id } }),
      [204],
    );
    await expect(readDraft(actor, mailDraftId)).resolves.toMatchObject({
      status: 404,
    });
    const next = await chats.createThread(actor, { model: null });
    const relinked = await linked(actor, next.id, "r-draft");
    expect(relinked.mailDraftId).not.toBe(mailDraftId);
    expect(recorder.deletes).toStrictEqual([]);
  });

  it("mail-062 does not attach an existing draft to a different Gmail account", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    const replacement = await connectGmail(actor, {
      subject: `replacement-${actor.userId}`,
      email: "replacement@example.com",
    });
    mockGmail(replacement.token, { "r-draft": gmailJson("r-draft") });
    await deleteAccount(actor, gmail.connectionId);
    const draft = await draftOf(actor, mailDraftId);
    expect(draft).toMatchObject({
      accessStatus: "reconnect",
      detailAvailable: false,
      status: "draft",
      subject: "Attachment review",
    });
    expect("reconnectConnectionId" in draft).toBeFalsy();
  });

  it("mail-061 restores a draft after its Gmail connector is reconnected", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    await deleteAccount(actor, gmail.connectionId);
    const again = await connectGmail(actor);
    mockGmail(again.token, { "r-draft": gmailJson("r-draft") });
    const draft = await draftOf(actor, mailDraftId);
    expect(draft).toMatchObject({
      accessStatus: "ready",
      detailAvailable: true,
      from: "sender@example.com",
      status: "draft",
      subject: "Attachment review",
    });
  });
  it("mail-032 rejects a new draft after the Gmail account is publicly disconnected", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    await linked(actor, thread.id, "r-draft");
    await selectAccount(actor, thread.id, {
      connectionId: gmail.connectionId,
      target: GMAIL_TARGET,
    });
    await deleteAccount(actor, gmail.connectionId);
    const next = await chats.createThread(actor, { model: null });
    const response = await link(actor, next.id, "r-draft");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { message: "Connect and allow Gmail in this Chat first" },
    });
  });

  it("mail-034 clears the exact thread selection after custom connector disconnect", async () => {
    const { actor, connector, thread } = await customSelection();
    await connectors.deleteDefaultCustomConnectorAccount(actor, connector.id);
    await expect(readSelections(actor, thread.id)).resolves.toStrictEqual({
      selections: [],
      selectedConnections: [],
    });
  });

  it("mail-035 clears the exact thread selection after custom connector delete", async () => {
    const { actor, connector, thread } = await customSelection();
    await connectors.deleteCustomConnector(actor, connector.id);
    await expect(readSelections(actor, thread.id)).resolves.toStrictEqual({
      selections: [],
      selectedConnections: [],
    });
  });
  it("mail-023 uses the thread-selected Gmail account without probing the default", async () => {
    const { actor, thread } = await gmailMember();
    const second = await connectGmail(actor, {
      subject: `second-${actor.userId}`,
      email: "second@example.com",
    });
    let revoked = false;
    mockGmail(second.token, {
      "r-draft": () => {
        return revoked
          ? HttpResponse.json({ error: { code: 401 } }, { status: 401 })
          : HttpResponse.json(gmailDraftResource("r-draft"));
      },
    });
    await selectAccount(actor, thread.id, {
      connectionId: second.connectionId,
      target: GMAIL_TARGET,
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      detailAvailable: true,
    });
    revoked = true;
    const draft = await draftOf(actor, mailDraftId);
    expect(draft.reconnectConnectionId).toBe(second.connectionId);
  });

  it("mail-024 (1/2) requires reconnect for the selected Gmail account without falling back", async () => {
    const { actor, second, thread } = await reconnectRequiredSelection();
    const first = await link(actor, thread.id, "r-draft");
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({
      error: { message: "Reconnect Gmail before continuing" },
    });
    const saved = await gmailAccounts(actor);
    expect(
      saved.connections.find((connection) => {
        return connection.id === second.connectionId;
      }),
    ).toMatchObject({ connectionStatus: "reconnect-required" });
  });

  it("mail-024 (2/2) keeps refusing the link after Gmail access recovers", async () => {
    const { actor, thread, recover } = await reconnectRequiredSelection();
    await expect(link(actor, thread.id, "r-draft")).resolves.toMatchObject({
      status: 409,
    });
    recover();
    const retry = await link(actor, thread.id, "r-draft");
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({
      error: { message: "Connect and allow Gmail in this Chat first" },
    });
  });

  it("mail-031 reads an existing draft from its pinned Gmail account after changing the Chat selection", async () => {
    const { actor, gmail, thread, mailDraftId, replacement } =
      await pinnedWithReplacementDefault();
    await selectAccount(actor, thread.id, {
      connectionId: replacement.connectionId,
      target: GMAIL_TARGET,
    });
    const saved = await gmailAccounts(actor);
    expect(saved.defaultConnection?.id).toBe(replacement.connectionId);
    expect(
      saved.connections.some((connection) => {
        return connection.id === gmail.connectionId;
      }),
    ).toBeTruthy();
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      accessStatus: "ready",
      detailAvailable: true,
      from: "sender@example.com",
    });
  });

  it("mail-033 (1/3) keeps the pinned Gmail account selected before deletion", async () => {
    const { actor, gmail, thread } = await pinnedWithReplacementDefault();
    const before = await readSelections(actor, thread.id);
    expect(before.selections).toStrictEqual([
      { connectionId: gmail.connectionId, target: GMAIL_TARGET },
    ]);
  });

  it("mail-033 (2/3) selects the surviving default after the pinned Gmail account is deleted", async () => {
    const { actor, gmail, thread, replacement } =
      await pinnedWithReplacementDefault();
    await deleteAccount(actor, gmail.connectionId);
    const after = await readSelections(actor, thread.id);
    expect(after.selections).toStrictEqual([
      { connectionId: replacement.connectionId, target: GMAIL_TARGET },
    ]);
    expect(after.selectedConnections).toMatchObject([
      { id: replacement.connectionId },
    ]);
  });

  it("mail-033 (3/3) links a new draft with the surviving default account", async () => {
    const { actor, gmail, thread, replacement } =
      await pinnedWithReplacementDefault();
    await deleteAccount(actor, gmail.connectionId);
    mockGmail(replacement.token, { "r-next": gmailJson("r-next") });
    await expect(link(actor, thread.id, "r-next")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("mail-057 serves an inline image stored directly in the Gmail MIME body", async () => {
    const { actor, gmail, thread } = await gmailMember();
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    mockGmail(gmail.token, {
      "r-inline": () => {
        return HttpResponse.json(
          multipartDraft("r-inline", [
            textPart("0", "text/plain", "See the logo."),
            textPart(
              "1",
              "text/html",
              '<p>See <img src="cid:logo" alt="Logo"></p>',
            ),
            {
              partId: "2",
              mimeType: "image/png",
              filename: "logo.png",
              headers: [{ name: "Content-ID", value: "<logo>" }],
              body: { size: image.length, data: base64Url(image) },
            },
          ]),
        );
      },
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-inline");
    const bytes = await download(actor, mailDraftId, "2");
    expect(bytes.status).toBe(200);
    expect(bytes.content).toStrictEqual(image);
  });

  it("mail-058 serves regular attachments stored directly in the Gmail MIME body", async () => {
    const { actor, gmail, thread } = await gmailMember();
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4 decision report"));
    const text = new Uint8Array(Buffer.from("Decision: approved"));
    mockGmail(gmail.token, {
      "r-files": () => {
        return HttpResponse.json(
          multipartDraft("r-files", [
            textPart("0", "text/plain", "Files attached."),
            {
              partId: "1",
              mimeType: "application/pdf",
              filename: "report.pdf",
              headers: [],
              body: { size: pdf.length, data: base64Url(pdf) },
            },
            {
              partId: "3",
              mimeType: "text/plain",
              filename: "decision.txt",
              headers: [],
              body: { size: text.length, data: base64Url(text) },
            },
          ]),
        );
      },
    });
    const { mailDraftId } = await linked(actor, thread.id, "r-files");
    const draft = await draftOf(actor, mailDraftId);
    expect(draft.attachments).toContainEqual({
      filename: "report.pdf",
      contentType: "application/pdf",
      size: pdf.length,
      partId: "1",
    });
    const report = await download(actor, mailDraftId, "1");
    expect(report.content).toStrictEqual(pdf);
    const decision = await download(actor, mailDraftId, "3");
    expect(decision.content).toStrictEqual(text);
    expect(decision.contentType).toBe("application/octet-stream");
  });
  it("mail-026 follows member account eligibility when the Chat owner links a Gmail draft", async () => {
    const { actor, gmail, thread } = await gmailMember();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected a workspace member");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId },
      { memberConnectorAccountAccess: true },
    );
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    await setPolicy(actor, gmail.connectionId, "deny");
    const denied = await link(actor, thread.id, "r-draft");
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({
      error: { message: "Connect and allow Gmail in this Chat first" },
    });
    await setPolicy(actor, gmail.connectionId, "allow-always");
    await expect(link(actor, thread.id, "r-draft")).resolves.toMatchObject({
      status: 200,
    });
  });

  async function connectGmailFast(
    actor: ApiTestUser,
    options: { readonly expiringRefreshTo?: string } = {},
  ): Promise<string> {
    const token = `gmail-token-${randomUUID()}`;
    mockGmailConnectorOAuth({
      subject: `gmail-${actor.userId}`,
      email: "sender@example.com",
      accessToken: token,
    });
    const refreshTo = options.expiringRefreshTo;
    if (refreshTo !== undefined) {
      const refreshToken = `refresh-${token}`;
      server.use(
        http.post(
          "https://oauth2.googleapis.com/token",
          async ({ request }) => {
            const body = new URLSearchParams(await request.clone().text());
            const grant = body.get("grant_type");
            if (
              grant === "refresh_token" &&
              body.get("refresh_token") !== refreshToken
            ) {
              return undefined;
            }
            return HttpResponse.json({
              access_token: grant === "refresh_token" ? refreshTo : token,
              refresh_token: refreshToken,
              expires_in: 30,
              token_type: "Bearer",
              scope: "https://www.googleapis.com/auth/gmail.modify",
            });
          },
        ),
      );
    }
    const started = await connectors.startOauth(actor, "gmail", "oauth");
    const callback = await connectors.completeOauthCallbackResult("gmail", {
      code: "authorized",
      state: oauthState(started.authorizationUrl),
    });
    expect(callback.body.status).toBe("success");
    return token;
  }

  it("mail-075 (1/2) refreshes an actor's expired Gmail token without changing another actor's account", async () => {
    const otherActor = bdd.user();
    const [otherToken, otherThread] = await Promise.all([
      connectGmailFast(otherActor),
      chats.createThread(otherActor, { model: null }),
    ]);
    mockGmail(otherToken, { "r-other": gmailJson("r-other") });
    const [, otherBefore] = await Promise.all([
      linked(otherActor, otherThread.id, "r-other"),
      gmailAccounts(otherActor),
    ]);

    const actor = bdd.user();
    const refreshed = `refreshed-${randomUUID()}`;
    const [, thread] = await Promise.all([
      connectGmailFast(actor, { expiringRefreshTo: refreshed }),
      chats.createThread(actor, { model: null }),
    ]);
    mockGmail(refreshed, { "r-draft": gmailJson("r-draft") });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");

    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      detailAvailable: true,
    });
    await expect(gmailAccounts(otherActor)).resolves.toStrictEqual(otherBefore);
  });

  it("mail-075 (2/2) keeps another actor's Gmail draft readable after the first actor refreshes", async () => {
    const otherActor = bdd.user();
    const [otherToken, otherThread] = await Promise.all([
      connectGmailFast(otherActor),
      chats.createThread(otherActor, { model: null }),
    ]);
    mockGmail(otherToken, { "r-other": gmailJson("r-other") });
    const otherDraft = await linked(otherActor, otherThread.id, "r-other");

    const actor = bdd.user();
    const refreshed = `refreshed-${randomUUID()}`;
    const [, thread] = await Promise.all([
      connectGmailFast(actor, { expiringRefreshTo: refreshed }),
      chats.createThread(actor, { model: null }),
    ]);
    mockGmail(refreshed, { "r-draft": gmailJson("r-draft") });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");

    await draftOf(actor, mailDraftId);
    await expect(
      draftOf(otherActor, otherDraft.mailDraftId),
    ).resolves.toMatchObject({ detailAvailable: true });
  });
});

describe("thread email list", () => {
  it("mail-019 does not disclose another user's thread", async () => {
    const { actor } = await gmailMember();
    const other = bdd.user();
    const otherThread = await chats.createThread(other, { model: null });
    const missing = await listThread(actor, randomUUID());
    const foreign = await listThread(actor, otherThread.id);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toStrictEqual(missing.body);
  });

  it("mail-018 omits deleted drafts immediately and keeps their original links unavailable", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    await accept(
      mail.deleteDraft({ headers: as(actor), params: { mailDraftId } }),
      [204],
    );
    const list = await listThread(actor, thread.id);
    expect(list.body).toStrictEqual({ mails: [] });
    const draft = await draftOf(actor, mailDraftId);
    expect(draft).toMatchObject({ status: "deleted", detailAvailable: false });
  });

  it("mail-016 lists linked drafts, then sent emails, and refuses to delete sent mail", async () => {
    const { actor, gmail, thread } = await gmailMember();
    mockGmail(gmail.token, { "r-draft": gmailJson("r-draft") });
    const { mailDraftId } = await linked(actor, thread.id, "r-draft");
    const first = await listThread(actor, thread.id);
    expect(first.body).toStrictEqual({
      mails: [
        {
          mailDraftId,
          status: "draft",
          subject: "Attachment review",
          from: "sender@example.com",
          createdAt: expect.any(String),
        },
      ],
    });
    const sent = await send(actor, mailDraftId);
    expect(sent.status).toBe(200);
    const afterSend = await listThread(actor, thread.id);
    expect(afterSend.body).toMatchObject({
      mails: [{ mailDraftId, status: "sent", subject: "Attachment review" }],
    });
    const deleted = await accept(
      mail.deleteDraft({ headers: as(actor), params: { mailDraftId } }),
      [204, 409],
    );
    expect(deleted.status).toBe(409);
    await expect(listThread(actor, thread.id)).resolves.toMatchObject({
      body: afterSend.body,
    });
  });
});

const OUTLOOK_GRAPH = "https://graph.microsoft.com/v1.0/me";

interface OutlookAttachmentFixture {
  readonly "@odata.type": string;
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly isInline: boolean;
  readonly contentId?: string;
  readonly contentBytes: string;
}

function outlookMessageResource(
  messageId: string,
  options: {
    readonly subject?: string;
    readonly isDraft?: boolean;
    readonly sentDateTime?: string | null;
    readonly inReplyTo?: string;
  } = {},
) {
  return {
    id: messageId,
    conversationId: `${messageId}-conversation`,
    isDraft: options.isDraft ?? true,
    from: {
      emailAddress: {
        address: "outlook-sender@example.com",
        name: "Outlook Sender",
      },
    },
    toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
    ccRecipients: [],
    bccRecipients: [],
    replyTo: [],
    subject: options.subject ?? "Outlook review",
    body: {
      contentType: "html",
      content: "<p>Please review the Outlook draft.</p>",
    },
    ...(options.sentDateTime === undefined
      ? {}
      : { sentDateTime: options.sentDateTime }),
    internetMessageHeaders: options.inReplyTo
      ? [{ name: "In-Reply-To", value: options.inReplyTo }]
      : [],
  };
}

interface OutlookRecorder {
  readonly sends: string[];
  readonly deletes: string[];
}

function mockOutlook(
  token: string,
  options: {
    readonly messages: Readonly<Record<string, () => Response>>;
    readonly attachments?: Readonly<
      Record<string, readonly OutlookAttachmentFixture[]>
    >;
    readonly send?: (messageId: string) => Response;
  },
): OutlookRecorder {
  const recorder: OutlookRecorder = { sends: [], deletes: [] };
  function owned(request: Request): boolean {
    return request.headers.get("authorization") === `Bearer ${token}`;
  }
  server.use(
    http.get(`${OUTLOOK_GRAPH}/messages/:messageId`, ({ request, params }) => {
      if (!owned(request)) {
        return undefined;
      }
      const respond = options.messages[String(params.messageId)];
      return respond
        ? respond()
        : HttpResponse.json(
            { error: { code: "ErrorItemNotFound" } },
            { status: 404 },
          );
    }),
    http.get(
      `${OUTLOOK_GRAPH}/messages/:messageId/attachments`,
      ({ request, params }) => {
        if (!owned(request)) {
          return undefined;
        }
        const items = options.attachments?.[String(params.messageId)] ?? [];
        return HttpResponse.json({
          value: items.map((item) => {
            return {
              "@odata.type": item["@odata.type"],
              id: item.id,
              name: item.name,
              contentType: item.contentType,
              size: item.size,
              isInline: item.isInline,
            };
          }),
        });
      },
    ),
    http.get(
      `${OUTLOOK_GRAPH}/messages/:messageId/attachments/:attachmentId`,
      ({ request, params }) => {
        if (!owned(request)) {
          return undefined;
        }
        const items = options.attachments?.[String(params.messageId)] ?? [];
        const found = items.find((item) => {
          return item.id === String(params.attachmentId);
        });
        return found
          ? HttpResponse.json(found)
          : HttpResponse.json(
              { error: { code: "ErrorItemNotFound" } },
              { status: 404 },
            );
      },
    ),
    http.post(
      `${OUTLOOK_GRAPH}/messages/:messageId/send`,
      ({ request, params }) => {
        if (!owned(request)) {
          return undefined;
        }
        const messageId = String(params.messageId);
        recorder.sends.push(messageId);
        return options.send
          ? options.send(messageId)
          : new HttpResponse(null, { status: 202 });
      },
    ),
    http.delete(
      `${OUTLOOK_GRAPH}/messages/:messageId`,
      ({ request, params }) => {
        if (!owned(request)) {
          return undefined;
        }
        recorder.deletes.push(String(params.messageId));
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  return recorder;
}

async function connectOutlook(
  actor: ApiTestUser,
  options: { readonly subject?: string; readonly email?: string } = {},
): Promise<{ readonly connectionId: string; readonly token: string }> {
  mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "outlook-test-client-id");
  mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "outlook-test-client-secret");
  const token = `outlook-token-${randomUUID()}`;
  const subject = options.subject ?? `outlook-${actor.userId}`;
  const email = options.email ?? "outlook-sender@example.com";
  server.use(
    http.post(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      () => {
        return HttpResponse.json({
          access_token: token,
          refresh_token: `outlook-refresh-${token}`,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "Mail.ReadWrite Mail.Send User.Read offline_access",
        });
      },
    ),
    http.get(OUTLOOK_GRAPH, ({ request }) => {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return undefined;
      }
      return HttpResponse.json({
        id: subject,
        mail: email,
        userPrincipalName: email,
        displayName: "Outlook Sender",
      });
    }),
  );
  const started = await connectors.startOauth(actor, "outlook-mail", "oauth");
  const callback = await connectors.completeOauthCallbackResult(
    "outlook-mail",
    {
      code: "authorized",
      state: oauthState(started.authorizationUrl),
    },
  );
  expect(callback.body.status).toBe("success");
  const completed = await accept(
    accounts.oauthCompletion({
      headers: as(actor),
      params: { attemptId: started.oauthAttemptId },
      query: { kind: "builtin", connectorSlug: "outlook-mail" },
    }),
    [200],
  );
  return { connectionId: completed.body.connectionId, token };
}

async function outlookMember() {
  const actor = bdd.user();
  const outlook = await connectOutlook(actor);
  const thread = await chats.createThread(actor, { model: null });
  return { actor, outlook, thread };
}

async function linkOutlook(
  actor: ApiTestUser,
  threadId: string,
  outlookMessageId: string,
) {
  return await accept(
    mail.linkDraft({
      headers: as(actor),
      body: { threadId, provider: "outlook", outlookMessageId },
    }),
    [200, 400, 404, 409],
  );
}

async function linkedOutlook(
  actor: ApiTestUser,
  threadId: string,
  outlookMessageId: string,
) {
  const response = await linkOutlook(actor, threadId, outlookMessageId);
  if (response.status !== 200) {
    throw new Error(`Expected a linked Outlook draft, got ${response.status}`);
  }
  return response.body;
}

describe("Outlook mail in chat", () => {
  it("mail-001 returns an actionable 400 for a malformed message ID (ErrorInvalidIdMalformed)", async () => {
    const { actor, outlook, thread } = await outlookMember();
    mockOutlook(outlook.token, {
      messages: {
        "malformed-id": () => {
          return HttpResponse.json(
            {
              error: {
                code: "ErrorInvalidIdMalformed",
                message: "Sensitive provider detail for malformed-id",
              },
            },
            { status: 400 },
          );
        },
        "real-outlook-draft": () => {
          return HttpResponse.json(
            outlookMessageResource("real-outlook-draft"),
          );
        },
      },
    });

    const invalid = await linkOutlook(actor, thread.id, "malformed-id");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message:
          "Invalid Outlook draft ID. Check for a typo or placeholder, then retry with the exact id returned by Microsoft Graph for the draft.",
      },
    });

    const valid = await linkOutlook(actor, thread.id, "real-outlook-draft");
    expect(valid.status).toBe(200);
  });

  it("mail-005 links, refreshes and previews the provider draft with its attachments", async () => {
    const { actor, outlook, thread } = await outlookMember();
    const pdfBytes = new Uint8Array(Buffer.from("%PDF-1.4 outlook proposal"));
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
    let subject = "Outlook review";
    mockOutlook(outlook.token, {
      messages: {
        "outlook-draft-5": () => {
          return HttpResponse.json(
            outlookMessageResource("outlook-draft-5", {
              subject,
              inReplyTo: "<original@example.com>",
            }),
          );
        },
      },
      attachments: {
        "outlook-draft-5": [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "report",
            name: "proposal.pdf",
            contentType: "application/pdf",
            size: pdfBytes.length,
            isInline: false,
            contentBytes: Buffer.from(pdfBytes).toString("base64"),
          },
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "inline-logo",
            name: "logo.png",
            contentType: "image/png",
            size: pngBytes.length,
            isInline: true,
            contentId: "outlook-logo",
            contentBytes: Buffer.from(pngBytes).toString("base64"),
          },
        ],
      },
    });

    const first = await linkedOutlook(actor, thread.id, "outlook-draft-5");
    const second = await linkedOutlook(actor, thread.id, "outlook-draft-5");
    expect(second.mailDraftId).toBe(first.mailDraftId);

    subject = "Revised Outlook proposal";
    const draft = await draftOf(actor, first.mailDraftId);
    expect(draft).toMatchObject({
      provider: "outlook",
      outlookMessageId: "outlook-draft-5",
      subject: "Revised Outlook proposal",
      status: "draft",
      inReplyTo: "<original@example.com>",
      attachments: [
        {
          filename: "proposal.pdf",
          contentType: "application/pdf",
          size: pdfBytes.length,
          partId: "report",
        },
      ],
      inlineImages: [
        {
          contentId: "outlook-logo",
          partId: "inline-logo",
          alt: "logo.png",
        },
      ],
    });

    const downloaded = await download(actor, first.mailDraftId, "report");
    expect(downloaded.status).toBe(200);
    expect(downloaded.contentType).toBe("application/pdf");
    expect(downloaded.content).toStrictEqual(pdfBytes);

    const listed = await listThread(actor, thread.id);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      mails: [
        {
          mailDraftId: first.mailDraftId,
          subject: "Revised Outlook proposal",
        },
      ],
    });
  });

  it("mail-006 marks a 202 send successful immediately and prevents duplicate sends", async () => {
    const { actor, outlook, thread } = await outlookMember();
    const providerSentAt = "2026-06-15T12:34:56.000Z";
    let phase: "draft" | "propagating" | "sent" = "draft";
    const recorder = mockOutlook(outlook.token, {
      messages: {
        "outlook-draft-6": () => {
          if (phase === "propagating") {
            return HttpResponse.json(
              { error: { code: "ErrorItemNotFound" } },
              { status: 404 },
            );
          }
          if (phase === "sent") {
            return HttpResponse.json(
              outlookMessageResource("outlook-draft-6", {
                isDraft: false,
                sentDateTime: providerSentAt,
              }),
            );
          }
          return HttpResponse.json(outlookMessageResource("outlook-draft-6"));
        },
      },
    });
    const { mailDraftId } = await linkedOutlook(
      actor,
      thread.id,
      "outlook-draft-6",
    );

    const [firstSend, secondSend] = await Promise.all([
      send(actor, mailDraftId),
      send(actor, mailDraftId),
    ]);
    expect([200, 409]).toContain(firstSend.status);
    expect([200, 409]).toContain(secondSend.status);
    const winning = [firstSend, secondSend].find((result) => {
      return result.status === 200;
    });
    if (!winning || !("mailDraft" in winning.body)) {
      throw new Error("Expected one concurrent send to succeed with HTTP 200");
    }
    expect(winning.body.mailDraft).toMatchObject({
      status: "sent",
      sentAt: expect.any(String),
    });
    expect(recorder.sends).toStrictEqual(["outlook-draft-6"]);

    phase = "propagating";
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      status: "sent",
    });

    const extraSend = await send(actor, mailDraftId);
    expect(extraSend.status).toBe(409);

    phase = "sent";
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      status: "sent",
      sentAt: providerSentAt,
    });

    const deleted = await accept(
      mail.deleteDraft({ headers: as(actor), params: { mailDraftId } }),
      [204, 409],
    );
    expect(deleted.status).toBe(409);
    expect(recorder.sends).toStrictEqual(["outlook-draft-6"]);
  });

  it("mail-010 preserves an uncertain 408 send without retrying and lets explicit rejections be corrected", async () => {
    const { actor, outlook, thread } = await outlookMember();
    let sendAttempt = 0;
    const recorder = mockOutlook(outlook.token, {
      messages: {
        "outlook-draft-10": () => {
          return HttpResponse.json(outlookMessageResource("outlook-draft-10"));
        },
      },
      send: () => {
        sendAttempt += 1;
        return sendAttempt === 1
          ? HttpResponse.json(
              { error: { code: "ErrorInvalidRequest" } },
              { status: 400 },
            )
          : new HttpResponse(null, { status: 408 });
      },
    });
    const { mailDraftId } = await linkedOutlook(
      actor,
      thread.id,
      "outlook-draft-10",
    );

    const first = await send(actor, mailDraftId);
    expect(first.status).toBe(400);
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      status: "draft",
    });

    const second = await send(actor, mailDraftId);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      mailDraft: { status: "sending" },
    });

    const third = await send(actor, mailDraftId);
    expect(third.status).toBe(409);
    expect(recorder.sends).toStrictEqual([
      "outlook-draft-10",
      "outlook-draft-10",
    ]);
  });

  it("mail-013 requires reconnect for revoked Outlook access", async () => {
    const { actor, outlook, thread } = await outlookMember();
    let revoked = false;
    mockOutlook(outlook.token, {
      messages: {
        "outlook-draft-13": () => {
          return revoked
            ? HttpResponse.json(
                { error: { code: "InvalidAuthenticationToken" } },
                { status: 401 },
              )
            : HttpResponse.json(outlookMessageResource("outlook-draft-13"));
        },
      },
    });
    const { mailDraftId } = await linkedOutlook(
      actor,
      thread.id,
      "outlook-draft-13",
    );

    revoked = true;
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      provider: "outlook",
      accessStatus: "reconnect",
    });
  });

  it("mail-014 preserves the sent copy when the user sends an Outlook draft externally", async () => {
    const { actor, outlook, thread } = await outlookMember();
    let sentExternally = false;
    const recorder = mockOutlook(outlook.token, {
      messages: {
        "outlook-draft-14": () => {
          return HttpResponse.json(
            outlookMessageResource("outlook-draft-14", {
              isDraft: !sentExternally,
              sentDateTime: sentExternally
                ? "2026-06-15T14:00:00.000Z"
                : undefined,
            }),
          );
        },
      },
    });
    const { mailDraftId } = await linkedOutlook(
      actor,
      thread.id,
      "outlook-draft-14",
    );

    sentExternally = true;
    const deleted = await accept(
      mail.deleteDraft({ headers: as(actor), params: { mailDraftId } }),
      [204, 409],
    );
    expect(deleted.status).toBe(409);
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      status: "sent",
    });
    expect(recorder.deletes).toStrictEqual([]);
    expect(recorder.sends).toStrictEqual([]);
  });

  it("mail-015 deletes an Outlook draft and keeps its review link unavailable", async () => {
    const { actor, outlook, thread } = await outlookMember();
    const recorder = mockOutlook(outlook.token, {
      messages: {
        "outlook-draft-15": () => {
          return HttpResponse.json(outlookMessageResource("outlook-draft-15"));
        },
      },
    });
    const { mailDraftId } = await linkedOutlook(
      actor,
      thread.id,
      "outlook-draft-15",
    );

    await accept(
      mail.deleteDraft({ headers: as(actor), params: { mailDraftId } }),
      [204],
    );
    await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
      status: "deleted",
    });
    expect(recorder.deletes).toStrictEqual(["outlook-draft-15"]);
  });
});

describe("Active chat Run Gmail drafts", () => {
  const runs = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const gmailDraftUpdatedWebhook = setupApp({
    context,
    routes: webhooksAgentGmailDraftUpdatedRoutes,
  })(runWebhookContract);

  function unauthenticatedClerk(): void {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  }

  async function launchGmailRun() {
    mockEnv("APP_URL", "https://app.okou.ai");
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
    const actor = bdd.user();
    const [gmail, runnerGroup] = await Promise.all([
      connectGmail(actor),
      runs.configureRunnerGroup(),
      deliverOrganizationCreated(context, actor),
    ]);
    const sent = await chats.requestSendEvent(
      actor,
      { prompt: "Draft an email", clientEventId: randomUUID(), model: null },
      [201],
    );
    await flushWaitUntilForTest();
    const dispatch = runs.receivedDispatches(runnerGroup).at(-1);
    const token = dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
    if (!dispatch || !token || !("threadId" in sent.body)) {
      throw new Error("Expected a dispatched active Run");
    }
    return {
      actor,
      gmail,
      runId: dispatch.executionContext.runId,
      threadId: sent.body.threadId,
      token,
      sandboxToken: dispatch.executionContext.sandboxToken,
    };
  }

  async function finishRun(run: {
    readonly actor: ApiTestUser;
    readonly runId: string;
    readonly sandboxToken: string;
  }) {
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await runs.requestCancelRun(run.actor, run.runId, [200]);
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "Run cancelled" },
      { authorization: `Bearer ${run.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
  }

  it(
    "mail-036 links without injecting a duplicate card and sends without rebuilding MIME",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const run = await launchGmailRun();
      const { actor, gmail } = run;
      const [otherThread, eventsBefore] = await Promise.all([
        chats.createThread(actor, { model: null }),
        chats.listThreadEvents(actor, run.threadId),
      ]);
      const pngBytes = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3,
      ]);
      const pdfBytes = new Uint8Array(Buffer.from("%PDF-1.4 mail-036 report"));
      const htmlBody =
        '<p>Please review <img src="cid:inline-logo" alt="Company logo" /></p>';
      const draftResource = {
        id: "r-draft-36",
        message: {
          id: "r-draft-36-message",
          threadId: "r-draft-36-thread",
          payload: {
            partId: "",
            mimeType: "multipart/mixed",
            filename: "",
            headers: [
              { name: "From", value: "sender@example.com" },
              { name: "To", value: "recipient@example.com" },
              { name: "Cc", value: "cc@example.com" },
              { name: "Subject", value: "Attachment review" },
            ],
            body: { size: 0 },
            parts: [
              {
                partId: "0",
                mimeType: "multipart/alternative",
                filename: "",
                headers: [
                  { name: "Content-Type", value: "multipart/alternative" },
                ],
                body: { size: 0 },
                parts: [
                  textPart(
                    "0.0",
                    "text/plain",
                    "Please review the attachment.",
                  ),
                  textPart("0.1", "text/html", htmlBody),
                ],
              },
              {
                partId: "2",
                mimeType: "image/png",
                filename: "logo.png",
                headers: [{ name: "Content-ID", value: "<inline-logo>" }],
                body: { size: pngBytes.length, data: base64Url(pngBytes) },
              },
              {
                partId: "3",
                mimeType: "application/pdf",
                filename: "report.pdf",
                headers: [{ name: "Content-Type", value: "application/pdf" }],
                body: { size: pdfBytes.length, data: base64Url(pdfBytes) },
              },
            ],
          },
        },
      };

      const draftReads: string[] = [];
      const recorder = mockGmail(gmail.token, {
        "r-draft-36": () => {
          draftReads.push("r-draft-36");
          return HttpResponse.json(draftResource);
        },
      });
      const runHeaders = { authorization: `Bearer ${run.token}` };

      unauthenticatedClerk();
      const foreignThreadLink = await accept(
        mail.linkDraft({
          headers: runHeaders,
          body: { threadId: otherThread.id, gmailDraftId: "r-draft-36" },
        }),
        [404],
      );
      expect(foreignThreadLink.status).toBe(404);
      expect(draftReads).toStrictEqual([]);

      const linkedByRun = await accept(
        mail.linkDraft({
          headers: runHeaders,
          body: { threadId: run.threadId, gmailDraftId: "r-draft-36" },
        }),
        [200],
      );
      const { mailDraftId, mailDraftUrl } = linkedByRun.body;
      expect(mailDraftUrl).toBe(
        `https://app.okou.ai/mail/drafts/${mailDraftId}`,
      );

      const [duplicateLink, draft, partResponse] = await Promise.all([
        linked(actor, run.threadId, "r-draft-36"),
        draftOf(actor, mailDraftId),
        accept(
          mail.getAttachment({
            headers: as(actor),
            params: { mailDraftId, partId: "2" },
          }),
          [200],
        ),
      ]);
      expect(duplicateLink).toStrictEqual(linkedByRun.body);
      expect(draft).toMatchObject({
        version: 3,
        provider: "gmail",
        gmailDraftId: "r-draft-36",
        from: "sender@example.com",
        to: ["recipient@example.com"],
        cc: ["cc@example.com"],
        subject: "Attachment review",
        body: "Please review the attachment.",
        bodyHtml: htmlBody,
        inlineImages: [
          { contentId: "inline-logo", partId: "2", alt: "Company logo" },
        ],
        attachments: [
          {
            filename: "report.pdf",
            contentType: "application/pdf",
            size: pdfBytes.length,
            partId: "3",
          },
        ],
      });
      if (!(partResponse.body instanceof Blob)) {
        throw new Error("Expected image attachment bytes");
      }
      expect(partResponse.headers.get("content-type")).toBe("image/png");
      expect(partResponse.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(
        new Uint8Array(await partResponse.body.arrayBuffer()),
      ).toStrictEqual(pngBytes);

      const firstSend = await send(actor, mailDraftId);
      expect(firstSend.status).toBe(200);
      expect(firstSend.body).toMatchObject({
        mailDraft: {
          status: "sent",
          sentGmailMessageId: "sent-message",
        },
      });
      expect(recorder.sends).toStrictEqual([{ id: "r-draft-36" }]);

      const [secondSend, eventsAfter] = await Promise.all([
        send(actor, mailDraftId),
        chats.listThreadEvents(actor, run.threadId),
      ]);
      expect(secondSend.status).toBe(409);
      expect(secondSend.body).toMatchObject({
        error: { message: expect.stringContaining("can no longer be sent") },
      });
      expect(recorder.sends).toStrictEqual([{ id: "r-draft-36" }]);
      expect(eventsAfter).toStrictEqual(eventsBefore);

      await finishRun(run);
    },
  );

  it(
    "pf-092 links and refreshes the active chat draft and sends without rebuilding MIME",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const run = await launchGmailRun();
      const { actor, gmail } = run;
      const runHeaders = { authorization: `Bearer ${run.token}` };
      const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };
      const channel = `user-org:${actor.userId}:${actor.orgId}`;
      let current = gmailDraftResource("r-draft-92", {
        subject: "Initial draft",
        body: "First draft body",
      });
      const recorder = mockGmail(gmail.token, {
        "r-draft-92": () => {
          return HttpResponse.json(current);
        },
      });

      await Promise.all([
        accept(
          gmailDraftUpdatedWebhook.gmailDraftUpdated({
            headers: sandboxHeaders,
            body: {
              runId: randomUUID(),
              connectionId: gmail.connectionId,
              gmailDraftId: "r-draft-92",
            },
          }),
          [401],
        ),
        accept(
          gmailDraftUpdatedWebhook.gmailDraftUpdated({
            headers: sandboxHeaders,
            body: {
              runId: run.runId,
              connectionId: gmail.connectionId,
              gmailDraftId: "r-draft-92",
            },
          }),
          [204],
        ),
      ]);
      await flushWaitUntilForTest();

      unauthenticatedClerk();
      const linkedDraft = await accept(
        mail.linkDraft({
          headers: runHeaders,
          body: { threadId: run.threadId, gmailDraftId: "r-draft-92" },
        }),
        [200],
      );
      const { mailDraftId } = linkedDraft.body;
      const topic = mailDraftChangedEvent(mailDraftId);
      expect(countPublishedTo(context.mocks, { channel, topic })).toBe(0);
      await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
        subject: "Initial draft",
        body: "First draft body",
        status: "draft",
      });

      current = gmailDraftResource("r-draft-92", {
        subject: "Refreshed draft",
        body: "Updated body from active Run",
      });
      await Promise.all([
        accept(
          gmailDraftUpdatedWebhook.gmailDraftUpdated({
            headers: sandboxHeaders,
            body: {
              runId: run.runId,
              connectionId: gmail.connectionId,
              gmailDraftId: "r-draft-92",
            },
          }),
          [204],
        ),
        accept(
          gmailDraftUpdatedWebhook.gmailDraftUpdated({
            headers: sandboxHeaders,
            body: {
              runId: run.runId,
              connectionId: randomUUID(),
              gmailDraftId: "r-draft-92",
            },
          }),
          [204],
        ),
      ]);
      await flushWaitUntilForTest();
      expect(countPublishedTo(context.mocks, { channel, topic })).toBe(1);

      await expect(draftOf(actor, mailDraftId)).resolves.toMatchObject({
        subject: "Refreshed draft",
        body: "Updated body from active Run",
        status: "draft",
      });

      const sent = await send(actor, mailDraftId);
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({
        mailDraft: {
          status: "sent",
          subject: "Refreshed draft",
          sentGmailMessageId: "sent-message",
        },
      });
      expect(recorder.sends).toStrictEqual([{ id: "r-draft-92" }]);

      await accept(
        gmailDraftUpdatedWebhook.gmailDraftUpdated({
          headers: sandboxHeaders,
          body: {
            runId: run.runId,
            connectionId: gmail.connectionId,
            gmailDraftId: "r-draft-92",
          },
        }),
        [204],
      );
      await flushWaitUntilForTest();
      expect(countPublishedTo(context.mocks, { channel, topic })).toBe(1);

      await finishRun(run);
    },
  );
});
