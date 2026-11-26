import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { webhookGmailContract } from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { webhooksGmailRoutes } from "../webhooks-gmail";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUSH_SERVICE_ACCOUNT = "gmail-push@okou-test.iam.gserviceaccount.com";
const GOOGLE_CERT_KID = "gmail-pubsub-signing-key";
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const GMAIL_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "gmail" as const,
});

const googleSigningKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

const workflowsApi = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsCollectionContract);

const automationsApi = setupApp({
  context,
  routes: workflowAutomationsRoutes,
})(workflowAutomationsContract);
const accountsApi = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);
const gmailWebhook = setupApp({
  context,
  routes: webhooksGmailRoutes,
})(webhookGmailContract);
const gmailOauthStart = setupApp({
  context,
  routes: builtinConnectorsRoutes,
})(builtinConnectorOauthStartContract);
const gmailOauthCallback = setupApp({
  context,
  routes: builtinConnectorsSlugCallbackRoutes,
})(builtinConnectorsSlugCallbackContract);
const chatConnectorAccessApi = setupApp({
  context,
  routes: chatConnectorAccessRoutes,
})(chatConnectorAccessContract);
const chatSelectionsApi = setupApp({
  context,
  routes: chatThreadConnectorSelectionRoutes,
})(chatThreadConnectorSelectionContract);

interface GmailAccount {
  readonly email: string;
  readonly accessToken: string;
  readonly subject: string;
}

interface GmailProvider {
  readonly watchTokens: string[];
  readonly labelTokens: string[];
  readonly historyReads: string[];
  readonly stopTokens: string[];
  readonly watchHistoryIds: string[];
  historyId: string;
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
}

function gmailAccount(label: string): GmailAccount {
  const id = randomUUID();
  const email = `${label}-${id}@example.com`;
  return {
    email,
    accessToken: `gmail-${label}-token-${id}`,
    subject: `subject-${email}`,
  };
}

function configureGmailPubSub(): void {
  mockOptionalEnv(
    "GMAIL_PUBSUB_PUSH_AUDIENCE",
    "https://api.okou.test/api/webhooks/gmail",
  );
  mockOptionalEnv(
    "GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    PUSH_SERVICE_ACCOUNT,
  );
  mockOptionalEnv(
    "GMAIL_PUBSUB_TOPIC_NAME",
    `projects/okou-test/topics/gmail-${randomUUID()}`,
  );
  server.use(
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json({
        [GOOGLE_CERT_KID]: googleSigningKey.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      });
    }),
  );
}

function mockGmailApi(
  watchHistoryIds: readonly string[],
  labelsByToken: Readonly<
    Record<string, readonly { readonly id: string; readonly name: string }[]>
  > = {},
): GmailProvider {
  const provider: GmailProvider = {
    watchTokens: [],
    labelTokens: [],
    historyReads: [],
    stopTokens: [],
    watchHistoryIds: [...watchHistoryIds],
    historyId: "101",
  };
  server.use(
    http.post(`${GMAIL_API}/watch`, ({ request }) => {
      provider.watchTokens.push(bearer(request));
      return HttpResponse.json({
        historyId: provider.watchHistoryIds.shift() ?? "100",
        expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
      });
    }),
    http.post(`${GMAIL_API}/stop`, ({ request }) => {
      provider.stopTokens.push(bearer(request));
      return HttpResponse.json(
        { error: { code: 500, message: "Backend Error" } },
        { status: 500 },
      );
    }),
    http.get(`${GMAIL_API}/labels`, ({ request }) => {
      const token = bearer(request);
      provider.labelTokens.push(token);
      return HttpResponse.json({
        labels: labelsByToken[token] ?? [],
      });
    }),
    http.get(`${GMAIL_API}/history`, ({ request }) => {
      provider.historyReads.push(
        new URL(request.url).searchParams.get("startHistoryId") ?? "",
      );
      return HttpResponse.json({ history: [], historyId: provider.historyId });
    }),
  );
  return provider;
}

function refuseTokenRefresh(): string[] {
  const refreshes: string[] = [];
  server.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const grantType = new URLSearchParams(await request.clone().text()).get(
        "grant_type",
      );
      if (grantType !== "refresh_token") {
        return undefined;
      }
      refreshes.push(grantType);
      return HttpResponse.json(
        {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        },
        { status: 400 },
      );
    }),
  );
  return refreshes;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function pubSubToken(issuedAtMs: number): string {
  const seconds = Math.floor(issuedAtMs / 1000);
  const signingInput = `${encodeJwtPart({ alg: "RS256", typ: "JWT", kid: GOOGLE_CERT_KID })}.${encodeJwtPart(
    {
      iss: "https://accounts.google.com",
      aud: optionalEnv("GMAIL_PUBSUB_PUSH_AUDIENCE"),
      sub: "gmail-push-service-account",
      email: PUSH_SERVICE_ACCOUNT,
      email_verified: true,
      iat: seconds,
      exp: seconds + 3600,
    },
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(googleSigningKey.privateKey).toString("base64url")}`;
}

function pushGmail(
  emailAddress: string,
  historyId: string,
  issuedAtMs: number = now(),
) {
  return gmailWebhook.post({
    body: JSON.stringify({
      message: {
        data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString(
          "base64",
        ),
        messageId: `pubsub-${randomUUID()}`,
      },
      subscription: "projects/okou-test/subscriptions/gmail-push",
    }),
    extraHeaders: { authorization: `Bearer ${pubSubToken(issuedAtMs)}` },
  });
}

async function completeGmailOauth(authorizationUrl: string, code: string) {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth state");
  }
  const completed = await accept(
    gmailOauthCallback.callback({
      headers: {},
      params: { connectorSlug: "gmail" },
      query: { code, state, responseMode: "json" },
    }),
    [200],
  );
  expect(completed.body.status).toBe("success");
}

async function workflowAdmin(account: GmailAccount) {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin" as const,
  };
  const mocks = createRouteMocks(context);
  function authenticate() {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return SESSION;
  }
  mockGmailConnectorOAuth({
    accessToken: account.accessToken,
    email: account.email,
    subject: account.subject,
  });
  const [createdWorkflow, oauthStarted] = await Promise.all([
    accept(
      workflowsApi.create({
        headers: authenticate(),
        body: {
          name: `gmail-${randomUUID().slice(0, 8)}`,
          visibility: "private",
        },
      }),
      [201],
    ),
    accept(
      gmailOauthStart.start({
        headers: authenticate(),
        params: { connectorSlug: "gmail" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    ),
  ]);
  const workflowId = createdWorkflow.body.id;
  await completeGmailOauth(
    oauthStarted.body.authorizationUrl,
    `code-${randomUUID()}`,
  );

  return { actor, workflowId, authenticate };
}

type WorkflowAdmin = Awaited<ReturnType<typeof workflowAdmin>>;

async function createNewMessageAutomation(admin: WorkflowAdmin) {
  const created = await accept(
    automationsApi.create({
      headers: admin.authenticate(),
      params: { workflowId: admin.workflowId },
      body: {
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: { provider: "gmail", event: "new_message" },
      },
    }),
    [201],
  );
  return created.body;
}

async function listGmailAccounts(admin: WorkflowAdmin) {
  const response = await accept(
    accountsApi.connections({
      headers: admin.authenticate(),
      query: GMAIL_TARGET,
    }),
    [200],
  );
  return response.body;
}

async function gmailConnectionId(
  admin: WorkflowAdmin,
  account: GmailAccount,
): Promise<string> {
  const { connections } = await listGmailAccounts(admin);
  const connection = connections.find((candidate) => {
    return candidate.externalEmail === account.email;
  });
  if (!connection) {
    throw new Error(`Expected a Gmail connection for ${account.email}`);
  }
  return connection.id;
}

async function deleteGmailAccount(admin: WorkflowAdmin, connectionId: string) {
  const response = await accept(
    accountsApi.delete({
      headers: admin.authenticate(),
      params: { connectionId },
      body: { target: GMAIL_TARGET },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  return response.body;
}

function emailsOf(
  connections: readonly {
    readonly externalEmail: string | null;
    readonly isDefault: boolean;
  }[],
) {
  return connections.map((connection) => {
    return {
      externalEmail: connection.externalEmail,
      isDefault: connection.isDefault,
    };
  });
}

async function startTwoGmailOauths() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin" as const,
  };
  const mocks = createRouteMocks(context);
  function authenticate() {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return SESSION;
  }
  const [createdWorkflow, firstStart, secondStart] = await Promise.all([
    accept(
      workflowsApi.create({
        headers: authenticate(),
        body: {
          name: `gmail-${randomUUID().slice(0, 8)}`,
          visibility: "private",
        },
      }),
      [201],
    ),
    accept(
      gmailOauthStart.start({
        headers: authenticate(),
        params: { connectorSlug: "gmail" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    ),
    accept(
      gmailOauthStart.start({
        headers: authenticate(),
        params: { connectorSlug: "gmail" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    ),
  ]);
  const workflowId = createdWorkflow.body.id;
  return {
    admin: { actor, workflowId, authenticate },
    firstAuthUrl: firstStart.body.authorizationUrl,
    secondAuthUrl: secondStart.body.authorizationUrl,
  };
}

async function workflowAdminTwoAccountsParallel() {
  const accountA = gmailAccount("first");
  const accountB = gmailAccount("second");
  const { admin, firstAuthUrl, secondAuthUrl } = await startTwoGmailOauths();
  const codeA = `code-a-${randomUUID()}`;
  const codeB = `code-b-${randomUUID()}`;
  mockGmailOAuthByCode({ [codeA]: accountA, [codeB]: accountB });
  await Promise.all([
    completeGmailOauth(firstAuthUrl, codeA),
    completeGmailOauth(secondAuthUrl, codeB),
  ]);
  const accounts = await listGmailAccounts(admin);
  const defaultConn = accounts.connections.find((c) => {
    return c.isDefault;
  });
  const secondConn = accounts.connections.find((c) => {
    return !c.isDefault;
  });
  if (!defaultConn || !secondConn) {
    throw new Error("Expected both Gmail connections");
  }
  const first =
    defaultConn.externalEmail === accountA.email ? accountA : accountB;
  const second = first === accountA ? accountB : accountA;
  return {
    admin,
    first,
    second,
    firstId: defaultConn.id,
    secondId: secondConn.id,
  };
}

async function revokedGmailAutomation(includeAccountId = false) {
  const issuedAtMs = now();
  configureGmailPubSub();
  mockGmailApi(["100"]);
  const mailbox = gmailAccount("revoked");
  const admin = await workflowAdmin(mailbox);
  const createCall = accept(
    automationsApi.create({
      headers: admin.authenticate(),
      params: { workflowId: admin.workflowId },
      body: {
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: { provider: "gmail", event: "new_message" },
      },
    }),
    [201],
  );
  let accountId = "";
  let automationId = "";
  if (includeAccountId) {
    const [automation, id] = await Promise.all([
      createCall,
      gmailConnectionId(admin, mailbox),
    ]);
    automationId = automation.body.id;
    accountId = id;
  } else {
    const automation = await createCall;
    automationId = automation.body.id;
  }
  const refreshes = refuseTokenRefresh();
  mockNow(issuedAtMs + 2 * 60 * 60 * 1000);
  return { admin, automationId, accountId, mailbox, refreshes, issuedAtMs };
}

async function switchedLabelAutomation() {
  configureGmailPubSub();
  const labelsByToken: Record<
    string,
    readonly { readonly id: string; readonly name: string }[]
  > = {};
  const gmail = mockGmailApi(["100", "200"], labelsByToken);
  const { admin, first, second, secondId } =
    await workflowAdminTwoAccountsParallel();
  labelsByToken[first.accessToken] = [
    { id: "Label_collision", name: "Account scoped" },
  ];
  labelsByToken[second.accessToken] = [
    { id: "Label_collision", name: "Different label" },
    { id: "Label_selected", name: "Selected account" },
  ];
  const created = await accept(
    automationsApi.create({
      headers: admin.authenticate(),
      params: { workflowId: admin.workflowId },
      body: {
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Account scoped",
        },
      },
    }),
    [201],
  );
  if (!created.body.chatThreadId) {
    throw new Error("Expected automation chat thread");
  }
  await accept(
    chatSelectionsApi.update({
      headers: admin.authenticate(),
      params: { id: created.body.chatThreadId },
      body: { target: GMAIL_TARGET, connectionId: secondId },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  return {
    admin,
    gmail,
    first,
    second,
    automationId: created.body.id,
  };
}

function mockGmailOAuthByCode(
  accountsByCode: Readonly<Record<string, GmailAccount>>,
): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  const byToken = new Map(
    Object.values(accountsByCode).map((account) => {
      return [account.accessToken, account] as const;
    }),
  );
  server.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      const account = accountsByCode[body.get("code") ?? ""];
      if (body.get("grant_type") !== "authorization_code" || !account) {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "Unknown code" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: account.accessToken,
        refresh_token: `refresh-${account.accessToken}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      });
    }),
    http.get(
      "https://openidconnect.googleapis.com/v1/userinfo",
      ({ request }) => {
        const account = byToken.get(bearer(request));
        if (!account) {
          return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        return HttpResponse.json({
          sub: account.subject,
          email: account.email,
          name: "BDD Gmail User",
        });
      },
    ),
  );
}

async function deniedFirstAndDeletedSecondGmail() {
  configureGmailPubSub();
  const accountA = gmailAccount("first");
  const accountB = gmailAccount("second");
  mockGmailApi(["100", "200"]);
  const { admin, firstAuthUrl, secondAuthUrl } = await startTwoGmailOauths();
  const codeA = `code-a-${randomUUID()}`;
  const codeB = `code-b-${randomUUID()}`;
  mockGmailOAuthByCode({ [codeA]: accountA, [codeB]: accountB });
  await Promise.all([
    completeGmailOauth(firstAuthUrl, codeA),
    completeGmailOauth(secondAuthUrl, codeB),
  ]);
  const [automation, accounts] = await Promise.all([
    accept(
      automationsApi.create({
        headers: admin.authenticate(),
        params: { workflowId: admin.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    ),
    listGmailAccounts(admin),
  ]);
  const defaultConn = accounts.connections.find((c) => {
    return c.isDefault;
  });
  const secondConn = accounts.connections.find((c) => {
    return !c.isDefault;
  });
  if (
    !defaultConn ||
    !secondConn ||
    !defaultConn.externalEmail ||
    !automation.body.chatThreadId
  ) {
    throw new Error("Expected both Gmail connections and automation thread");
  }
  const firstEmail = defaultConn.externalEmail;
  const overridden = await accept(
    chatConnectorAccessApi.setThreadOverride({
      headers: admin.authenticate(),
      params: {
        threadId: automation.body.chatThreadId,
        connectionId: defaultConn.id,
      },
      body: { target: GMAIL_TARGET, enabled: false },
    }),
    [200],
  );
  await accept(
    accountsApi.delete({
      headers: admin.authenticate(),
      params: { connectionId: secondConn.id },
      body: { target: GMAIL_TARGET },
    }),
    [200],
  );
  return {
    admin,
    firstEmail,
    firstId: defaultConn.id,
    secondId: secondConn.id,
    automationId: automation.body.id,
    threadId: automation.body.chatThreadId,
    overridden: overridden.body,
  };
}

describe("POST /api/webhooks/gmail", () => {
  it("webhooks-gmail-006 (1/3) acknowledges both pushes without dispatching after one refresh attempt", async () => {
    const { mailbox, refreshes, issuedAtMs } = await revokedGmailAutomation();

    const first = await accept(
      pushGmail(mailbox.email, "101", issuedAtMs),
      [200],
    );
    const second = await accept(
      pushGmail(mailbox.email, "101", issuedAtMs),
      [200],
    );

    expect([first.body, second.body]).toStrictEqual([
      { success: true, watchStates: 1, dispatched: 0, duplicates: 0 },
      { success: true, watchStates: 1, dispatched: 0, duplicates: 0 },
    ]);
    expect(refreshes).toStrictEqual(["refresh_token"]);
  });

  it("webhooks-gmail-006 (2/3) marks the Gmail account reconnect-required and disables the automation", async () => {
    const { admin, automationId, mailbox, issuedAtMs } =
      await revokedGmailAutomation();
    await accept(pushGmail(mailbox.email, "101", issuedAtMs), [200]);

    const [accounts, disabled] = await Promise.all([
      listGmailAccounts(admin),
      accept(
        automationsApi.disable({
          headers: admin.authenticate(),
          params: { id: automationId },
          body: undefined,
        }),
        [200],
      ),
    ]);

    expect(accounts.connections).toMatchObject([
      {
        externalEmail: mailbox.email,
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      },
    ]);
    expect(disabled.status).toBe(200);
  });

  it("webhooks-gmail-006 (3/3) deletes the automation after Gmail is reconnected", async () => {
    const { admin, automationId, accountId, mailbox, issuedAtMs } =
      await revokedGmailAutomation(true);

    const [, reconnectStart] = await Promise.all([
      accept(pushGmail(mailbox.email, "101", issuedAtMs), [200]),
      accept(
        gmailOauthStart.start({
          headers: admin.authenticate(),
          params: { connectorSlug: "gmail" },
          body: {
            authMethod: "oauth",
            account: { intent: "reconnect", connectionId: accountId },
          },
        }),
        [200],
      ),
    ]);
    mockGmailConnectorOAuth({
      accessToken: mailbox.accessToken,
      email: mailbox.email,
      subject: mailbox.subject,
    });
    await completeGmailOauth(
      reconnectStart.body.authorizationUrl,
      `code-${randomUUID()}`,
    );

    const deleted = await accept(
      automationsApi.delete({
        headers: admin.authenticate(),
        params: { id: automationId },
        body: undefined,
      }),
      [204],
    );
    expect(deleted.status).toBe(204);
  });

  it("webhooks-gmail-018 restores the Gmail watch after the last account is replaced", async () => {
    configureGmailPubSub();
    const gmail = mockGmailApi(["100", "200"]);
    const original = gmailAccount("original");
    const replacement = gmailAccount("replacement");
    const admin = await workflowAdmin(original);
    const [, originalId] = await Promise.all([
      createNewMessageAutomation(admin),
      gmailConnectionId(admin, original),
    ]);

    mockGmailConnectorOAuth({
      accessToken: replacement.accessToken,
      email: replacement.email,
      subject: replacement.subject,
    });
    const [deleted, addStart] = await Promise.all([
      deleteGmailAccount(admin, originalId),
      accept(
        gmailOauthStart.start({
          headers: admin.authenticate(),
          params: { connectorSlug: "gmail" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [200],
      ),
    ]);
    await completeGmailOauth(
      addStart.body.authorizationUrl,
      `code-${randomUUID()}`,
    );
    await flushWaitUntilForTest();
    const accounts = await listGmailAccounts(admin);

    expect(deleted).toStrictEqual({
      deletedConnectionId: originalId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });
    expect(gmail.watchTokens).toStrictEqual([
      original.accessToken,
      replacement.accessToken,
    ]);
    expect(gmail.stopTokens).toStrictEqual([]);
    expect(emailsOf(accounts.connections)).toStrictEqual([
      { externalEmail: replacement.email, isDefault: true },
    ]);
  });

  it("webhooks-gmail-015 (1/3) resolves the label on the first Gmail account and watches only that account", async () => {
    configureGmailPubSub();
    const labelsByToken: Record<
      string,
      readonly { readonly id: string; readonly name: string }[]
    > = {};
    const gmail = mockGmailApi(["100", "200"], labelsByToken);
    const { admin, first, second } = await workflowAdminTwoAccountsParallel();
    labelsByToken[first.accessToken] = [
      { id: "Label_collision", name: "Account scoped" },
    ];
    labelsByToken[second.accessToken] = [
      { id: "Label_collision", name: "Different label" },
      { id: "Label_selected", name: "Selected account" },
    ];

    const created = await accept(
      automationsApi.create({
        headers: admin.authenticate(),
        params: { workflowId: admin.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Account scoped",
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();

    expect(created.body.kind).toBe("event");
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected gmail-label-applied automation");
    }
    expect(created.body.eventConfig).toStrictEqual({
      provider: "gmail",
      event: "label_applied",
      labelName: "Account scoped",
      resolvedLabelId: "Label_collision",
    });
    expect(gmail.watchTokens).toStrictEqual([first.accessToken]);
  });

  it("webhooks-gmail-015 (2/3) reprojects the label automation and watches the second account without stopping the first", async () => {
    const { admin, gmail, first, second, automationId } =
      await switchedLabelAutomation();

    const listed = await accept(
      automationsApi.list({
        headers: admin.authenticate(),
        params: { workflowId: admin.workflowId },
      }),
      [200],
    );

    const refreshed = listed.body.find((item) => {
      return item.id === automationId;
    });
    if (
      !refreshed ||
      refreshed.kind !== "event" ||
      refreshed.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected refreshed gmail-label-applied automation");
    }
    expect(refreshed.eventConfig).toStrictEqual({
      provider: "gmail",
      event: "label_applied",
      labelName: "Account scoped",
    });
    expect(gmail.watchTokens).toStrictEqual([
      first.accessToken,
      second.accessToken,
    ]);
    expect(gmail.stopTokens).toStrictEqual([]);
  });

  it("webhooks-gmail-015 (3/3) resolves a new label automation against the switched second account", async () => {
    const { admin, gmail, second } = await switchedLabelAutomation();
    const labelReadsBeforeSecond = gmail.labelTokens.length;

    const secondAutomation = await accept(
      automationsApi.create({
        headers: admin.authenticate(),
        params: { workflowId: admin.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Selected account",
          },
        },
      }),
      [201],
    );

    expect(gmail.labelTokens.slice(labelReadsBeforeSecond)).toStrictEqual([
      second.accessToken,
    ]);
    expect(secondAutomation.body.kind).toBe("event");
    if (
      secondAutomation.body.kind !== "event" ||
      secondAutomation.body.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected second gmail-label-applied automation");
    }
    expect(secondAutomation.body.eventConfig).toStrictEqual({
      provider: "gmail",
      event: "label_applied",
      labelName: "Selected account",
      resolvedLabelId: "Label_selected",
    });
  });

  it("webhooks-gmail-016 (1/3) switches current account on deny and leaves no available account after deleting the second", async () => {
    const { admin, secondId, threadId, overridden } =
      await deniedFirstAndDeletedSecondGmail();

    expect(overridden.currentConnectionId).toBe(secondId);

    const access = await accept(
      chatConnectorAccessApi.getThread({
        headers: admin.authenticate(),
        params: { threadId },
        query: GMAIL_TARGET,
      }),
      [200],
    );
    expect(access.body).toMatchObject({
      currentConnectionId: null,
      available: false,
    });
  });

  it("webhooks-gmail-016 (2/3) ignores Pub/Sub pushes for the denied Gmail account", async () => {
    const { firstEmail } = await deniedFirstAndDeletedSecondGmail();

    const pushed = await accept(pushGmail(firstEmail, "101"), [200]);
    expect(pushed.body).toMatchObject({ dispatched: 0 });
  });

  it("webhooks-gmail-016 (3/3) disables the automation and rejects re-enabling without an allowed account", async () => {
    const { admin, automationId } = await deniedFirstAndDeletedSecondGmail();

    const disabled = await accept(
      automationsApi.disable({
        headers: admin.authenticate(),
        params: { id: automationId },
        body: undefined,
      }),
      [200],
    );
    expect(disabled.status).toBe(200);

    await accept(
      automationsApi.enable({
        headers: admin.authenticate(),
        params: { id: automationId },
        body: undefined,
      }),
      [400],
    );
  });
});
