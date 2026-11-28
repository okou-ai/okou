import { randomUUID } from "node:crypto";

import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { connectorCheckRoutes } from "../connector-check";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { projectRoutes } from "../projects";
import { runDetailRoutes } from "../run-detail";
import { usageMembersRoutes } from "../usage-members";
import { usageRecordRoutes } from "../usage-record";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import {
  createChatEventsFixture,
  executionEnvironment,
  okouTokenFromExecution,
  userMessages,
} from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import { connectX } from "./helpers/connector-auth-provider-fixtures";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function s3CommandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function s3CommandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    isRecord(command.input)
  ) {
    return command.input;
  }
  return {};
}

function s3BodyToBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.alloc(0);
}

function s3ReadableBody(buffer: Buffer) {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
    transformToString: () => {
      return Promise.resolve(buffer.toString("utf8"));
    },
    transformToByteArray: () => {
      return Promise.resolve(new Uint8Array(buffer));
    },
  };
}

function clerkDirectoryProfile(actor: ApiTestUser) {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Member",
  };
}

function metadataFromUploadHeaders(
  uploadHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [header, value] of Object.entries(uploadHeaders)) {
    const lower = header.toLowerCase();
    if (lower.startsWith("x-amz-meta-")) {
      metadata[lower.slice("x-amz-meta-".length)] = value;
    }
  }
  return metadata;
}

function artifactObjectKeyFromPublicUrl(publicUrl: string): string {
  const path = new URL(publicUrl).pathname.replace(/^\/+/u, "");
  return path.startsWith("artifacts/") ? path : `artifacts/${path}`;
}

function nextProjectOpId(): string {
  return createProjectOperationId(now(), randomUUID());
}

describe("run lifecycle and context", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const runReads = createRunReadsApi(context);
  const chat = createChatFilesBddApi(context);
  const chatFixture = createChatEventsFixture(context);
  const connectors = createConnectorBddApi(context);
  const chatConnectorAccess = createChatConnectorAccessApi(context);
  const firewall = createFirewallApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const routeMocks = createRouteMocks(context);

  const chatEventsApi = setupApp({ context, routes: chatEventsRoutes })(
    chatEventsContract,
  );
  const projectsApi = setupApp({ context, routes: projectRoutes })(
    projectsContract,
  );
  const usageMembersApi = setupApp({ context, routes: usageMembersRoutes })(
    usageMembersContract,
  );
  const usageRecordApi = setupApp({ context, routes: usageRecordRoutes })(
    usageRecordContract,
  );
  const automaticConnectorApi = setupApp({
    context,
    routes: builtinConnectorsAutomaticRoutes,
  })(builtinConnectorAutomaticContract);
  const connectorCheckApi = setupApp({
    context,
    routes: connectorCheckRoutes,
  })(connectorCheckContract);
  const mcpConnectorsApi = setupApp({
    context,
    routes: mcpConnectorsRoutes,
  })(mcpConnectorsContract);
  const rawRunDetail = setupRawAppRequest({
    context,
    routes: runDetailRoutes,
  });

  function authenticateSession(
    actor: ApiTestUser,
    directoryActors: readonly ApiTestUser[] = [actor],
  ) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    mockClerkUsers(context, directoryActors.map(clerkDirectoryProfile));
    return SESSION_HEADERS;
  }

  async function prepareFastRunActor(
    options: {
      readonly keyTag: string;
      readonly includeClaude?: boolean;
    } = { keyTag: "run" },
  ): Promise<ApiTestUser> {
    const actor = bdd.user();
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", `bdd-${options.keyTag}-key`);
    chatFixture.chatCallbacks.disableVapid();
    if (options.includeClaude) {
      mockClaudeCodeTokenEndpoint();
    }
    await Promise.all([
      runs.configureRunnerGroup(),
      bdd.bootstrapLimitedFreeOnboarding(actor),
      ...(options.includeClaude
        ? [
            runs.createPersonalModelProvider(actor, {
              type: "claude-code-oauth-token",
              secret: `claude-token-${randomUUID()}`,
            }),
          ]
        : []),
    ]);
    return actor;
  }

  function installRunContextDiagnosticCapture() {
    const capturedByRunId = new Map<string, Record<string, unknown>>();
    let customResponse:
      | {
          readonly kind: "rows";
          readonly rows: readonly Record<string, unknown>[];
        }
      | { readonly kind: "error"; readonly error: Error }
      | null = null;

    context.mocks.axiom.ingest.mockImplementation(
      (dataset: unknown, events: unknown) => {
        if (
          typeof dataset === "string" &&
          dataset.endsWith("run-context") &&
          Array.isArray(events)
        ) {
          for (const event of events) {
            if (isRecord(event) && typeof event.runId === "string") {
              capturedByRunId.set(event.runId.toLowerCase(), event);
            }
          }
        }
        return true;
      },
    );
    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      if (customResponse?.kind === "error") {
        return Promise.reject(customResponse.error);
      }
      if (customResponse?.kind === "rows") {
        return Promise.resolve([...customResponse.rows]);
      }
      if (typeof apl === "string" && apl.includes("run-context")) {
        for (const [runId, snapshot] of capturedByRunId) {
          if (apl.includes(runId)) {
            return Promise.resolve([snapshot]);
          }
        }
      }
      return Promise.resolve([]);
    });

    return {
      snapshotFor(runId: string): Record<string, unknown> {
        const snapshot = capturedByRunId.get(runId.toLowerCase());
        if (!snapshot) {
          throw new Error(
            `Expected captured run-context snapshot for ${runId}`,
          );
        }
        return snapshot;
      },
      setRows(rows: readonly Record<string, unknown>[]): void {
        customResponse = { kind: "rows", rows };
      },
      setError(error: Error): void {
        customResponse = { kind: "error", error };
      },
    };
  }

  function installLegacyUploadStorage() {
    const artifactBucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const hostedSitesBucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    const policyObjects = new Map<string, Buffer>();
    const artifactObjects = new Map<
      string,
      {
        size: number;
        contentType: string;
        metadata: Readonly<Record<string, string>>;
        lastModified: Date;
      }
    >();

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const name = s3CommandName(command);
      const input = s3CommandInput(command);
      const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
      const key = typeof input.Key === "string" ? input.Key : "";

      if (bucket === artifactBucket) {
        if (name === "ListObjectsV2Command") {
          const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
          const contents = [...artifactObjects.entries()]
            .filter(([objectKey]) => {
              return objectKey.startsWith(prefix);
            })
            .map(([objectKey, entry]) => {
              return {
                Key: objectKey,
                Size: entry.size,
                LastModified: entry.lastModified,
              };
            });
          return Promise.resolve({ Contents: contents });
        }
        if (name === "HeadObjectCommand") {
          const entry = artifactObjects.get(key);
          if (!entry) {
            return Promise.reject(
              Object.assign(new Error("Object not found"), {
                name: "NotFound",
              }),
            );
          }
          return Promise.resolve({
            ContentLength: entry.size,
            ContentType: entry.contentType,
            LastModified: entry.lastModified,
            Metadata: entry.metadata,
            ETag: `"etag-${entry.size}"`,
          });
        }
        if (name === "GetObjectCommand") {
          const entry = artifactObjects.get(key);
          if (!entry) {
            return Promise.reject(
              Object.assign(new Error("No such key"), { name: "NoSuchKey" }),
            );
          }
          return Promise.resolve({
            Body: s3ReadableBody(Buffer.alloc(Math.max(1, entry.size), 0x61)),
            ContentLength: entry.size,
            ContentType: entry.contentType,
            LastModified: entry.lastModified,
            Metadata: entry.metadata,
            ETag: `"etag-${entry.size}"`,
          });
        }
      }

      if (bucket === hostedSitesBucket) {
        if (name === "PutObjectCommand") {
          if (input.IfNoneMatch === "*" && policyObjects.has(key)) {
            return Promise.reject(
              Object.assign(new Error("Precondition failed"), {
                name: "PreconditionFailed",
              }),
            );
          }
          policyObjects.set(key, s3BodyToBuffer(input.Body));
          return Promise.resolve({ ETag: '"policy-etag"' });
        }
        if (name === "GetObjectCommand") {
          const body = policyObjects.get(key);
          if (!body) {
            return Promise.reject(
              Object.assign(new Error("No such key"), { name: "NoSuchKey" }),
            );
          }
          return Promise.resolve({
            Body: s3ReadableBody(body),
            ETag: '"policy-etag"',
          });
        }
      }

      return Promise.resolve({
        ContentLength: 1024,
        UploadId: randomUUID(),
        ETag: '"default-etag"',
      });
    });

    return {
      putArtifactObject(args: {
        readonly key: string;
        readonly size: number;
        readonly contentType: string;
        readonly metadata: Readonly<Record<string, string>>;
      }): void {
        artifactObjects.set(args.key, {
          size: args.size,
          contentType: args.contentType,
          metadata: args.metadata,
          lastModified: nowDate(),
        });
      },
      resizeArtifactObject(key: string, size: number): void {
        const entry = artifactObjects.get(key);
        if (!entry) {
          throw new Error(`Expected stored artifact object for ${key}`);
        }
        entry.size = size;
        entry.lastModified = nowDate();
      },
    };
  }

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const dummyId = "00000000-0000-4000-8000-000000000000";
    await Promise.all([
      accept(
        chatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      accept(projectsApi.list({ headers: {} }), [401]),
      accept(usageMembersApi.get({ headers: {}, query: {} }), [401]),
      accept(usageRecordApi.get({ headers: {}, query: {} }), [401]),
      accept(
        automaticConnectorApi.start({
          headers: {},
          params: { connectorSlug: "automatic-mcp-none" },
          body: { authMethod: "smart-connect", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        connectorCheckApi.check({
          headers: {},
          body: {
            mode: "url",
            method: "POST",
            url: "https://automatic-mcp.example.test/server",
          },
        }),
        [401],
      ),
      accept(mcpConnectorsApi.list({ headers: {} }), [401]),
      rawRunDetail(`/api/runs/${dummyId}/context`, { method: "GET" }),
      chat.requestPrepareUpload(
        null,
        { filename: "warmup.txt", contentType: "text/plain", size: 6 },
        [401],
      ),
      chat.requestCompleteUpload(null, { id: dummyId }, [401]),
    ]);
  });

  describe("run-bootstrap.catalog-generation", () => {
    it(
      "run-bootstrap.catalog-generation-001 omits a connected but unselected X connector from execution input",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareFastRunActor({ keyTag: "catalog-gen" });
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          await connectX(connectors, actor);
          const accounts = await connectors.listBuiltinConnectorAccounts(
            actor,
            "x",
          );
          const xAccount = accounts[0];
          expect(xAccount).toBeDefined();
          if (!xAccount) {
            throw new Error("Expected connected X account");
          }

          await chatConnectorAccess.setDefault(
            actor,
            {
              target: { kind: "builtin", connectorSlug: "x" },
              connectionId: xAccount.id,
            },
            false,
          );

          const launched = await chatFixture.sendChatRun(actor, {
            prompt: "Run without X enabled by default",
            model: null,
          });
          const execution = await owner.executionInput(launched.runId);
          const mergedEnv = executionEnvironment(execution);
          const xFirewalls = (execution.firewalls ?? []).filter((entry) => {
            return entry.kind === "builtin" && entry.name === "x";
          });

          expect(mergedEnv.X_TOKEN).toBeUndefined();
          expect(execution.secretConnectorMap?.X_TOKEN).toBeUndefined();
          expect(xFirewalls).toStrictEqual([]);
          expect(execution.billableFirewalls ?? []).not.toContain("x");
          expect(execution.networkPolicies?.x).toBeUndefined();
        });
      },
    );
  });

  describe("run-lifecycle-billing", () => {
    it(
      "run-lifecycle-billing.bdd-001 keeps member totals consistent with image-provider breakdowns across reports",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const orgId = `org_${randomUUID()}`;
        const admin = bdd.user({
          userId: `user_a_${randomUUID()}`,
          orgId,
          orgRole: "org:admin",
          email: "billing-admin@example.test",
        });
        const member = bdd.user({
          userId: `user_b_${randomUUID()}`,
          orgId,
          orgRole: "org:member",
          email: "billing-member@example.test",
        });

        bdd.acceptStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        mockOptionalEnv("OPENROUTER_API_KEY", "bdd-billing-openrouter-key");
        chatFixture.chatCallbacks.disableVapid();

        const periodStart = nowDate();
        periodStart.setUTCDate(periodStart.getUTCDate() - 1);
        periodStart.setUTCHours(9, 15, 0, 0);
        const periodEndUnix =
          Math.floor(periodStart.getTime() / 1000) + 30 * 86_400;

        await Promise.all([
          runs.configureRunnerGroup({ maxConcurrent: 4 }),
          runs.grantProEntitlement(admin, { periodEndUnix }),
        ]);
        await bdd.completeOnboarding(member);

        const actors = [admin, member] as const;
        const adminLaunch = await chatFixture.sendChatRun(admin, {
          prompt: `Generate billed images for ${admin.userId}`,
          model: null,
        });
        const memberLaunch = await chatFixture.sendChatRun(member, {
          prompt: `Generate billed images for ${member.userId}`,
          model: null,
        });

        const [adminExecution, memberExecution] = await Promise.all([
          runs.executionInput(adminLaunch.runId),
          runs.executionInput(memberLaunch.runId),
        ]);

        const runsWithTokens = [
          {
            runId: adminLaunch.runId,
            headers: { authorization: `Bearer ${adminExecution.sandboxToken}` },
          },
          {
            runId: memberLaunch.runId,
            headers: {
              authorization: `Bearer ${memberExecution.sandboxToken}`,
            },
          },
        ] as const;

        await Promise.all(
          runsWithTokens.map((entry) => {
            return webhooks.requestAgentUsageEvent(
              {
                runId: entry.runId,
                events: [
                  {
                    idempotencyKey: randomUUID(),
                    kind: "image",
                    provider: "gpt-image-2.5-flare",
                    category: "tokens.output.image",
                    quantity: 800,
                  },
                  {
                    idempotencyKey: randomUUID(),
                    kind: "image",
                    provider: "gpt-image-2.5-flare",
                    category: "tokens.input.text",
                    quantity: 800,
                  },
                  {
                    idempotencyKey: randomUUID(),
                    kind: "image",
                    provider: "fal-ai/nano-banana-2",
                    category: "output_image",
                    quantity: 1,
                  },
                ],
              },
              entry.headers,
              [200],
            );
          }),
        );

        await Promise.all(
          runsWithTokens.map((entry) => {
            return webhooks.requestAgentComplete(
              {
                runId: entry.runId,
                exitCode: 1,
                error: "Image run failed after recording usage",
                failureReason: "execution_timeout",
              },
              entry.headers,
              [200],
            );
          }),
        );
        await flushWaitUntilForTest();

        const expectedBreakdown = [
          {
            kind: "image",
            credits: 108,
            providers: [
              {
                provider: "fal-ai/nano-banana-2",
                credits: 80,
                usageKinds: [{ kind: "image", credits: 80 }],
              },
              {
                provider: "gpt-image-2.5-flare",
                credits: 28,
                usageKinds: [{ kind: "image", credits: 28 }],
              },
            ],
          },
        ];

        const expectedMembers = [...actors]
          .sort((left, right) => {
            return left.userId.localeCompare(right.userId);
          })
          .map((actor) => {
            return {
              userId: actor.userId,
              email: actor.email,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              creditsCharged: 108,
              breakdown: expectedBreakdown,
            };
          });

        const adminHeaders = authenticateSession(admin, actors);
        const [report24h, reportBillingPeriod, adminRecord] = await Promise.all(
          [
            accept(
              usageMembersApi.get({
                headers: adminHeaders,
                query: { range: "24h", tz: "Asia/Shanghai" },
              }),
              [200],
            ),
            accept(
              usageMembersApi.get({
                headers: adminHeaders,
                query: { range: "billingPeriod", tz: "UTC" },
              }),
              [200],
            ),
            accept(
              usageRecordApi.get({
                headers: adminHeaders,
                query: {
                  page: 1,
                  pageSize: 20,
                  scope: "mine",
                  range: "24h",
                  tz: "Asia/Shanghai",
                },
              }),
              [200],
            ),
          ],
        );

        expect(report24h.body.members).toStrictEqual(expectedMembers);
        expect(reportBillingPeriod.body.period?.start).toBe(
          periodStart.toISOString(),
        );
        expect(reportBillingPeriod.body.members).toStrictEqual(expectedMembers);

        expect(adminRecord.body.totalCredits).toBe(108);
        expect(adminRecord.body.rows).toHaveLength(1);
        expect(adminRecord.body.rows[0]?.credits).toBe(108);
        expect(adminRecord.body.rows[0]?.tokens).toBe(0);
        expect(adminRecord.body.rows[0]?.breakdown).toStrictEqual(
          expectedBreakdown,
        );

        const repeatedReport = await accept(
          usageMembersApi.get({
            headers: authenticateSession(admin, actors),
            query: { range: "24h", tz: "Asia/Shanghai" },
          }),
          [200],
        );
        expect(repeatedReport.body.members).toStrictEqual(
          report24h.body.members,
        );
      },
    );
  });

  describe("run-lifecycle-automatic", () => {
    it(
      "run-lifecycle-automatic.bdd-001 admits an Automatic built-in MCP no-auth account without sandbox tokens",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
        const fixture = automaticMcpCatalogFixture("none");
        mockAutomaticMcpOAuthProvider(context, {
          registration: "none",
          authentication: "none",
          endpoint: fixture.endpoint,
        });

        const actor = await prepareFastRunActor({ keyTag: "automatic-none" });

        const started = await accept(
          automaticConnectorApi.start({
            headers: authenticateSession(actor),
            params: { connectorSlug: fixture.slug },
            body: {
              authMethod: fixture.methodId,
              account: { intent: "add" },
            },
          }),
          [200],
        );
        expect(started.body.result).toBe("connected");
        if (started.body.result !== "connected") {
          throw new Error("Expected immediate no-auth automatic connection");
        }
        const connectionId = started.body.connectionId;

        const owner = publicRunOwner(context, actor);
        await owner.run(async () => {
          const launched = await chatFixture.sendChatRun(actor, {
            prompt: "Inspect automatic no-auth MCP connector",
            model: null,
          });
          const execution = await owner.executionInput(launched.runId);
          const okouToken = okouTokenFromExecution(execution);
          const mergedEnv = executionEnvironment(execution);

          expect(execution.connectorRuntimeTargets).toContainEqual(
            expect.objectContaining({
              kind: "builtin",
              connectorSlug: fixture.slug,
              sourceId: connectionId,
            }),
          );
          expect(execution.firewalls).toContainEqual(
            expect.objectContaining({
              kind: "builtin",
              name: fixture.slug,
              sourceId: connectionId,
            }),
          );
          expect(execution.appendSystemPrompt).toContain(`\`${fixture.slug}\``);
          expect(mergedEnv.AUTOMATIC_NONE_ACCESS_TOKEN).toBeUndefined();
          expect(mergedEnv.AUTOMATIC_NONE_REFRESH_TOKEN).toBeUndefined();
          expect(mergedEnv.MCP_ACCESS_TOKEN).toBeUndefined();
          expect(
            execution.secretConnectorMap?.MCP_ACCESS_TOKEN,
          ).toBeUndefined();

          const [listed, memberCheck, runCheck, boundary] = await Promise.all([
            accept(
              mcpConnectorsApi.list({
                headers: { authorization: `Bearer ${okouToken}` },
              }),
              [200],
            ),
            accept(
              connectorCheckApi.check({
                headers: authenticateSession(actor),
                body: {
                  mode: "url",
                  method: "POST",
                  url: fixture.endpoint,
                  target: fixture.target,
                },
              }),
              [200],
            ),
            accept(
              connectorCheckApi.check({
                headers: { authorization: `Bearer ${okouToken}` },
                body: {
                  mode: "url",
                  method: "POST",
                  url: fixture.endpoint,
                  target: fixture.target,
                },
              }),
              [200],
            ),
            firewall.requestFirewallAuth(
              { authorization: `Bearer ${execution.firewallToken}` },
              {
                authHeaders: fixture.firewallAuthHeaders,
                matchedFirewall: {
                  name: fixture.slug,
                  apiId: "api-0",
                  base: fixture.firewallBase,
                  connectorSlug: fixture.slug,
                  sourceId: connectionId,
                  routingVariables: {},
                },
              },
              [200],
            ),
          ]);

          expect(listed.body.connectors).toContainEqual(
            expect.objectContaining({
              target: fixture.target,
              connectionId,
              slug: fixture.slug,
              transport: "streamable-http",
              endpoint: fixture.endpoint,
              runtimeAvailable: true,
              connectionStatus: "connected",
            }),
          );
          expect(memberCheck.body).toMatchObject({
            outcome: "resolved",
            connector: {
              target: fixture.target,
              credentialResolution: "none",
            },
          });
          expect(runCheck.body).toMatchObject({
            outcome: "resolved",
            connector: {
              target: fixture.target,
              credentialResolution: "none",
            },
          });
          expect(boundary.status).toBe(200);
          if (boundary.status === 200) {
            expect(boundary.body.headers).toStrictEqual({});
          }

          const cancelled = await runs.requestCancelRun(
            actor,
            launched.runId,
            [200],
          );
          expect(cancelled.status).toBe(200);
        });
      },
    );

    it(
      "run-lifecycle-automatic.bdd-002 admits an Automatic built-in MCP OAuth account and reflects reconnect to no-auth",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
        const fixture = automaticMcpCatalogFixture("oauth");
        const initialAccessToken = "automatic-oauth-initial-token";
        const provider = mockAutomaticMcpOAuthProvider(context, {
          registration: "cimd",
          authentication: "oauth",
          endpoint: fixture.endpoint,
          initialAccessToken,
          initialExpiresIn: 3600,
        });

        const actor = await prepareFastRunActor({ keyTag: "automatic-oauth" });

        const started = await accept(
          automaticConnectorApi.start({
            headers: authenticateSession(actor),
            params: { connectorSlug: fixture.slug },
            body: {
              authMethod: fixture.methodId,
              account: { intent: "add" },
            },
          }),
          [200],
        );
        expect(started.body.result).toBe("authorization");
        if (started.body.result !== "authorization") {
          throw new Error("Expected OAuth authorization redirect");
        }
        const state = new URL(started.body.authorizationUrl).searchParams.get(
          "state",
        );
        expect(state).toBeTruthy();
        if (!state) {
          throw new Error("Expected automatic OAuth state");
        }

        const callback = await accept(
          automaticConnectorApi.callback({
            query: {
              state,
              code: "automatic-oauth-code",
              iss: provider.issuer,
              responseMode: "json",
            },
          }),
          [200],
        );
        expect(callback.body.status).toBe("success");

        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          fixture.slug,
        );
        const connectionId = accounts[0]?.id;
        expect(connectionId).toBeDefined();
        if (!connectionId) {
          throw new Error("Expected connected automatic OAuth account");
        }

        const owner = publicRunOwner(context, actor);
        await owner.run(async () => {
          const launched = await chatFixture.sendChatRun(actor, {
            prompt: "Inspect automatic OAuth MCP connector",
            model: null,
          });
          const execution = await owner.executionInput(launched.runId);
          const okouToken = okouTokenFromExecution(execution);
          const mergedEnv = executionEnvironment(execution);

          expect(execution.connectorRuntimeTargets).toContainEqual(
            expect.objectContaining({
              kind: "builtin",
              connectorSlug: fixture.slug,
              sourceId: connectionId,
            }),
          );
          expect(execution.firewalls).toContainEqual(
            expect.objectContaining({
              kind: "builtin",
              name: fixture.slug,
              sourceId: connectionId,
            }),
          );
          expect(execution.appendSystemPrompt).toContain(`\`${fixture.slug}\``);
          expect(mergedEnv.AUTOMATIC_ACCESS_TOKEN).toBeUndefined();
          expect(mergedEnv.AUTOMATIC_REFRESH_TOKEN).toBeUndefined();
          expect(mergedEnv.MCP_ACCESS_TOKEN).toBeUndefined();
          expect(JSON.stringify(execution)).not.toContain(initialAccessToken);

          const [listed, memberCheck, runCheck, boundary] = await Promise.all([
            accept(
              mcpConnectorsApi.list({
                headers: { authorization: `Bearer ${okouToken}` },
              }),
              [200],
            ),
            accept(
              connectorCheckApi.check({
                headers: authenticateSession(actor),
                body: {
                  mode: "url",
                  method: "POST",
                  url: fixture.endpoint,
                  target: fixture.target,
                },
              }),
              [200],
            ),
            accept(
              connectorCheckApi.check({
                headers: { authorization: `Bearer ${okouToken}` },
                body: {
                  mode: "url",
                  method: "POST",
                  url: fixture.endpoint,
                  target: fixture.target,
                },
              }),
              [200],
            ),
            firewall.requestFirewallAuth(
              { authorization: `Bearer ${execution.firewallToken}` },
              {
                authHeaders: fixture.firewallAuthHeaders,
                matchedFirewall: {
                  name: fixture.slug,
                  apiId: "api-0",
                  base: fixture.firewallBase,
                  connectorSlug: fixture.slug,
                  sourceId: connectionId,
                  routingVariables: {},
                },
              },
              [200],
            ),
          ]);

          expect(listed.body.connectors).toContainEqual(
            expect.objectContaining({
              target: fixture.target,
              connectionId,
              slug: fixture.slug,
              transport: "streamable-http",
              endpoint: fixture.endpoint,
              runtimeAvailable: true,
              connectionStatus: "connected",
            }),
          );
          expect(memberCheck.body).toMatchObject({
            outcome: "resolved",
            connector: {
              target: fixture.target,
              credentialResolution: "network-boundary",
            },
          });
          expect(runCheck.body).toMatchObject({
            outcome: "resolved",
            connector: {
              target: fixture.target,
              credentialResolution: "network-boundary",
            },
          });
          expect(boundary.status).toBe(200);
          if (boundary.status === 200) {
            expect(boundary.body.headers).toStrictEqual({
              Authorization: `Bearer ${initialAccessToken}`,
            });
          }

          mockAutomaticMcpOAuthProvider(context, {
            registration: "none",
            authentication: "none",
            endpoint: fixture.endpoint,
          });
          const reconnected = await accept(
            automaticConnectorApi.start({
              headers: authenticateSession(actor),
              params: { connectorSlug: fixture.slug },
              body: {
                authMethod: fixture.methodId,
                account: { intent: "reconnect", connectionId },
              },
            }),
            [200],
          );
          expect(reconnected.body).toStrictEqual({
            result: "connected",
            connectionId,
          });

          const [syncResults, staleBoundary, afterReconnectCheck] =
            await Promise.all([
              runs.syncConnectorRuntime(launched.runId, {
                targets: [
                  {
                    kind: "builtin",
                    connectorSlug: fixture.slug,
                    sourceId: connectionId,
                  },
                ],
              }),
              firewall.requestFirewallAuth(
                { authorization: `Bearer ${execution.firewallToken}` },
                {
                  authHeaders: fixture.firewallAuthHeaders,
                  matchedFirewall: {
                    name: fixture.slug,
                    apiId: "api-0",
                    base: fixture.firewallBase,
                    connectorSlug: fixture.slug,
                    sourceId: connectionId,
                    routingVariables: {},
                  },
                },
                [424],
              ),
              accept(
                connectorCheckApi.check({
                  headers: { authorization: `Bearer ${okouToken}` },
                  body: {
                    mode: "url",
                    method: "POST",
                    url: fixture.endpoint,
                    target: fixture.target,
                  },
                }),
                [200],
              ),
            ]);

          const syncEntry = syncResults[0];
          expect(syncEntry).toBeDefined();
          expect(syncEntry?.state).toBe("available");
          expect(syncEntry).not.toHaveProperty("firewall");

          expect(staleBoundary.status).toBe(424);
          if (staleBoundary.status === 424) {
            expect(staleBoundary.body.error.code).toBe(
              "CONNECTOR_NOT_CONFIGURED",
            );
          }

          expect(afterReconnectCheck.body).toMatchObject({
            outcome: "resolved",
            connector: {
              target: fixture.target,
              credentialResolution: "network-boundary",
            },
          });

          const cancelled = await runs.requestCancelRun(
            actor,
            launched.runId,
            [200],
          );
          expect(cancelled.status).toBe(200);
        });
      },
    );
  });

  describe("run-uploaded-files-publication", () => {
    it(
      "run-uploaded-files-publication-001 keeps one file identity and captured owner across concurrent replay and metadata updates",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareFastRunActor({ keyTag: "upload-pub-1" });
        const storage = installLegacyUploadStorage();
        const colleague = bdd.user({
          orgId: actor.orgId,
          orgRole: "org:member",
        });
        const outsider = bdd.user();
        const noOrgActor: ApiTestUser = {
          ...actor,
          orgId: null,
          orgRole: undefined,
        };

        const owner = publicRunOwner(context, actor);
        await owner.run(async () => {
          const launched = await chatFixture.sendChatRun(actor, {
            prompt: "Publish an uploaded report artifact",
            model: null,
          });
          const execution = await owner.executionInput(launched.runId);
          const okouToken = okouTokenFromExecution(execution);

          const prepared = await chat.prepareUpload(noOrgActor, {
            filename: "report.txt",
            contentType: "text/plain",
            size: 7,
            purpose: "artifact",
          });
          if (!("uploadHeaders" in prepared)) {
            throw new Error("Expected direct upload preparation response");
          }
          const objectKey = artifactObjectKeyFromPublicUrl(prepared.url);
          storage.putArtifactObject({
            key: objectKey,
            size: 7,
            contentType: "text/plain",
            metadata: metadataFromUploadHeaders(prepared.uploadHeaders),
          });

          const [firstComplete, secondComplete] = await Promise.all([
            chat.completeUploadWithBearer(
              `Bearer ${okouToken}`,
              { id: prepared.id },
              [200],
            ),
            chat.completeUploadWithBearer(
              `Bearer ${okouToken}`,
              { id: prepared.id },
              [200],
            ),
          ]);
          expect(firstComplete.status).toBe(200);
          expect(secondComplete.status).toBe(200);
          expect(firstComplete.body).toStrictEqual(secondComplete.body);

          const initialCatalog = await chat.listArtifactCatalog(actor);
          expect(initialCatalog.artifacts).toHaveLength(1);
          const originalArtifact = initialCatalog.artifacts[0];
          const originalArtifactId = originalArtifact?.id;
          if (!originalArtifactId) {
            throw new Error("Expected recorded catalog artifact ID");
          }
          const initialDetail = await chat.getArtifactCatalogEntry(
            actor,
            originalArtifactId,
          );
          expect(initialDetail.kind).toBe("file");
          if (initialDetail.kind !== "file") {
            throw new Error("Expected initial catalog detail to be a file");
          }
          expect(initialDetail.file).toMatchObject({
            filename: "report.txt",
            contentType: "text/plain",
            size: 7,
          });
          const initialDetailFileId = initialDetail.file.id;

          storage.resizeArtifactObject(objectKey, 19);

          const mismatchedComplete = await chat.completeUploadWithBearer(
            `Bearer ${okouToken}`,
            { id: prepared.id, contentType: "text/markdown" },
            [500],
          );
          expect(mismatchedComplete.status).toBe(500);

          const afterMismatch = await chat.getArtifactCatalogEntry(
            actor,
            originalArtifactId,
          );
          expect(afterMismatch.kind).toBe("file");
          if (afterMismatch.kind === "file") {
            expect(afterMismatch.file).toMatchObject({
              id: initialDetailFileId,
              filename: "report.txt",
              contentType: "text/plain",
              size: 7,
            });
          }

          const finalComplete = await chat.completeUploadWithBearer(
            `Bearer ${okouToken}`,
            { id: prepared.id, contentType: "text/plain" },
            [200],
          );
          expect(finalComplete.body).toMatchObject({
            id: prepared.id,
            filename: "report.txt",
            contentType: "text/plain",
            size: 19,
            url: prepared.url,
          });

          const [legacyThreadArtifacts, catalog] = await Promise.all([
            chat.listThreadArtifacts(actor, launched.threadId),
            chat.listArtifactCatalog(actor),
          ]);
          expect(legacyThreadArtifacts.runs).toStrictEqual([]);

          expect(catalog.artifacts).toHaveLength(1);
          expect(catalog.artifacts[0]).toMatchObject({
            id: originalArtifactId,
            kind: "file",
            title: "report.txt",
          });

          const detail = await chat.getArtifactCatalogEntry(
            actor,
            originalArtifactId,
          );
          expect(detail.kind).toBe("file");
          if (detail.kind === "file") {
            expect(detail.file).toStrictEqual({
              id: initialDetailFileId,
              filename: "report.txt",
              contentType: "text/plain",
              size: 19,
              url: prepared.url,
              previewImageUrl: null,
            });
          }

          for (const unauthorized of [outsider, colleague]) {
            const threadResponse = await chat.requestListThreadArtifacts(
              unauthorized,
              launched.threadId,
              [404],
            );
            expect(threadResponse.status).toBe(404);
            const catalogDetailResponse =
              await chat.requestArtifactCatalogEntry(
                unauthorized,
                originalArtifactId,
                [404],
              );
            expect(catalogDetailResponse.status).toBe(404);
            const unauthorizedCatalog =
              await chat.listArtifactCatalog(unauthorized);
            expect(unauthorizedCatalog.artifacts).toStrictEqual([]);
          }
        });
      },
    );

    it(
      "run-uploaded-files-publication-002 records late upload completion through the issued token after Run completion",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareFastRunActor({ keyTag: "upload-pub-2" });
        const storage = installLegacyUploadStorage();
        const noOrgActor: ApiTestUser = {
          ...actor,
          orgId: null,
          orgRole: undefined,
        };

        const launched = await chatFixture.sendChatRun(actor, {
          prompt: "Complete run before uploading report",
          model: null,
        });
        const execution = await runs.executionInput(launched.runId);
        const okouToken = okouTokenFromExecution(execution);

        const prepared = await chat.prepareUpload(noOrgActor, {
          filename: "report.txt",
          contentType: "text/plain",
          size: 7,
          purpose: "artifact",
        });
        if (!("uploadHeaders" in prepared)) {
          throw new Error("Expected direct upload preparation response");
        }
        const objectKey = artifactObjectKeyFromPublicUrl(prepared.url);
        storage.putArtifactObject({
          key: objectKey,
          size: 7,
          contentType: "text/plain",
          metadata: metadataFromUploadHeaders(prepared.uploadHeaders),
        });

        await chatFixture.completeChatRunOk(
          launched.runId,
          { authorization: `Bearer ${execution.sandboxToken}` },
          { cliAgentType: "pi", cliAgentSessionId: launched.threadId },
        );
        await flushWaitUntilForTest();

        const completed = await chat.completeUploadWithBearer(
          `Bearer ${okouToken}`,
          { id: prepared.id },
          [200],
        );
        expect(completed.status).toBe(200);

        const catalog = await chat.listArtifactCatalog(actor);
        expect(catalog.artifacts).toHaveLength(1);
        expect(catalog.artifacts[0]?.title).toBe("report.txt");
      },
    );
  });

  describe("run-context-diagnostics", () => {
    it(
      "run-context-diagnostics-001 masks API-only data router credentials in captured diagnostics",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const appUrl = env("APP_URL");
        mockEnv("OKOU_DATA_ROUTER_URL", "https://data-router.example.test");
        mockEnv("OKOU_DATA_TOKEN", appUrl);

        const actor = await prepareFastRunActor({ keyTag: "diag-1" });
        const diagnostics = installRunContextDiagnosticCapture();
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          const launched = await chatFixture.sendChatRun(actor, {
            prompt: "Verify data router diagnostic masking",
            model: null,
          });
          const execution = await owner.executionInput(launched.runId);
          const okouToken = okouTokenFromExecution(execution);

          expect(diagnostics.snapshotFor(launched.runId)).toBeDefined();

          const contextResponse = await runs.requestRunContext(
            actor,
            launched.runId,
            [200],
          );
          expect(contextResponse.status).toBe(200);
          if (contextResponse.status !== 200) {
            throw new Error("Expected run context snapshot");
          }

          expect(contextResponse.body.prompt).toBe(execution.prompt);
          expect(contextResponse.body.appendSystemPrompt).toBe(
            execution.appendSystemPrompt,
          );
          expect(contextResponse.body.environment.OKOU_APP_URL).toBe("***");
          expect(contextResponse.body.secretNames).toContain("OKOU_TOKEN");
          expect(contextResponse.body.secretNames).toContain("OKOU_DATA_TOKEN");
          expect(execution.platformEnvironment.OKOU_APP_URL).toBe(appUrl);
          expect(Object.values(contextResponse.body.environment)).not.toContain(
            appUrl,
          );
          expect(JSON.stringify(contextResponse.body)).not.toContain(okouToken);
        });
      },
    );

    it(
      "run-context-diagnostics-004 distinguishes captured empty values from historically unavailable diagnostic fields",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareFastRunActor({ keyTag: "diag-4" });
        const diagnostics = installRunContextDiagnosticCapture();
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          const launched = await chatFixture.sendChatRun(actor, {
            prompt: "Inspect diagnostic field normalization",
            model: null,
          });
          await owner.executionInput(launched.runId);
          const baseSnapshot = diagnostics.snapshotFor(launched.runId);
          const capturedInstructions = baseSnapshot.appendSystemPrompt;

          diagnostics.setRows([
            {
              ...baseSnapshot,
              prompt: "",
              varEntries: [],
            },
          ]);
          const emptyCapture = await runs.requestRunContext(
            actor,
            launched.runId,
            [200],
          );
          expect(emptyCapture.status).toBe(200);
          if (emptyCapture.status === 200) {
            expect(emptyCapture.body.prompt).toBe("");
            expect(emptyCapture.body.appendSystemPrompt).toBe(
              capturedInstructions,
            );
            expect(emptyCapture.body.vars).toStrictEqual({});
          }

          const { varEntries: _omittedVarEntries, ...withoutVarEntries } =
            baseSnapshot;
          diagnostics.setRows([
            {
              ...withoutVarEntries,
              prompt: "Historical prompt without varEntries",
            },
          ]);
          const absentVars = await runs.requestRunContext(
            actor,
            launched.runId,
            [200],
          );
          expect(absentVars.status).toBe(200);
          if (absentVars.status === 200) {
            expect(absentVars.body.prompt).toBe(
              "Historical prompt without varEntries",
            );
            expect(absentVars.body.vars).toBeNull();
          }

          diagnostics.setRows([
            {
              ...baseSnapshot,
              prompt: "Historical prompt with null varEntries",
              varEntries: null,
            },
          ]);
          const nullVars = await runs.requestRunContext(
            actor,
            launched.runId,
            [200],
          );
          expect(nullVars.status).toBe(200);
          if (nullVars.status === 200) {
            expect(nullVars.body.prompt).toBe(
              "Historical prompt with null varEntries",
            );
            expect(nullVars.body.vars).toBeNull();
          }

          const { prompt: _omittedPrompt, ...withoutPrompt } = baseSnapshot;
          diagnostics.setRows([withoutPrompt]);
          const missingPrompt = await runs.requestRunContext(
            actor,
            launched.runId,
            [404],
          );
          expect(missingPrompt.status).toBe(404);

          diagnostics.setRows([]);
          const missingCapture = await runs.requestRunContext(
            actor,
            launched.runId,
            [404],
          );
          expect(missingCapture.status).toBe(404);
        });
      },
    );

    it(
      "run-context-diagnostics-005 keeps ownership and business reads independent of unavailable diagnostic storage",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareFastRunActor({
          keyTag: "diag-5",
          includeClaude: true,
        });
        const colleague = bdd.user({
          orgId: actor.orgId,
          orgRole: "org:member",
        });
        const outsider = bdd.user();
        const diagnostics = installRunContextDiagnosticCapture();
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          const businessPrompt = "Run with unavailable diagnostic storage";
          const launched = await chatFixture.sendChatRun(actor, {
            prompt: businessPrompt,
            model: "claude-fable-5-1",
          });
          await owner.executionInput(launched.runId);

          diagnostics.setError(new Error("Diagnostic store unavailable"));

          const colleagueContext = await runs.requestRunContext(
            colleague,
            launched.runId,
            [404],
          );
          expect(colleagueContext.status).toBe(404);

          const outsiderContext = await runs.requestRunContext(
            outsider,
            launched.runId,
            [404],
          );
          expect(outsiderContext.status).toBe(404);

          const colleagueLog = await runReads.requestReadLogById(
            colleague,
            launched.runId,
            [404],
          );
          expect(colleagueLog.status).toBe(404);

          const ownerRun = await runs.readRun(actor, launched.runId);
          expect(ownerRun.status).toBe("running");
          expect(ownerRun.prompt).toBe(businessPrompt);

          const ownerLog = await runReads.requestReadLogById(
            actor,
            launched.runId,
            [200],
          );
          expect(ownerLog.status).toBe(200);
          if (ownerLog.status === 200) {
            expect(ownerLog.body.framework).toBe("claude-code");
            expect(ownerLog.body.appendSystemPrompt).toBeNull();
          }

          const ownerContext = await rawRunDetail(
            `/api/runs/${launched.runId}/context`,
            {
              method: "GET",
              headers: authenticateSession(actor),
            },
          );
          expect(ownerContext.status).toBe(500);
        });
      },
    );
  });

  describe("project-run-context", () => {
    it(
      "project-run-context-001 prepares queued inputs from current membership while preserving started Runs and captured mentions",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = bdd.user();
        bdd.acceptStorageWrites();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        mockOptionalEnv("OPENROUTER_API_KEY", "bdd-project-context-key");
        chatFixture.chatCallbacks.disableVapid();
        await Promise.all([
          runs.configureRunnerGroup(),
          bdd.bootstrapLimitedFreeOnboarding(actor),
        ]);

        const owner = publicRunOwner(context, actor);
        await owner.run(async () => {
          const firstPrompt = "Start unassigned run before project changes";
          const firstRun = await chatFixture.sendChatRun(actor, {
            prompt: firstPrompt,
            model: null,
          });
          const firstExecution = await owner.executionInput(firstRun.runId);

          const launchId = nextProjectOpId();
          const researchId = nextProjectOpId();
          const latestLaunchId = nextProjectOpId();
          const unavailableProjectId = nextProjectOpId();

          const headers = authenticateSession(actor);
          await accept(
            projectsApi.create({
              headers,
              body: { id: launchId, eventId: launchId, name: "Launch" },
            }),
            [201],
          );
          await accept(
            projectsApi.create({
              headers,
              body: {
                id: researchId,
                eventId: researchId,
                name: "Original research",
              },
            }),
            [201],
          );
          await accept(
            projectsApi.create({
              headers,
              body: {
                id: latestLaunchId,
                eventId: latestLaunchId,
                name: "Latest launch",
              },
            }),
            [201],
          );

          await accept(
            projectsApi.membership({
              headers: authenticateSession(actor),
              params: { id: firstRun.threadId },
              body: { eventId: nextProjectOpId(), projectId: launchId },
            }),
            [200],
          );

          const unavailableSend = await chat.requestSendEvent(
            actor,
            {
              threadId: firstRun.threadId,
              prompt: "Reference missing project",
              userMessage: {
                version: 1,
                parts: [
                  { type: "text", text: "Check " },
                  {
                    type: "project",
                    projectId: unavailableProjectId,
                    nameSnapshot: "Missing project",
                  },
                ],
              },
            },
            [404],
          );
          expect(unavailableSend.status).toBe(404);

          const queuedClientEventId = randomUUID();
          const queuedSend = await chat.requestSendEvent(
            actor,
            {
              threadId: firstRun.threadId,
              clientEventId: queuedClientEventId,
              prompt: "Review Original research for launch",
              userMessage: {
                version: 1,
                parts: [
                  { type: "text", text: "Review " },
                  {
                    type: "project",
                    projectId: researchId,
                    nameSnapshot: "Original research",
                  },
                  { type: "text", text: " for launch" },
                ],
              },
            },
            [201],
          );
          expect(queuedSend.status).toBe(201);

          await accept(
            projectsApi.membership({
              headers: authenticateSession(actor),
              params: { id: firstRun.threadId },
              body: { eventId: nextProjectOpId(), projectId: latestLaunchId },
            }),
            [200],
          );
          await accept(
            projectsApi.update({
              headers: authenticateSession(actor),
              params: { id: researchId },
              body: { eventId: nextProjectOpId(), name: "Current research" },
            }),
            [200],
          );

          await chatFixture.cancelChatRun(actor, firstRun.runId, {
            authorization: `Bearer ${firstExecution.sandboxToken}`,
          });

          const history = await chat.listThreadEvents(actor, firstRun.threadId);
          const launchedInput = userMessages(history.events).find((message) => {
            return (
              message.revokesEventId === queuedClientEventId &&
              message.runId !== undefined
            );
          });
          expect(launchedInput?.runId).toBeDefined();
          const secondRunId = launchedInput?.runId;
          if (!secondRunId) {
            throw new Error("Expected queued project input to launch a Run");
          }

          const secondExecution = await owner.executionInput(secondRunId);
          const firstRunRecord = await runs.readRun(actor, firstRun.runId);
          expect(firstRunRecord.prompt).toBe(firstPrompt);
          expect(firstExecution.appendSystemPrompt ?? "").not.toContain(
            `PROJECT_ID=${launchId}`,
          );

          const secondSystemPrompt = secondExecution.appendSystemPrompt ?? "";
          expect(secondSystemPrompt).toContain(
            `Current Project: "Latest launch" (PROJECT_ID=${latestLaunchId})`,
          );
          expect(secondSystemPrompt).toContain(
            `Mentioned Project "Original research": PROJECT_ID=${researchId}; current name="Current research"`,
          );
          expect(secondSystemPrompt).toContain(
            "okou chat list --project-id <PROJECT_ID> --limit all --json",
          );
          expect(secondSystemPrompt).not.toContain('Current Project: "Launch"');

          const deleted = await accept(
            projectsApi.delete({
              headers: authenticateSession(actor),
              params: { id: latestLaunchId },
              body: { eventId: nextProjectOpId() },
            }),
            [204],
          );
          expect(deleted.status).toBe(204);

          const secondRunAfterDelete = await runs.readRun(actor, secondRunId);
          expect(secondRunAfterDelete.prompt).toBe(secondExecution.prompt);
        });
      },
    );
  });
});
