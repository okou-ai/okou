import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  chatThreadConnectorSelectionContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  webhookCompleteContract,
  webhookFirewallAuthContract,
  webhookGmailContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runnersRoutes } from "../runners";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksGmailRoutes } from "../webhooks-gmail";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { mockClerkUsers } from "./helpers/clerk-users";
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
const chatThreadEventsApi = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadEventsContract);
const personalModelProvidersApi = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const runnersHeartbeatApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const userModelPreferenceApi = setupApp({
  context,
  routes: userModelPreferenceRoutes,
})(userModelPreferenceContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const firewallAuthApi = setupApp({
  context,
  routes: webhooksAgentFirewallAuthRoutes,
})(webhookFirewallAuthContract);

const CLAUDE_MODEL = "claude-fable-5-1";

function visibleMessageText(
  parts: readonly { readonly type: string; readonly text?: string }[],
): string {
  return parts
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } => {
        return part.type === "text" && typeof part.text === "string";
      },
    )
    .map((part) => {
      return part.text;
    })
    .join("");
}

function gmailFullMessagePayload(args: {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly labelIds?: readonly string[];
}) {
  return {
    id: args.id,
    threadId: args.threadId,
    labelIds: [...(args.labelIds ?? ["INBOX"])],
    internalDate: String(Date.parse("2026-06-01T12:00:00.000Z")),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: args.from },
        { name: "To", value: args.to },
        { name: "Subject", value: args.subject },
      ],
      body: {
        data: Buffer.from(args.bodyText, "utf8").toString("base64url"),
      },
    },
  };
}

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
  const bdd = createBddApi(context);
  const runsApi = createRunsApi(context);
  const chatCallbacks = createChatCallbacksApi(context);

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(
          workflowsApi.create({
            headers: {},
            body: { name: "warmup-gmail", visibility: "private" },
          }),
          [401],
        ),
        accept(
          automationsApi.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          accountsApi.connections({ headers: {}, query: GMAIL_TARGET }),
          [401],
        ),
        accept(
          chatConnectorAccessApi.getThread({
            headers: {},
            params: { threadId: warmupId },
            query: GMAIL_TARGET,
          }),
          [401],
        ),
        accept(
          chatSelectionsApi.update({
            headers: {},
            params: { id: warmupId },
            body: { target: GMAIL_TARGET, connectionId: warmupId },
          }),
          [401],
        ),
        accept(
          chatThreadEventsApi.catchUp({
            headers: {},
            body: [[warmupId, 0]],
          }),
          [401],
        ),
        accept(
          personalModelProvidersApi.upsert({
            headers: {},
            body: { type: "claude-code-oauth-token", secret: "warmup" },
          }),
          [401],
        ),
        accept(
          runnersHeartbeatApi.heartbeat({
            headers: {},
            body: {
              runnerId: warmupId,
              runnerHostname: `runner-${warmupId}.okou.app`,
              group: "vm0/warmup",
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 8,
              totalMemoryMb: 16_384,
              maxConcurrent: 2,
              allocatedVcpu: 0,
              allocatedMemoryMb: 0,
              runningCount: 0,
              admittableProfiles: ["vm0/default"],
              heldSandboxStates: [],
              heldHomeStates: [],
              activeReuseProducers: [],
              mode: "running",
              ingressServiceActive: true,
            },
          }),
          [401],
        ),
        accept(
          userModelPreferenceApi.update({
            headers: {},
            body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
          }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          firewallAuthApi.resolve({
            headers: {},
            body: { authHeaders: {} },
          }),
          [401],
        ),
        accept(
          gmailOauthStart.start({
            headers: {},
            params: { connectorSlug: "gmail" },
            body: { authMethod: "oauth", account: { intent: "add" } },
          }),
          [401],
        ),
        accept(
          gmailWebhook.post({
            body: "{}",
          }),
          [401, 503],
        ),
        bdd.requestReadMe(null, [401]),
      ]);
      pubSubToken(now());
      runnerDispatchEnvelopeSchema.safeParse({});
    });
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

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

  function createDirectRunnerForGmail() {
    const group = `vm0/gmail-${randomUUID().slice(0, 8)}`;
    const runnerId = randomUUID();
    const hostname = `runner-${runnerId}.okou.app`;
    const acceptedOrder: string[] = [];
    const acceptedByRunId = new Map<string, ExecutionContext>();
    const completedRunIds = new Set<string>();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");

    chatCallbacks.acceptChatObjectStorage();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    chatCallbacks.disableVapid();
    mockClaudeCodeTokenEndpoint();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);

    server.use(
      http.post(
        `https://${hostname}/runners/${runnerId}/control/runs/:runId/dispatch`,
        async ({ request, params }) => {
          const encoding = request.headers.get("content-encoding");
          const rawBytes = Buffer.from(await request.arrayBuffer());
          const text =
            encoding === "gzip"
              ? gunzipSync(rawBytes).toString("utf8")
              : rawBytes.toString("utf8");
          const envelope = runnerDispatchEnvelopeSchema.parse(JSON.parse(text));
          if (
            envelope.runnerId !== runnerId ||
            envelope.executionContext.runId !== params.runId
          ) {
            throw new Error("Unexpected direct Runner dispatch identity");
          }
          acceptedByRunId.set(
            envelope.executionContext.runId,
            envelope.executionContext,
          );
          acceptedOrder.push(envelope.executionContext.runId);
          return HttpResponse.json({
            runnerId,
            heartbeatGeneration: 1,
            runId: envelope.executionContext.runId,
            disposition: "accepted",
          });
        },
      ),
    );

    async function completeRun(runId: string): Promise<void> {
      const exec = acceptedByRunId.get(runId);
      if (!exec) {
        throw new Error(`Missing execution context for run ${runId}`);
      }
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: { authorization: `Bearer ${exec.sandboxToken}` },
          body: {
            runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `complete-${runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
              storageOutputs: [],
            },
          },
        }),
        [200],
      );
      completedRunIds.add(runId);
      await flushWaitUntilForTest();
    }

    onTestFinished(async () => {
      const previousGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
      context.mocks.ably.publish.mockResolvedValue(undefined);
      context.mocks.s3.getSignedUrl.mockImplementation(
        (_client: unknown, command: unknown) => {
          return Promise.resolve(apiTestS3PresignedUrl(command));
        },
      );
      const cleaned = await settleIncludingAbort(async () => {
        await flushWaitUntilForTest();
        for (let pass = 0; pass < 6; pass += 1) {
          const pending = acceptedOrder.filter((runId) => {
            return !completedRunIds.has(runId);
          });
          if (pending.length === 0) {
            break;
          }
          await Promise.all(
            pending.map((runId) => {
              return completeRun(runId);
            }),
          );
        }
      });
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousGroup);
      if (!cleaned.ok) {
        throw cleaned.error;
      }
    });

    async function registerRunner(): Promise<void> {
      await accept(
        runnersHeartbeatApi.heartbeat({
          headers: {
            authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
          },
          body: {
            runnerId,
            runnerHostname: hostname,
            group,
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 16,
            totalMemoryMb: 32_768,
            maxConcurrent: 4,
            allocatedVcpu: 0,
            allocatedMemoryMb: 0,
            runningCount: 0,
            admittableProfiles: ["vm0/default"],
            heldSandboxStates: [],
            heldHomeStates: [],
            activeReuseProducers: [],
            mode: "running",
            ingressServiceActive: true,
          },
        }),
        [200],
      );
    }

    return {
      acceptedOrder,
      acceptedByRunId,
      completeRun,
      registerRunner,
    };
  }

  function signInMember(actor: ApiTestUser) {
    const mocks = createRouteMocks(context);
    mocks.clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole ?? "org:admin",
    );
    const emailId = `email_${actor.userId}`;
    mockClerkUsers(context, [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "BDD",
        lastName: "Gmail",
      },
    ]);
    return SESSION;
  }

  async function setupGmailRunMember(accounts: readonly GmailAccount[]) {
    configureGmailPubSub();
    const runner = createDirectRunnerForGmail();
    const actor = bdd.user({ orgRole: "org:admin" });
    if (!actor.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    const authenticate = () => {
      return signInMember(actor);
    };
    authenticate();

    const codeByIndex = accounts.map((_, index) => {
      return `gmail-run-code-${index}-${randomUUID()}`;
    });
    const accountsByCode: Record<string, GmailAccount> = {};
    for (const [index, account] of accounts.entries()) {
      const code = codeByIndex[index];
      if (code) {
        accountsByCode[code] = account;
      }
    }
    if (accounts.length > 0) {
      mockGmailOAuthByCode(accountsByCode);
    }

    const [createdWorkflow, oauthStarts] = await Promise.all([
      accept(
        workflowsApi.create({
          headers: SESSION,
          body: {
            name: `gmail-run-${randomUUID().slice(0, 8)}`,
            visibility: "private",
          },
        }),
        [201],
      ),
      Promise.all(
        accounts.map(() => {
          return accept(
            gmailOauthStart.start({
              headers: SESSION,
              params: { connectorSlug: "gmail" },
              body: { authMethod: "oauth", account: { intent: "add" } },
            }),
            [200],
          );
        }),
      ),
      bdd.provisionWorkspace(actor),
      bdd.completeOnboarding(actor),
      runner.registerRunner(),
      accept(
        personalModelProvidersApi.upsert({
          headers: SESSION,
          body: {
            type: "claude-code-oauth-token",
            secret: `sk-ant-oat01-${randomUUID()}`,
          },
        }),
        [201],
      ),
    ]);

    await Promise.all([
      accept(
        userModelPreferenceApi.update({
          headers: SESSION,
          body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
        }),
        [200],
      ),
      ...oauthStarts.map((started, index) => {
        const code = codeByIndex[index];
        if (!code) {
          throw new Error("Missing Gmail OAuth code");
        }
        return completeGmailOauth(started.body.authorizationUrl, code);
      }),
    ]);

    const admin: WorkflowAdmin = {
      actor: {
        userId: actor.userId,
        orgId: actor.orgId,
        orgRole: "org:admin",
      },
      workflowId: createdWorkflow.body.id,
      authenticate,
    };

    return { admin, runner };
  }

  async function resolveRunGmailAuthorization(
    execution: ExecutionContext,
  ): Promise<{ readonly sourceId: string; readonly authorization: string }> {
    const gmailTarget = execution.connectorRuntimeTargets?.find((target) => {
      return target.kind === "builtin" && target.connectorSlug === "gmail";
    });
    if (!gmailTarget?.sourceId) {
      throw new Error("Expected Gmail runtime target on dispatched run");
    }
    const resolved = await accept(
      firewallAuthApi.resolve({
        headers: { authorization: `Bearer ${execution.firewallToken}` },
        body: {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("GMAIL_TOKEN")}`,
          },
          secretConnectorMap: { GMAIL_TOKEN: "gmail" },
          secretConnectorMetadataMap: {
            GMAIL_TOKEN: {
              sourceType: "connector",
              sourceId: gmailTarget.sourceId,
            },
          },
        },
      }),
      [200],
    );
    return {
      sourceId: gmailTarget.sourceId,
      authorization: resolved.body.headers.Authorization ?? "",
    };
  }

  it(
    "webhooks-gmail-009 retries history pagination after rate limiting without losing or duplicating events",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const mailbox = gmailAccount("ratelimit");
      let pageTwoAvailable = false;
      const watchHistoryIds = ["100"];
      server.use(
        http.post(`${GMAIL_API}/watch`, () => {
          return HttpResponse.json({
            historyId: watchHistoryIds.shift() ?? "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        }),
        http.get(`${GMAIL_API}/history`, ({ request }) => {
          const pageToken = new URL(request.url).searchParams.get("pageToken");
          if (pageToken === "page-2") {
            if (!pageTwoAvailable) {
              return HttpResponse.json(
                { error: { code: 429, message: "Too Many Requests" } },
                { status: 429 },
              );
            }
            return HttpResponse.json({ history: [], historyId: "101" });
          }
          return HttpResponse.json({
            history: [
              {
                id: "101",
                messagesAdded: [
                  {
                    message: {
                      id: "msg-rate-1",
                      threadId: "gmail-thread-rate-1",
                      labelIds: ["INBOX"],
                    },
                  },
                ],
              },
            ],
            nextPageToken: "page-2",
            historyId: "101",
          });
        }),
        http.get(`${GMAIL_API}/messages/msg-rate-1`, () => {
          return HttpResponse.json(
            gmailFullMessagePayload({
              id: "msg-rate-1",
              threadId: "gmail-thread-rate-1",
              from: "Billing <billing@example.com>",
              to: mailbox.email,
              subject: "Rate limit retry test",
              bodyText: "Retry body",
            }),
          );
        }),
      );

      const { admin, runner } = await setupGmailRunMember([mailbox]);
      const automation = await createNewMessageAutomation(admin);
      if (!automation.chatThreadId) {
        throw new Error("Expected automation chatThreadId");
      }

      const rateLimited = await accept(pushGmail(mailbox.email, "101"), [503]);
      expect(rateLimited.body).toStrictEqual({
        error:
          "Gmail history is temporarily unavailable; retry this notification",
      });
      const beforeRetry = await accept(
        automationsApi.get({
          headers: admin.authenticate(),
          params: { id: automation.id },
        }),
        [200],
      );
      expect(beforeRetry.body.lastRunAt).toBeNull();
      expect(runner.acceptedOrder).toHaveLength(0);

      pageTwoAvailable = true;
      const retried = await accept(pushGmail(mailbox.email, "101"), [200]);
      await flushWaitUntilForTest();
      expect(retried.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });
      const eventsAfterRetry = await readProjectedChatEvents(context, {
        threadId: automation.chatThreadId,
        headers: admin.authenticate(),
      });
      const runsAfterRetry = eventsAfterRetry.filter((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined;
      });
      expect(runsAfterRetry).toHaveLength(1);
      expect(runner.acceptedOrder).toHaveLength(1);

      const duplicate = await accept(pushGmail(mailbox.email, "101"), [200]);
      await flushWaitUntilForTest();
      expect(duplicate.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 1,
      });
      const eventsAfterDup = await readProjectedChatEvents(context, {
        threadId: automation.chatThreadId,
        headers: admin.authenticate(),
      });
      const runsAfterDup = eventsAfterDup.filter((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined;
      });
      expect(runsAfterDup).toHaveLength(1);
      expect(runner.acceptedOrder).toHaveLength(1);
    },
  );

  it(
    "webhooks-gmail-014 dispatches matching new inbound messages and de-duplicates retries",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const accountA = gmailAccount("first");
      const accountB = gmailAccount("second");
      const watchHistoryIds = ["100", "200"];
      const { admin, runner } = await setupGmailRunMember([accountA, accountB]);
      const accounts = await listGmailAccounts(admin);
      const defaultConn = accounts.connections.find((entry) => {
        return entry.isDefault;
      });
      const secondConn = accounts.connections.find((entry) => {
        return !entry.isDefault;
      });
      if (!defaultConn || !secondConn) {
        throw new Error("Expected two Gmail connections");
      }
      const first =
        defaultConn.externalEmail === accountA.email ? accountA : accountB;
      const second = first === accountA ? accountB : accountA;

      server.use(
        http.post(`${GMAIL_API}/watch`, () => {
          return HttpResponse.json({
            historyId: watchHistoryIds.shift() ?? "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        }),
        http.post(`${GMAIL_API}/stop`, () => {
          return HttpResponse.json({}, { status: 204 });
        }),
        http.get(`${GMAIL_API}/history`, ({ request }) => {
          const token = bearer(request);
          if (token !== second.accessToken) {
            return HttpResponse.json({ history: [], historyId: "101" });
          }
          return HttpResponse.json({
            history: [
              {
                id: "101",
                messagesAdded: [
                  {
                    message: {
                      id: "msg-1",
                      threadId: "gmail-thread-1",
                      labelIds: ["INBOX"],
                    },
                  },
                ],
              },
            ],
            historyId: "101",
          });
        }),
        http.get(`${GMAIL_API}/messages/msg-1`, () => {
          return HttpResponse.json(
            gmailFullMessagePayload({
              id: "msg-1",
              threadId: "gmail-thread-1",
              from: "Customer Example <customer@example.com>",
              to: second.email,
              subject: "Invoice needs a reply",
              bodyText: "Please draft a helpful reply.",
            }),
          );
        }),
      );

      const [automationOne, automationTwo] = await Promise.all([
        accept(
          automationsApi.create({
            headers: admin.authenticate(),
            params: { workflowId: admin.workflowId },
            body: {
              kind: "event",
              eventType: "gmail-new-message",
              eventConfig: {
                provider: "gmail",
                event: "new_message",
                threadId: "gmail-thread-1",
                match: { subject: { contains: "invoice" } },
              },
            },
          }),
          [201],
        ),
        accept(
          automationsApi.create({
            headers: admin.authenticate(),
            params: { workflowId: admin.workflowId },
            body: {
              kind: "event",
              eventType: "gmail-new-message",
              eventConfig: {
                provider: "gmail",
                event: "new_message",
                threadId: "gmail-thread-2",
              },
            },
          }),
          [201],
        ),
      ]);
      const threadId = automationOne.body.chatThreadId;
      if (!threadId) {
        throw new Error("Expected automation chatThreadId");
      }

      await accept(
        chatSelectionsApi.update({
          headers: admin.authenticate(),
          params: { id: threadId },
          body: { target: GMAIL_TARGET, connectionId: secondConn.id },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const firstAccountPush = await accept(
        pushGmail(first.email, "101"),
        [200],
      );
      expect(firstAccountPush.body.dispatched).toBe(0);

      const [concurrentA, concurrentB] = await Promise.all([
        accept(pushGmail(second.email, "101"), [200]),
        accept(pushGmail(second.email, "101"), [200]),
      ]);
      await flushWaitUntilForTest();

      const sortedBodies = [concurrentA.body, concurrentB.body].sort(
        (left, right) => {
          return right.dispatched - left.dispatched;
        },
      );
      expect(sortedBodies).toStrictEqual([
        { success: true, watchStates: 1, dispatched: 1, duplicates: 0 },
        { success: true, watchStates: 1, dispatched: 0, duplicates: 1 },
      ]);

      const [events, access, refreshedOne, refreshedTwo] = await Promise.all([
        readProjectedChatEvents(context, {
          threadId,
          headers: admin.authenticate(),
        }),
        accept(
          chatConnectorAccessApi.getThread({
            headers: admin.authenticate(),
            params: { threadId },
            query: GMAIL_TARGET,
          }),
          [200],
        ),
        accept(
          automationsApi.get({
            headers: admin.authenticate(),
            params: { id: automationOne.body.id },
          }),
          [200],
        ),
        accept(
          automationsApi.get({
            headers: admin.authenticate(),
            params: { id: automationTwo.body.id },
          }),
          [200],
        ),
      ]);

      const automationEvents = events.filter((event) => {
        return event.eventType === "input.automation";
      });
      expect(automationEvents).toHaveLength(1);
      expect(
        visibleMessageText(automationEvents[0]?.userMessage?.parts ?? []),
      ).toContain(
        'A new email arrived from Customer Example <customer@example.com> with subject "Invoice needs a reply".',
      );
      expect(access.body.currentConnectionId).toBe(secondConn.id);
      expect(refreshedOne.body.lastRunAt).not.toBeNull();
      expect(refreshedTwo.body.lastRunAt).toBeNull();

      expect(runner.acceptedOrder).toHaveLength(1);
      const runId = runner.acceptedOrder[0] ?? "";
      const execution = runner.acceptedByRunId.get(runId);
      if (!execution) {
        throw new Error("Expected dispatched Gmail automation run");
      }
      expect(execution.prompt).toContain("Not included below: the email body.");
      expect(execution.prompt).not.toContain("Please draft a helpful reply.");
      expect(execution.prompt).toContain(automationOne.body.id);
      expect(execution.prompt).toContain('"event": "new_message"');
      expect(execution.prompt).toContain(second.email);
      expect(execution.prompt).toContain('"messageId": "msg-1"');
      expect(execution.prompt).toContain('"threadId": "gmail-thread-1"');
      expect(execution.prompt).toContain(
        '"from": "Customer Example <customer@example.com>"',
      );
      expect(execution.prompt).toContain(`"${second.email}"`);
      expect(execution.prompt).toContain('"cc": []');
      expect(execution.prompt).toContain('"subject": "Invoice needs a reply"');
      expect(execution.appendSystemPrompt).toContain("# Identity");

      const resolvedGmail = await resolveRunGmailAuthorization(execution);
      expect(resolvedGmail).toStrictEqual({
        sourceId: secondConn.id,
        authorization: `Bearer ${second.accessToken}`,
      });

      const finalRetry = await accept(pushGmail(second.email, "101"), [200]);
      await flushWaitUntilForTest();
      expect(finalRetry.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 1,
      });
      const eventsAfterRetry = await readProjectedChatEvents(context, {
        threadId,
        headers: admin.authenticate(),
      });
      expect(
        eventsAfterRetry.filter((event) => {
          return event.eventType === "input.automation";
        }),
      ).toHaveLength(1);
    },
  );

  it(
    "webhooks-gmail-019 binds an unbound Gmail automation when the member's first account connects",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const original = gmailAccount("orig-unbound");
      const replacement = gmailAccount("new-first");
      const watchTokens: string[] = [];
      const watchHistoryIds = ["100", "100"];
      server.use(
        http.post(`${GMAIL_API}/watch`, ({ request }) => {
          watchTokens.push(bearer(request));
          return HttpResponse.json({
            historyId: watchHistoryIds.shift() ?? "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        }),
        http.post(`${GMAIL_API}/stop`, () => {
          return HttpResponse.json({}, { status: 204 });
        }),
        http.get(`${GMAIL_API}/history`, () => {
          return HttpResponse.json({
            history: [
              {
                id: "101",
                messagesAdded: [
                  {
                    message: {
                      id: "msg-1",
                      threadId: "gmail-thread-1",
                      labelIds: ["INBOX"],
                    },
                  },
                ],
              },
            ],
            historyId: "101",
          });
        }),
        http.get(`${GMAIL_API}/messages/msg-1`, () => {
          return HttpResponse.json(
            gmailFullMessagePayload({
              id: "msg-1",
              threadId: "gmail-thread-1",
              from: "Customer Example <customer@example.com>",
              to: replacement.email,
              subject: "Invoice needs a reply",
              bodyText: "First account body",
            }),
          );
        }),
      );

      const { admin, runner } = await setupGmailRunMember([original]);
      const [automation, originalConnId] = await Promise.all([
        createNewMessageAutomation(admin),
        gmailConnectionId(admin, original),
      ]);
      await deleteGmailAccount(admin, originalConnId);
      const unboundState = await accept(
        automationsApi.get({
          headers: admin.authenticate(),
          params: { id: automation.id },
        }),
        [200],
      );
      expect(unboundState.body.enabled).toBeTruthy();
      expect(unboundState.body.lastRunAt).toBeNull();

      const replacementCode = `code-replacement-${randomUUID()}`;
      mockGmailOAuthByCode({ [replacementCode]: replacement });
      const oauthStart = await accept(
        gmailOauthStart.start({
          headers: admin.authenticate(),
          params: { connectorSlug: "gmail" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [200],
      );
      await completeGmailOauth(
        oauthStart.body.authorizationUrl,
        replacementCode,
      );
      await flushWaitUntilForTest();

      const listedAccounts = await listGmailAccounts(admin);
      expect(emailsOf(listedAccounts.connections)).toStrictEqual([
        { externalEmail: replacement.email, isDefault: true },
      ]);
      const replacementConnId = listedAccounts.connections[0]?.id ?? "";
      expect(watchTokens.at(-1)).toBe(replacement.accessToken);

      const pushed = await accept(pushGmail(replacement.email, "101"), [200]);
      await flushWaitUntilForTest();
      expect(pushed.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });

      const refreshed = await accept(
        automationsApi.get({
          headers: admin.authenticate(),
          params: { id: automation.id },
        }),
        [200],
      );
      expect(refreshed.body.enabled).toBeTruthy();
      expect(refreshed.body.lastRunAt).not.toBeNull();

      expect(runner.acceptedOrder).toHaveLength(1);
      const runId = runner.acceptedOrder[0] ?? "";
      const execution = runner.acceptedByRunId.get(runId);
      if (!execution) {
        throw new Error(
          "Expected dispatched run for newly bound Gmail account",
        );
      }
      expect(execution.prompt).toContain(automation.id);
      expect(execution.prompt).toContain(replacement.email);
      expect(execution.prompt).toContain('"messageId": "msg-1"');

      const resolvedGmail = await resolveRunGmailAuthorization(execution);
      expect(resolvedGmail).toStrictEqual({
        sourceId: replacementConnId,
        authorization: `Bearer ${replacement.accessToken}`,
      });
    },
  );

  it(
    "webhooks-gmail-021 dispatches label applied events after refreshing a recreated label id",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const mailbox = gmailAccount("label-recreate");
      let currentLabelId = "Label_support_old";
      const messageIds = ["msg-1", "msg-2", "msg-3", "msg-4"] as const;
      server.use(
        http.post(`${GMAIL_API}/watch`, () => {
          return HttpResponse.json({
            historyId: "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        }),
        http.get(`${GMAIL_API}/labels`, () => {
          return HttpResponse.json({
            labels: [{ id: currentLabelId, name: "Support" }],
          });
        }),
        http.get(`${GMAIL_API}/history`, () => {
          return HttpResponse.json({
            history: [
              {
                id: "102",
                labelsAdded: messageIds.map((messageId) => {
                  return {
                    message: {
                      id: messageId,
                      threadId: `thread-${messageId}`,
                      labelIds: ["INBOX", "Label_support_new"],
                    },
                    labelIds: ["Label_support_new"],
                  };
                }),
              },
            ],
            historyId: "102",
          });
        }),
        http.get(`${GMAIL_API}/messages/:messageId`, ({ params }) => {
          const messageId = String(params.messageId);
          return HttpResponse.json(
            gmailFullMessagePayload({
              id: messageId,
              threadId: `thread-${messageId}`,
              from: "Support Team <support@example.com>",
              to: mailbox.email,
              subject: `Support request ${messageId}`,
              bodyText: `Support body for ${messageId}`,
              labelIds: ["INBOX", "Label_support_new"],
            }),
          );
        }),
      );

      const { admin, runner } = await setupGmailRunMember([mailbox]);
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
              labelName: "Support",
            },
          },
        }),
        [201],
      );
      const threadId = created.body.chatThreadId;
      if (!threadId) {
        throw new Error("Expected automation chatThreadId");
      }
      if (
        created.body.kind !== "event" ||
        created.body.eventType !== "gmail-label-applied"
      ) {
        throw new Error("Expected gmail-label-applied automation");
      }
      expect(created.body.eventConfig).toMatchObject({
        labelName: "Support",
        resolvedLabelId: "Label_support_old",
      });

      currentLabelId = "Label_support_new";
      const pushed = await accept(pushGmail(mailbox.email, "102"), [200]);
      await flushWaitUntilForTest();
      expect(pushed.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 4,
        duplicates: 0,
      });

      for (let index = 0; index < messageIds.length; index += 1) {
        expect(runner.acceptedOrder).toHaveLength(index + 1);
        const runId = runner.acceptedOrder[index] ?? "";
        await runner.completeRun(runId);
      }
      expect(runner.acceptedOrder).toHaveLength(4);

      const [events, refreshed] = await Promise.all([
        readProjectedChatEvents(context, {
          threadId,
          headers: admin.authenticate(),
        }),
        accept(
          automationsApi.get({
            headers: admin.authenticate(),
            params: { id: created.body.id },
          }),
          [200],
        ),
      ]);
      const inputTexts = events
        .filter((event) => {
          return event.eventType === "input.automation";
        })
        .map((event) => {
          return visibleMessageText(event.userMessage?.parts ?? []);
        });
      expect(inputTexts).toStrictEqual(
        messageIds.map((messageId) => {
          return `Gmail label "Support" was added to an email from Support Team <support@example.com> with subject "Support request ${messageId}".`;
        }),
      );
      expect(refreshed.body.lastRunAt).not.toBeNull();
      if (
        refreshed.body.kind !== "event" ||
        refreshed.body.eventType !== "gmail-label-applied"
      ) {
        throw new Error("Expected refreshed gmail-label-applied automation");
      }
      expect(refreshed.body.eventConfig).toMatchObject({
        labelName: "Support",
        resolvedLabelId: "Label_support_new",
      });
    },
  );

  it(
    "webhooks-gmail-022 preserves metadata-only context through the workflow queue",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const mailbox = gmailAccount("meta-queue");
      server.use(
        http.post(`${GMAIL_API}/watch`, () => {
          return HttpResponse.json({
            historyId: "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        }),
        http.get(`${GMAIL_API}/history`, () => {
          return HttpResponse.json({
            history: [
              {
                id: "101",
                messagesAdded: [
                  {
                    message: {
                      id: "msg-1",
                      threadId: "gmail-thread-1",
                      labelIds: ["INBOX"],
                    },
                  },
                ],
              },
            ],
            historyId: "101",
          });
        }),
        http.get(`${GMAIL_API}/messages/msg-1`, () => {
          return HttpResponse.json(
            gmailFullMessagePayload({
              id: "msg-1",
              threadId: "gmail-thread-1",
              from: "Customer Example <customer@example.com>",
              to: mailbox.email,
              subject: "Invoice needs a reply",
              bodyText: "Please draft a helpful reply.",
            }),
          );
        }),
      );

      const { admin, runner } = await setupGmailRunMember([mailbox]);
      const created = await accept(
        automationsApi.create({
          headers: admin.authenticate(),
          params: { workflowId: admin.workflowId },
          body: {
            kind: "event",
            eventType: "gmail-new-message",
            eventConfig: {
              provider: "gmail",
              event: "new_message",
              match: { body: { contains: "helpful reply" } },
            },
          },
        }),
        [201],
      );

      await accept(
        automationsApi.run({
          headers: admin.authenticate(),
          params: { id: created.body.id },
          body: undefined,
        }),
        [201],
      );
      await flushWaitUntilForTest();
      expect(runner.acceptedOrder).toHaveLength(1);
      const manualRunId = runner.acceptedOrder[0] ?? "";

      const pushed = await accept(pushGmail(mailbox.email, "101"), [200]);
      await flushWaitUntilForTest();
      expect(pushed.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });
      expect(runner.acceptedOrder).toHaveLength(1);

      await runner.completeRun(manualRunId);
      expect(runner.acceptedOrder).toHaveLength(2);
      const secondRunId = runner.acceptedOrder[1] ?? "";
      const execution = runner.acceptedByRunId.get(secondRunId);
      if (!execution) {
        throw new Error("Expected queued Gmail run after manual run completed");
      }
      expect(execution.prompt).toContain("Not included below: the email body.");
      expect(execution.prompt).not.toContain("Please draft a helpful reply.");
      expect(execution.prompt).toContain(created.body.id);
      expect(execution.prompt).toContain('"event": "new_message"');
      expect(execution.prompt).toContain(mailbox.email);
      expect(execution.prompt).toContain('"messageId": "msg-1"');
      expect(execution.prompt).toContain('"threadId": "gmail-thread-1"');
      expect(execution.prompt).toContain(
        '"from": "Customer Example <customer@example.com>"',
      );
      expect(execution.prompt).toContain(`"${mailbox.email}"`);
      expect(execution.prompt).toContain('"cc": []');
      expect(execution.prompt).toContain('"subject": "Invoice needs a reply"');
      expect(execution.appendSystemPrompt).toContain("# Identity");
    },
  );
});
