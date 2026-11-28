import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

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
  webhookGoogleWorkspaceEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
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
import { webhooksGoogleWorkspaceEventsRoutes } from "../webhooks-google-workspace-events";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const WORKSPACE_EVENTS_API = "https://workspaceevents.googleapis.com/v1";
const MEET_TRANSCRIPT = "google-meet-transcript-generated" as const;
const MEET_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "google-meet" as const,
});
const WORKSPACE_PUSH_SERVICE_ACCOUNT =
  "workspace-events-push@okou-test.iam.gserviceaccount.com";
const WORKSPACE_CERT_KID = "workspace-events-pubsub-signing-key";
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const CLAUDE_MODEL = "claude-fable-5-1";

const workspaceSigningKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const workflowsApi = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsCollectionContract);
const workflowsDetailApi = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsDetailContract);
const automationsApi = setupApp({
  context,
  routes: workflowAutomationsRoutes,
})(workflowAutomationsContract);
const accountsApi = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);
const chatSelectionsApi = setupApp({
  context,
  routes: chatThreadConnectorSelectionRoutes,
})(chatThreadConnectorSelectionContract);
const chatThreadEventsApi = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadEventsContract);
const meetOauthStartApi = setupApp({
  context,
  routes: builtinConnectorsRoutes,
})(builtinConnectorOauthStartContract);
const meetOauthCallbackApi = setupApp({
  context,
  routes: builtinConnectorsSlugCallbackRoutes,
})(builtinConnectorsSlugCallbackContract);
const workspaceWebhookApi = setupApp({
  context,
  routes: webhooksGoogleWorkspaceEventsRoutes,
})(webhookGoogleWorkspaceEventsContract);
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

interface MeetAccount {
  readonly email: string;
  readonly accessToken: string;
  readonly subject: string;
}

interface WorkspaceSubscriptionCall {
  readonly name: string;
  readonly token: string;
}

interface WorkspaceEventsProvider {
  readonly created: WorkspaceSubscriptionCall[];
  readonly deleted: WorkspaceSubscriptionCall[];
  readonly renewed: string[];
  subscriptionsForToken(token: string): readonly string[];
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
}

function meetAccount(label: string): MeetAccount {
  const id = randomUUID();
  const email = `meet-${label}-${id}@example.com`;
  return {
    email,
    accessToken: `meet-${label}-token-${id}`,
    subject: `meet-subject-${email}`,
  };
}

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

function configureWorkspaceEventsPubSub(): void {
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME",
    `projects/okou-test/topics/workspace-events-${randomUUID()}`,
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE",
    "https://api.okou.test/api/webhooks/google-workspace-events",
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    WORKSPACE_PUSH_SERVICE_ACCOUNT,
  );
  server.use(
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json({
        [WORKSPACE_CERT_KID]: workspaceSigningKey.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      });
    }),
  );
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function workspacePubSubToken(): string {
  const seconds = Math.floor(now() / 1000);
  const signingInput = `${encodeJwtPart({ alg: "RS256", typ: "JWT", kid: WORKSPACE_CERT_KID })}.${encodeJwtPart(
    {
      iss: "https://accounts.google.com",
      aud: optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE"),
      sub: "workspace-events-push-service-account",
      email: WORKSPACE_PUSH_SERVICE_ACCOUNT,
      email_verified: true,
      iat: seconds,
      exp: seconds + 3600,
    },
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(workspaceSigningKey.privateKey).toString("base64url")}`;
}

function mockWorkspaceEventsApi(): WorkspaceEventsProvider {
  const created: WorkspaceSubscriptionCall[] = [];
  const deleted: WorkspaceSubscriptionCall[] = [];
  const renewed: string[] = [];

  server.use(
    http.get(`${WORKSPACE_EVENTS_API}/subscriptions`, () => {
      return HttpResponse.json({ subscriptions: [] });
    }),
    http.post(`${WORKSPACE_EVENTS_API}/subscriptions`, ({ request }) => {
      const name = `subscriptions/sub-${randomUUID().slice(0, 8)}`;
      const token = bearer(request);
      created.push({ name, token });
      return HttpResponse.json({
        done: true,
        response: {
          name,
          state: "ACTIVE",
          expireTime: new Date(now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          notificationEndpoint: {
            pubsubTopic:
              optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME") ?? "",
          },
        },
      });
    }),
    http.patch(`${WORKSPACE_EVENTS_API}/subscriptions/:id`, ({ params }) => {
      const name = `subscriptions/${String(params.id)}`;
      renewed.push(name);
      return HttpResponse.json({ done: true, response: { name } });
    }),
    http.delete(
      `${WORKSPACE_EVENTS_API}/subscriptions/:id`,
      ({ request, params }) => {
        const name = `subscriptions/${String(params.id)}`;
        deleted.push({ name, token: bearer(request) });
        return HttpResponse.json({ done: true });
      },
    ),
  );

  return {
    created,
    deleted,
    renewed,
    subscriptionsForToken(token: string): readonly string[] {
      return created
        .filter((entry) => {
          return entry.token === token;
        })
        .map((entry) => {
          return entry.name;
        });
    },
  };
}

function mockGoogleMeetOAuthByCode(
  accountsByCode: Readonly<Record<string, MeetAccount>>,
): void {
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");

  const accountsByToken = new Map<string, MeetAccount>();
  for (const account of Object.values(accountsByCode)) {
    accountsByToken.set(account.accessToken, account);
  }

  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== "authorization_code") {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh is not granted by this fixture",
          },
          { status: 400 },
        );
      }
      const code = body.get("code") ?? "";
      const account = accountsByCode[code];
      if (!account) {
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
        scope:
          "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get(GOOGLE_USERINFO_URL, ({ request }) => {
      const account = accountsByToken.get(bearer(request));
      if (!account) {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({
        id: account.subject,
        email: account.email,
        name: "BDD Meet User",
      });
    }),
  );
}

async function completeMeetOauth(
  authorizationUrl: string,
  code: string,
): Promise<void> {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Meet OAuth state");
  }
  const completed = await accept(
    meetOauthCallbackApi.callback({
      headers: {},
      params: { connectorSlug: "google-meet" },
      query: { code, state, responseMode: "json" },
    }),
    [200],
  );
  expect(completed.body.status).toBe("success");
}

function pushMeetTranscript(subscriptionName: string) {
  const transcriptName = `conferenceRecords/rec-${randomUUID().slice(0, 8)}/transcripts/tr-${randomUUID().slice(0, 8)}`;
  const cloudEvent = {
    id: `ce-${randomUUID()}`,
    source: `//workspaceevents.googleapis.com/${subscriptionName}`,
    type: "google.workspace.meet.transcript.v2.fileGenerated",
    time: new Date(now()).toISOString(),
    specversion: "1.0",
    data: {
      transcript: { name: transcriptName },
    },
  };
  return workspaceWebhookApi.post({
    body: JSON.stringify({
      message: {
        messageId: `pubsub-${randomUUID()}`,
        data: Buffer.from(JSON.stringify(cloudEvent), "utf8").toString(
          "base64",
        ),
      },
      subscription: "projects/okou-test/subscriptions/workspace-events-push",
    }),
    extraHeaders: { authorization: `Bearer ${workspacePubSubToken()}` },
  });
}

describe("Google Workspace Events subscription lifecycle", () => {
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
            body: { name: "warmup-meet", visibility: "private" },
          }),
          [401],
        ),
        accept(
          workflowsDetailApi.copy({
            headers: {},
            params: { workflowId: warmupId },
            body: {},
          }),
          [401],
        ),
        accept(
          automationsApi.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          accountsApi.connections({ headers: {}, query: MEET_TARGET }),
          [401],
        ),
        accept(
          chatSelectionsApi.get({ headers: {}, params: { id: warmupId } }),
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
          meetOauthStartApi.start({
            headers: {},
            params: { connectorSlug: "google-meet" },
            body: { authMethod: "oauth", account: { intent: "add" } },
          }),
          [401],
        ),
        accept(
          workspaceWebhookApi.post({
            body: "{}",
          }),
          [401, 503],
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
        bdd.requestReadMe(null, [401]),
      ]);
      configureWorkspaceEventsPubSub();
      await accept(
        workspaceWebhookApi.post({
          body: "{}",
          extraHeaders: { authorization: `Bearer ${workspacePubSubToken()}` },
        }),
        [400],
      );
      server.resetHandlers();
      runnerDispatchEnvelopeSchema.safeParse({});
    });
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  function createDirectRunnerForMeet() {
    const group = `vm0/meet-${randomUUID().slice(0, 8)}`;
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
        lastName: "Meet",
      },
    ]);
    return SESSION;
  }

  async function setupMeetRunMember(options: {
    readonly accounts: readonly MeetAccount[];
    readonly workflowVisibility?: "private" | "public";
    readonly extraWorkflows?: number;
  }) {
    configureWorkspaceEventsPubSub();
    const provider = mockWorkspaceEventsApi();
    const runner = createDirectRunnerForMeet();
    const actor = bdd.user({ orgRole: "org:admin" });
    if (!actor.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    const authenticate = () => {
      return signInMember(actor);
    };
    authenticate();

    const codeByIndex = options.accounts.map((_, index) => {
      return `meet-code-${index}-${randomUUID()}`;
    });
    const accountsByCode: Record<string, MeetAccount> = {};
    for (const [index, account] of options.accounts.entries()) {
      const code = codeByIndex[index];
      if (code) {
        accountsByCode[code] = account;
      }
    }
    if (options.accounts.length > 0) {
      mockGoogleMeetOAuthByCode(accountsByCode);
    }

    const totalWorkflows = 1 + (options.extraWorkflows ?? 0);
    const [createdWorkflows, oauthStarts] = await Promise.all([
      Promise.all(
        Array.from({ length: totalWorkflows }, (_, index) => {
          return accept(
            workflowsApi.create({
              headers: SESSION,
              body: {
                name: `meet-wf-${index}-${randomUUID().slice(0, 8)}`,
                visibility:
                  index === 0
                    ? (options.workflowVisibility ?? "private")
                    : "private",
              },
            }),
            [201],
          );
        }),
      ),
      Promise.all(
        options.accounts.map(() => {
          return accept(
            meetOauthStartApi.start({
              headers: SESSION,
              params: { connectorSlug: "google-meet" },
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

    // Complete OAuth callbacks sequentially so the first account is deterministically default.
    const updatePref = accept(
      userModelPreferenceApi.update({
        headers: SESSION,
        body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
      }),
      [200],
    );
    for (const [index, started] of oauthStarts.entries()) {
      const code = codeByIndex[index];
      if (!code) {
        throw new Error("Missing Google Meet OAuth code");
      }
      await completeMeetOauth(started.body.authorizationUrl, code);
    }
    await updatePref;

    async function listMeetAccounts() {
      const listed = await accept(
        accountsApi.connections({
          headers: authenticate(),
          query: MEET_TARGET,
        }),
        [200],
      );
      return listed.body.connections;
    }

    async function addMeetAccount(account: MeetAccount) {
      const code = `meet-add-${randomUUID()}`;
      mockGoogleMeetOAuthByCode({ [code]: account });
      const started = await accept(
        meetOauthStartApi.start({
          headers: authenticate(),
          params: { connectorSlug: "google-meet" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [200],
      );
      await completeMeetOauth(started.body.authorizationUrl, code);
      await flushWaitUntilForTest();
    }

    return {
      actor,
      provider,
      runner,
      workflowIds: createdWorkflows.map((wf) => {
        return wf.body.id;
      }),
      authenticate,
      listMeetAccounts,
      addMeetAccount,
    };
  }

  async function resolveRunMeetAuthorization(
    execution: ExecutionContext,
  ): Promise<{ readonly sourceId: string; readonly authorization: string }> {
    const meetTarget = execution.connectorRuntimeTargets?.find((target) => {
      return (
        target.kind === "builtin" && target.connectorSlug === "google-meet"
      );
    });
    if (!meetTarget?.sourceId) {
      throw new Error("Expected Google Meet runtime target on dispatched run");
    }
    const resolved = await accept(
      firewallAuthApi.resolve({
        headers: { authorization: `Bearer ${execution.firewallToken}` },
        body: {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("GOOGLE_MEET_TOKEN")}`,
          },
          secretConnectorMap: { GOOGLE_MEET_TOKEN: "google-meet" },
          secretConnectorMetadataMap: {
            GOOGLE_MEET_TOKEN: {
              sourceType: "connector",
              sourceId: meetTarget.sourceId,
            },
          },
        },
      }),
      [200],
    );
    return {
      sourceId: meetTarget.sourceId,
      authorization: resolved.body.headers.Authorization ?? "",
    };
  }

  it(
    "webhooks-google-workspace-events-001 dispatches a visible Google Meet transcript message",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const primary = meetAccount("primary");
      const { provider, runner, workflowIds, authenticate } =
        await setupMeetRunMember({ accounts: [primary] });
      const workflowId = workflowIds[0];
      if (!workflowId) {
        throw new Error("Expected workflowId");
      }

      const created = await accept(
        automationsApi.create({
          headers: authenticate(),
          params: { workflowId },
          body: { kind: "event", eventType: MEET_TRANSCRIPT },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const threadId = created.body.chatThreadId;
      const [subscription] = provider.subscriptionsForToken(
        primary.accessToken,
      );
      if (!threadId || !subscription) {
        throw new Error("Expected Meet automation thread and subscription");
      }

      const pushed = await accept(pushMeetTranscript(subscription), [200]);
      await flushWaitUntilForTest();

      expect(pushed.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });
      expect(runner.acceptedOrder).toHaveLength(1);

      const [events, selections, deleted] = await Promise.all([
        readProjectedChatEvents(context, {
          threadId,
          headers: authenticate(),
        }),
        accept(
          chatSelectionsApi.get({
            headers: authenticate(),
            params: { id: threadId },
          }),
          [200],
        ),
        accept(
          automationsApi.delete({
            headers: authenticate(),
            params: { id: created.body.id },
            body: undefined,
          }),
          [204],
        ),
      ]);
      const visibleTexts = events
        .filter((event) => {
          return event.eventType === "input.automation";
        })
        .map((event) => {
          return visibleMessageText(event.userMessage?.parts ?? []);
        });
      expect(visibleTexts).toContain("A Google Meet transcript is ready.");
      expect(selections.body.selections).toStrictEqual([]);
      expect(selections.body.selectedConnections).toStrictEqual([]);
      expect(deleted.status).toBe(204);
    },
  );

  it(
    "webhooks-google-workspace-events-005 isolates simultaneous subscriptions and dispatch by selected account",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const primary = meetAccount("iso-primary");
      const secondary = meetAccount("iso-secondary");
      const { provider, runner, workflowIds, authenticate, listMeetAccounts } =
        await setupMeetRunMember({
          accounts: [primary, secondary],
          extraWorkflows: 1,
        });
      const [firstWorkflowId, secondWorkflowId] = workflowIds;
      if (!firstWorkflowId || !secondWorkflowId) {
        throw new Error("Expected two workflows");
      }

      const [firstAuto, accounts] = await Promise.all([
        accept(
          automationsApi.create({
            headers: authenticate(),
            params: { workflowId: firstWorkflowId },
            body: { kind: "event", eventType: MEET_TRANSCRIPT },
          }),
          [201],
        ),
        listMeetAccounts(),
      ]);
      const secondAuto = await accept(
        automationsApi.create({
          headers: authenticate(),
          params: { workflowId: secondWorkflowId },
          body: { kind: "event", eventType: MEET_TRANSCRIPT },
        }),
        [201],
      );
      const firstThreadId = firstAuto.body.chatThreadId;
      const secondThreadId = secondAuto.body.chatThreadId;
      const secondaryConn = accounts.find((account) => {
        return account.externalEmail === secondary.email;
      });
      if (!firstThreadId || !secondThreadId || !secondaryConn) {
        throw new Error("Expected threads and secondary Meet connection");
      }
      expect(firstThreadId).not.toBe(secondThreadId);

      await accept(
        chatSelectionsApi.update({
          headers: authenticate(),
          params: { id: secondThreadId },
          body: { target: MEET_TARGET, connectionId: secondaryConn.id },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const primarySubs = provider.subscriptionsForToken(primary.accessToken);
      const secondarySubs = provider.subscriptionsForToken(
        secondary.accessToken,
      );
      expect(primarySubs).toHaveLength(1);
      expect(secondarySubs).toHaveLength(1);
      const [primarySub] = primarySubs;
      const [secondarySub] = secondarySubs;
      if (!primarySub || !secondarySub) {
        throw new Error("Expected both subscriptions");
      }

      const primaryPush = await accept(pushMeetTranscript(primarySub), [200]);
      await flushWaitUntilForTest();
      expect(primaryPush.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });

      const secondaryPush = await accept(
        pushMeetTranscript(secondarySub),
        [200],
      );
      await flushWaitUntilForTest();
      expect(secondaryPush.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });
      expect(runner.acceptedOrder).toHaveLength(2);

      const secondaryRunId = runner.acceptedOrder[1] ?? "";
      const secondaryExec = runner.acceptedByRunId.get(secondaryRunId);
      if (!secondaryExec) {
        throw new Error("Expected secondary execution context");
      }
      const [resolvedSecret] = await Promise.all([
        resolveRunMeetAuthorization(secondaryExec),
        accept(
          automationsApi.create({
            headers: authenticate(),
            params: { workflowId: firstWorkflowId },
            body: { kind: "event", eventType: MEET_TRANSCRIPT },
          }),
          [201],
        ),
      ]);
      await flushWaitUntilForTest();

      expect(resolvedSecret).toStrictEqual({
        sourceId: secondaryConn.id,
        authorization: `Bearer ${secondary.accessToken}`,
      });
      expect(provider.subscriptionsForToken(primary.accessToken)).toHaveLength(
        1,
      );
      expect(
        provider.subscriptionsForToken(secondary.accessToken),
      ).toHaveLength(1);
      expect(provider.created).toHaveLength(2);
    },
  );

  it(
    "webhooks-google-workspace-events-008 dispatches source and copied Google Meet automations independently",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const primary = meetAccount("copy-primary");
      const secondary = meetAccount("copy-secondary");
      const { provider, runner, workflowIds, authenticate, listMeetAccounts } =
        await setupMeetRunMember({
          accounts: [primary, secondary],
          workflowVisibility: "public",
        });
      const sourceWorkflowId = workflowIds[0];
      if (!sourceWorkflowId) {
        throw new Error("Expected source workflowId");
      }

      const [sourceAuto, accounts] = await Promise.all([
        accept(
          automationsApi.create({
            headers: authenticate(),
            params: { workflowId: sourceWorkflowId },
            body: { kind: "event", eventType: MEET_TRANSCRIPT },
          }),
          [201],
        ),
        listMeetAccounts(),
      ]);
      const sourceThreadId = sourceAuto.body.chatThreadId;
      const secondaryConn = accounts.find((account) => {
        return account.externalEmail === secondary.email;
      });
      if (!sourceThreadId || !secondaryConn) {
        throw new Error("Expected source thread and secondary Meet connection");
      }

      await accept(
        chatSelectionsApi.update({
          headers: authenticate(),
          params: { id: sourceThreadId },
          body: { target: MEET_TARGET, connectionId: secondaryConn.id },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const copiedWorkflow = await accept(
        workflowsDetailApi.copy({
          headers: authenticate(),
          params: { workflowId: sourceWorkflowId },
          body: {},
        }),
        [201],
      );
      await flushWaitUntilForTest();
      expect(copiedWorkflow.body.id).not.toBe(sourceWorkflowId);

      const sourceSub = provider
        .subscriptionsForToken(secondary.accessToken)
        .at(-1);
      const copiedSub = provider
        .subscriptionsForToken(primary.accessToken)
        .at(-1);
      if (!sourceSub || !copiedSub) {
        throw new Error("Expected source and copied Meet subscriptions");
      }
      expect(sourceSub).not.toBe(copiedSub);

      const sourcePush = await accept(pushMeetTranscript(sourceSub), [200]);
      await flushWaitUntilForTest();
      expect(sourcePush.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });

      const copiedPush = await accept(pushMeetTranscript(copiedSub), [200]);
      await flushWaitUntilForTest();
      expect(copiedPush.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });
      expect(runner.acceptedOrder.length).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    "webhooks-google-workspace-events-012 promotes a sibling account and repairs after deleting and re-adding accounts",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const primary = meetAccount("promote-primary");
      const secondary = meetAccount("promote-secondary");
      const {
        provider,
        runner,
        workflowIds,
        authenticate,
        listMeetAccounts,
        addMeetAccount,
      } = await setupMeetRunMember({ accounts: [primary, secondary] });
      const workflowId = workflowIds[0];
      if (!workflowId) {
        throw new Error("Expected workflowId");
      }

      const [, accounts] = await Promise.all([
        accept(
          automationsApi.create({
            headers: authenticate(),
            params: { workflowId },
            body: { kind: "event", eventType: MEET_TRANSCRIPT },
          }),
          [201],
        ),
        listMeetAccounts(),
      ]);
      await flushWaitUntilForTest();
      const primaryConn = accounts.find((account) => {
        return account.externalEmail === primary.email;
      });
      const secondaryConn = accounts.find((account) => {
        return account.externalEmail === secondary.email;
      });
      const [firstPrimarySub] = provider.subscriptionsForToken(
        primary.accessToken,
      );
      if (!primaryConn || !secondaryConn || !firstPrimarySub) {
        throw new Error("Expected primary, secondary, and first subscription");
      }

      const deletedPrimary = await accept(
        accountsApi.delete({
          headers: authenticate(),
          params: { connectionId: primaryConn.id },
          body: { target: MEET_TARGET },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(deletedPrimary.body).toStrictEqual({
        deletedConnectionId: primaryConn.id,
        resolvedSelectionCount: 0,
        promotedDefaultConnectionId: secondaryConn.id,
      });
      const [secondarySub] = provider.subscriptionsForToken(
        secondary.accessToken,
      );
      if (!secondarySub) {
        throw new Error("Expected promoted secondary subscription");
      }
      expect(
        provider.deleted.map((entry) => {
          return entry.name;
        }),
      ).toContain(firstPrimarySub);

      const oldPush = await accept(pushMeetTranscript(firstPrimarySub), [200]);
      expect(oldPush.body).toStrictEqual({
        success: true,
        watchStates: 0,
        dispatched: 0,
        duplicates: 0,
      });

      const promotedPush = await accept(
        pushMeetTranscript(secondarySub),
        [200],
      );
      await flushWaitUntilForTest();
      expect(promotedPush.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });
      expect(runner.acceptedOrder).toHaveLength(1);
      const [, deletedSecondary] = await Promise.all([
        runner.completeRun(runner.acceptedOrder[0] ?? ""),
        accept(
          accountsApi.delete({
            headers: authenticate(),
            params: { connectionId: secondaryConn.id },
            body: { target: MEET_TARGET },
          }),
          [200],
        ),
      ]);
      await flushWaitUntilForTest();
      expect(deletedSecondary.body).toStrictEqual({
        deletedConnectionId: secondaryConn.id,
        resolvedSelectionCount: 0,
        promotedDefaultConnectionId: null,
      });
      expect(
        provider.deleted.map((entry) => {
          return entry.name;
        }),
      ).toContain(secondarySub);

      const readdedPrimary: MeetAccount = {
        email: primary.email,
        subject: primary.subject,
        accessToken: `meet-readded-token-${randomUUID()}`,
      };
      await addMeetAccount(readdedPrimary);

      const accountsAfterReadd = await listMeetAccounts();
      expect(accountsAfterReadd).toHaveLength(1);
      const [readdedConn] = accountsAfterReadd;
      if (!readdedConn) {
        throw new Error("Expected re-added primary Meet connection");
      }
      expect(readdedConn.id).not.toBe(primaryConn.id);

      const [readdedSub] = provider.subscriptionsForToken(
        readdedPrimary.accessToken,
      );
      if (!readdedSub) {
        throw new Error("Expected second primary subscription after re-add");
      }
      expect(readdedSub).not.toBe(firstPrimarySub);

      const readdedPush = await accept(pushMeetTranscript(readdedSub), [200]);
      await flushWaitUntilForTest();
      expect(readdedPush.body).toStrictEqual({
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      });
      expect(runner.acceptedOrder).toHaveLength(2);
    },
  );
});
