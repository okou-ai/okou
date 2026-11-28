import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorExternalCodeSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsExternalCodeRoutes } from "../connectors-external-code";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { awsVerificationCode } from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const AWS_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "aws" as const,
});
const AWS_SIGNIN_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";
const AWS_FIREWALL_BASE = "https://{awsHost+}.amazonaws.com";

const awsTokenRequestBodySchema = object({
  clientId: string().min(1),
  grantType: string().min(1),
  code: string().optional(),
  refreshToken: string().optional(),
});

const app = setupApp({
  context,
  routes: [
    ...chatEventsRoutes,
    ...connectorAccountRoutes,
    ...builtinConnectorsExternalCodeRoutes,
    ...meModelProvidersUpsertRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentFirewallAuthRoutes,
    ...webhooksClerkRoutes,
    ...webhooksStripeRoutes,
  ],
});

const chatEventsApi = app(chatEventsContract);
const connectorAccountsApi = app(connectorAccountsContract);
const externalCodeApi = app(builtinConnectorExternalCodeSessionContract);
const personalModelProvidersApi = app(personalModelProvidersMainContract);
const runsCancelApi = app(runsCancelContract);
const agentCompleteApi = app(webhookCompleteContract);
const firewallAuthApi = app(runWebhookContract);
const clerkWebhookApi = app(webhookClerkContract);
const stripeWebhookApi = app(webhookStripeContract);

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function signIn(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "AWS",
    },
  ]);
  const memberships = actor.orgId
    ? [
        {
          id: `membership-${actor.userId}-${actor.orgId}`,
          createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ]
    : [];
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: memberships,
    },
  );
  return SESSION_HEADERS;
}

interface AwsCredentialsFixture {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly refreshToken: string;
}

interface AwsIdentityFixture {
  readonly accountId: string;
  readonly userId: string;
  readonly arn: string;
}

function awsSigv4AuthBody(sourceId: string, forceRefresh?: boolean) {
  const metadata = {
    sourceType: "connector" as const,
    sourceId,
  };
  return {
    authHeaders: {},
    authAwsSigv4: {
      accessKeyId: secretTemplate("AWS_ACCESS_KEY_ID"),
      secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
      sessionToken: secretTemplate("AWS_SESSION_TOKEN"),
    },
    secretConnectorMap: {
      AWS_ACCESS_KEY_ID: "aws",
      AWS_SECRET_ACCESS_KEY: "aws",
      AWS_SESSION_TOKEN: "aws",
    },
    secretConnectorMetadataMap: {
      AWS_ACCESS_KEY_ID: metadata,
      AWS_SECRET_ACCESS_KEY: metadata,
      AWS_SESSION_TOKEN: metadata,
    },
    matchedFirewall: {
      name: "aws",
      apiId: "api-0",
      base: AWS_FIREWALL_BASE,
      connectorSlug: "aws" as const,
      sourceId,
      routingVariables: {},
    },
    ...(forceRefresh === undefined ? {} : { forceRefresh }),
  };
}

function createAwsSigninMock() {
  let nextExchangeCredentials: AwsCredentialsFixture = {
    accessKeyId: "aws-initial-access-key-1",
    secretAccessKey: "initial-secret-access-key-1",
    sessionToken: "initial-session-token-1",
    refreshToken: "aws-initial-refresh-token-1",
  };
  let nextIdentity: AwsIdentityFixture = {
    accountId: "111111111111",
    userId: "aws-original-user",
    arn: "arn:aws:iam::111111111111:user/original",
  };
  let refreshResponder: () => Response = () => {
    return HttpResponse.json({
      tokenOutput: {
        accessToken: {
          accessKeyId: "aws-refreshed-access-key",
          secretAccessKey: "refreshed-secret-access-key",
          sessionToken: "refreshed-session-token",
        },
        expiresIn: 900,
        refreshToken: "aws-rotated-refresh-token",
        tokenType: "aws_sigv4",
        idToken: "aws-id-token",
      },
    });
  };
  const refreshRequests: { readonly refreshToken?: string }[] = [];

  server.use(
    http.post(AWS_SIGNIN_TOKEN_URL, async ({ request }) => {
      if (!request.headers.get("dpop")) {
        return HttpResponse.json(
          { error: "invalid_request", error_description: "Missing DPoP proof" },
          { status: 400 },
        );
      }
      const parsed = awsTokenRequestBodySchema.parse(await request.json());
      if (parsed.grantType === "refresh_token") {
        refreshRequests.push({ refreshToken: parsed.refreshToken });
        return refreshResponder();
      }
      return HttpResponse.json({
        tokenOutput: {
          accessToken: {
            accessKeyId: nextExchangeCredentials.accessKeyId,
            secretAccessKey: nextExchangeCredentials.secretAccessKey,
            sessionToken: nextExchangeCredentials.sessionToken,
          },
          expiresIn: 900,
          refreshToken: nextExchangeCredentials.refreshToken,
          tokenType: "aws_sigv4",
          idToken: "aws-id-token",
        },
      });
    }),
    http.get(AWS_STS_URL, () => {
      return HttpResponse.xml(
        [
          "<GetCallerIdentityResponse>",
          "<GetCallerIdentityResult>",
          `<UserId>${nextIdentity.userId}</UserId>`,
          `<Account>${nextIdentity.accountId}</Account>`,
          `<Arn>${nextIdentity.arn}</Arn>`,
          "</GetCallerIdentityResult>",
          "</GetCallerIdentityResponse>",
        ].join(""),
      );
    }),
  );

  return {
    refreshRequests,
    setExchange(
      credentials: AwsCredentialsFixture,
      identity: AwsIdentityFixture,
    ) {
      nextExchangeCredentials = credentials;
      nextIdentity = identity;
    },
    setRefreshResponder(handler: () => Response) {
      refreshResponder = handler;
    },
  };
}

beforeAll(async () => {
  const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
  const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  const missingId = randomUUID();
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(new Error("warmup"));
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_stripe_warmup");

  const warmupResult = await settleIncludingAbort(async () => {
    await Promise.all([
      accept(
        chatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.connections({
          headers: {},
          query: AWS_TARGET,
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.connection({
          headers: {},
          params: { connectionId: missingId },
          query: AWS_TARGET,
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.setDefault({
          headers: {},
          params: { connectionId: missingId },
          body: { target: AWS_TARGET },
        }),
        [401],
      ),
      accept(
        externalCodeApi.create({
          headers: {},
          params: { connectorSlug: "aws" },
          body: { authMethod: "cli", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        externalCodeApi.complete({
          headers: {},
          params: { connectorSlug: "aws", sessionId: missingId },
          body: {
            sessionToken: "warmup-session-token",
            code: Buffer.from("state=warmup&code=warmup").toString("base64"),
          },
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
        runsCancelApi.cancel({ headers: {}, params: { id: missingId } }),
        [401],
      ),
      accept(
        agentCompleteApi.complete({
          headers: {},
          body: { runId: missingId, exitCode: 1, error: "warmup" },
        }),
        [401],
      ),
      accept(
        firewallAuthApi.firewallAuth({
          headers: {},
          body: { authHeaders: {} },
        }),
        [401],
      ),
      accept(clerkWebhookApi.post({ body: "{}", extraHeaders: {} }), [401]),
      accept(stripeWebhookApi.post({ body: "{}", extraHeaders: {} }), [401]),
    ]);
  });

  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
  if (!warmupResult.ok) {
    throw warmupResult.error;
  }
});

interface TrackedRun {
  readonly runId: string;
  readonly sandboxToken: string;
  done: boolean;
}

function prepareProAwsRunEnvironment() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor with an organization");
  }
  const orgId = actor.orgId;
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  mockClaudeCodeTokenEndpoint();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);

  const trackedRuns: TrackedRun[] = [];
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");

  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: { id: orgId, created_by: actor.userId, created_at: now() },
  });

  const runnerGroupPromise = runs.configureRunnerGroup();
  const orgCreatedPromise = accept(
    clerkWebhookApi.post({ body: "{}", extraHeaders: {} }),
    [200],
  );
  let resolvedRunnerGroup: string | undefined;
  let proMemberPromise: Promise<string> | undefined;

  onTestFinished(async () => {
    const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
    if (resolvedRunnerGroup !== undefined) {
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", resolvedRunnerGroup);
    }
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const result = await settleIncludingAbort(async () => {
      await flushWaitUntilForTest();
      const activeRuns = trackedRuns.filter((tracked) => {
        return !tracked.done;
      });
      if (activeRuns.length > 0) {
        const ownerHeaders = signIn(actor);
        await Promise.all(
          activeRuns.map(async (tracked) => {
            await accept(
              runsCancelApi.cancel({
                headers: ownerHeaders,
                params: { id: tracked.runId },
              }),
              [200],
            );
            await accept(
              agentCompleteApi.complete({
                headers: bearerHeaders(tracked.sandboxToken),
                body: {
                  runId: tracked.runId,
                  exitCode: 137,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200],
            );
            tracked.done = true;
          }),
        );
      }
      await flushWaitUntilForTest();
    });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
    if (!result.ok) {
      throw result.error;
    }
  });

  function bootstrapProMember(): Promise<string> {
    if (proMemberPromise !== undefined) {
      return proMemberPromise;
    }
    proMemberPromise = (async () => {
      const [runnerGroup] = await Promise.all([
        runnerGroupPromise,
        orgCreatedPromise,
      ]);
      resolvedRunnerGroup = runnerGroup;
      const periodEnd = nowDate();
      periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);
      await Promise.all([
        postSubscriptionInvoicePaid(context.signal, {
          orgId,
          userId: actor.userId,
          tier: "pro",
          customerId: generatedStripeCustomerId(),
          subscriptionId: generatedStripeSubscriptionId(),
          currentPeriodEnd: periodEnd,
        }),
        accept(
          personalModelProvidersApi.upsert({
            headers: signIn(actor),
            body: {
              type: "claude-code-oauth-token",
              secret: `claude-token-${randomUUID()}`,
            },
          }),
          [201],
        ),
      ]);
      return runnerGroup;
    })();
    return proMemberPromise;
  }

  async function connectAwsAccount(displayName: string): Promise<string> {
    await orgCreatedPromise;
    const started = await accept(
      externalCodeApi.create({
        headers: signIn(actor),
        params: { connectorSlug: "aws" },
        body: {
          authMethod: "cli",
          account: { intent: "add", displayName },
        },
      }),
      [200],
    );
    const completed = await accept(
      externalCodeApi.complete({
        headers: signIn(actor),
        params: {
          connectorSlug: "aws",
          sessionId: started.body.sessionId,
        },
        body: {
          sessionToken: started.body.sessionToken,
          code: awsVerificationCode(
            started.body.authorizationUrl,
            `AWS-CODE-${randomUUID()}`,
          ),
        },
      }),
      [200],
    );
    return completed.body.connectionId;
  }

  async function startAwsRun(prompt: string) {
    const runnerGroup = await bootstrapProMember();
    await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          prompt,
          model: "claude-fable-5-1",
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
          hasTextContent: true,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const execution = await runs.nextReceivedExecution(runnerGroup);
    trackedRuns.push({
      runId: execution.runId,
      sandboxToken: execution.sandboxToken,
      done: false,
    });
    expect(execution.firewalls).toContainEqual(
      expect.objectContaining({
        kind: "builtin",
        name: "aws",
      }),
    );
    return execution;
  }

  return {
    actor,
    bootstrapProMember,
    connectAwsAccount,
    startAwsRun,
  };
}

describe("AWS Sign-In refresh expiry", () => {
  it(
    "webhooks-agent-firewall-auth-aws-002 keeps a healthy sibling account usable without substituting it for the expired account",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const awsMock = createAwsSigninMock();
      const envSetup = prepareProAwsRunEnvironment();
      const { actor } = envSetup;
      const proMemberPromise = envSetup.bootstrapProMember();

      awsMock.setExchange(
        {
          accessKeyId: "aws-original-key-1",
          secretAccessKey: "original-secret-key",
          sessionToken: "original-session-token",
          refreshToken: "original-refresh-token",
        },
        {
          accountId: "111111111111",
          userId: "aws-original-user-01",
          arn: "arn:aws:iam::111111111111:user/original-iam-user",
        },
      );
      const originalConnectionId = await envSetup.connectAwsAccount("Original");

      awsMock.setExchange(
        {
          accessKeyId: "aws-sibling-key-2",
          secretAccessKey: "sibling-secret-key",
          sessionToken: "sibling-session-token",
          refreshToken: "sibling-refresh-token",
        },
        {
          accountId: "222222222222",
          userId: "aws-sibling-user-02",
          arn: "arn:aws:iam::222222222222:user/sibling-iam-user",
        },
      );
      const [siblingConnectionId] = await Promise.all([
        envSetup.connectAwsAccount("Sibling"),
        proMemberPromise,
      ]);
      expect(siblingConnectionId).not.toBe(originalConnectionId);

      const execution = await envSetup.startAwsRun(
        "Verify sibling AWS account remains usable after original expires",
      );

      awsMock.setRefreshResponder(() => {
        return HttpResponse.json(
          {
            code: "TOKEN_EXPIRED",
            message: "The refresh token has expired",
          },
          { status: 401 },
        );
      });

      const firstOriginalFail = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(execution.firewallToken),
          body: awsSigv4AuthBody(originalConnectionId, true),
        }),
        [502],
      );
      expect(firstOriginalFail.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });
      expect(firstOriginalFail.body.error.connectors).toContain("aws");

      await accept(
        connectorAccountsApi.setDefault({
          headers: signIn(actor),
          params: { connectionId: siblingConnectionId },
          body: { target: AWS_TARGET },
        }),
        [200],
      );

      const [secondOriginalFail, siblingResolved, listedAccounts] =
        await Promise.all([
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(execution.firewallToken),
              body: awsSigv4AuthBody(originalConnectionId),
            }),
            [502],
          ),
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(execution.firewallToken),
              body: awsSigv4AuthBody(siblingConnectionId),
            }),
            [200],
          ),
          accept(
            connectorAccountsApi.connections({
              headers: signIn(actor),
              query: AWS_TARGET,
            }),
            [200],
          ),
        ]);

      expect(secondOriginalFail.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });
      expect(siblingResolved.body.awsSigv4).toStrictEqual({
        accessKeyId: "aws-sibling-key-2",
        secretAccessKey: "sibling-secret-key",
        sessionToken: "sibling-session-token",
      });
      expect(awsMock.refreshRequests).toHaveLength(1);

      const originalAccount = listedAccounts.body.connections.find(
        (account) => {
          return account.id === originalConnectionId;
        },
      );
      const siblingAccount = listedAccounts.body.connections.find((account) => {
        return account.id === siblingConnectionId;
      });
      expect(originalAccount).toMatchObject({
        connectionStatus: "reconnect-required",
        reconnectReason: "credential_expired",
      });
      expect(siblingAccount).toMatchObject({
        connectionStatus: "connected",
        reconnectReason: null,
      });
    },
  );

  it(
    "webhooks-agent-firewall-auth-aws-004 keeps HTTP 401 INVALID_CLIENT actionable and recoverable",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const awsMock = createAwsSigninMock();
      const envSetup = prepareProAwsRunEnvironment();
      const { actor } = envSetup;
      const [, connectionId] = await Promise.all([
        envSetup.bootstrapProMember(),
        envSetup.connectAwsAccount("InvalidClient"),
      ]);
      const execution = await envSetup.startAwsRun(
        "Verify HTTP 401 INVALID_CLIENT stays recoverable",
      );

      awsMock.setRefreshResponder(() => {
        return HttpResponse.json(
          {
            code: "INVALID_CLIENT",
            message: "Refresh token expired for client",
          },
          { status: 401 },
        );
      });

      const failed = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(execution.firewallToken),
          body: awsSigv4AuthBody(connectionId, true),
        }),
        [502],
      );
      expect(failed.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });

      const accountDuringFailure = await accept(
        connectorAccountsApi.connection({
          headers: signIn(actor),
          params: { connectionId },
          query: AWS_TARGET,
        }),
        [200],
      );
      expect(accountDuringFailure.body.reconnectReason).not.toBe(
        "credential_expired",
      );

      awsMock.setRefreshResponder(() => {
        return HttpResponse.json({
          tokenOutput: {
            accessToken: {
              accessKeyId: "aws-recovered-401-key",
              secretAccessKey: "recovered-401-secret",
              sessionToken: "recovered-401-session",
            },
            expiresIn: 900,
            refreshToken: "recovered-401-refresh",
            tokenType: "aws_sigv4",
            idToken: "aws-id-token",
          },
        });
      });

      const refreshesBeforeRetry = awsMock.refreshRequests.length;
      const recovered = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(execution.firewallToken),
          body: awsSigv4AuthBody(connectionId, true),
        }),
        [200],
      );
      expect(recovered.body.awsSigv4).toStrictEqual({
        accessKeyId: "aws-recovered-401-key",
        secretAccessKey: "recovered-401-secret",
        sessionToken: "recovered-401-session",
      });
      expect(awsMock.refreshRequests).toHaveLength(refreshesBeforeRetry + 1);

      const accountAfterRecovery = await accept(
        connectorAccountsApi.connection({
          headers: signIn(actor),
          params: { connectionId },
          query: AWS_TARGET,
        }),
        [200],
      );
      expect(accountAfterRecovery.body).toMatchObject({
        connectionStatus: "connected",
        reconnectReason: null,
      });
    },
  );

  it(
    "webhooks-agent-firewall-auth-aws-008 keeps HTTP 503 TOKEN_EXPIRED actionable and recoverable",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const awsMock = createAwsSigninMock();
      const envSetup = prepareProAwsRunEnvironment();
      const { actor } = envSetup;
      const [, connectionId] = await Promise.all([
        envSetup.bootstrapProMember(),
        envSetup.connectAwsAccount("Transient503"),
      ]);
      const execution = await envSetup.startAwsRun(
        "Verify HTTP 503 TOKEN_EXPIRED stays recoverable",
      );

      awsMock.setRefreshResponder(() => {
        return HttpResponse.json(
          {
            code: "TOKEN_EXPIRED",
            message: "AWS Sign-In temporarily unavailable",
          },
          { status: 503 },
        );
      });

      const failed = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(execution.firewallToken),
          body: awsSigv4AuthBody(connectionId, true),
        }),
        [502],
      );
      expect(failed.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "upstream_provider",
      });

      const accountDuringFailure = await accept(
        connectorAccountsApi.connection({
          headers: signIn(actor),
          params: { connectionId },
          query: AWS_TARGET,
        }),
        [200],
      );
      expect(accountDuringFailure.body.reconnectReason).not.toBe(
        "credential_expired",
      );

      awsMock.setRefreshResponder(() => {
        return HttpResponse.json({
          tokenOutput: {
            accessToken: {
              accessKeyId: "aws-recovered-503-key",
              secretAccessKey: "recovered-503-secret",
              sessionToken: "recovered-503-session",
            },
            expiresIn: 900,
            refreshToken: "recovered-503-refresh",
            tokenType: "aws_sigv4",
            idToken: "aws-id-token",
          },
        });
      });

      const refreshesBeforeRetry = awsMock.refreshRequests.length;
      const recovered = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(execution.firewallToken),
          body: awsSigv4AuthBody(connectionId, true),
        }),
        [200],
      );
      expect(recovered.body.awsSigv4).toStrictEqual({
        accessKeyId: "aws-recovered-503-key",
        secretAccessKey: "recovered-503-secret",
        sessionToken: "recovered-503-session",
      });
      expect(awsMock.refreshRequests).toHaveLength(refreshesBeforeRetry + 1);

      const accountAfterRecovery = await accept(
        connectorAccountsApi.connection({
          headers: signIn(actor),
          params: { connectionId },
          query: AWS_TARGET,
        }),
        [200],
      );
      expect(accountAfterRecovery.body).toMatchObject({
        connectionStatus: "connected",
        reconnectReason: null,
      });
    },
  );
});
