import { Buffer } from "node:buffer";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as signData,
} from "node:crypto";
import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  workflowAutomationsContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  chatEventAutomationPart,
  chatEventDisplayText,
} from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  clearWorkflowAutomationEventConnectorAsPreviousApi,
  seedBuiltInModelKey,
} from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { webhooksGmailRoutes } from "../webhooks-gmail";

const TEST_APP_ROUTES = Object.freeze([
  ...webhooksGmailRoutes,
  ...workflowAutomationsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chatApi = createChatFilesBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const miscApi = createMiscRoutesApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

const WORKFLOW_NAME = "gmail-webhook-workflow";
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const GMAIL_AUDIENCE = "https://api.okou.ai/api/webhooks/gmail";
const GMAIL_PUSH_SERVICE_ACCOUNT =
  "gmail-pubsub-push@vm0-ai-488909.iam.gserviceaccount.com";
const GMAIL_WORKSPACE_MODEL = DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
const GOOGLE_OIDC_CERT_KID = "gmail-pubsub-test-key";
const googleOidcKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleOidcPublicKeyPem = googleOidcKeyPair.publicKey.export({
  type: "spki",
  format: "pem",
});

interface GmailTestFixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly workflowId: string;
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function connectorAccountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function expectGmailEventContextInPrompt(
  prompt: string,
  expected: Record<string, unknown>,
): void {
  expect(prompt).toContain(JSON.stringify(expected, null, 2));
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedGoogleIdToken(): string {
  const issuedAt = Math.floor(now() / 1000);
  const header = {
    alg: "RS256",
    kid: GOOGLE_OIDC_CERT_KID,
    typ: "JWT",
  };
  const payload = {
    aud: GMAIL_AUDIENCE,
    email: GMAIL_PUSH_SERVICE_ACCOUNT,
    email_verified: true,
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: "https://accounts.google.com",
    sub: "gmail-pubsub-test-subject",
  };
  const signedContent = `${encodeJwtPart(header)}.${encodeJwtPart(payload)}`;
  const signature = signData(
    "RSA-SHA256",
    Buffer.from(signedContent, "utf8"),
    googleOidcKeyPair.privateKey,
  );
  return `${signedContent}.${signature.toString("base64url")}`;
}

function configureGoogleOidcCertMock(): void {
  server.use(
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json(
        { [GOOGLE_OIDC_CERT_KID]: googleOidcPublicKeyPem },
        { headers: { "cache-control": "no-cache" } },
      );
    }),
  );
}

function configureGmailEnv(): void {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
  mockOptionalEnv("GMAIL_PUBSUB_PUSH_AUDIENCE", GMAIL_AUDIENCE);
  mockOptionalEnv(
    "GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    GMAIL_PUSH_SERVICE_ACCOUNT,
  );
  configureGoogleOidcCertMock();
}

interface GmailWatchRecorder {
  calls: number;
}

interface GmailWatchLifecycleRecorder {
  readonly watchedTokens: string[];
  stopCalls: number;
}

function configureGmailWatchMock(
  historyIds: string | readonly string[] = "100",
): GmailWatchRecorder {
  const recorder: GmailWatchRecorder = { calls: 0 };
  server.use(
    http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
      recorder.calls += 1;
      return HttpResponse.json({
        historyId:
          typeof historyIds === "string"
            ? historyIds
            : historyIds[Math.min(recorder.calls - 1, historyIds.length - 1)],
        expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
      });
    }),
  );
  return recorder;
}

function configureGmailWatchLifecycleMock(args?: {
  readonly onStop?: () => void;
  readonly waitForStop?: () => Promise<void> | null;
}): GmailWatchLifecycleRecorder {
  const recorder: GmailWatchLifecycleRecorder = {
    watchedTokens: [],
    stopCalls: 0,
  };
  server.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      ({ request }) => {
        const authorization = request.headers.get("authorization");
        if (!authorization) {
          throw new Error("Expected Gmail watch authorization");
        }
        recorder.watchedTokens.push(authorization);
        return HttpResponse.json({
          historyId: authorization.endsWith("second-access-token")
            ? "200"
            : "100",
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      async () => {
        recorder.stopCalls += 1;
        args?.onStop?.();
        const waitForStop = args?.waitForStop?.();
        if (waitForStop) {
          await waitForStop;
        }
        return HttpResponse.json({ error: "retry cleanup" }, { status: 500 });
      },
    ),
  );
  return recorder;
}

function uniqueGmailEmail(): string {
  return `webhook-user-${randomUUID()}@example.com`;
}

function gmailBodyData(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function configureGmailMessageMocks(
  gmailEmail: string,
  accessToken = "gmail-access-token",
): void {
  server.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${accessToken}`,
        );
        expect(
          new URL(request.url).searchParams.get("startHistoryId"),
        ).toBeTruthy();
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
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId",
      () => {
        return HttpResponse.json({
          id: "msg-1",
          threadId: "gmail-thread-1",
          labelIds: ["INBOX", "IMPORTANT"],
          payload: {
            mimeType: "multipart/alternative",
            headers: [
              {
                name: "From",
                value: "Customer Example <customer@example.com>",
              },
              { name: "To", value: gmailEmail },
              { name: "Subject", value: "Invoice needs a reply" },
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: {
                  data: gmailBodyData("Please draft a helpful reply."),
                },
              },
            ],
          },
        });
      },
    ),
  );
}

function configureGmailLabelsMockSequence(
  labelsByCall: readonly (readonly {
    readonly id: string;
    readonly name: string;
  }[])[],
): void {
  let callIndex = 0;
  server.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels", () => {
      const labels =
        labelsByCall[Math.min(callIndex, labelsByCall.length - 1)] ?? [];
      callIndex += 1;
      return HttpResponse.json({ labels });
    }),
  );
}

function configureGmailLabelAppliedMocks(
  labelId: string,
  gmailEmail: string,
): void {
  server.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () => {
      return HttpResponse.json({
        history: [
          {
            id: "102",
            labelsAdded: [
              {
                message: {
                  id: "msg-labeled",
                  threadId: "gmail-thread-labeled",
                },
                labelIds: [labelId],
              },
            ],
          },
        ],
        historyId: "102",
      });
    }),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId",
      () => {
        return HttpResponse.json({
          id: "msg-labeled",
          threadId: "gmail-thread-labeled",
          labelIds: ["INBOX", labelId],
          payload: {
            headers: [
              { name: "From", value: "Support Team <support@example.com>" },
              { name: "To", value: gmailEmail },
              { name: "Subject", value: "Support request" },
            ],
          },
        });
      },
    ),
  );
}

function gmailPushBody(args: {
  readonly emailAddress: string;
  readonly historyId: string | number;
  readonly messageId: string;
}): string {
  return JSON.stringify({
    message: {
      messageId: args.messageId,
      data: Buffer.from(
        JSON.stringify({
          emailAddress: args.emailAddress,
          historyId: args.historyId,
        }),
        "utf8",
      ).toString("base64"),
    },
  });
}

async function postGmailWebhook(
  rawBody: string,
  googleIdToken = signedGoogleIdToken(),
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request("/api/webhooks/gmail", {
    method: "POST",
    headers: {
      authorization: `Bearer ${googleIdToken}`,
      "Content-Type": "application/json",
    },
    body: rawBody,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function expectResponseStatus(
  response: { readonly status: number; readonly body: unknown },
  status: number,
): void {
  if (response.status !== status) {
    throw new Error(
      `Expected status ${status}, received ${response.status}: ${JSON.stringify(
        response.body,
      )}`,
    );
  }
}

async function configureWorkspaceModelProvider(
  actor: ApiTestUser,
): Promise<void> {
  await configureBuiltInModelKey();
  const policies = await miscApi.listModelPolicies(actor);
  const workspacePolicy = policies.policies.find((policy) => {
    return policy.model === GMAIL_WORKSPACE_MODEL;
  });
  if (!workspacePolicy) {
    throw new Error(
      `Expected ${GMAIL_WORKSPACE_MODEL} model policy to be available`,
    );
  }
  await miscApi.updateModelPolicies(
    actor,
    [
      {
        ...workspacePolicy,
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ],
    [200],
  );
  const updated = await miscApi.listModelPolicies(actor);
  expect(
    updated.policies.find((policy) => {
      return policy.model === GMAIL_WORKSPACE_MODEL;
    }),
  ).toMatchObject({
    defaultProviderType: "built-in",
    modelProviderId: null,
  });
}

async function configureBuiltInModelKey(): Promise<void> {
  await seedBuiltInModelKey(context, GMAIL_WORKSPACE_MODEL);
}

async function configureAutomationThreadModel(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<void> {
  await chatApi.updateThreadModelSelection(
    actor,
    chatThreadId,
    GMAIL_WORKSPACE_MODEL,
  );
}

async function grantVisibleCredits(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  webhooksApi.configureStripeBillingEnv();
  const response = await webhooksApi.postStripeEvent(
    {
      id: `evt_gmail_credit_${randomUUID()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_gmail_credit_${randomUUID()}`,
          invoice: null,
          subscription: null,
          customer: null,
          metadata: {
            purpose: "credit_purchase",
            orgId: actor.orgId,
            creditsAmountMode: "amount_total",
          },
          amount_total: 1000,
          payment_status: "paid",
        },
      },
    },
    [200],
  );
  expect(response.body).toBe("OK");
}

async function connectGmail(
  actor: ApiTestUser,
  gmailEmail: string,
  subject = "bdd-gmail-user-id",
  account?: ConnectorAccountMutationIntent,
  agentId?: string,
): Promise<string> {
  mockGmailConnectorOAuth({
    accessToken: "gmail-access-token",
    email: gmailEmail,
    subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
    account,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth start URL to include state");
  }

  await connectorsApi.completeOauthCallback("gmail", {
    code: "gmail-code",
    state,
  });
  const connector = (
    await connectorsApi.listBuiltinConnectorAccounts(actor, "gmail")
  ).find((candidate) => {
    return account?.intent === "reconnect"
      ? candidate.id === account.connectionId
      : candidate.externalId === subject;
  });
  if (!connector) {
    throw new Error("Expected the connected Gmail account");
  }
  expect(connector).toMatchObject({
    authMethod: "oauth",
    externalEmail: gmailEmail,
    target: { kind: "builtin", connectorSlug: "gmail" },
  });
  return connector.id;
}

async function addGmailAccount(
  actor: ApiTestUser,
  args: {
    readonly gmailEmail: string;
    readonly subject: string;
    readonly accessToken: string;
    readonly displayName: string;
    readonly agentId: string;
  },
): Promise<string> {
  mockGmailConnectorOAuth({
    accessToken: args.accessToken,
    email: args.gmailEmail,
    subject: args.subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    args.agentId,
    { intent: "add", displayName: args.displayName },
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth start URL to include state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: "gmail-code",
    state,
  });
  const accounts = await connectorsApi.listBuiltinConnectorAccounts(
    actor,
    "gmail",
  );
  const account = accounts.find((candidate) => {
    return candidate.externalEmail === args.gmailEmail;
  });
  if (!account) {
    throw new Error("Expected the added Gmail account to be listed");
  }
  return account.id;
}

async function setupFixture(
  email = "gmail-webhook-owner@example.test",
): Promise<GmailTestFixture> {
  const actor = bdd.user({
    email,
    orgRole: "org:admin",
  });
  if (!actor.orgId) {
    throw new Error("Expected Gmail webhook fixture actor to have an org");
  }

  bdd.acceptAgentStorageWrites();
  await bdd.readOnboardingStatus(actor);
  await bdd.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "BDD Gmail Webhook Owner",
  });
  await grantVisibleCredits({ ...actor, orgId: actor.orgId });
  const agent = await bdd.createAgent(actor, {
    displayName: "gmail-webhook-agent",
    visibility: "private",
  });
  const workflow = await miscApi.createWorkflow(
    actor,
    agent.agentId,
    WORKFLOW_NAME,
    { content: "Handle Gmail webhook events." },
    [201],
  );
  if (!("id" in workflow.body)) {
    throw new Error(
      `Expected workflow creation to succeed, got ${JSON.stringify(
        workflow.body,
      )}`,
    );
  }
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    workflowId: workflow.body.id,
  };
}

interface MultiAccountGmailTestFixture extends GmailTestFixture {
  readonly firstEmail: string;
  readonly secondEmail: string;
  readonly firstConnectorId: string;
  readonly secondConnectorId: string;
}

async function setupMultiAccountGmailFixture(): Promise<MultiAccountGmailTestFixture> {
  const fixture = await setupFixture();
  await updateFeatureSwitchesForUser(context, fixture.actor, {});
  const firstEmail = uniqueGmailEmail();
  const secondEmail = uniqueGmailEmail();
  const firstConnectorId = await connectGmail(
    fixture.actor,
    firstEmail,
    "gmail-first-account",
    undefined,
    fixture.agentId,
  );
  const secondConnectorId = await addGmailAccount(fixture.actor, {
    gmailEmail: secondEmail,
    subject: "gmail-second-account",
    accessToken: "gmail-second-access-token",
    displayName: "Second Gmail",
    agentId: fixture.agentId,
  });
  return {
    ...fixture,
    firstEmail,
    secondEmail,
    firstConnectorId,
    secondConnectorId,
  };
}

async function readAutomation(
  actor: ApiTestUser,
  automationId: string,
): Promise<WorkflowAutomationSummary> {
  const response = await accept(
    automationsClient().get({
      headers: authHeaders(actor),
      params: { id: automationId },
    }),
    [200],
  );
  return response.body;
}

async function runAutomationNow(
  actor: ApiTestUser,
  automationId: string,
): Promise<{ readonly chatThreadId: string; readonly runId: string }> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(`/api/workflow-automations/${automationId}/run`, {
    method: "POST",
    headers: authHeaders(actor),
  });
  const body = (await response.json()) as unknown;
  if (response.status !== 201) {
    expectApiError(body);
    throw new Error(
      `Expected automation run to start, received ${response.status}: ${JSON.stringify(
        body,
      )}`,
    );
  }
  return body as { readonly chatThreadId: string; readonly runId: string };
}

function requireAutomationChatThreadId(
  automation: WorkflowAutomationSummary,
): string {
  if (!automation.chatThreadId) {
    throw new Error(
      `Expected automation ${automation.id} to have a chat thread`,
    );
  }
  return automation.chatThreadId;
}

async function workflowAutomationDisplayTexts(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<readonly (string | null)[]> {
  const { events } = await chatApi.listThreadEvents(actor, chatThreadId, {
    limit: 20,
  });
  return events
    .filter((event) => {
      return event.eventType === "input.prompt";
    })
    .map((event) => {
      return chatEventDisplayText(event);
    });
}

async function workflowRunIds(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<readonly string[]> {
  const { events } = await chatApi.listThreadEvents(actor, chatThreadId, {
    limit: 20,
  });
  return events.flatMap((message) => {
    if (
      message.eventType !== "input.prompt" ||
      chatEventAutomationPart(message)?.workflowName !== WORKFLOW_NAME ||
      !message.runId
    ) {
      return [];
    }
    return [message.runId];
  });
}

async function completeRunThroughSandbox(
  runnerGroup: string,
  runId: string,
): Promise<void> {
  await runsApi.heartbeatRunner(runnerGroup);
  const claim = await runsApi.claimRunnerJob(runId);
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooksApi.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `gmail-workflow-cli-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`gmail workflow history ${runId}`)
          .digest("hex"),
      },
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
}

describe("POST /api/webhooks/gmail", () => {
  it("invalidates Gmail label ids when the selected account is replaced", async () => {
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailLabelsMockSequence([
      [{ id: "Label_old_account", name: "Support" }],
    ]);

    const { actor, workflowId } = await setupFixture();
    await connectGmail(actor, uniqueGmailEmail(), "gmail-label-account-one");
    const initialConnection = await connectorsApi.readConnectorBySlug(
      actor,
      "gmail",
    );
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
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
    expect(created.body).toMatchObject({
      eventConfig: { resolvedLabelId: "Label_old_account" },
    });

    const replacementConnectionId = await connectGmail(
      actor,
      uniqueGmailEmail(),
      "gmail-label-account-two",
    );
    expect(replacementConnectionId).not.toBe(initialConnection.id);
    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "gmail",
      initialConnection.id,
    );
    const updated = await readAutomation(actor, created.body.id);
    if (
      updated.kind !== "event" ||
      updated.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected a Gmail label automation");
    }
    expect(updated.eventConfig).not.toHaveProperty("resolvedLabelId");
  });

  it("rejects an in-flight Gmail event after the selected account is removed", async () => {
    const oldEmail = uniqueGmailEmail();
    const newEmail = uniqueGmailEmail();
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailLabelAppliedMocks("Label_new_account", oldEmail);
    const labelLookupStarted = createDeferredPromise<void>(context.signal);
    const releaseLabelLookup = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseLabelLookup.settled()) {
        releaseLabelLookup.resolve();
      }
    });
    let labelLookupCount = 0;
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        async () => {
          labelLookupCount += 1;
          if (labelLookupCount === 1) {
            return HttpResponse.json({
              labels: [{ id: "Label_old_account", name: "Support" }],
            });
          }
          labelLookupStarted.resolve();
          await releaseLabelLookup.promise;
          return HttpResponse.json({
            labels: [{ id: "Label_new_account", name: "Support" }],
          });
        },
      ),
    );

    const { actor, workflowId } = await setupFixture();
    const initialConnectionId = await connectGmail(
      actor,
      oldEmail,
      "gmail-race-account-one",
    );
    await configureWorkspaceModelProvider(actor);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
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
    const chatThreadId = requireAutomationChatThreadId(created.body);
    await configureAutomationThreadModel(actor, chatThreadId);

    const webhookRequest = postGmailWebhook(
      gmailPushBody({
        emailAddress: oldEmail,
        historyId: 102,
        messageId: "pubsub-replaced-account-race",
      }),
    );
    await labelLookupStarted.promise;
    await connectGmail(actor, newEmail, "gmail-race-account-two");
    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "gmail",
      initialConnectionId,
    );
    releaseLabelLookup.resolve();

    const response = await webhookRequest;
    expectResponseStatus(response, 200);
    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const updated = await readAutomation(actor, created.body.id);
    if (
      updated.kind !== "event" ||
      updated.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected a Gmail label automation");
    }
    expect(updated.eventConfig).not.toHaveProperty("resolvedLabelId");
    await expect(workflowRunIds(actor, chatThreadId)).resolves.toStrictEqual(
      [],
    );
  });

  it("keeps same-account watch state and drops it when the account switches", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    const watch = configureGmailWatchMock();
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () => {
        return HttpResponse.json({ history: [], historyId: "101" });
      }),
    );

    const { actor, workflowId } = await setupFixture();
    await connectGmail(actor, gmailEmail, "gmail-account-one");
    const initialConnection = await connectorsApi.readConnectorBySlug(
      actor,
      "gmail",
    );
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    expect(watch.calls).toBe(1);

    const renamedGmailEmail = `renamed-${gmailEmail}`;
    await connectGmail(actor, renamedGmailEmail, "gmail-account-one", {
      intent: "reconnect",
      connectionId: initialConnection.id,
    });
    const sameAccountConnection = await connectorsApi.readConnectorBySlug(
      actor,
      "gmail",
    );
    expect(sameAccountConnection).toMatchObject({
      id: initialConnection.id,
      externalEmail: renamedGmailEmail,
    });
    expect(watch.calls).toBe(1);
    const sameAccountEvent = await postGmailWebhook(
      gmailPushBody({
        emailAddress: renamedGmailEmail,
        historyId: 101,
        messageId: "pubsub-same-account",
      }),
    );
    expectResponseStatus(sameAccountEvent, 200);
    expect(sameAccountEvent.body).toMatchObject({ watchStates: 1 });

    const replacementConnectionId = await connectGmail(
      actor,
      `replacement-${gmailEmail}`,
      "gmail-account-two",
    );
    expect(replacementConnectionId).not.toBe(initialConnection.id);
    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "gmail",
      initialConnection.id,
    );
    const oldAccountEvent = await postGmailWebhook(
      gmailPushBody({
        emailAddress: renamedGmailEmail,
        historyId: 102,
        messageId: "pubsub-old-account",
      }),
    );
    expectResponseStatus(oldAccountEvent, 200);
    expect(oldAccountEvent.body).toMatchObject({ watchStates: 0 });

    await accept(
      automationsClient().delete({
        headers: authHeaders(actor),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("short-circuits before Gmail history reads when no consumer remains", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    configureGmailWatchMock();
    let historyCalls = 0;
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        return HttpResponse.json({ error: "stop failed" }, { status: 500 });
      }),
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () => {
        historyCalls += 1;
        return HttpResponse.json({ history: [], historyId: "101" });
      }),
    );

    const { actor, workflowId } = await setupFixture();
    await connectGmail(actor, gmailEmail);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("refresh_token");
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "gmail-refreshed-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
    );
    const connectedAt = now();
    mockNow(connectedAt + 2 * 60 * 60 * 1000);
    await accept(
      automationsClient().disable({
        headers: authHeaders(actor),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(refreshCalls).toBe(1);
    mockNow(connectedAt);

    const response = await postGmailWebhook(
      gmailPushBody({
        emailAddress: gmailEmail,
        historyId: 101,
        messageId: "pubsub-no-consumer",
      }),
    );

    expectResponseStatus(response, 200);
    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    expect(historyCalls).toBe(0);
    expect(refreshCalls).toBe(1);

    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await accept(
      automationsClient().delete({
        headers: authHeaders(actor),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("acknowledges events without dispatching after Gmail access becomes unavailable", async () => {
    const startedAt = now();
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    configureGmailWatchMock();
    const { actor, workflowId } = await setupFixture();
    const connectorId = await connectGmail(actor, gmailEmail);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );

    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );
    const googleIdToken = signedGoogleIdToken();
    mockNow(startedAt + 2 * 60 * 60 * 1000);
    context.mocks.sentry.captureException.mockClear();

    for (const messageId of [
      "pubsub-gmail-access-unavailable-first",
      "pubsub-gmail-access-unavailable-repeat",
    ]) {
      const response = await postGmailWebhook(
        gmailPushBody({
          emailAddress: gmailEmail,
          historyId: 101,
          messageId,
        }),
        googleIdToken,
      );
      expectResponseStatus(response, 200);
      expect(response.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 0,
      });
    }

    expect(refreshCalls).toBe(1);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    await expect(
      connectorsApi.listBuiltinConnectorAccounts(actor, "gmail"),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: connectorId,
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(actor),
        params: { id: created.body.id },
      }),
      [200],
    );

    mockNow(startedAt);
    server.use(
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await connectGmail(actor, gmailEmail);
    await accept(
      automationsClient().delete({
        headers: authHeaders(actor),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("preserves existing Gmail cursors when another identity starts watching the mailbox", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    const watch = configureGmailWatchMock(["100", "200"]);
    const first = await setupFixture(
      `gmail-first-${randomUUID()}@example.test`,
    );
    await connectGmail(first.actor, gmailEmail);
    await accept(
      automationsClient().create({
        headers: authHeaders(first.actor),
        params: { workflowId: first.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );

    const second = await setupFixture(
      `gmail-second-${randomUUID()}@example.test`,
    );
    await connectGmail(second.actor, gmailEmail);
    await accept(
      automationsClient().create({
        headers: authHeaders(second.actor),
        params: { workflowId: second.workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    expect(watch.calls).toBe(2);

    const startHistoryIds: string[] = [];
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/history",
        ({ request }) => {
          const startHistoryId = new URL(request.url).searchParams.get(
            "startHistoryId",
          );
          if (!startHistoryId) {
            throw new Error("Expected Gmail history cursor");
          }
          startHistoryIds.push(startHistoryId);
          return HttpResponse.json({ history: [], historyId: "201" });
        },
      ),
    );

    const response = await postGmailWebhook(
      gmailPushBody({
        emailAddress: gmailEmail,
        historyId: 201,
        messageId: "pubsub-shared-mailbox",
      }),
    );

    expectResponseStatus(response, 200);
    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 2,
      dispatched: 0,
      duplicates: 0,
    });
    expect(startHistoryIds.sort()).toStrictEqual(["100", "200"]);
  });

  it("dispatches matching new inbound messages and de-duplicates retries", async () => {
    configureGmailEnv();
    const runnerGroup = runsApi.configureRunnerGroup();
    configureGmailWatchMock();

    const { actor, workflowId, firstEmail, secondEmail, secondConnectorId } =
      await setupMultiAccountGmailFixture();
    configureGmailMessageMocks(secondEmail, "gmail-second-access-token");
    await configureWorkspaceModelProvider(actor);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
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
    );
    const unrelatedThread = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            threadId: "gmail-thread-2",
            match: { subject: { contains: "invoice" } },
          },
        },
      }),
      [201],
    );
    const chatThreadId = requireAutomationChatThreadId(created.body);
    await configureAutomationThreadModel(actor, chatThreadId);
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: chatThreadId },
        body: {
          connectionId: secondConnectorId,
          target: { kind: "builtin", connectorSlug: "gmail" },
        },
      }),
      [200],
    );
    await clearWorkflowAutomationEventConnectorAsPreviousApi(
      context,
      created.body.id,
    );

    const oldSource = await postGmailWebhook(
      gmailPushBody({
        emailAddress: firstEmail,
        historyId: 101,
        messageId: "pubsub-old-account",
      }),
    );
    expectResponseStatus(oldSource, 200);
    expect(oldSource.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });

    const body = gmailPushBody({
      emailAddress: secondEmail,
      historyId: 101,
      messageId: "pubsub-1",
    });
    const first = await postGmailWebhook(body);

    expectResponseStatus(first, 200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    const expectedDisplayMessage =
      'A new email arrived from Customer Example <customer@example.com> with subject "Invoice needs a reply".';

    await expect(
      workflowAutomationDisplayTexts(actor, chatThreadId),
    ).resolves.toContain(expectedDisplayMessage);
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(actor),
        params: { id: chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: secondConnectorId,
        target: { kind: "builtin", connectorSlug: "gmail" },
      },
    ]);
    await expect(readAutomation(actor, created.body.id)).resolves.toMatchObject(
      {
        lastRunAt: expect.any(String),
      },
    );
    await expect(
      readAutomation(actor, unrelatedThread.body.id),
    ).resolves.toMatchObject({
      lastRunAt: null,
    });
    const [runId] = await workflowRunIds(actor, chatThreadId);
    if (!runId) {
      throw new Error("Expected a dispatched Gmail workflow run");
    }
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(runId);
    expect(claim.prompt).toContain("Not included below: the email body.");
    expect(claim.prompt).not.toContain("Please draft a helpful reply.");
    expectGmailEventContextInPrompt(claim.prompt, {
      automationId: created.body.id,
      event: "new_message",
      emailAddress: secondEmail,
      messageId: "msg-1",
      threadId: "gmail-thread-1",
      from: "Customer Example <customer@example.com>",
      to: [secondEmail],
      cc: [],
      subject: "Invoice needs a reply",
    });
    expect(claim.appendSystemPrompt).toContain("# Agent Identity");
    expect(claim.appendSystemPrompt).not.toContain("# Current context");
    expect(
      Object.values(claim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(expect.objectContaining({ sourceId: secondConnectorId }));

    const second = await postGmailWebhook(body);

    expectResponseStatus(second, 200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 1,
    });
    const displayMessagesAfterDuplicate = await workflowAutomationDisplayTexts(
      actor,
      chatThreadId,
    );
    expect(
      displayMessagesAfterDuplicate.filter((message) => {
        return message === expectedDisplayMessage;
      }),
    ).toHaveLength(1);
  });

  it("reprojects Gmail labels when the workflow thread account changes", async () => {
    configureGmailEnv();
    const recorder = configureGmailWatchLifecycleMock();
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        ({ request }) => {
          const authorization = request.headers.get("authorization");
          return HttpResponse.json({
            labels:
              authorization === "Bearer gmail-access-token"
                ? [{ id: "Label_collision", name: "Account scoped" }]
                : [{ id: "Label_collision", name: "Different label" }],
          });
        },
      ),
    );

    const { actor, workflowId, firstConnectorId, secondConnectorId } =
      await setupMultiAccountGmailFixture();
    const accountScopedLabelAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
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
    if (
      accountScopedLabelAutomation.body.kind !== "event" ||
      accountScopedLabelAutomation.body.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected an account-scoped Gmail label automation");
    }
    expect(accountScopedLabelAutomation.body.eventConfig).toStrictEqual({
      provider: "gmail",
      event: "label_applied",
      labelName: "Account scoped",
      resolvedLabelId: "Label_collision",
    });
    const chatThreadId = requireAutomationChatThreadId(
      accountScopedLabelAutomation.body,
    );
    expect(firstConnectorId).not.toBe(secondConnectorId);
    expect(recorder.watchedTokens).toStrictEqual(["Bearer gmail-access-token"]);

    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: chatThreadId },
        body: {
          connectionId: secondConnectorId,
          target: { kind: "builtin", connectorSlug: "gmail" },
        },
      }),
      [200],
    );
    expect(recorder.watchedTokens).toStrictEqual([
      "Bearer gmail-access-token",
      "Bearer gmail-second-access-token",
    ]);
    expect(recorder.stopCalls).toBe(1);
    const reprojectedLabelAutomation = await readAutomation(
      actor,
      accountScopedLabelAutomation.body.id,
    );
    if (
      reprojectedLabelAutomation.kind !== "event" ||
      reprojectedLabelAutomation.eventType !== "gmail-label-applied"
    ) {
      throw new Error("Expected a reprojected Gmail label automation");
    }
    expect(reprojectedLabelAutomation).toMatchObject({
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: "Account scoped",
      },
    });
    expect(reprojectedLabelAutomation.eventConfig).not.toHaveProperty(
      "resolvedLabelId",
    );

    const labelAuthorizations: (string | null)[] = [];
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
        ({ request }) => {
          labelAuthorizations.push(request.headers.get("authorization"));
          return HttpResponse.json({
            labels: [{ id: "Label_selected", name: "Selected account" }],
          });
        },
      ),
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
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
    expect(labelAuthorizations).toStrictEqual([
      "Bearer gmail-second-access-token",
    ]);
  });

  it("reconciles Gmail watches when selection and default account change", async () => {
    configureGmailEnv();
    const recorder = configureGmailWatchLifecycleMock();
    const { actor, workflowId, secondConnectorId } =
      await setupMultiAccountGmailFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    const chatThreadId = requireAutomationChatThreadId(created.body);
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(actor),
        params: { id: chatThreadId },
        body: {
          connectionId: secondConnectorId,
          target: { kind: "builtin", connectorSlug: "gmail" },
        },
      }),
      [200],
    );
    expect(recorder.watchedTokens).toStrictEqual([
      "Bearer gmail-access-token",
      "Bearer gmail-second-access-token",
    ]);
    expect(recorder.stopCalls).toBe(1);

    await accept(
      chatThreadConnectorSelectionsClient().clear({
        headers: authHeaders(actor),
        params: { id: chatThreadId },
        body: { kind: "builtin", connectorSlug: "gmail" },
      }),
      [204],
    );
    expect(recorder.watchedTokens).toStrictEqual([
      "Bearer gmail-access-token",
      "Bearer gmail-second-access-token",
      "Bearer gmail-access-token",
    ]);
    expect(recorder.stopCalls).toBe(2);
    const clearedSelections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(actor),
        params: { id: chatThreadId },
      }),
      [200],
    );
    expect(clearedSelections.body.selections).toStrictEqual([]);

    await accept(
      connectorAccountsClient().setDefault({
        headers: authHeaders(actor),
        params: { connectionId: secondConnectorId },
        body: { target: { kind: "builtin", connectorSlug: "gmail" } },
      }),
      [200],
    );
    expect(recorder.watchedTokens).toStrictEqual([
      "Bearer gmail-access-token",
      "Bearer gmail-second-access-token",
      "Bearer gmail-access-token",
      "Bearer gmail-second-access-token",
    ]);
    expect(recorder.stopCalls).toBe(3);
  });

  it("commits Gmail default-account deletion before provider cleanup", async () => {
    configureGmailEnv();
    let signalStopStarted: (() => void) | null = null;
    let waitForStopRelease: Promise<void> | null = null;
    const recorder = configureGmailWatchLifecycleMock({
      onStop: () => {
        signalStopStarted?.();
      },
      waitForStop: () => {
        return waitForStopRelease;
      },
    });
    const { actor, workflowId, firstConnectorId, secondConnectorId } =
      await setupMultiAccountGmailFixture();
    await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    await accept(
      connectorAccountsClient().setDefault({
        headers: authHeaders(actor),
        params: { connectionId: secondConnectorId },
        body: { target: { kind: "builtin", connectorSlug: "gmail" } },
      }),
      [200],
    );

    const stopStarted = createDeferredPromise<void>(context.signal);
    const stopRelease = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!stopRelease.settled()) {
        stopRelease.resolve();
      }
    });
    signalStopStarted = () => {
      stopStarted.resolve();
    };
    waitForStopRelease = stopRelease.promise;
    const deleteDefaultRequest = connectorAccountsClient().delete({
      headers: authHeaders(actor),
      params: { connectionId: secondConnectorId },
      body: { target: { kind: "builtin", connectorSlug: "gmail" } },
    });
    await stopStarted.promise;
    const accountsWhileProviderStopIsPending =
      await connectorsApi.listBuiltinConnectorAccounts(actor, "gmail");
    expect(
      accountsWhileProviderStopIsPending.map((account) => {
        return { id: account.id, isDefault: account.isDefault };
      }),
    ).toStrictEqual([{ id: firstConnectorId, isDefault: true }]);
    stopRelease.resolve();
    signalStopStarted = null;
    waitForStopRelease = null;

    const deletedDefault = await accept(deleteDefaultRequest, [200]);
    expect(deletedDefault.body).toStrictEqual({
      deletedConnectionId: secondConnectorId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: firstConnectorId,
    });
    expect(recorder.watchedTokens).toStrictEqual([
      "Bearer gmail-access-token",
      "Bearer gmail-second-access-token",
      "Bearer gmail-access-token",
    ]);
    expect(recorder.stopCalls).toBe(2);
  });

  it("restores a Gmail watch after the last account is replaced", async () => {
    configureGmailEnv();
    const recorder = configureGmailWatchLifecycleMock();
    const { actor, agentId, workflowId } = await setupFixture();
    await updateFeatureSwitchesForUser(context, actor, {});
    const firstConnectorId = await connectGmail(
      actor,
      uniqueGmailEmail(),
      "gmail-first-account",
      undefined,
      agentId,
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    const deletedLast = await accept(
      connectorAccountsClient().delete({
        headers: authHeaders(actor),
        params: { connectionId: firstConnectorId },
        body: { target: { kind: "builtin", connectorSlug: "gmail" } },
      }),
      [200],
    );
    expect(deletedLast.body).toStrictEqual({
      deletedConnectionId: firstConnectorId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });

    const replacementConnectorId = await addGmailAccount(actor, {
      gmailEmail: uniqueGmailEmail(),
      subject: "gmail-replacement-account",
      accessToken: "gmail-replacement-access-token",
      displayName: "Replacement Gmail",
      agentId,
    });
    expect(replacementConnectorId).not.toBe(firstConnectorId);
    expect(recorder.watchedTokens).toStrictEqual([
      "Bearer gmail-access-token",
      "Bearer gmail-replacement-access-token",
    ]);
    expect(recorder.stopCalls).toBe(1);
    const accounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "gmail",
    );
    expect(accounts).toStrictEqual([
      expect.objectContaining({ id: replacementConnectorId, isDefault: true }),
    ]);
  });

  it("dispatches label applied events after refreshing a recreated label id", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailLabelsMockSequence([
      [{ id: "Label_support_old", name: "Support" }],
      [{ id: "Label_support_new", name: "Support" }],
    ]);
    configureGmailLabelAppliedMocks("Label_support_new", gmailEmail);

    const { actor, workflowId } = await setupFixture();
    await connectGmail(actor, gmailEmail);
    await configureWorkspaceModelProvider(actor);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
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
    const chatThreadId = requireAutomationChatThreadId(created.body);
    await configureAutomationThreadModel(actor, chatThreadId);

    expect(created.body).toMatchObject({
      eventType: "gmail-label-applied",
      eventConfig: {
        labelName: "Support",
        resolvedLabelId: "Label_support_old",
      },
    });

    const first = await postGmailWebhook(
      gmailPushBody({
        emailAddress: gmailEmail,
        historyId: 102,
        messageId: "pubsub-label-1",
      }),
    );

    expectResponseStatus(first, 200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    await expect(
      workflowAutomationDisplayTexts(actor, chatThreadId),
    ).resolves.toContain(
      'Gmail label "Support" was added to an email from Support Team <support@example.com> with subject "Support request".',
    );
    await expect(readAutomation(actor, created.body.id)).resolves.toMatchObject(
      {
        eventConfig: {
          labelName: "Support",
          resolvedLabelId: "Label_support_new",
        },
        lastRunAt: expect.any(String),
      },
    );
  });

  it("preserves metadata-only context through the workflow queue", async () => {
    const gmailEmail = uniqueGmailEmail();
    configureGmailEnv();
    const runnerGroup = runsApi.configureRunnerGroup();
    configureGmailWatchMock();
    configureGmailMessageMocks(gmailEmail);

    const { actor, workflowId } = await setupFixture();
    await connectGmail(actor, gmailEmail);
    await configureWorkspaceModelProvider(actor);

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(actor),
        params: { workflowId },
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
    const chatThreadId = requireAutomationChatThreadId(created.body);
    await configureAutomationThreadModel(actor, chatThreadId);
    const activeRun = await runAutomationNow(actor, created.body.id);

    const response = await postGmailWebhook(
      gmailPushBody({
        emailAddress: gmailEmail,
        historyId: 101,
        messageId: "pubsub-queued",
      }),
    );

    expectResponseStatus(response, 200);
    expect(response.body).toMatchObject({ dispatched: 1, duplicates: 0 });
    await expect(workflowRunIds(actor, chatThreadId)).resolves.toStrictEqual([
      activeRun.runId,
    ]);

    await completeRunThroughSandbox(runnerGroup, activeRun.runId);
    const runIds = await workflowRunIds(actor, chatThreadId);
    expect(runIds).toHaveLength(2);
    const queuedRunId = runIds.find((runId) => {
      return runId !== activeRun.runId;
    });
    if (!queuedRunId) {
      throw new Error("Expected the queued Gmail event to start a run");
    }

    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(queuedRunId);
    const appendSystemPrompt = claim.appendSystemPrompt;
    if (typeof appendSystemPrompt !== "string") {
      throw new Error("Expected appendSystemPrompt on the queued run");
    }
    expect(claim.prompt).toContain("Not included below: the email body.");
    expect(claim.prompt).not.toContain("Please draft a helpful reply.");
    expectGmailEventContextInPrompt(claim.prompt, {
      automationId: created.body.id,
      event: "new_message",
      emailAddress: gmailEmail,
      messageId: "msg-1",
      threadId: "gmail-thread-1",
      from: "Customer Example <customer@example.com>",
      to: [gmailEmail],
      cc: [],
      subject: "Invoice needs a reply",
    });
    expect(appendSystemPrompt).toContain("# Agent Identity");
    expect(appendSystemPrompt).not.toContain("# Current context");
  });
});
