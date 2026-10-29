import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { readPublishedArchive } from "./helpers/published-archive";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createHash, randomUUID } from "node:crypto";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";

import { builtinConnectorOpenIdStartContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
} from "@okouai/core/storage-names";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  clearMockNow,
  mockNow,
  now,
  withMockNowForTest,
} from "../../../lib/time";
import { server } from "../../../mocks/server";
import { mockApiTestConnectorProviderConfiguration } from "../../../test-fixtures/connector-catalog";
import { createDeferredPromise } from "../../utils";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAwsExternalCodeProvider,
  mockSlackConnectorOAuth,
  mockTestOAuthAuthCodeProvider,
} from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { withConnectorRuntime } from "./helpers/connector-runtime-consumer";
import { makeCodexAuthJson } from "./helpers/api-bdd-auth-device";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";

import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { connectorCatalogRoutes } from "../connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();
const routeMocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const CRON_SECRET = "connector-catalog-cron-secret";
const ACTIVE_KEY = "connectors/v4/active.json";
const FIRST_SYNC_TIME = "2026-07-15T08:00:00.000Z";
const PRIVATE_VALUE = "SECRET_TOKEN";
const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_REVOKE_URL = "https://slack.com/api/auth.revoke";
const STEAM_TEST_ID = "76561198000000000";

type JsonRecord = Record<string, unknown>;

interface ReleaseFixtureOptions {
  readonly version: string;
  readonly connectorSlug?: string;
  readonly label?: string;
  readonly skill?: JsonRecord;
}

function createConnectorCleanup(
  actor: ApiTestUser,
  connectorSlug: ConnectorSlug,
): () => Promise<void> {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  return async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockApiTestConnectorProviderConfiguration();
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      connectorSlug,
    );
  };
}

interface ReleaseFixture {
  readonly version: string;
  readonly connectorSlug: string;
  // The catalog digest, which identifies the generation once it serves.
  readonly digest: string;
  readonly pointer: Buffer;
  readonly catalogKey: string;
  readonly objects: ReadonlyMap<string, Buffer>;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return canonicalJsonValue(item);
    });
  }
  if (!isJsonRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        return [key, canonicalJsonValue(value[key])];
      }),
  );
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function releaseKeys(version: string): {
  readonly catalog: string;
} {
  const prefix = `connectors/v4/releases/${version}`;
  return {
    catalog: `${prefix}/catalog.json`,
  };
}

function buildCatalogConnector(args: {
  readonly connectorSlug: string;
  readonly label: string;
  readonly iconKey: string;
  readonly skill?: JsonRecord;
}): JsonRecord {
  return {
    slug: args.connectorSlug,
    label: args.label,
    description: "An external connector used only by the sync fixture",
    category: "testing",
    generation: [],
    tags: ["fixture"],
    authMethods: [
      {
        id: "api-token",
        label: "API Token",
        description: null,
        visible: true,
        storage: { version: 1, secrets: [PRIVATE_VALUE], variables: [] },
        grant: {
          kind: "manual",
          fields: [
            {
              privateName: PRIVATE_VALUE,
              publicId: "credential",
              label: "Credential",
              required: true,
              placeholder: null,
              storage: "secret",
            },
          ],
        },
        access: {
          kind: "static",
          envBindings: { SERVICE_TOKEN: `$secrets.${PRIVATE_VALUE}` },
        },
        revoke: { kind: "none" },
      },
    ],
    icon: { key: args.iconKey, invertInDarkMode: false },
    skill: args.skill ?? { kind: "none" },
    firewall: { kind: "none" },
  };
}

function buildBundledSkillFixture(connectorSlug: string) {
  const storageName = `connector-skill@${connectorSlug}-${randomUUID().replaceAll("-", "")}`;
  const versionId = createHash("sha256").update(randomUUID()).digest("hex");
  const archiveSize = 321;
  return {
    storageName,
    versionId,
    archiveSize,
    descriptor: {
      kind: "bundled",
      storageName,
      versionId,
      storageVersionPrefix: `__system__/volume/${storageName}/${versionId}`,
      size: Buffer.byteLength(`# ${connectorSlug}\n`),
      archiveSize,
      fileCount: 1,
    },
  };
}

function buildRelease(options: ReleaseFixtureOptions): ReleaseFixture {
  const connectorSlug = options.connectorSlug ?? "external-test";
  const label = options.label ?? "External Test";
  const keys = releaseKeys(options.version);
  const iconBytes = Buffer.from(`<svg>${connectorSlug}</svg>`);
  const iconDigest = digest(iconBytes);
  const iconKey =
    "platform/views/zero-page/components/settings/icons/" +
    `${connectorSlug}-${iconDigest.slice("sha256:".length, 19)}.svg`;
  const catalog: JsonRecord = {
    artifactSchemaVersion: 4,
    catalogVersion: options.version,
    categoryMetadata: {
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    },
    connectors: [
      buildCatalogConnector({
        connectorSlug,
        label,
        iconKey,
        skill: options.skill,
      }),
    ],
  };

  const catalogBytes = jsonBytes(catalog);
  const pointer: JsonRecord = {
    catalogVersion: options.version,
    catalogKey: keys.catalog,
    catalogDigest: digest(catalogBytes),
  };

  return {
    version: options.version,
    connectorSlug,
    digest: digest(catalogBytes),
    pointer: jsonBytes(pointer),
    catalogKey: keys.catalog,
    objects: new Map([[keys.catalog, catalogBytes]]),
  };
}

function catalogObjects(
  releases: readonly ReleaseFixture[],
  active: ReleaseFixture,
): ReadonlyMap<string, Buffer> {
  const objects = new Map<string, Buffer>();
  for (const release of releases) {
    for (const [key, bytes] of release.objects) {
      objects.set(key, bytes);
    }
  }
  objects.set(ACTIVE_KEY, active.pointer);
  return objects;
}

function commandInput(command: unknown): JsonRecord {
  if (!isJsonRecord(command)) {
    return {};
  }
  return isJsonRecord(command.input) ? command.input : {};
}

function steamOpenIdCallbackQuery(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  const returnTo = url.searchParams.get("openid.return_to");
  if (!returnTo) {
    throw new Error("Steam authorization URL is missing openid.return_to");
  }
  const state = new URL(returnTo).searchParams.get("state");
  if (!state) {
    throw new Error("Steam return_to is missing state");
  }
  const claimedId = `https://steamcommunity.com/openid/id/${STEAM_TEST_ID}`;
  return {
    state,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": "2026-07-15T08:00:00Znonce",
    "openid.assoc_handle": "catalog-assoc-handle",
    "openid.signed":
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "catalog-signature",
  };
}

function mockSteamOpenIdVerification(): void {
  server.use(
    http.post(
      "https://steamcommunity.com/openid/login",
      async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("openid.mode")).toBe("check_authentication");
        return new HttpResponse(
          ["ns:http://specs.openid.net/auth/2.0", "is_valid:true", ""].join(
            "\n",
          ),
          { headers: { "content-type": "text/plain" } },
        );
      },
    ),
  );
}

function s3Body(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function deferredGate(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  const deferred = createDeferredPromise<void>(context.signal);
  return {
    promise: deferred.promise,
    release: () => {
      if (!deferred.settled()) {
        deferred.resolve(undefined);
      }
    },
  };
}

function serveObjects(objects: ReadonlyMap<string, Buffer>): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const key = typeof input.Key === "string" ? input.Key : undefined;
    const bytes = key ? objects.get(key) : undefined;
    if (!bytes) {
      return Promise.reject(new Error("Object unavailable"));
    }
    return Promise.resolve({
      ContentLength: bytes.length,
      Body: s3Body(bytes),
    });
  });
}

function configureSource(): string {
  const bucket = `connector-catalog-test-${randomUUID()}`;
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
  return bucket;
}

function cronHeaders(secret = CRON_SECRET): { readonly authorization: string } {
  return { authorization: `Bearer ${secret}` };
}

async function syncCatalog(app: Awaited<ReturnType<typeof setupApp>>) {
  return await accept(
    app(cronConnectorCatalogContract).sync({ headers: cronHeaders() }),
    [200],
  );
}

// The public catalog served from the current pointer, read as a fresh user.
async function servedConnectors() {
  routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const headers = { authorization: "Bearer clerk-session" };
  const response = await accept(
    setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    ).list({ headers }),
    [200],
  );
  return response.body.connectors;
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockNow(new Date(FIRST_SYNC_TIME));
});

afterEach(() => {
  clearMockNow();
});

describe("connector catalog cron authentication", () => {
  it("rejects missing and invalid cron credentials", async () => {
    const response = await accept(
      setupApp({ context, routes: cronConnectorCatalogRoutes })(
        cronConnectorCatalogContract,
      ).sync({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    const missing = await createApp({
      signal: context.signal,
      routes: cronConnectorCatalogRoutes,
    }).request("/api/cron/sync-connector-catalog", { method: "GET" });
    expect(missing.status).toBe(401);
  });
});

describe("connector catalog valid lifecycle", () => {
  it("accepts, advances, rolls back, and serves the active database snapshot", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    configureSource();
    const first = buildRelease({
      version: "2026-07-15.1",
      label: "Initial catalog",
    });
    const second = buildRelease({
      version: "2026-07-15.2",
      label: "External Test Updated",
    });
    serveObjects(catalogObjects([first, second], first));
    const acceptedFirst = await syncCatalog(app);
    expect(acceptedFirst.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    const unchanged = await syncCatalog(app);
    expect(unchanged.body).toStrictEqual({
      outcome: "unchanged",
      failureCode: null,
    });
    serveObjects(catalogObjects([first, second], second));
    expect((await syncCatalog(app)).body).toMatchObject({
      outcome: "accepted",
    });
    await expect(servedConnectors()).resolves.toMatchObject([
      { slug: second.connectorSlug, label: "External Test Updated" },
    ]);

    // Rolling back publishes the first generation again rather than treating
    // it as unchanged.
    serveObjects(catalogObjects([first, second], first));
    expect((await syncCatalog(app)).body).toMatchObject({
      outcome: "accepted",
    });

    await expect(servedConnectors()).resolves.toMatchObject([
      { slug: first.connectorSlug, label: "Initial catalog" },
    ]);
  });

  it("uses a manual GitLab credential in a Run without optional host configuration", async () => {
    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "gitlab"));
    const connected = await connectorsApi.connectManualGrant(
      actor,
      "gitlab",
      "api-token",
      { accessToken: "manual-gitlab-secret" },
    );
    expect(connected).toMatchObject({
      target: { kind: "builtin", connectorSlug: "gitlab" },
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    const listed = await connectorsApi.listBuiltinConnectors(actor);
    expect(JSON.stringify(listed)).not.toContain("manual-gitlab-secret");
    await withConnectorRuntime(
      context,
      actor,
      "gitlab",
      async ({ claim, resolveAuth }) => {
        expect(claim.environment).not.toHaveProperty("GITLAB_HOST");
        const resolved = await resolveAuth({
          authHeaders: {
            "PRIVATE-TOKEN": secretTemplate("GITLAB_TOKEN"),
          },
        });
        expect(resolved.headers).toStrictEqual({
          "PRIVATE-TOKEN": "manual-gitlab-secret",
        });
      },
    );
  });

  it("mounts all 17 normally published connector skill versions", async () => {
    const owned = await publicChatActor(context, { clockTime: now() });
    const fixture = createChatEventsFixture(context);
    await owned.run(async () => {
      await fixture.api.createPersonalModelProvider(owned.actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: makeCodexAuthJson() },
      });
      await fixture.api.updateUserModelPreference(owned.actor, "gpt-6-luna");
    });
    const skills: {
      connector: Awaited<
        ReturnType<typeof connectorsApi.createCustomConnector>
      >;
      published: ReturnType<typeof readPublishedArchive>;
    }[] = [];
    for (let index = 0; index < 17; index += 1) {
      const start = context.mocks.s3.send.mock.calls.length;
      const connector = await owned.run(() => {
        return connectorsApi.createCustomConnector(owned.actor, {
          displayName: `Published skill ${index + 1}`,
          prefixTemplates: [`https://skill-${randomUUID()}.example.test/`],
          fields: [
            { key: "secret", label: "Token", kind: "secret", required: true },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.secret}}",
            },
          ],
          queryInjections: [],
          authMode: "manual",
          skillMarkdown: `Read published skill ${index + 1}.`,
        });
      });
      skills.push({
        connector,
        published: readPublishedArchive(context, start),
      });
    }
    await owned.run(() => {
      return connectorsApi.updateAgentCustomConnectors(
        owned.actor,
        owned.agentId,
        skills.map((skill) => {
          return skill.connector.id;
        }),
      );
    });
    for (const prompt of [
      "Use all published connector skills",
      "Reuse all exact published connector skills",
    ]) {
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt,
      });
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        run.runId,
      );
      const mounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return skills.some((skill) => {
            return (
              mount.name ===
              getCustomConnectorSkillStorageName(skill.connector.id)
            );
          });
        }) ?? [];
      expect(mounts).toHaveLength(17);
      for (const { connector, published } of skills) {
        expect(mounts).toContainEqual(
          expect.objectContaining({
            name: getCustomConnectorSkillStorageName(connector.id),
            mountPath: `/home/user/.pi/agent/skills/${getCustomConnectorSkillName(connector.slug, connector.id)}`,
            versionId: published.versionId,
            archiveSize: published.archiveSize,
            archiveUrl: expect.any(String),
          }),
        );
      }
      await owned.run(() => {
        return fixture.failChatRun(
          run.runId,
          sandboxHeaders,
          "Published skills inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    }
  }, 30_000);

  it("pins a published connector skill before a normal update", async () => {
    const owned = await publicChatActor(context, { clockTime: now() });
    const fixture = createChatEventsFixture(context);
    await owned.run(async () => {
      await fixture.api.createPersonalModelProvider(owned.actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: makeCodexAuthJson() },
      });
      await fixture.api.updateUserModelPreference(owned.actor, "gpt-6-luna");
    });
    const body = manualHttpCustomConnectorCreateBody({
      displayName: "Published skill",
      prefixTemplates: [`https://skill-${randomUUID()}.example.test/`],
      skillMarkdown: "Read the first published skill.",
    });
    const start = context.mocks.s3.send.mock.calls.length;
    const connector = await owned.run(() => {
      return connectorsApi.createCustomConnector(owned.actor, body);
    });
    const published = readPublishedArchive(context, start);
    await owned.run(() => {
      return connectorsApi.updateAgentCustomConnectors(
        owned.actor,
        owned.agentId,
        [connector.id],
      );
    });
    const first = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use the first published skill",
    });
    const updateStart = context.mocks.s3.send.mock.calls.length;
    await owned.run(() => {
      return connectorsApi.updateCustomConnector(owned.actor, connector.id, {
        ...body,
        skillMarkdown: "Use the updated published skill.",
      });
    });
    const updated = readPublishedArchive(context, updateStart);
    expect(updated.versionId).not.toBe(published.versionId);
    const check = async (runId: string, expected: typeof published) => {
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        runId,
      );
      const mounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return (
            mount.name === getCustomConnectorSkillStorageName(connector.id)
          );
        }) ?? [];
      expect(mounts).toHaveLength(1);
      expect(mounts[0]).toMatchObject({
        name: getCustomConnectorSkillStorageName(connector.id),
        mountPath: `/home/user/.pi/agent/skills/${getCustomConnectorSkillName(connector.slug, connector.id)}`,
        versionId: expected.versionId,
        archiveSize: expected.archiveSize,
        archiveUrl: expect.any(String),
      });
      await owned.run(() => {
        return fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Published skill inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    };
    await check(first.runId, published);
    const later = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use the updated published skill",
    });
    await check(later.runId, updated);
  }, 30_000);

  it("makes a verified Steam OpenID identity available to its Run", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockOptionalEnv("STEAM_WEB_API_KEY", "catalog-steam-api-key");
    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "steam"));
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const start = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorOpenIdStartContract,
      ).start({
        params: { connectorSlug: "steam" },
        headers,
        body: {
          authMethod: "openid",
          account: { intent: "add" },
        },
      }),
      [200],
    );
    mockSteamOpenIdVerification();
    await accept(
      setupApp({ context, routes: builtinConnectorsSlugCallbackRoutes })(
        builtinConnectorsSlugCallbackContract,
      ).callback({
        params: { connectorSlug: "steam" },
        headers: {},
        query: steamOpenIdCallbackQuery(start.body.authorizationUrl),
      }),
      [307],
    );
    await expect(
      connectorsApi.readDefaultBuiltinAccount(actor, "steam"),
    ).resolves.toMatchObject({
      authMethod: "openid",
      externalId: STEAM_TEST_ID,
      connectionStatus: "connected",
    });
    await withConnectorRuntime(context, actor, "steam", ({ claim }) => {
      expect(claim.environment?.STEAM_ID).toBe(STEAM_TEST_ID);
    });
  });

  it("refreshes AWS credentials in a Run after external-code authorization", async () => {
    const provider = mockAwsExternalCodeProvider();
    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "aws"));
    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const completed = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: awsVerificationCode(session.authorizationUrl),
    });
    expect(completed.account).toMatchObject({
      target: { kind: "builtin", connectorSlug: "aws" },
      authMethod: "cli",
      externalId: "123456789012",
      oauthScopes: ["openid"],
    });
    await withConnectorRuntime(
      context,
      actor,
      "aws",
      async ({ resolveAuth }) => {
        const resolved = await resolveAuth({
          authHeaders: {},
          authAwsSigv4: {
            accessKeyId: secretTemplate("AWS_ACCESS_KEY_ID"),
            secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
            sessionToken: secretTemplate("AWS_SESSION_TOKEN"),
          },
          forceRefresh: true,
        });
        expect(resolved.awsSigv4).toStrictEqual({
          accessKeyId: "aws-external-code-credential-id",
          secretAccessKey: "aws-secret-access-key",
          sessionToken: "aws-session-token",
        });
        expect(
          provider.tokenRequests.map(({ grantType }) => {
            return grantType;
          }),
        ).toStrictEqual(["authorization_code", "refresh_token"]);
        expect(provider.tokenRequests[1]?.refreshToken).toBe(
          "aws-login-refresh-token",
        );
      },
      // AWS connector aliases are valid on the vendor Runner harness; Pi
      // deliberately rejects them as ambient model-provider authentication.
      { model: "claude-fable-5-1" },
    );
  });

  it("revokes the connected Slack credential when its account is deleted", async () => {
    mockSlackConnectorOAuth();
    let revokeCalls = 0;
    server.use(
      http.post(SLACK_REVOKE_URL, ({ request }) => {
        revokeCalls += 1;
        expect(request.headers.get("authorization")).toBe(
          "Bearer xoxp-bdd-user-token",
        );
        return HttpResponse.json({ ok: true });
      }),
    );
    const actor = bdd.user();
    const start = await connectorsApi.startOauth(actor, "slack", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Slack authorization state");
    }
    await connectorsApi.completeOauthCallback("slack", {
      code: "catalog-slack-code",
      state,
    });
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "slack");
    expect(revokeCalls).toBe(1);
  });

  it("completes an in-flight Slack OAuth operation and reconnects its exact account", async () => {
    mockSlackConnectorOAuth();
    const providerEntered = deferredGate();
    const providerResume = deferredGate();
    server.use(
      http.post(SLACK_OAUTH_TOKEN_URL, async () => {
        providerEntered.release();
        await providerResume.promise;
        return HttpResponse.json({
          ok: true,
          authed_user: {
            id: "U012AB3CD",
            access_token: "xoxp-in-flight-token",
            scope: "channels:read,chat:write",
          },
        });
      }),
      http.post(SLACK_REVOKE_URL, () => {
        return HttpResponse.json({ ok: true });
      }),
    );
    const { actor, run: own } = createPublicConnectorActor(context, {
      optionalEnvironmentNames: [
        "SLACK_OAUTH_CLIENT_ID",
        "SLACK_OAUTH_CLIENT_SECRET",
      ],
      beforeDrain: providerResume.release,
    });
    const firstStart = await own(() => {
      return connectorsApi.startOauth(actor, "slack", "oauth");
    });
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!firstState) {
      throw new Error("Expected Slack authorization state");
    }
    const firstCallback = own(() => {
      return withMockNowForTest(now(), () => {
        return connectorsApi.completeOauthCallback("slack", {
          code: "first-authorization",
          state: firstState,
        });
      });
    });
    await providerEntered.promise;
    providerResume.release();
    await firstCallback;
    const [firstAccount] = await own(() => {
      return connectorsApi.listBuiltinConnectorAccounts(actor, "slack");
    });
    if (!firstAccount) {
      throw new Error("Expected the actual Slack account");
    }
    expect(firstAccount).toMatchObject({
      authMethod: "oauth",
      externalId: "U012AB3CD",
      connectionStatus: "connected",
    });
    const secondStart = await own(() => {
      return connectorsApi.startOauth(actor, "slack", "oauth", undefined, {
        intent: "reconnect",
        connectionId: firstAccount.id,
      });
    });
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!secondState) {
      throw new Error("Expected Slack authorization state");
    }
    await own(() => {
      return withMockNowForTest(now(), () => {
        return connectorsApi.completeOauthCallback("slack", {
          code: "second-authorization",
          state: secondState,
        });
      });
    });
    await expect(
      own(() => {
        return connectorsApi.listBuiltinConnectorAccounts(actor, "slack");
      }),
    ).resolves.toMatchObject([
      {
        id: firstAccount.id,
        authMethod: "oauth",
        externalId: "U012AB3CD",
        connectionStatus: "connected",
      },
    ]);
    await own(() => {
      return connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "slack");
    });
  });

  it("reuses a bundled skill registration in a later catalog release", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    configureSource();
    const skill = buildBundledSkillFixture("agora");
    const release = buildRelease({
      version: "2026-07-15.bundled-skill",
      connectorSlug: "agora",
      skill: skill.descriptor,
    });
    serveObjects(catalogObjects([release], release));
    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });

    const later = buildRelease({
      version: "2026-07-15.reused-bundled-skill",
      connectorSlug: "agora",
      label: "Reused bundled skill",
      skill: skill.descriptor,
    });
    serveObjects(catalogObjects([release, later], later));
    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    await expect(servedConnectors()).resolves.toStrictEqual([
      expect.objectContaining({ slug: "agora", label: "Reused bundled skill" }),
    ]);

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "agora"));
    await connectorsApi.connectManualGrant(actor, "agora", "api-token", {
      credential: "bundled-skill-token",
    });
    await withConnectorRuntime(context, actor, "agora", ({ claim }) => {
      const mounts = expectCanonicalStorageManifest(
        claim.storageManifest,
      )?.storageMounts;
      expect(mounts).toContainEqual(
        expect.objectContaining({
          name: skill.storageName,
          versionId: skill.versionId,
          archiveSize: skill.archiveSize,
        }),
      );
    });
  });
});

describe("connector catalog executable compatibility", () => {
  it("applies test OAuth rollout before connecting its confidential client", async () => {
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const provider = mockTestOAuthAuthCodeProvider({
      refreshToken: "catalog-test-oauth-refresh",
    });
    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "test-oauth"));
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const featureClient = setupApp({
      context,
      routes: featureSwitchesRoutes,
    })(featureSwitchesContract);

    const disabled = await accept(catalogClient.list({ headers }), [200]);
    expect(disabled.body.connectors).not.toContainEqual(
      expect.objectContaining({ slug: "test-oauth" }),
    );
    await accept(
      featureClient.update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.TestOauthConnector]: true },
        },
      }),
      [200],
    );
    const enabled = await accept(catalogClient.list({ headers }), [200]);
    expect(enabled.body.connectors).toContainEqual(
      expect.objectContaining({
        slug: "test-oauth",
        authMethods: expect.arrayContaining([
          expect.objectContaining({ id: "oauth", grantKind: "auth-code" }),
        ]),
      }),
    );
    expect(JSON.stringify(enabled.body)).not.toContain("test-oauth-secret");

    const start = await connectorsApi.startOauth(actor, "test-oauth", "oauth");
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-oauth-client",
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected test OAuth authorization state");
    }
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "catalog-test-oauth-code",
      state,
    });
    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("client_secret")).toBe(
      "test-oauth-secret",
    );
  });
});

describe("connector catalog rejection and latest-valid retention", () => {
  it("replaces current content when a catalog version is reused", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    configureSource();
    const original = buildRelease({ version: "2026-07-15.conflict" });
    serveObjects(catalogObjects([original], original));
    const originalResponse = await syncCatalog(app);

    const conflicting = buildRelease({
      version: original.version,
      label: "Conflicting Content",
    });
    serveObjects(catalogObjects([conflicting], conflicting));
    const replacementResponse = await syncCatalog(app);
    expect(originalResponse.body.outcome).toBe("accepted");
    expect(replacementResponse.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    expect(conflicting.digest).not.toBe(original.digest);
    await expect(servedConnectors()).resolves.toMatchObject([
      { slug: conflicting.connectorSlug, label: "Conflicting Content" },
    ]);
  });
});
