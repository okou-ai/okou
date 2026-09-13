import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { connectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { runnersBuiltinFirewallsResolveContract } from "@okouai/api-contracts/contracts/runners";
import {
  testSystemStoragePresignedUrlCacheStateContract,
  type TestSystemStoragePresignedUrlCacheStateActionBody,
} from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import {
  connectorOpenIdStartContract,
  connectorsSearchContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  connectorCatalogContract,
  CONNECTOR_CATALOG_MAX_RAW_BYTES,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import apiPackage from "../../../../package.json";
import { createApp } from "../../../app-factory";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { singleton } from "../../../lib/singleton";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  apiTestConnectorCatalogValidationAuthority,
  clearApiTestConnectorCatalogExternalReaderIdentityReplacements,
  corruptApiTestConnectorCatalogActiveSnapshotPayload,
  deleteApiTestConnectorCatalogCompatibility,
  deleteApiTestConnectorCatalogCompatibilityEvaluation,
  deleteApiTestConnectorCatalogRuntimeProjectionSet,
  expireApiTestConnectorCatalogRuntimeProjectionAuthority,
  installApiTestConnectorCatalog,
  invalidateApiTestConnectorCatalogCompatibility,
  mockApiTestConnectorProviderConfiguration,
  readApiTestConnectorCatalogCompatibilityEvaluations,
  readApiTestConnectorCatalogSnapshot,
  readApiTestConnectorCatalogRuntimeProjection,
  readApiTestConnectorCatalogRuntimeProjectionAuthority,
  readApiTestConnectorCatalogValidationAuthority,
  replaceApiTestConnectorCatalogStoredBytes,
  setApiTestConnectorCatalogExternalReaderIdentityReplacements,
  setApiTestConnectorCatalogRuntimeProjectionAuthority,
  setApiTestConnectorCatalogValidationAuthority,
} from "../../../test-fixtures/connector-catalog";
import {
  deleteOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { createDeferredPromise, settle } from "../../utils";
import { createRouteMocks } from "./helpers/route-test";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { readConnectorCredentialStorageState } from "./helpers/connector-credential-storage-state";
import { readUserSecrets } from "./helpers/user-config-state";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAwsExternalCodeProvider,
  mockDatadogConnectorOAuth,
  mockGmailConnectorOAuth,
  mockSlackConnectorOAuth,
  mockTestOAuthAuthCodeProvider,
  mockTestOAuthDeviceConnectorProvider,
  requestOauthCallbackRaw,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createGithubBddApi, newGithubUserId } from "./helpers/api-bdd-github";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { connectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { runnersRoutes } from "../runners";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorCheckRoutes } from "../connector-check";
import { connectorsRoutes } from "../connectors";
import { featureSwitchesRoutes } from "../feature-switches";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";

const TEST_APP_ROUTES = Object.freeze([
  ...connectorsSlugCallbackRoutes,
  ...cronConnectorCatalogRoutes,
  ...runnersRoutes,
  ...testSystemStoragePresignedUrlCacheStateRoutes,
  ...connectorCatalogRoutes,
  ...connectorCheckRoutes,
  ...connectorsRoutes,
  ...featureSwitchesRoutes,
  ...userPermissionGrantsRoutes,
  ...workflowAutomationsRoutes,
  ...workflowsRoutes,
]);

const context = testContext();
const routeMocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const githubApi = createGithubBddApi(context);
const miscApi = createMiscRoutesApi(context);
const CRON_SECRET = "connector-catalog-cron-secret";
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const ACTIVE_KEY = "connectors/v3/active.json";
const FIRST_SYNC_TIME = "2026-07-15T08:00:00.000Z";
const DIAGNOSTICS_USER_ID = `user_${randomUUID()}`;
const DIAGNOSTICS_ORG_ID = `org_${randomUUID()}`;
const PRIVATE_VALUE = "SECRET_TOKEN";
const DEFAULT_API_VERSION = apiPackage.version;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const PREVIOUS_CONNECTOR_CATALOG_MAX_RAW_BYTES = 32 * 1024 * 1024;
const EXPECTED_CAPABILITY_DIGEST =
  "sha256:9a8c84f91a49b1ab88d0771fda4bfa91816dcd9d471d98d2d3eb2f2aafbc4627";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SLACK_OAUTH_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_REVOKE_URL = "https://slack.com/api/auth.revoke";
const STEAM_TEST_ID = "76561198000000000";

type JsonRecord = Record<string, unknown>;
type JsonMutation = (value: JsonRecord) => void;

interface ReleaseFixtureOptions {
  readonly version: string;
  readonly connectorSlug?: string;
  readonly label?: string;
  readonly generatedFirewall?: boolean;
  readonly catalogBytes?: Buffer;
  readonly mutateCatalog?: JsonMutation;
  readonly mutateRuntime?: JsonMutation;
  readonly mutateFirewall?: JsonMutation;
  readonly mutateArtifact?: JsonMutation;
  readonly mutatePointer?: JsonMutation;
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
  readonly pointer: Buffer;
  readonly catalogKey: string;
  readonly objects: ReadonlyMap<string, Buffer>;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }
  return value;
}

function firstRecord(value: unknown, label: string): JsonRecord {
  const first = arrayValue(value, label)[0];
  return recordValue(first, `${label}[0]`);
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

function objectEtag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function catalogTemplate(reference: string): string {
  return `\${{ ${reference} }}`;
}

function releaseKeys(version: string): {
  readonly catalog: string;
} {
  const prefix = `connectors/v3/releases/${version}`;
  return {
    catalog: `${prefix}/catalog.json`,
  };
}

function buildCatalogConnector(args: {
  readonly connectorSlug: string;
  readonly label: string;
  readonly iconKey: string;
  readonly firewall?: JsonRecord;
}): JsonRecord {
  const presentationMethod = publicAuthMethod({
    id: "api-token",
    grantKind: "manual",
    manual: true,
  });
  presentationMethod.label = "API Token";
  return {
    slug: args.connectorSlug,
    label: args.label,
    description: "An external connector used only by the sync fixture",
    category: "testing",
    generation: [],
    tags: ["fixture"],
    authMethods: [
      canonicalAuthMethod(presentationMethod, defaultRuntimeAuthMethod()),
    ],
    icon: {
      key: args.iconKey,
      invertInDarkMode: false,
    },
    skill: { kind: "none" },
    firewall: args.firewall ?? { kind: "none" },
  };
}

function defaultRuntimeAuthMethod(): JsonRecord {
  return {
    id: "api-token",
    storage: { version: 1, secrets: [PRIVATE_VALUE], variables: [] },
    grant: {
      kind: "manual",
      fields: [
        {
          privateName: PRIVATE_VALUE,
          publicId: "credential",
          storage: "secret",
        },
      ],
    },
    access: {
      kind: "static",
      envBindings: { SERVICE_TOKEN: `$secrets.${PRIVATE_VALUE}` },
    },
    revoke: { kind: "none" },
  };
}

interface FixtureAuthComponents {
  presentation: readonly JsonRecord[];
  runtime: readonly JsonRecord[];
}

const fixtureAuthComponents = singleton(() => {
  return new WeakMap<JsonRecord, FixtureAuthComponents>();
});

function setFixtureAuthComponents(
  artifact: JsonRecord,
  components: FixtureAuthComponents,
): void {
  fixtureAuthComponents().set(artifact, components);
  if (components.presentation.length !== components.runtime.length) {
    return;
  }
  firstRecord(artifact.connectors, "connectors").authMethods =
    components.presentation.map((presentation, index) => {
      return canonicalAuthMethod(presentation, components.runtime[index]);
    });
}

function setArtifactAuthMethods(
  artifact: JsonRecord,
  methods: readonly JsonRecord[],
): void {
  const current = fixtureAuthComponents().get(artifact);
  if (!current) {
    throw new Error("Catalog fixture auth components are not initialized");
  }
  const presentation = methods.every((method) => {
    return typeof method.grantKind === "string";
  });
  setFixtureAuthComponents(artifact, {
    presentation: presentation ? methods : current.presentation,
    runtime: presentation ? current.runtime : methods,
  });
}

function initializeFixtureAuthComponents(artifact: JsonRecord): void {
  const presentationMethod = publicAuthMethod({
    id: "api-token",
    grantKind: "manual",
    manual: true,
  });
  presentationMethod.label = "API Token";
  setFixtureAuthComponents(artifact, {
    presentation: [presentationMethod],
    runtime: [defaultRuntimeAuthMethod()],
  });
}

function assertFixtureAuthComponentsComplete(artifact: JsonRecord): void {
  const components = fixtureAuthComponents().get(artifact);
  if (
    components &&
    components.presentation.length !== components.runtime.length
  ) {
    firstRecord(artifact.connectors, "connectors").authMethods = [
      {
        invalidFixtureAuthMethodCount: {
          presentation: components.presentation.length,
          runtime: components.runtime.length,
        },
      },
    ];
  }
}

function publicAuthMethod(args: {
  readonly id: string;
  readonly grantKind:
    | "manual"
    | "auth-code"
    | "openid-auth"
    | "external-code"
    | "device-auth";
  readonly manual?: boolean;
}): JsonRecord {
  return {
    id: args.id,
    label: `${args.id} auth`,
    description: null,
    visible: true,
    grantKind: args.grantKind,
    manualFields: args.manual
      ? [
          {
            id: "credential",
            label: "Credential",
            required: true,
            placeholder: null,
            inputType: "password",
          },
        ]
      : [],
    startOptions: [],
  };
}

function manualPrivateAuthMethod(args: {
  readonly id: string;
  readonly prefix: string;
  readonly access: "static" | "refresh-token";
  readonly revoke: "none" | "token-revoke";
}): JsonRecord {
  const credentialName = `${args.prefix}_CREDENTIAL`;
  const accessTokenName = `${args.prefix}_ACCESS_TOKEN`;
  return {
    id: args.id,
    storage: {
      version: 1,
      secrets:
        args.access === "refresh-token"
          ? [accessTokenName, credentialName]
          : [credentialName],
      variables: [],
    },
    grant: {
      kind: "manual",
      fields: [
        {
          privateName: credentialName,
          publicId: "credential",
          storage: "secret",
        },
      ],
    },
    access:
      args.access === "refresh-token"
        ? {
            kind: "refresh-token",
            envBindings: {
              SERVICE_TOKEN: `$secrets.${accessTokenName}`,
            },
            inputs: { refreshToken: `$secrets.${credentialName}` },
            outputs: {
              accessToken: `$secrets.${accessTokenName}`,
              refreshToken: `$secrets.${credentialName}`,
            },
            refreshableSecrets: [accessTokenName],
          }
        : {
            kind: "static",
            envBindings: { SERVICE_TOKEN: `$secrets.${credentialName}` },
          },
    revoke:
      args.revoke === "token-revoke"
        ? {
            kind: "token-revoke",
            inputs: { token: `$secrets.${credentialName}` },
          }
        : { kind: "none" },
  };
}

function testOauthPrivateAuthMethod(): JsonRecord {
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientId: "test-oauth-client",
      clientSecret: "test-oauth-secret",
    },
    storage: {
      version: 1,
      secrets: ["TEST_OAUTH_ACCESS_TOKEN", "TEST_OAUTH_REFRESH_TOKEN"],
      variables: ["TEST_OAUTH_API_TENANT_ID"],
    },
    grant: {
      kind: "auth-code",
      scopes: ["read"],
      callbackOrigin: "api",
      outputs: {
        accessToken: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
        refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
        tenantId: "$vars.TEST_OAUTH_API_TENANT_ID",
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
        TEST_OAUTH_TENANT_ID: "$vars.TEST_OAUTH_API_TENANT_ID",
      },
      inputs: {
        refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
      },
      outputs: {
        accessToken: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
        refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
      },
      refreshableSecrets: ["TEST_OAUTH_ACCESS_TOKEN"],
    },
    revoke: { kind: "none" },
  };
}

function devicePrivateAuthMethod(args?: {
  readonly accessTokenName?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
}): JsonRecord {
  const accessTokenName = args?.accessTokenName ?? "DEVICE_ACCESS_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "public",
      clientId: args?.clientId ?? "external-device-client",
    },
    storage: { version: 1, secrets: [accessTokenName], variables: [] },
    grant: {
      kind: "device-auth",
      scopes: [...(args?.scopes ?? [])],
      outputs: { accessToken: `$secrets.${accessTokenName}` },
      startOptionMappings: [],
    },
    access: {
      kind: "static",
      envBindings: {
        TEST_OAUTH_DEVICE_TOKEN: `$secrets.${accessTokenName}`,
      },
    },
    revoke: { kind: "none" },
  };
}

function steamPrivateAuthMethod(args?: {
  readonly callbackOrigin?: "web" | "api";
  readonly platformSecret?: string;
  readonly steamIdName?: string;
}): JsonRecord {
  const platformSecret = args?.platformSecret ?? "STEAM_WEB_API_KEY";
  const steamIdName = args?.steamIdName ?? "STEAM_ID";
  return {
    id: "openid",
    storage: { version: 1, secrets: [], variables: [steamIdName] },
    grant: {
      kind: "openid-auth",
      callbackOrigin: args?.callbackOrigin ?? "api",
      outputs: { steamId: `$vars.${steamIdName}` },
    },
    access: {
      kind: "static",
      platformSecrets: [platformSecret],
      envBindings: {
        STEAM_ID: `$vars.${steamIdName}`,
        STEAM_WEB_API_KEY: `$secrets.${platformSecret}`,
      },
    },
    revoke: { kind: "none" },
  };
}

function awsPrivateAuthMethod(
  scopes: readonly string[] = ["openid"],
): JsonRecord {
  const refreshTokenName = "CATALOG_AWS_LOGIN_REFRESH_TOKEN";
  const dpopKeyName = "CATALOG_AWS_LOGIN_DPOP_KEY";
  const accessKeyIdName = "CATALOG_AWS_ACCESS_KEY_ID";
  const secretAccessKeyName = "CATALOG_AWS_SECRET_ACCESS_KEY";
  const sessionTokenName = "CATALOG_AWS_SESSION_TOKEN";
  const signinRegionName = "CATALOG_AWS_SIGNIN_REGION";
  const runtimeRegionName = "CATALOG_AWS_REGION";
  return {
    id: "cli",
    client: {
      clientRegistration: "static",
      clientType: "public",
      clientId: "arn:aws:signin:::devtools/cross-device",
    },
    storage: {
      version: 1,
      secrets: [
        refreshTokenName,
        dpopKeyName,
        accessKeyIdName,
        secretAccessKeyName,
        sessionTokenName,
      ],
      variables: [signinRegionName, runtimeRegionName],
    },
    grant: {
      kind: "external-code",
      scopes: [...scopes],
      outputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        dpopKey: `$secrets.${dpopKeyName}`,
        accessKeyId: `$secrets.${accessKeyIdName}`,
        secretAccessKey: `$secrets.${secretAccessKeyName}`,
        sessionToken: `$secrets.${sessionTokenName}`,
        signinRegion: `$vars.${signinRegionName}`,
        runtimeRegion: `$vars.${runtimeRegionName}`,
      },
    },
    access: {
      kind: "refresh-token",
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        dpopKey: `$secrets.${dpopKeyName}`,
        signinRegion: `$vars.${signinRegionName}`,
      },
      outputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        accessKeyId: `$secrets.${accessKeyIdName}`,
        secretAccessKey: `$secrets.${secretAccessKeyName}`,
        sessionToken: `$secrets.${sessionTokenName}`,
      },
      refreshableSecrets: [
        accessKeyIdName,
        secretAccessKeyName,
        sessionTokenName,
      ],
      envBindings: {
        AWS_ACCESS_KEY_ID: `$secrets.${accessKeyIdName}`,
        AWS_SECRET_ACCESS_KEY: `$secrets.${secretAccessKeyName}`,
        AWS_SESSION_TOKEN: `$secrets.${sessionTokenName}`,
        AWS_REGION: `$vars.${runtimeRegionName}`,
        AWS_DEFAULT_REGION: `$vars.${runtimeRegionName}`,
      },
    },
    revoke: { kind: "none" },
  };
}

function deelPrivateAuthMethod(): JsonRecord {
  const accessTokenName = "CATALOG_DEEL_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_DEEL_REFRESH_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "DEEL_OAUTH_CLIENT_ID",
      clientSecretEnv: "DEEL_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: [],
      callbackOrigin: "web",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        DEEL_TOKEN: `$secrets.${accessTokenName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: { kind: "none" },
  };
}

function gmailPrivateAuthMethod(): JsonRecord {
  const accessTokenName = "CATALOG_GMAIL_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_GMAIL_REFRESH_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
      clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      callbackOrigin: "web",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        GMAIL_TOKEN: `$secrets.${accessTokenName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: { kind: "none" },
  };
}

function cloudflarePrivateAuthMethod(): JsonRecord {
  const accessTokenName = "CATALOG_CLOUDFLARE_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_CLOUDFLARE_REFRESH_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "CLOUDFLARE_OAUTH_CLIENT_ID",
      clientSecretEnv: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: [],
      callbackOrigin: "api",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        CLOUDFLARE_TOKEN: `$secrets.${accessTokenName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: {
      kind: "token-revoke",
      inputs: { refreshToken: `$secrets.${refreshTokenName}` },
    },
  };
}

function unsupportedWebAuthCodePrivateAuthMethod(): JsonRecord {
  const accessTokenName = "FUTURE_WEB_ACCESS_TOKEN";
  return {
    id: "future-web",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "CLOUDFLARE_OAUTH_CLIENT_ID",
      clientSecretEnv: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
    },
    storage: { version: 1, secrets: [accessTokenName], variables: [] },
    grant: {
      kind: "auth-code",
      scopes: [],
      callbackOrigin: "web",
      outputs: { accessToken: `$secrets.${accessTokenName}` },
    },
    access: {
      kind: "static",
      envBindings: { FUTURE_WEB_TOKEN: `$secrets.${accessTokenName}` },
    },
    revoke: { kind: "none" },
  };
}

function slackPrivateAuthMethod(
  accessTokenName = "CATALOG_SLACK_ACCESS_TOKEN",
  storageVersion = 1,
): JsonRecord {
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
      clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: storageVersion,
      secrets: [accessTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: ["channels:read", "chat:write"],
      callbackOrigin: "web",
      outputs: { accessToken: `$secrets.${accessTokenName}` },
    },
    access: {
      kind: "static",
      envBindings: { SLACK_TOKEN: `$secrets.${accessTokenName}` },
    },
    revoke: {
      kind: "token-revoke",
      inputs: { accessToken: `$secrets.${accessTokenName}` },
    },
  };
}

function datadogPrivateAuthMethod(scopes: readonly string[]): JsonRecord {
  const accessTokenName = "CATALOG_DATADOG_ACCESS_TOKEN";
  const refreshTokenName = "CATALOG_DATADOG_REFRESH_TOKEN";
  const domainName = "CATALOG_DATADOG_DOMAIN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "DATADOG_OAUTH_CLIENT_ID",
      clientSecretEnv: "DATADOG_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName, refreshTokenName],
      variables: [domainName],
    },
    grant: {
      kind: "auth-code",
      scopes: [...scopes],
      callbackOrigin: "web",
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
        domain: `$vars.${domainName}`,
      },
    },
    access: {
      kind: "refresh-token",
      envBindings: {
        DATADOG_TOKEN: `$secrets.${accessTokenName}`,
        DATADOG_DOMAIN: `$vars.${domainName}`,
      },
      inputs: {
        refreshToken: `$secrets.${refreshTokenName}`,
        domain: `$vars.${domainName}`,
      },
      outputs: {
        accessToken: `$secrets.${accessTokenName}`,
        refreshToken: `$secrets.${refreshTokenName}`,
      },
      refreshableSecrets: [accessTokenName],
    },
    revoke: { kind: "none" },
  };
}

function githubPrivateAuthMethod(scopes: readonly string[]): JsonRecord {
  const accessTokenName = "CATALOG_GITHUB_ACCESS_TOKEN";
  return {
    id: "oauth",
    client: {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "GH_OAUTH_CLIENT_ID",
      clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
    },
    storage: {
      version: 1,
      secrets: [accessTokenName],
      variables: [],
    },
    grant: {
      kind: "auth-code",
      scopes: [...scopes],
      callbackOrigin: "web",
      outputs: { accessToken: `$secrets.${accessTokenName}` },
    },
    access: {
      kind: "static",
      envBindings: {
        GH_TOKEN: `$secrets.${accessTokenName}`,
        GITHUB_TOKEN: `$secrets.${accessTokenName}`,
      },
    },
    revoke: {
      kind: "token-revoke",
      inputs: { accessToken: `$secrets.${accessTokenName}` },
    },
  };
}

function buildBundledSkill(
  connectorSlug: string,
  versionId = createHash("sha256").update(randomUUID()).digest("hex"),
  metadata: {
    readonly size: number;
    readonly archiveSize: number;
    readonly fileCount: number;
  } = {
    size: Buffer.byteLength(`# ${connectorSlug}\n`),
    archiveSize: 321,
    fileCount: 1,
  },
  storageName = `connector-skill@${connectorSlug}-${randomUUID().replaceAll("-", "")}`,
): JsonRecord {
  const prefix = `__system__/volume/${storageName}/${versionId}`;
  return {
    kind: "bundled",
    storageName,
    versionId,
    storageVersionPrefix: prefix,
    size: metadata.size,
    archiveSize: metadata.archiveSize,
    fileCount: metadata.fileCount,
  };
}

interface OwnedVolumeStorageFixture {
  readonly storageId: string;
  readonly storageName: string;
  readonly s3Prefix: string;
}

function createOwnedVolumeStorageFixture(
  storageName: string,
  s3Prefix = `${SYSTEM_ORG_ID}/volume/${storageName}`,
): OwnedVolumeStorageFixture {
  return {
    storageId: randomUUID(),
    storageName,
    s3Prefix,
  };
}

function createBundledSkillStorageFixture(
  connectorSlug: string,
): OwnedVolumeStorageFixture {
  return createOwnedVolumeStorageFixture(
    `connector-skill@${connectorSlug}-${randomUUID().replaceAll("-", "")}`,
  );
}

interface BundledSkillFixture extends OwnedVolumeStorageFixture {
  readonly descriptor: JsonRecord;
  readonly versionId: string;
  readonly contentSize: number;
  readonly archiveSize: number;
  readonly manifestKey: string;
  readonly archiveKey: string;
}

function buildBundledSkillFixture(
  connectorSlug: string,
  versionId = createHash("sha256").update(randomUUID()).digest("hex"),
  storage = createBundledSkillStorageFixture(connectorSlug),
): BundledSkillFixture {
  const contentSize = Buffer.byteLength(`# ${connectorSlug}\n`);
  const archiveSize = 321;
  const fileCount = 1;
  const versionPrefix = `${storage.s3Prefix}/${versionId}`;
  const manifestKey = `${versionPrefix}/manifest.json`;
  const archiveKey = `${versionPrefix}/archive.tar.gz`;
  return {
    descriptor: buildBundledSkill(
      connectorSlug,
      versionId,
      {
        size: contentSize,
        archiveSize,
        fileCount,
      },
      storage.storageName,
    ),
    ...storage,
    versionId,
    contentSize,
    archiveSize,
    manifestKey,
    archiveKey,
  };
}

function setFirewallBase(artifact: JsonRecord, base: string): void {
  const connector = firstRecord(artifact.connectors, "connectors");
  const firewall = recordValue(connector.firewall, "firewall");
  const config = recordValue(firewall.config, "firewall.config");
  firstRecord(config.apis, "firewall.apis").base = base;
}

function buildGeneratedFirewall(): JsonRecord {
  const base = "https://api.example.test/v1";
  const auth = (): JsonRecord => {
    return {
      headers: {
        Authorization: `Bearer ${catalogTemplate("secrets.SERVICE_TOKEN")}`,
      },
    };
  };
  const permissions = [
    {
      name: "items.read",
      description: "Read items",
      rules: ["GET /items"],
    },
  ];
  return {
    kind: "generated",
    billable: false,
    config: {
      placeholders: { SERVICE_TOKEN: "placeholder-token" },
      apis: [{ base, auth: auth(), permissions }],
    },
    categories: {
      byPermission: { "items.read": "Items" },
      displayOrder: ["Items"],
    },
    defaultAllowed: ["items.read"],
    defaultUnknownPolicy: "deny",
  };
}

const DUPLICATE_DYNAMIC_FIREWALL_BASE = `https://${catalogTemplate("vars.SERVICE_HOST")}.example.test/v1`;
const DUPLICATE_DYNAMIC_FIREWALL_HOST_POLICY = {
  kind: "providerOwned",
  suffixes: [".example.test"],
} as const;

function addDynamicFirewallVariableBinding(artifact: JsonRecord): void {
  const connector = firstRecord(artifact.connectors, "connectors");
  const method = firstRecord(connector.authMethods, "authMethods");
  recordValue(method.storage, "storage").variables = ["SERVICE_HOST"];
  recordValue(
    recordValue(method.access, "access").envBindings,
    "envBindings",
  ).SERVICE_HOST = "$vars.SERVICE_HOST";
}

function addDuplicateDynamicPrivateFirewallApi(
  artifact: JsonRecord,
  options: { readonly conflictingHostPolicy?: boolean } = {},
): void {
  const connector = firstRecord(artifact.connectors, "connectors");
  const firewall = recordValue(connector.firewall, "firewall");
  const config = recordValue(firewall.config, "firewall.config");
  const apis = arrayValue(config.apis, "firewall.apis");
  const firstApi = firstRecord(apis, "firewall.apis");
  firstApi.base = DUPLICATE_DYNAMIC_FIREWALL_BASE;
  firstApi.hostPolicy = DUPLICATE_DYNAMIC_FIREWALL_HOST_POLICY;
  const fallbackApi = structuredClone(firstApi);
  fallbackApi.auth = {};
  fallbackApi.permissions = [];
  fallbackApi.hostPolicy = options.conflictingHostPolicy
    ? { kind: "publicDestination" }
    : DUPLICATE_DYNAMIC_FIREWALL_HOST_POLICY;
  apis.push(fallbackApi);
}

function canonicalGrant(
  publicMethod: JsonRecord,
  privateMethod: JsonRecord,
): JsonRecord {
  const privateGrant = structuredClone(
    recordValue(privateMethod.grant, "private auth method grant"),
  );
  if (privateGrant.kind === "manual") {
    const publicFields = arrayValue(
      publicMethod.manualFields,
      "public manual fields",
    ).map((field) => {
      return recordValue(field, "public manual field");
    });
    privateGrant.fields = arrayValue(
      privateGrant.fields,
      "private manual fields",
    ).map((fieldValue) => {
      const field = recordValue(fieldValue, "private manual field");
      const publicField = publicFields.find((candidate) => {
        return candidate.id === field.publicId;
      });
      return {
        ...field,
        label: publicField?.label,
        required: publicField?.required,
        placeholder: publicField?.placeholder,
      };
    });
  }
  if (privateGrant.kind === "device-auth") {
    const publicOptions = arrayValue(
      publicMethod.startOptions,
      "public device start options",
    ).map((option) => {
      return recordValue(option, "public device start option");
    });
    privateGrant.startOptions = arrayValue(
      privateGrant.startOptionMappings,
      "private device start option mappings",
    ).map((mappingValue) => {
      const mapping = recordValue(
        mappingValue,
        "private device start option mapping",
      );
      const publicOption = publicOptions.find((candidate) => {
        return candidate.id === mapping.publicId;
      });
      return {
        privateName: mapping.privateName,
        publicId: mapping.publicId,
        kind: publicOption?.kind,
        label: publicOption?.label,
        required: publicOption?.required,
        defaultValue: publicOption?.defaultValue,
        options: publicOption?.options,
      };
    });
    delete privateGrant.startOptionMappings;
  }
  return privateGrant;
}

function canonicalAuthMethod(
  publicMethodValue: unknown,
  privateMethodValue: unknown,
): JsonRecord {
  const publicMethod = recordValue(publicMethodValue, "public auth method");
  const privateMethod = recordValue(privateMethodValue, "private auth method");
  const publicExtras = Object.fromEntries(
    Object.entries(publicMethod).filter(([key]) => {
      return ![
        "id",
        "label",
        "description",
        "visible",
        "grantKind",
        "manualFields",
        "startOptions",
      ].includes(key);
    }),
  );
  const method: JsonRecord = {
    ...privateMethod,
    ...publicExtras,
    id: publicMethod.id,
    label: publicMethod.label,
    description: publicMethod.description,
    visible: publicMethod.visible,
    ...(privateMethod.client === undefined
      ? {}
      : { client: privateMethod.client }),
    storage: privateMethod.storage,
    grant: canonicalGrant(publicMethod, privateMethod),
    access: privateMethod.access,
    revoke: privateMethod.revoke,
  };
  if (
    publicMethod.id !== privateMethod.id ||
    publicMethod.grantKind !==
      recordValue(privateMethod.grant, "private auth method grant").kind
  ) {
    method.invalidSplitFixtureRelationship = true;
  }
  return method;
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
    artifactSchemaVersion: 3,
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
        ...(options.generatedFirewall
          ? { firewall: buildGeneratedFirewall() }
          : {}),
      }),
    ],
  };

  initializeFixtureAuthComponents(catalog);
  options.mutateCatalog?.(catalog);
  options.mutateRuntime?.(catalog);
  options.mutateFirewall?.(catalog);
  assertFixtureAuthComponentsComplete(catalog);
  options.mutateArtifact?.(catalog);
  const catalogBytes = options.catalogBytes ?? jsonBytes(catalog);
  const pointer: JsonRecord = {
    catalogVersion: options.version,
    catalogKey: keys.catalog,
    catalogDigest: digest(catalogBytes),
  };
  options.mutatePointer?.(pointer);

  return {
    version: options.version,
    connectorSlug,
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

function releaseCatalogBytes(release: ReleaseFixture): Buffer {
  const bytes = release.objects.get(release.catalogKey);
  if (bytes === undefined) {
    throw new Error("Expected release catalog bytes");
  }
  return bytes;
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
    const etag = objectEtag(bytes);
    if (input.IfNoneMatch === etag) {
      return Promise.reject(
        Object.assign(new Error("Not modified"), {
          $metadata: { httpStatusCode: 304 },
        }),
      );
    }
    return Promise.resolve({
      ContentLength: bytes.length,
      Body: s3Body(bytes),
      ETag: etag,
    });
  });
}

function configureSource(): string {
  const bucket = `connector-catalog-test-${randomUUID()}`;
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
  return bucket;
}

function previousConnectorCatalogSourceId(bucket: string): string {
  const endpoint =
    env("S3_ENDPOINT") ??
    `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  return createHash("sha256")
    .update(new URL(endpoint).origin)
    .update("\0")
    .update(bucket)
    .update("\0connector-catalog-persisted-snapshot-generation:")
    .update("2")
    .digest("hex");
}

function setApiVersion(version: string): void {
  apiPackage.version = version;
}

function cronHeaders(secret = CRON_SECRET): { readonly authorization: string } {
  return { authorization: `Bearer ${secret}` };
}

function cronClient() {
  return setupApp({ context, routes: cronConnectorCatalogRoutes })(
    cronConnectorCatalogContract,
  );
}

function diagnosticsClient() {
  return setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
}

function runnerFirewallClient() {
  return setupApp({ context, routes: runnersRoutes })(
    runnersBuiltinFirewallsResolveContract,
  );
}

async function expectCatalogUnavailableRequestError(
  reason: string,
): Promise<void> {
  const code = `CONNECTOR_CATALOG_UNAVAILABLE:${reason}`;
  const response = await accept(
    runnerFirewallClient().resolve({
      headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
      body: {},
    }),
    [500],
  );

  expect(response.body).toStrictEqual({ error: "Internal server error" });
  const capturedError =
    context.mocks.sentry.captureException.mock.calls.at(-1)?.[0];
  expect(capturedError).toMatchObject({
    name: "ExternalConnectorCatalogUnavailableError",
    message: "Accepted external connector catalog is unavailable",
    reason,
    code,
  });
}

interface VolumeStorageState {
  readonly s3_prefix: string;
  readonly size: number;
  readonly file_count: number;
  readonly head_version_id: string | null;
}

function systemStorageStateClient() {
  return setupAppWithRoutes({
    context,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  })(testSystemStoragePresignedUrlCacheStateContract);
}

async function systemStorageStateAction(
  body: TestSystemStoragePresignedUrlCacheStateActionBody,
) {
  return await accept(systemStorageStateClient().action({ body }), [200]);
}

async function readVolumeStorageState(args: {
  readonly orgId: string;
  readonly storageName: string;
}): Promise<VolumeStorageState | null> {
  const response = await systemStorageStateAction({
    action: "read-storage-state",
    org_id: args.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: args.storageName,
  });
  return response.body.storage_state ?? null;
}

async function readOwnedVolumeStorageState(
  storageId: string,
): Promise<VolumeStorageState | null> {
  const response = await systemStorageStateAction({
    action: "read-owned-storage-state",
    storage_id: storageId,
  });
  return response.body.storage_state ?? null;
}

interface OwnedVolumeStorageClaim extends OwnedVolumeStorageFixture {
  readonly orgId: string;
}

async function claimOwnedVolumeStorages(
  claims: readonly OwnedVolumeStorageClaim[],
): Promise<void> {
  await systemStorageStateAction({
    action: "claim-owned-storages",
    storages: claims.map((claim) => {
      return {
        storage_id: claim.storageId,
        org_id: claim.orgId,
        user_id: VOLUME_ORG_USER_ID,
        storage_name: claim.storageName,
        s3_prefix: claim.s3Prefix,
      };
    }),
  });
}

async function claimOwnedVolumeStorage(
  claim: OwnedVolumeStorageClaim,
): Promise<void> {
  await claimOwnedVolumeStorages([claim]);
}

async function cleanupOwnedVolumeStorages(
  storageIds: readonly string[],
): Promise<void> {
  await systemStorageStateAction({
    action: "cleanup-owned-storages",
    storage_ids: [...storageIds],
  });
}

async function seedOwnedVolumeStorageVersion(args: {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
}): Promise<void> {
  await systemStorageStateAction({
    action: "seed-owned-storage-version",
    storage_id: args.storageId,
    version_id: args.versionId,
    s3_key: args.s3Key,
    archive_size: 321,
  });
}

async function readVolumeStorageVersion(args: {
  readonly orgId: string;
  readonly storageName: string;
  readonly versionId: string;
}) {
  const response = await systemStorageStateAction({
    action: "read-storage-version",
    org_id: args.orgId,
    user_id: VOLUME_ORG_USER_ID,
    storage_name: args.storageName,
    version_id: args.versionId,
  });
  return response.body.storage_version ?? null;
}

async function syncCatalog() {
  return await accept(cronClient().sync({ headers: cronHeaders() }), [200]);
}

async function enableDiagnosticsFeatureSwitch(): Promise<void> {
  routeMocks.clerk.session(DIAGNOSTICS_USER_ID, DIAGNOSTICS_ORG_ID);
  await accept(
    setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).update({
      headers: { authorization: "Bearer clerk-session" },
      body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
    }),
    [200],
  );
  onTestFinished(async () => {
    routeMocks.clerk.session(DIAGNOSTICS_USER_ID, DIAGNOSTICS_ORG_ID);
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).delete({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });
}

async function readStatus() {
  await enableDiagnosticsFeatureSwitch();
  return await accept(
    diagnosticsClient().diagnostics({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
}

async function rawCronRequest(path: string): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(path, {
    method: "GET",
  });
}

function expectRejectedBeforeAcceptance(
  body: Awaited<ReturnType<typeof syncCatalog>>["body"],
  failureCode: string,
): void {
  expect(body).toMatchObject({
    outcome: "rejected",
    state: "never-synced",
    active: null,
    lastAttempt: {
      outcome: "rejected",
      failureCode,
    },
    lastSuccessAt: null,
  });
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockNow(new Date(FIRST_SYNC_TIME));
});

afterEach(() => {
  clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
  setApiVersion(DEFAULT_API_VERSION);
  clearMockNow();
});

describe("connector catalog cron authentication and initial state", () => {
  it("rejects missing and invalid cron credentials", async () => {
    const response = await accept(
      cronClient().sync({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    const missing = await rawCronRequest("/api/cron/sync-connector-catalog");
    expect(missing.status).toBe(401);
  });

  it("reports never-synced without reading the shared storage bucket", async () => {
    configureSource();
    expect((await readStatus()).body).toStrictEqual({
      state: "never-synced",
      active: null,
      lastAttempt: null,
      lastSuccessAt: null,
      rejectedCandidate: null,
      credentialStorage: {
        missingConnectorVersions: expect.any(Number),
        unownedConnectorSecrets: expect.any(Number),
        unownedConnectorVariables: expect.any(Number),
        unresolvedBridgeCredentials: expect.any(Number),
      },
      filtering: {
        capabilityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        evaluatedAt: null,
        stale: true,
        filteredAuthMethods: [],
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("reports zero final connector credential invariant violations", async () => {
    configureSource();

    const response = await readStatus();
    expect(response.body.credentialStorage).toStrictEqual({
      missingConnectorVersions: 0,
      unownedConnectorSecrets: 0,
      unownedConnectorVariables: 0,
      unresolvedBridgeCredentials: 0,
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});

describe("connector catalog unavailable request telemetry", () => {
  it("classifies a missing current identity", async () => {
    expect.hasAssertions();
    configureSource();

    await expectCatalogUnavailableRequestError("missing_current_identity");
  });

  it("classifies an invalid persisted compatibility evaluation", async () => {
    expect.hasAssertions();
    configureSource();
    await installApiTestConnectorCatalog();
    await invalidateApiTestConnectorCatalogCompatibility();

    await expectCatalogUnavailableRequestError(
      "invalid_compatibility_evaluation",
    );
  });

  it("classifies a rejected persisted artifact", async () => {
    expect.hasAssertions();
    configureSource();
    await installApiTestConnectorCatalog();
    await corruptApiTestConnectorCatalogActiveSnapshotPayload();

    await expectCatalogUnavailableRequestError(
      "invalid_artifact:invalid-compression",
    );
  });

  it("classifies a missing active snapshot after the identity retry", async () => {
    expect.hasAssertions();
    configureSource();
    await installApiTestConnectorCatalog({
      catalogVersion: "2026-08-31.identity-race-initial",
    });
    setApiTestConnectorCatalogExternalReaderIdentityReplacements([
      "2026-08-31.identity-race-first-replacement",
      "2026-08-31.identity-race-second-replacement",
    ]);

    await expectCatalogUnavailableRequestError(
      "missing_active_snapshot_after_retry",
    );
  });
});

describe("connector catalog valid lifecycle", () => {
  it("accepts, advances, rolls back, and serves the active database snapshot", async () => {
    const bucket = configureSource();
    const first = buildRelease({ version: "2026-07-15.1" });
    const second = buildRelease({
      version: "2026-07-15.2",
      label: "External Test Updated",
    });
    serveObjects(catalogObjects([first, second], first));
    const acceptedFirst = await syncCatalog();
    expect(acceptedFirst.body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: first.version },
      lastAttempt: { outcome: "accepted", failureCode: null },
      lastSuccessAt: FIRST_SYNC_TIME,
      filtering: {
        evaluatedAt: FIRST_SYNC_TIME,
        stale: false,
        filteredAuthMethods: [],
      },
    });
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual(apiTestConnectorCatalogValidationAuthority());
    await expect(
      readApiTestConnectorCatalogRuntimeProjection(),
    ).resolves.toStrictEqual({
      connectorCount: 1,
      connectorSlugs: [first.connectorSlug],
    });
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: bucket,
      Key: ACTIVE_KEY,
    });

    const callsBeforeStatus = context.mocks.s3.send.mock.calls.length;
    expect((await readStatus()).body).toStrictEqual(
      (({ outcome: _outcome, ...status }) => {
        return status;
      })(acceptedFirst.body),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStatus);

    mockNow(new Date("2026-07-15T08:01:00.000Z"));
    await deleteApiTestConnectorCatalogRuntimeProjectionSet();
    await expect(
      readApiTestConnectorCatalogRuntimeProjection(),
    ).resolves.toBeNull();
    const callsBeforeUnchanged = context.mocks.s3.send.mock.calls.length;
    const unchanged = await syncCatalog();
    expect(unchanged.body).toMatchObject({
      outcome: "unchanged",
      state: "current",
      active: { catalogVersion: first.version },
      lastAttempt: { outcome: "unchanged", failureCode: null },
      lastSuccessAt: "2026-07-15T08:01:00.000Z",
      filtering: {
        evaluatedAt: FIRST_SYNC_TIME,
        stale: false,
        filteredAuthMethods: [],
      },
    });
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeUnchanged).toBe(
      1,
    );
    expect(
      commandInput(context.mocks.s3.send.mock.calls[callsBeforeUnchanged]?.[0]),
    ).toMatchObject({
      Bucket: bucket,
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(first.pointer),
    });
    await expect(
      readApiTestConnectorCatalogRuntimeProjection(),
    ).resolves.toStrictEqual({
      connectorCount: 1,
      connectorSlugs: [first.connectorSlug],
    });

    await expireApiTestConnectorCatalogRuntimeProjectionAuthority();
    await expect(
      readApiTestConnectorCatalogRuntimeProjectionAuthority(),
    ).resolves.toStrictEqual({
      validatorVersion: "1.0.0",
      buildCommitSha: null,
    });
    mockNow(new Date("2026-07-15T08:02:00.000Z"));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "unchanged",
      state: "current",
      active: { catalogVersion: first.version },
    });
    await expect(
      readApiTestConnectorCatalogRuntimeProjectionAuthority(),
    ).resolves.toStrictEqual(apiTestConnectorCatalogValidationAuthority());

    const newerProjectionAuthority = {
      validatorVersion: "999.0.0",
      buildCommitSha: null,
    };
    await setApiTestConnectorCatalogRuntimeProjectionAuthority(
      newerProjectionAuthority,
    );
    mockNow(new Date("2026-07-15T08:03:00.000Z"));
    expect((await syncCatalog()).body.outcome).toBe("unchanged");
    await expect(
      readApiTestConnectorCatalogRuntimeProjectionAuthority(),
    ).resolves.toStrictEqual(newerProjectionAuthority);

    serveObjects(catalogObjects([first, second], second));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: second.version },
    });
    await expect(
      readApiTestConnectorCatalogRuntimeProjection(),
    ).resolves.toStrictEqual({
      connectorCount: 1,
      connectorSlugs: [second.connectorSlug],
    });

    serveObjects(catalogObjects([first, second], first));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: first.version },
    });
    await expect(
      readApiTestConnectorCatalogRuntimeProjection(),
    ).resolves.toStrictEqual({
      connectorCount: 1,
      connectorSlugs: [first.connectorSlug],
    });

    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const callsBeforePublicCatalog = context.mocks.s3.send.mock.calls.length;
    const publicCatalog = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      publicCatalog.body.connectors.some((connector) => {
        return connector.slug === first.connectorSlug;
      }),
    ).toBeTruthy();
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(
      callsBeforePublicCatalog,
    );
  });

  it("serves every public catalog surface from accepted database state", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-public-reader",
      generatedFirewall: true,
      mutateCatalog: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        recordValue(connector.icon, "icon").key =
          "connector-icons/resolved-icon.svg";
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const searchClient = setupApp({ context, routes: connectorsRoutes })(
      connectorsSearchContract,
    );
    const callsBeforePublicReads = context.mocks.s3.send.mock.calls.length;

    const list = await accept(catalogClient.list({ headers }), [200]);
    expect(list.body.connectors).toHaveLength(1);
    expect(list.body.connectors[0]).toMatchObject({
      slug: release.connectorSlug,
      label: "External Test",
      description: "An external connector used only by the sync fixture",
      category: "testing",
      generation: [],
      tags: ["fixture"],
      icon: {
        url: "https://static.vm0.io/connector-icons/resolved-icon.svg",
        invertInDarkMode: false,
      },
      authMethods: [
        {
          id: "api-token",
          label: "API Token",
          description: null,
          grantKind: "manual",
        },
      ],
      permissionSummary: {
        hasPermissions: true,
        permissionCount: 1,
        hasCategories: true,
        hasDefaultPolicyOverrides: true,
      },
    });
    expect(list.body.categoryMetadata).toStrictEqual({
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    });
    assertPublicConnectorCatalogHasNoPrivateFields(list.body);

    const detail = await accept(
      catalogClient.get({
        params: { connectorSlug: release.connectorSlug },
        headers,
      }),
      [200],
    );
    expect(detail.body.connector.authMethods[0]).toMatchObject({
      id: "api-token",
      manualFields: [
        {
          id: "credential",
          label: "Credential",
          required: true,
          placeholder: null,
          inputType: "password",
        },
      ],
      startOptions: [],
    });

    const permissions = await accept(
      catalogClient.permissions({
        params: { connectorSlug: release.connectorSlug },
        headers,
      }),
      [200],
    );
    expect(permissions.body.permissions).toMatchObject({
      connectorSlug: release.connectorSlug,
      permissionCount: 1,
      permissions: [{ name: "items.read", description: "Read items" }],
      categories: {
        categories: { "items.read": "Items" },
        displayOrder: ["Items"],
      },
      defaultPolicy: {
        permissionDefault: "allow",
        unknownPolicy: "deny",
      },
    });

    const status = await accept(catalogClient.status({ headers }), [200]);
    expect(status.body.connectors).toHaveLength(1);
    expect(status.body.connectors[0]).toMatchObject({
      slug: release.connectorSlug,
      connected: false,
      connection: null,
      connectionStatus: "not-connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
      singleAuthCodeAuthMethodId: null,
      connectNotice: null,
    });
    assertPublicConnectorCatalogHasNoPrivateFields(status.body);

    const search = await accept(
      searchClient.search({
        query: { keyword: "external" },
        headers,
      }),
      [200],
    );
    expect(search.body.connectors).toStrictEqual([
      {
        slug: release.connectorSlug,
        label: "External Test",
        description: "An external connector used only by the sync fixture",
        authMethods: ["api-token"],
      },
    ]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforePublicReads);
    expect(JSON.stringify({ detail, permissions, search })).not.toContain(
      PRIVATE_VALUE,
    );
  });

  it("keeps the first firewall permission description and sorts public permissions", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-permission-projection",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        const firewall = recordValue(connector.firewall, "firewall");
        const config = recordValue(firewall.config, "firewall.config");
        const apis = arrayValue(config.apis, "firewall.apis");
        const secondApi = structuredClone(firstRecord(apis, "firewall.apis"));
        secondApi.base = "https://api.example.test/v2";
        secondApi.permissions = [
          {
            name: "items.read",
            description: "Later items description",
            rules: ["GET /later-items"],
          },
          {
            name: "alpha.read",
            description: "Read alpha",
            rules: ["GET /alpha"],
          },
        ];
        apis.push(secondApi);
        recordValue(
          recordValue(firewall.categories, "firewall.categories").byPermission,
          "firewall.categories.byPermission",
        )["alpha.read"] = "Items";
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const response = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).permissions({
        params: { connectorSlug: release.connectorSlug },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.permissions.permissions).toStrictEqual([
      { name: "alpha.read", description: "Read alpha" },
      { name: "items.read", description: "Read items" },
    ]);
  });

  it("serves concurrent external catalog reads without returning to R2", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-concurrent-cold-reader",
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const callsBeforePublicReads = context.mocks.s3.send.mock.calls.length;

    const [list, detail] = await Promise.all([
      accept(catalogClient.list({ headers }), [200]),
      accept(
        catalogClient.get({
          params: { connectorSlug: release.connectorSlug },
          headers,
        }),
        [200],
      ),
    ]);
    expect(list.body.connectors).toHaveLength(1);
    expect(detail.body.connector.slug).toBe(release.connectorSlug);

    await accept(catalogClient.list({ headers }), [200]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforePublicReads);
  });

  it("fails closed when attested catalog integrity or identity is corrupted", async () => {
    configureSource();
    const digestRelease = buildRelease({
      version: "2026-07-27.attested-digest-corruption",
    });
    serveObjects(catalogObjects([digestRelease], digestRelease));
    await syncCatalog();
    const changedBytes = Buffer.from(releaseCatalogBytes(digestRelease));
    changedBytes[changedBytes.length - 1] = 0x20;
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion: digestRelease.version,
      rawBytes: changedBytes,
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
      retainCatalogDigest: true,
    });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const digestResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(digestResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    configureSource();
    const jsonRelease = buildRelease({
      version: "2026-07-27.attested-json-corruption",
    });
    serveObjects(catalogObjects([jsonRelease], jsonRelease));
    await syncCatalog();
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion: jsonRelease.version,
      rawBytes: Buffer.from("{"),
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
    });
    const jsonResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(jsonResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    configureSource();
    const identityRelease = buildRelease({
      version: "2026-07-27.attested-identity-corruption",
    });
    const mismatchedIdentity = buildRelease({
      version: identityRelease.version,
      mutateArtifact: (artifact) => {
        artifact.catalogVersion = "different-catalog-version";
      },
    });
    serveObjects(catalogObjects([identityRelease], identityRelease));
    await syncCatalog();
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion: identityRelease.version,
      rawBytes: releaseCatalogBytes(mismatchedIdentity),
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
    });
    const identityResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(identityResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    configureSource();
    const nonObjectRelease = buildRelease({
      version: "2026-07-27.attested-non-object-corruption",
    });
    serveObjects(catalogObjects([nonObjectRelease], nonObjectRelease));
    await syncCatalog();
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion: nonObjectRelease.version,
      rawBytes: Buffer.from("null"),
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
    });
    const nonObjectResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(nonObjectResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    configureSource();
    const schemaRelease = buildRelease({
      version: "2026-07-27.attested-schema-corruption",
    });
    serveObjects(catalogObjects([schemaRelease], schemaRelease));
    await syncCatalog();
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion: schemaRelease.version,
      rawBytes: jsonBytes({
        artifactSchemaVersion: 4,
        catalogVersion: schemaRelease.version,
      }),
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
    });
    const schemaResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(schemaResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    configureSource();
    const shapeRelease = buildRelease({
      version: "2026-07-27.attested-shape-corruption",
    });
    serveObjects(catalogObjects([shapeRelease], shapeRelease));
    await syncCatalog();
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion: shapeRelease.version,
      rawBytes: jsonBytes({
        artifactSchemaVersion: 3,
      }),
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
    });
    const shapeResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(shapeResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("keeps corruption fail closed and derives missing compatibility", async () => {
    configureSource();
    const semanticRelease = buildRelease({
      version: "2026-07-27.stale-semantic-corruption",
    });
    const invalidSemanticRelease = buildRelease({
      version: semanticRelease.version,
      mutateArtifact: (artifact) => {
        firstRecord(artifact.connectors, "connectors").label = "";
      },
    });
    serveObjects(catalogObjects([semanticRelease], semanticRelease));
    await syncCatalog();
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion: semanticRelease.version,
      rawBytes: releaseCatalogBytes(invalidSemanticRelease),
      catalogValidationAuthority: null,
    });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const semanticResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(semanticResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toBeNull();

    configureSource();
    const compatibilityRelease = buildRelease({
      version: "2026-07-27.compatibility-corruption",
    });
    serveObjects(catalogObjects([compatibilityRelease], compatibilityRelease));
    await syncCatalog();
    await invalidateApiTestConnectorCatalogCompatibility();
    const corruptedEvaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();
    expect(corruptedEvaluations).toHaveLength(1);
    const compatibilityResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(compatibilityResponse.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    configureSource();
    const missingRelease = buildRelease({
      version: "2026-07-27.missing-compatibility",
    });
    serveObjects(catalogObjects([missingRelease], missingRelease));
    await syncCatalog();
    await deleteApiTestConnectorCatalogCompatibility();
    const remainingEvaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();
    expect(remainingEvaluations).toHaveLength(0);
    const missingResponse = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(missingResponse.body).toMatchObject({
      connectors: [
        expect.objectContaining({ slug: missingRelease.connectorSlug }),
      ],
    });
    await expect(
      readApiTestConnectorCatalogCompatibilityEvaluations(),
    ).resolves.toHaveLength(0);
  });

  it("applies compatibility, authored visibility, and request rollout filters", async () => {
    configureSource();
    const gated = publicAuthMethod({
      id: "api-token",
      grantKind: "manual",
      manual: true,
    });
    const visible = publicAuthMethod({
      id: "cli",
      grantKind: "manual",
      manual: true,
    });
    const hidden = publicAuthMethod({
      id: "oauth",
      grantKind: "manual",
      manual: true,
    });
    hidden.visible = false;
    const release = buildRelease({
      version: "2026-07-15.external-request-filters",
      connectorSlug: "cal-com",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [gated, visible, hidden]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "api-token",
            prefix: "GATED",
            access: "static",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "cli",
            prefix: "VISIBLE",
            access: "static",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "oauth",
            prefix: "HIDDEN",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    routeMocks.clerk.session(userId, orgId);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const featureClient = setupApp({
      context,
      routes: featureSwitchesRoutes,
    })(featureSwitchesContract);

    const released = await accept(catalogClient.list({ headers }), [200]);
    expect(
      released.body.connectors[0]?.authMethods.map((method) => {
        return method.id;
      }),
    ).toStrictEqual(["api-token", "cli"]);

    await accept(
      featureClient.update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.CalComConnector]: false },
        },
      }),
      [200],
    );
    const disabled = await accept(catalogClient.list({ headers }), [200]);
    expect(disabled.body.connectors[0]?.authMethods).toStrictEqual([
      {
        id: "cli",
        label: "cli auth",
        description: null,
        grantKind: "manual",
      },
    ]);

    await accept(
      featureClient.update({
        headers,
        body: {
          switches: { [FeatureSwitchKey.CalComConnector]: true },
        },
      }),
      [200],
    );
    const enabled = await accept(catalogClient.list({ headers }), [200]);
    expect(
      enabled.body.connectors[0]?.authMethods.map((method) => {
        return method.id;
      }),
    ).toStrictEqual(["api-token", "cli"]);
    await accept(featureClient.delete({ headers }), [200]);

    const graduated = buildRelease({
      version: "2026-07-15.external-graduated-switch",
    });
    serveObjects(catalogObjects([release, graduated], graduated));
    await syncCatalog();
    const graduatedVisible = await accept(
      catalogClient.list({ headers }),
      [200],
    );
    expect(graduatedVisible.body.connectors).toMatchObject([
      {
        slug: "external-test",
        authMethods: [{ id: "api-token" }],
      },
    ]);
  });

  it("executes an external manual grant with catalog-owned storage", async () => {
    configureSource();
    const optionalSecretName = "EXTERNAL_OPTIONAL_TOKEN";
    const release = buildRelease({
      version: "2026-07-15.external-manual-grant",
      connectorSlug: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        const grant = recordValue(method.grant, "grant");
        arrayValue(grant.fields, "grant.fields").push({
          privateName: optionalSecretName,
          publicId: "optionalCredential",
          storage: "secret",
          label: "Optional credential",
          required: false,
          placeholder: null,
        });
      },
      mutateRuntime: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        arrayValue(
          recordValue(method.storage, "storage").secrets,
          "secrets",
        ).push(optionalSecretName);
        recordValue(
          recordValue(method.access, "access").envBindings,
          "envBindings",
        ).OPTIONAL_SERVICE_TOKEN = `$secrets.${optionalSecretName}`;
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "agora"));
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const connected = await connectorsApi.connectManualGrant(
      actor,
      "agora",
      "api-token",
      { credential: "catalog-manual-secret" },
    );
    expect(connected).toMatchObject({
      slug: "agora",
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    const listed = await connectorsApi.listConnectors(actor);
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "agora",
        authMethod: "api-token",
        namespace: "secrets",
        name: "SERVICE_TOKEN",
      }),
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(secrets).toContainEqual(
      expect.objectContaining({ name: PRIVATE_VALUE, type: "connector" }),
    );
    expect(JSON.stringify(secrets)).not.toContain("catalog-manual-secret");
    const storageState = await readConnectorCredentialStorageState(context, {
      connectorSlug: "agora",
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      secretNames: [optionalSecretName],
    });
    expect(storageState.secrets).toStrictEqual([]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("seeds an external token credential through the CLI test endpoint", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-cli-seed",
      connectorSlug: "test-oauth-device",
      label: "Catalog Device OAuth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "device-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          devicePrivateAuthMethod({
            accessTokenName: "CATALOG_CLI_DEVICE_ACCESS_TOKEN",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    const firewall = createFirewallApi(context);
    onTestFinished(createConnectorCleanup(actor, "test-oauth-device"));
    await firewall.provisionRunReadyOrg(actor);
    const callsBeforeSeed = context.mocks.s3.send.mock.calls.length;
    await firewall.seedTestConnector(actor, {
      connectorSlug: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "catalog-cli-access-token",
    });

    await expect(
      connectorsApi.readConnectorBySlug(actor, "test-oauth-device"),
    ).resolves.toMatchObject({
      slug: "test-oauth-device",
      authMethod: "oauth",
      connectionStatus: "connected",
    });
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(secrets).toContainEqual(
      expect.objectContaining({
        name: "CATALOG_CLI_DEVICE_ACCESS_TOKEN",
        type: "connector",
      }),
    );
    expect(JSON.stringify(secrets)).not.toContain("catalog-cli-access-token");
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeSeed);
  });

  it("replaces and deletes connections with compatibility-filtered auth methods", async () => {
    configureSource();
    const legacyMethod = publicAuthMethod({
      id: "legacy",
      grantKind: "manual",
      manual: true,
    });
    const currentMethod = publicAuthMethod({
      id: "current",
      grantKind: "manual",
      manual: true,
    });
    const initial = buildRelease({
      version: "2026-07-15.external-legacy-method",
      connectorSlug: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "agora"));
    const legacyConnection = await connectorsApi.connectManualGrant(
      actor,
      "agora",
      "legacy",
      { credential: "legacy-catalog-secret" },
    );

    const replacement = buildRelease({
      version: "2026-07-15.external-replacement-method",
      connectorSlug: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod, currentMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "refresh-token",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "current",
            prefix: "CURRENT",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial, replacement], replacement));
    const synced = await syncCatalog();
    expect(synced.body.filtering.filteredAuthMethods).toStrictEqual([
      {
        connectorSlug: "agora",
        authMethodId: "legacy",
        reasons: ["missing-access-provider"],
      },
    ]);

    const connected = await connectorsApi.connectManualGrant(
      actor,
      "agora",
      "current",
      { credential: "current-catalog-secret" },
      undefined,
      { intent: "reconnect", connectionId: legacyConnection.id },
    );
    expect(connected).toMatchObject({
      slug: "agora",
      authMethod: "current",
      connectionStatus: "connected",
    });

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    const names = secrets.map((secret) => {
      return secret.name;
    });
    expect(names).toContain("CURRENT_CREDENTIAL");
    expect(names).not.toContain("LEGACY_CREDENTIAL");

    const unavailable = buildRelease({
      version: "2026-07-15.external-all-methods-filtered",
      connectorSlug: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod, currentMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "refresh-token",
            revoke: "none",
          }),
          manualPrivateAuthMethod({
            id: "current",
            prefix: "CURRENT",
            access: "refresh-token",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(
      catalogObjects([initial, replacement, unavailable], unavailable),
    );
    const filtered = await syncCatalog();
    expect(filtered.body.filtering.filteredAuthMethods).toHaveLength(2);

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "agora");
    const secretsAfterDelete = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(
      secretsAfterDelete.map((secret) => {
        return secret.name;
      }),
    ).not.toContain("CURRENT_CREDENTIAL");
  });

  it("replaces and deletes stored connector state when its method is removed", async () => {
    configureSource();
    const legacyMethod = publicAuthMethod({
      id: "legacy",
      grantKind: "manual",
      manual: true,
    });
    const currentMethod = publicAuthMethod({
      id: "current",
      grantKind: "manual",
      manual: true,
    });
    const initial = buildRelease({
      version: "2026-07-15.external-stored-method-present",
      connectorSlug: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [legacyMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "agora"));
    const legacyConnection = await connectorsApi.connectManualGrant(
      actor,
      "agora",
      "legacy",
      { credential: "legacy-catalog-secret" },
    );

    const removed = buildRelease({
      version: "2026-07-15.external-stored-method-removed",
      connectorSlug: "agora",
      label: "Catalog Agora",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [currentMethod]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "current",
            prefix: "CURRENT",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial, removed], removed));
    await syncCatalog();

    const replacement = await connectorsApi.requestManualGrant(
      actor,
      "agora",
      "current",
      { credential: "current-catalog-secret" },
      {
        statuses: [200],
        account: {
          intent: "reconnect",
          connectionId: legacyConnection.id,
        },
      },
    );
    expect(replacement.status).toBe(200);
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "agora");

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    const secretNames = secrets.map((secret) => {
      return secret.name;
    });
    expect(secretNames).not.toContain("LEGACY_CREDENTIAL");
    expect(secretNames).not.toContain("CURRENT_CREDENTIAL");
  });

  it("replaces token state when the stored method is removed", async () => {
    configureSource();
    const initial = buildRelease({
      version: "2026-07-15.external-token-stored-method-present",
      connectorSlug: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "legacy", grantKind: "manual", manual: true }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          manualPrivateAuthMethod({
            id: "legacy",
            prefix: "LEGACY_GMAIL",
            access: "static",
            revoke: "none",
          }),
        ]);
      },
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "gmail"));
    const legacyConnection = await connectorsApi.connectManualGrant(
      actor,
      "gmail",
      "legacy",
      { credential: "legacy-gmail-secret" },
    );

    mockGmailConnectorOAuth({ email: "removed-method@example.test" });
    const replacement = buildRelease({
      version: "2026-07-15.external-token-stored-method-removed",
      connectorSlug: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [gmailPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([initial, replacement], replacement));
    await syncCatalog();

    const oauth = await connectorsApi.startOauth(
      actor,
      "gmail",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: legacyConnection.id },
    );
    const state = new URL(oauth.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Gmail authorization state");
    }
    const callback = await connectorsApi.completeOauthCallback("gmail", {
      code: "removed-stored-method",
      state,
    });
    const callbackLocation = new URL(callback.headers.get("location") ?? "");
    expect(callbackLocation.pathname).toBe("/connector/success");

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    const secretNames = secrets.map((secret) => {
      return secret.name;
    });
    expect(secretNames).not.toContain("LEGACY_GMAIL_CREDENTIAL");
    expect(secretNames).toContain("CATALOG_GMAIL_ACCESS_TOKEN");
    expect(secretNames).toContain("CATALOG_GMAIL_REFRESH_TOKEN");
    await expect(
      connectorsApi.readConnectorBySlug(actor, "gmail"),
    ).resolves.toMatchObject({ authMethod: "oauth" });
  });

  it("materializes external runtime bindings for runs and firewall auth", async () => {
    const connectorSlug = "external-runtime";
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-run-materialization",
      connectorSlug,
      label: "External Runtime",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        recordValue(connector.firewall, "firewall").billable = true;
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const runs = createRunsApi(context);
    const firewall = createFirewallApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "External catalog runtime agent",
      visibility: "private",
    });
    const created: { runId?: string } = {};
    const customConnectorIds: string[] = [];
    const cleanupConnector = createConnectorCleanup(actor, connectorSlug);
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      if (created.runId) {
        await runs.requestCancelRun(actor, created.runId, [200, 404]);
      }
      for (const customConnectorId of customConnectorIds) {
        await connectorsApi.deleteCustomConnector(actor, customConnectorId);
      }
      await cleanupConnector();
      await bdd.deleteAgent(actor, agent.agentId);
    });
    const connected = await connectorsApi.connectManualGrant(
      actor,
      connectorSlug,
      "api-token",
      { credential: "catalog-runtime-secret" },
      agent.agentId,
    );

    const callsBeforeRun = context.mocks.s3.send.mock.calls.length;
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const check = await accept(
      setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      ).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "url",
          method: "GET",
          url: "https://api.example.test/v1/items",
          connectorSlug,
        },
      }),
      [200],
    );
    expect(check.body).toMatchObject({
      outcome: "resolved",
      mode: "url",
      connector: {
        connectorSlug,
        label: "External Runtime",
      },
      base: "https://api.example.test/v1",
      relativePath: "/items",
      permission: {
        kind: "matched",
        permissions: [{ name: "items.read" }],
      },
    });
    const hostOverlap = await connectorsApi.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        displayName: "External Host Overlap",
        prefixTemplates: ["https://api.example.test/custom/"],
      }),
    );
    customConnectorIds.push(hostOverlap.id);
    expect(hostOverlap.prefixTemplates).toStrictEqual([
      "https://api.example.test/custom/",
    ]);
    const grants = await accept(
      setupApp({ context, routes: userPermissionGrantsRoutes })(
        userPermissionGrantsContract,
      ).apply({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentId: agent.agentId,
          connectorSlug,
          mode: "replace",
          grants: [{ permission: "items.read", action: "deny" }],
        },
      }),
      [200],
    );
    expect(grants.body).toMatchObject([
      { connectorSlug, permission: "items.read", action: "deny" },
    ]);
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the externally sourced connector credential",
      modelProvider: "anthropic-api-key",
    });
    created.runId = run.runId;
    await runs.heartbeatRunner(runnerGroup);
    await expect
      .poll(
        async () => {
          return (await runs.pollRunner(runnerGroup)).body.job?.runId;
        },
        { timeout: 10_000 },
      )
      .toBe(run.runId);
    const claim = await runs.claimRunnerJob(run.runId);
    expect(claim.environment?.SERVICE_TOKEN).toBeTruthy();
    expect(claim.secretConnectorMap).toMatchObject({
      SERVICE_TOKEN: connectorSlug,
    });
    expect(claim.firewalls).toContainEqual({
      kind: "builtin",
      name: connectorSlug,
      sourceId: connected.id,
    });
    expect(claim.billableFirewalls).toContain(connectorSlug);
    expect(claim.networkPolicies?.[connectorSlug]).toStrictEqual({
      allow: [],
      deny: ["items.read"],
      ask: [],
      unknownPolicy: "deny",
    });
    expect(
      expectCanonicalStorageManifest(claim.storageManifest)?.storageMounts.some(
        (storage) => {
          return storage.mountPath.endsWith(`/skills/${connectorSlug}`);
        },
      ),
    ).toBeFalsy();
    if (!claim.encryptedSecrets) {
      throw new Error("Expected encrypted connector secrets in the run claim");
    }
    const resolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: ["Bearer $", "{{ secrets.SERVICE_TOKEN }}"].join(""),
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected firewall auth to resolve connector secrets");
    }
    expect(resolved.body.headers).toStrictEqual({
      Authorization: "Bearer catalog-runtime-secret",
    });
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeRun);
    await runs.requestCancelRun(actor, run.runId, [200]);
  }, 15_000);

  it("omits and clears permission grants for a removed catalog connector", async () => {
    const removedConnectorSlug = "external-removed-permissions";
    const currentConnectorSlug = "external-current-permissions";
    configureSource();
    const removedRelease = buildRelease({
      version: "2026-07-15.external-removed-permissions",
      connectorSlug: removedConnectorSlug,
      label: "External Removed Permissions",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([removedRelease], removedRelease));
    await syncCatalog();

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Removed catalog permission agent",
      visibility: "private",
    });
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      await bdd.deleteAgent(actor, agent.agentId);
    });
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: userPermissionGrantsRoutes })(
      userPermissionGrantsContract,
    );
    await accept(
      client.apply({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentId: agent.agentId,
          connectorSlug: removedConnectorSlug,
          mode: "replace",
          grants: [{ permission: "items.read", action: "deny" }],
        },
      }),
      [200],
    );

    const currentRelease = buildRelease({
      version: "2026-07-15.external-current-permissions",
      connectorSlug: currentConnectorSlug,
      label: "External Current Permissions",
      generatedFirewall: true,
    });
    serveObjects(
      catalogObjects([removedRelease, currentRelease], currentRelease),
    );
    await syncCatalog();
    await accept(
      client.apply({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentId: agent.agentId,
          connectorSlug: currentConnectorSlug,
          mode: "replace",
          grants: [{ permission: "items.read", action: "allow" }],
        },
      }),
      [200],
    );

    const listed = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
        query: { agentId: agent.agentId },
      }),
      [200],
    );
    expect(listed.body).toStrictEqual([
      expect.objectContaining({
        connectorSlug: currentConnectorSlug,
        permission: "items.read",
        action: "allow",
      }),
    ]);

    const rejected = await accept(
      client.apply({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentId: agent.agentId,
          connectorSlug: removedConnectorSlug,
          mode: "replace",
          grants: [{ permission: "items.read", action: "deny" }],
        },
      }),
      [400],
    );
    expect(rejected.body.error.message).toBe(
      `Unknown connector slug: ${removedConnectorSlug}`,
    );
    const cleared = await accept(
      client.apply({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentId: agent.agentId,
          connectorSlug: removedConnectorSlug,
          mode: "replace",
          grants: [],
        },
      }),
      [200],
    );
    expect(cleared.body).toStrictEqual([]);

    serveObjects(
      catalogObjects([removedRelease, currentRelease], removedRelease),
    );
    await syncCatalog();
    const restored = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
        query: { agentId: agent.agentId },
      }),
      [200],
    );
    expect(restored.body).toStrictEqual([]);
  });

  it("wakes claimed runs when a custom permission bundle changes", async () => {
    const connectorSlug = "external-custom-permissions";
    configureSource();
    const initial = buildRelease({
      version: "2026-07-15.external-custom-permissions-1",
      connectorSlug,
      label: "External Custom Permissions",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog();

    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "External custom permission agent",
      visibility: "private",
    });
    const custom = await connectorsApi.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        displayName: "External custom permission API",
        prefixTemplates: ["https://custom-permissions.example.test/v1/"],
        permissionBundleRef: `builtin:${connectorSlug}@1`,
      }),
    );
    await connectorsApi.setCustomConnectorSecret(
      actor,
      custom.id,
      "custom-permission-secret",
    );
    const grant = {
      customConnectorId: custom.id,
      permissionNames: ["items.read"],
    };
    const grantResponse =
      await connectorsApi.requestUpdateAgentCustomConnectorGrants(
        actor,
        agent.agentId,
        [grant],
        [200],
      );
    if (grantResponse.status !== 200) {
      throw new Error("Expected custom connector permission grant");
    }

    const created: { runId?: string } = {};
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      if (created.runId) {
        await runs.requestCancelRun(actor, created.runId, [200, 404]);
      }
      await connectorsApi.deleteCustomConnector(actor, custom.id);
      await bdd.deleteAgent(actor, agent.agentId);
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the custom permission bundle",
      modelProvider: "anthropic-api-key",
    });
    created.runId = run.runId;
    await runs.heartbeatRunner(runnerGroup);
    await runs.claimRunnerJob(run.runId);

    context.mocks.ably.publish.mockClear();
    const replacement = buildRelease({
      version: "2026-07-15.external-custom-permissions-2",
      connectorSlug,
      label: "External Custom Permissions",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        const firewall = recordValue(connector.firewall, "firewall");
        const config = recordValue(firewall.config, "firewall.config");
        const api = firstRecord(config.apis, "firewall.apis");
        const permission = firstRecord(api.permissions, "permissions");
        permission.rules = ["GET /items", "GET /items/:id"];
      },
    });
    serveObjects(catalogObjects([initial, replacement], replacement));
    await syncCatalog();
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledWith({
      channels: [expect.stringMatching(/^runner-group:/)],
      messages: expect.arrayContaining([
        {
          name: "connector-runtime-sync",
          data: JSON.stringify({
            runId: run.runId,
            target: { kind: "custom", customConnectorId: custom.id },
          }),
          encoding: "json",
        },
      ]),
    });

    context.mocks.ably.batchPublish.mockClear();
    await syncCatalog();
    expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
  }, 15_000);

  it("composes accepted connector and local model-provider runner firewalls", async () => {
    const connectorSlug = "external-runner-firewall";
    configureSource();
    const first = buildRelease({
      version: "2026-07-15.external-runner-firewall-1",
      connectorSlug,
      label: "External Runner Firewall",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([first], first));
    const sync = await syncCatalog();
    const acceptedCatalogDigest = sync.body.active?.catalogDigest;
    if (!acceptedCatalogDigest) {
      throw new Error("Expected an accepted connector catalog digest");
    }

    const headers = { authorization: OFFICIAL_RUNNER_AUTHORIZATION };
    const providerName = "model-provider:openai-api-key";
    const callsBeforeReads = context.mocks.s3.send.mock.calls.length;
    const subset = await accept(
      runnerFirewallClient().resolve({
        headers,
        body: { names: [connectorSlug, connectorSlug, providerName] },
      }),
      [200],
    );
    expect(Object.keys(subset.body.firewalls).sort()).toStrictEqual([
      connectorSlug,
      providerName,
    ]);
    expect(subset.body.firewalls[connectorSlug]?.apis[0]?.base).toBe(
      "https://api.example.test/v1",
    );
    expect(subset.body.firewalls[providerName]?.apis[0]?.base).toBe(
      "https://api.openai.com/v1/responses",
    );

    const full = await accept(
      runnerFirewallClient().resolve({ headers, body: {} }),
      [200],
    );
    const providerNames = Object.values(MODEL_PROVIDER_FIREWALL_CONFIGS)
      .map((firewall) => {
        return firewall.name;
      })
      .sort();
    expect(Object.keys(full.body.firewalls).sort()).toStrictEqual(
      [connectorSlug, ...providerNames].sort(),
    );
    expect(subset.body.catalogDigest).toBe(full.body.catalogDigest);
    expect(subset.body.catalogVersion).toBe(full.body.catalogVersion);
    const firstHex = createHash("sha256")
      .update(JSON.stringify(full.body.firewalls, null, 2))
      .digest("hex");
    expect(full.body.catalogDigest).toBe(`sha256:${firstHex}`);
    expect(full.body.catalogVersion).toBe(`sha256-${firstHex.slice(0, 12)}`);
    for (const [name, firewall] of Object.entries(full.body.firewalls)) {
      expect(firewall.name).toBe(name);
    }
    const serialized = JSON.stringify(full.body);
    expect(serialized).not.toContain("sourceId");
    expect(serialized).not.toContain(acceptedCatalogDigest);
    expect(serialized).not.toContain(first.catalogKey);

    const missing = await accept(
      runnerFirewallClient().resolve({
        headers,
        body: { names: ["github"] },
      }),
      [400],
    );
    expect(missing.body.error.message).toBe("Unknown builtin firewall: github");
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeReads);

    const changedBase = "https://api.example.test/v2";
    const second = buildRelease({
      version: "2026-07-15.external-runner-firewall-2",
      connectorSlug,
      label: "External Runner Firewall",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        setFirewallBase(artifact, changedBase);
      },
    });
    serveObjects(catalogObjects([first, second], second));
    await syncCatalog();
    const callsBeforeSecondRead = context.mocks.s3.send.mock.calls.length;
    const updated = await accept(
      runnerFirewallClient().resolve({ headers, body: {} }),
      [200],
    );
    expect(updated.body.catalogDigest).not.toBe(full.body.catalogDigest);
    expect(updated.body.catalogVersion).not.toBe(full.body.catalogVersion);
    expect(updated.body.firewalls[connectorSlug]?.apis[0]?.base).toBe(
      changedBase,
    );
    expect(updated.body.firewalls[providerName]).toStrictEqual(
      full.body.firewalls[providerName],
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeSecondRead);
  });

  it("loads 17 exact connector skill versions in one bounded storage preload", async () => {
    const fixtureSuffix = randomUUID().replaceAll("-", "");
    const skills = Array.from({ length: 17 }, (_, index) => {
      const sequence = String(index + 1).padStart(2, "0");
      const connectorSlug = `batch-skill-${fixtureSuffix}-${sequence}`;
      const selectedVersionId = createHash("sha256")
        .update(`selected:${connectorSlug}`)
        .digest("hex");
      const newerVersionId = createHash("sha256")
        .update(`newer:${connectorSlug}`)
        .digest("hex");
      return {
        connectorSlug,
        selectedVersionId,
        newerVersionId,
        skill: buildBundledSkillFixture(connectorSlug, selectedVersionId),
      };
    });
    configureSource();
    await claimOwnedVolumeStorages(
      skills.map((skill) => {
        return { orgId: SYSTEM_ORG_ID, ...skill.skill };
      }),
    );

    const firstSkill = skills[0];
    if (!firstSkill) {
      throw new Error("Expected connector skill fixtures");
    }
    const release = buildRelease({
      version: `2026-07-15.external-batch-skills-${fixtureSuffix}`,
      connectorSlug: firstSkill.connectorSlug,
      label: "External Batch Skill 01",
      mutateArtifact: (artifact) => {
        const template = firstRecord(artifact.connectors, "connectors");
        const iconKey = recordValue(template.icon, "connector icon").key;
        if (typeof iconKey !== "string") {
          throw new Error("Expected connector icon key");
        }
        artifact.connectors = skills.map((skill, index) => {
          const sequence = String(index + 1).padStart(2, "0");
          const connector = buildCatalogConnector({
            connectorSlug: skill.connectorSlug,
            label: `External Batch Skill ${sequence}`,
            iconKey,
          });
          const presentation = publicAuthMethod({
            id: "api-token",
            grantKind: "manual",
            manual: true,
          });
          presentation.label = "API Token";
          const privateName = `BATCH_SKILL_${sequence}_TOKEN`;
          connector.authMethods = [
            canonicalAuthMethod(presentation, {
              id: "api-token",
              storage: {
                version: 1,
                secrets: [privateName],
                variables: [],
              },
              grant: {
                kind: "manual",
                fields: [
                  {
                    privateName,
                    publicId: "credential",
                    storage: "secret",
                  },
                ],
              },
              access: {
                kind: "static",
                envBindings: {
                  [privateName]: `$secrets.${privateName}`,
                },
              },
              revoke: { kind: "none" },
            }),
          ];
          connector.skill = skill.skill.descriptor;
          return connector;
        });
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped test actor");
    }
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "External batch connector skill agent",
      visibility: "private",
    });
    const activeRunIds = new Set<string>();
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      for (const runId of activeRunIds) {
        await runs.requestCancelRun(actor, runId, [200, 404]);
      }
      for (const skill of skills) {
        await systemStorageStateAction({
          action: "cleanup",
          object_key_prefix: skill.skill.s3Prefix,
        });
        await createConnectorCleanup(actor, skill.connectorSlug)();
      }
      await cleanupOwnedVolumeStorages(
        skills.map((skill) => {
          return skill.skill.storageId;
        }),
      );
      await bdd.deleteAgent(actor, agent.agentId);
    });

    for (const [index, skill] of skills.entries()) {
      await connectorsApi.connectManualGrant(
        actor,
        skill.connectorSlug,
        "api-token",
        { credential: `batch-skill-secret-${index + 1}` },
        agent.agentId,
      );
    }

    const createAndClaimRun = async (prompt: string) => {
      const run = await runs.createRun(actor, {
        agentId: agent.agentId,
        prompt,
        modelProvider: "anthropic-api-key",
      });
      activeRunIds.add(run.runId);
      expect(run.status).not.toBe("failed");
      await runs.heartbeatRunner(runnerGroup);
      await expect
        .poll(
          async () => {
            return (await runs.pollRunner(runnerGroup)).body.job?.runId;
          },
          { timeout: 10_000 },
        )
        .toBe(run.runId);
      return {
        run,
        claim: await runs.claimRunnerJob(run.runId),
      };
    };
    const expectSkillMounts = (
      claim: Awaited<ReturnType<typeof runs.claimRunnerJob>>,
    ): void => {
      const storageMounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return skills.some((skill) => {
            return mount.name === skill.skill.storageName;
          });
        }) ?? [];
      expect(storageMounts).toHaveLength(skills.length);
      for (const skill of skills) {
        expect(storageMounts).toContainEqual(
          expect.objectContaining({
            name: skill.skill.storageName,
            mountPath: `/home/user/.claude/skills/${skill.connectorSlug}`,
            versionId: skill.selectedVersionId,
            archiveSize: 321,
            archiveUrl: expect.any(String),
          }),
        );
      }
    };

    const headRun = await createAndClaimRun(
      "Use all connector skills at their registered HEAD versions",
    );
    expectSkillMounts(headRun.claim);
    await runs.requestCancelRun(actor, headRun.run.runId, [200]);
    activeRunIds.delete(headRun.run.runId);

    for (const skill of skills) {
      await seedOwnedVolumeStorageVersion({
        storageId: skill.skill.storageId,
        versionId: skill.newerVersionId,
        s3Key: `${skill.skill.s3Prefix}/${skill.newerVersionId}`,
      });
    }

    const historicalRun = await createAndClaimRun(
      "Use all connector skills after their storage HEADs advance",
    );
    expectSkillMounts(historicalRun.claim);
    await runs.requestCancelRun(actor, historicalRun.run.runId, [200]);
    activeRunIds.delete(historicalRun.run.runId);
  }, 30_000);

  it("mounts an external connector skill from its exact system version", async () => {
    const connectorSlug = `external-skill-${randomUUID().slice(0, 8)}`;
    const selectedVersionId = createHash("sha256")
      .update(`selected:${randomUUID()}`)
      .digest("hex");
    const otherVersionId = createHash("sha256")
      .update(`other:${randomUUID()}`)
      .digest("hex");
    const newerVersionId = createHash("sha256")
      .update(`newer:${randomUUID()}`)
      .digest("hex");
    const skill = buildBundledSkillFixture(connectorSlug, selectedVersionId);
    const { storageName, s3Prefix: canonicalPrefix } = skill;
    configureSource();
    await claimOwnedVolumeStorage({ orgId: SYSTEM_ORG_ID, ...skill });
    const release = buildRelease({
      version: "2026-07-15.external-exact-skill",
      connectorSlug,
      label: "External Exact Skill",
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill = skill.descriptor;
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const runs = createRunsApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped test actor");
    }
    const runtimeOrgId = actor.orgId;
    const runtimeStorage = createOwnedVolumeStorageFixture(
      storageName,
      canonicalPrefix,
    );
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "External exact connector skill agent",
      visibility: "private",
    });
    let successfulRunId: string | undefined;
    const cleanupConnector = createConnectorCleanup(actor, connectorSlug);
    onTestFinished(async () => {
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      if (successfulRunId) {
        await runs.requestCancelRun(actor, successfulRunId, [200, 404]);
      }
      await systemStorageStateAction({
        action: "cleanup",
        object_key_prefix: canonicalPrefix,
      });
      await cleanupOwnedVolumeStorages([
        skill.storageId,
        runtimeStorage.storageId,
      ]);
      await cleanupConnector();
      await bdd.deleteAgent(actor, agent.agentId);
    });
    await connectorsApi.connectManualGrant(
      actor,
      connectorSlug,
      "api-token",
      { credential: "catalog-skill-secret" },
      agent.agentId,
    );

    const createSkillRun = async () => {
      return await runs.createRun(actor, {
        agentId: agent.agentId,
        prompt: "Use the connector skill",
        modelProvider: "anthropic-api-key",
      });
    };
    const expectRegistrationFailure = async () => {
      const failed = await createSkillRun();
      expect(failed).toMatchObject({
        status: "failed",
        error: "Connector skill registration is unavailable",
      });
    };

    await seedOwnedVolumeStorageVersion({
      storageId: skill.storageId,
      versionId: newerVersionId,
      s3Key: `${canonicalPrefix}/${newerVersionId}`,
    });

    const run = await createSkillRun();
    successfulRunId = run.runId;
    expect(run.status).not.toBe("failed");
    await runs.heartbeatRunner(runnerGroup);
    await expect
      .poll(
        async () => {
          return (await runs.pollRunner(runnerGroup)).body.job?.runId;
        },
        { timeout: 10_000 },
      )
      .toBe(run.runId);
    const claim = await runs.claimRunnerJob(run.runId);
    const mountedSkills =
      expectCanonicalStorageManifest(
        claim.storageManifest,
      )?.storageMounts.filter((storage) => {
        return (
          storage.mountPath === `/home/user/.claude/skills/${connectorSlug}`
        );
      }) ?? [];
    expect(mountedSkills).toHaveLength(1);
    expect(mountedSkills[0]).toMatchObject({
      name: storageName,
      mountPath: `/home/user/.claude/skills/${connectorSlug}`,
      versionId: selectedVersionId,
      archiveSize: 321,
      archiveUrl: expect.any(String),
    });
    await runs.requestCancelRun(actor, run.runId, [200]);
    successfulRunId = undefined;

    await cleanupOwnedVolumeStorages([skill.storageId]);
    await claimOwnedVolumeStorage({
      orgId: runtimeOrgId,
      ...runtimeStorage,
    });
    await seedOwnedVolumeStorageVersion({
      storageId: runtimeStorage.storageId,
      versionId: selectedVersionId,
      s3Key: `${canonicalPrefix}/${selectedVersionId}`,
    });
    await expectRegistrationFailure();
    await cleanupOwnedVolumeStorages([runtimeStorage.storageId]);

    await claimOwnedVolumeStorage({ orgId: SYSTEM_ORG_ID, ...skill });
    await seedOwnedVolumeStorageVersion({
      storageId: skill.storageId,
      versionId: otherVersionId,
      s3Key: `${canonicalPrefix}/${otherVersionId}`,
    });
    await expectRegistrationFailure();

    const wrongPrefix = `${SYSTEM_ORG_ID}/volume/wrong-${storageName}`;
    await cleanupOwnedVolumeStorages([skill.storageId]);
    await claimOwnedVolumeStorage({
      orgId: SYSTEM_ORG_ID,
      storageId: skill.storageId,
      storageName,
      s3Prefix: wrongPrefix,
    });
    await seedOwnedVolumeStorageVersion({
      storageId: skill.storageId,
      versionId: selectedVersionId,
      s3Key: `${wrongPrefix}/${selectedVersionId}`,
    });
    await expectRegistrationFailure();

    await cleanupOwnedVolumeStorages([skill.storageId]);
    await claimOwnedVolumeStorage({ orgId: SYSTEM_ORG_ID, ...skill });
    await seedOwnedVolumeStorageVersion({
      storageId: skill.storageId,
      versionId: selectedVersionId,
      s3Key: `${canonicalPrefix}/wrong-${selectedVersionId}`,
    });
    await expectRegistrationFailure();
  }, 30_000);

  it("executes an external device grant with catalog-owned storage", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider({ tokenScope: null });
    configureSource();
    const deviceGrantRelease = (version: string, scopes: readonly string[]) => {
      return buildRelease({
        version,
        connectorSlug: "test-oauth-device",
        label: "Catalog Device OAuth",
        mutateCatalog: (artifact) => {
          const method = publicAuthMethod({
            id: "api",
            grantKind: "device-auth",
          });
          method.startOptions = [
            {
              id: "environment",
              kind: "select",
              label: "Environment",
              required: true,
              defaultValue: null,
              options: [
                { value: "test", label: "Test" },
                { value: "live", label: "Live" },
              ],
            },
          ];
          setArtifactAuthMethods(artifact, [method]);
        },
        mutateRuntime: (artifact) => {
          const method = devicePrivateAuthMethod({
            accessTokenName: "CATALOG_DEVICE_ACCESS_TOKEN",
            clientId: "test-oauth-device-api-client",
            scopes,
          });
          method.id = "api";
          recordValue(method.grant, "device grant").startOptionMappings = [
            { privateName: "mode", publicId: "environment" },
          ];
          setArtifactAuthMethods(artifact, [method]);
        },
      });
    };
    const release = deviceGrantRelease("2026-07-15.external-device-grant", [
      "read",
    ]);
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const cleanupConnector = createConnectorCleanup(actor, "test-oauth-device");
    onTestFinished(async () => {
      await cleanupConnector();
      await connectorsApi.deleteFeatureSwitches(actor);
    });
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const missingOption = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      undefined,
      [400],
    );
    expectApiError(missingOption.body);
    expect(missingOption.body.error.message).toBe(
      "test-oauth-device api device-auth start option environment is required",
    );

    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "api",
      { environment: "live" },
    );
    expect(provider.deviceCodeBodies[0]?.get("mode")).toBe("live");
    expect(provider.deviceCodeBodies[0]?.get("scope")).toBe("read");
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);

    const changedScopes = deviceGrantRelease(
      "2026-07-15.external-device-scope-change",
      ["read", "future_scope"],
    );
    serveObjects(catalogObjects([release, changedScopes], changedScopes));
    await syncCatalog();
    const callsBeforeCompletion = context.mocks.s3.send.mock.calls.length;
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: false,
    });
    const completed = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
    );
    expect(completed.status).toBe("complete");
    if (completed.status !== "complete") {
      throw new Error(
        `Expected completed device grant, got ${completed.status}`,
      );
    }
    expect(completed.connector).toMatchObject({
      slug: "test-oauth-device",
      authMethod: "api",
      oauthScopes: ["read"],
    });
    await expect(
      connectorsApi.readScopeDiff(actor, "test-oauth-device"),
    ).resolves.toStrictEqual({
      addedScopes: ["future_scope"],
      removedScopes: [],
      currentScopes: ["read", "future_scope"],
      storedScopes: ["read"],
    });
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(secrets).toContainEqual(
      expect.objectContaining({
        name: "CATALOG_DEVICE_ACCESS_TOKEN",
        type: "connector",
      }),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeCompletion);
  });

  it("executes an external OpenID grant with catalog-owned storage", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockOptionalEnv("STEAM_WEB_API_KEY", "catalog-steam-api-key");
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-openid-grant",
      connectorSlug: "steam",
      label: "Catalog Steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          steamPrivateAuthMethod({ steamIdName: "CATALOG_STEAM_ID" }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "steam"));
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
    const start = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorOpenIdStartContract,
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
      setupApp({ context, routes: connectorsSlugCallbackRoutes })(
        connectorsSlugCallbackContract,
      ).callback({
        params: { connectorSlug: "steam" },
        headers: {},
        query: steamOpenIdCallbackQuery(start.body.authorizationUrl),
      }),
      [307],
    );
    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      connectorSlug: "steam",
      variableNames: ["CATALOG_STEAM_ID"],
    });
    expect(storageState.connector?.storage_version).toBe(1);
    expect(storageState.variables).toStrictEqual([
      {
        name: "CATALOG_STEAM_ID",
        connector_id: storageState.connector?.id,
      },
    ]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("executes an external-code grant with catalog-owned storage", async () => {
    mockAwsExternalCodeProvider();
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-code-grant",
      connectorSlug: "aws",
      label: "Catalog AWS",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "cli",
          grantKind: "external-code",
        });
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [awsPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    const cleanupConnector = createConnectorCleanup(actor, "aws");
    onTestFinished(async () => {
      await cleanupConnector();
    });
    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const changedScopes = buildRelease({
      version: "2026-07-15.external-code-scope-change",
      connectorSlug: "aws",
      label: "Catalog AWS",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "cli",
          grantKind: "external-code",
        });
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          awsPrivateAuthMethod(["openid", "future_scope"]),
        ]);
      },
    });
    serveObjects(catalogObjects([release, changedScopes], changedScopes));
    await syncCatalog();
    const callsBeforeCompletion = context.mocks.s3.send.mock.calls.length;
    const completed = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: awsVerificationCode(session.authorizationUrl),
    });
    expect(completed.connector).toMatchObject({
      slug: "aws",
      authMethod: "cli",
      externalId: "123456789012",
      oauthScopes: ["openid"],
    });
    await expect(
      connectorsApi.readScopeDiff(actor, "aws"),
    ).resolves.toStrictEqual({
      addedScopes: ["future_scope"],
      removedScopes: [],
      currentScopes: ["openid", "future_scope"],
      storedScopes: ["openid"],
    });
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const secrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(
      secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "CATALOG_AWS_ACCESS_KEY_ID",
        "CATALOG_AWS_LOGIN_DPOP_KEY",
        "CATALOG_AWS_LOGIN_REFRESH_TOKEN",
        "CATALOG_AWS_SECRET_ACCESS_KEY",
        "CATALOG_AWS_SESSION_TOKEN",
      ]),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeCompletion);
  });

  it("rejects new auth-code actions for an authored-hidden external method", async () => {
    mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", undefined);
    mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", undefined);
    configureSource();
    const hidden = publicAuthMethod({
      id: "oauth",
      grantKind: "auth-code",
    });
    hidden.visible = false;
    const release = buildRelease({
      version: "2026-07-15.external-hidden-auth-code",
      connectorSlug: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [hidden]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [slackPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const response = await connectorsApi.requestOauthStart(
      bdd.user(),
      "slack",
      "oauth",
      { statuses: [403] },
    );
    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "slack connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("revokes an external auth-code credential through its selected method", async () => {
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
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-auth-code-revoke",
      connectorSlug: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [slackPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    const actor = bdd.user();
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
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
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
  });

  it("keeps an in-flight provider operation on its selected external snapshot", async () => {
    mockSlackConnectorOAuth();
    configureSource();
    const firstRelease = buildRelease({
      version: "2026-07-15.external-in-flight-first",
      connectorSlug: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          slackPrivateAuthMethod("FIRST_RELEASE_SLACK_TOKEN", 7),
        ]);
      },
    });
    serveObjects(catalogObjects([firstRelease], firstRelease));
    await syncCatalog();

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

    const actor = bdd.user();
    const cleanupConnector = createConnectorCleanup(actor, "slack");
    onTestFinished(async () => {
      providerResume.release();
      await cleanupConnector();
    });
    const firstStart = await connectorsApi.startOauth(actor, "slack", "oauth");
    const firstState = new URL(firstStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!firstState) {
      throw new Error("Expected Slack authorization state");
    }
    const firstCallback = connectorsApi.completeOauthCallback("slack", {
      code: "first-release",
      state: firstState,
    });
    await providerEntered.promise;

    const secondRelease = buildRelease({
      version: "2026-07-15.external-in-flight-second",
      connectorSlug: "slack",
      label: "Catalog Slack",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          slackPrivateAuthMethod("SECOND_RELEASE_SLACK_TOKEN", 8),
        ]);
      },
    });
    serveObjects(catalogObjects([firstRelease, secondRelease], secondRelease));
    await syncCatalog();
    const callsBeforeProviderResume = context.mocks.s3.send.mock.calls.length;
    providerResume.release();
    await firstCallback;

    const firstSecrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(
      firstSecrets.map((secret) => {
        return secret.name;
      }),
    ).toContain("FIRST_RELEASE_SLACK_TOKEN");
    const firstStorageState = await readConnectorCredentialStorageState(
      context,
      {
        orgId: actor.orgId ?? "",
        userId: actor.userId,
        connectorSlug: "slack",
        secretNames: ["FIRST_RELEASE_SLACK_TOKEN"],
      },
    );
    expect(firstStorageState.connector?.storage_version).toBe(7);
    expect(firstStorageState.secrets?.[0]?.connector_id).toBe(
      firstStorageState.connector?.id,
    );

    if (!firstStorageState.connector) {
      throw new Error("Expected first-release Slack connector storage");
    }
    const secondStart = await connectorsApi.startOauth(
      actor,
      "slack",
      "oauth",
      undefined,
      {
        intent: "reconnect",
        connectionId: firstStorageState.connector.id,
      },
    );
    const secondState = new URL(secondStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!secondState) {
      throw new Error("Expected Slack authorization state");
    }
    await connectorsApi.completeOauthCallback("slack", {
      code: "second-release",
      state: secondState,
    });
    const secondSecrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(
      secondSecrets.map((secret) => {
        return secret.name;
      }),
    ).toContain("SECOND_RELEASE_SLACK_TOKEN");
    const secondStorageState = await readConnectorCredentialStorageState(
      context,
      {
        orgId: actor.orgId ?? "",
        userId: actor.userId,
        connectorSlug: "slack",
      },
    );
    expect(secondStorageState.connector?.storage_version).toBe(8);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(
      callsBeforeProviderResume,
    );
  });

  it("does not persist an in-flight refresh after the connector is replaced", async () => {
    mockGmailConnectorOAuth({ email: "refresh-race@example.test" });
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.external-refresh-replacement",
      connectorSlug: "gmail",
      label: "Catalog Gmail",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [gmailPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    mockOptionalEnv(
      "GMAIL_PUBSUB_TOPIC_NAME",
      "projects/vm0-ai-488909/topics/gmail-events",
    );
    server.use(
      http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ connectors: [] }) },
            },
          ],
        });
      }),
    );

    const orgId = createUniqueStaffOrgIdFixture();
    const actor = bdd.user({ orgId });
    const created: { agentId?: string; workflowId?: string } = {};
    const refreshResume = deferredGate();
    const cleanupConnector = createConnectorCleanup(actor, "gmail");
    onTestFinished(async () => {
      refreshResume.release();
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      await cleanupConnector();
      if (created.workflowId) {
        await miscApi.deleteWorkflow(actor, created.workflowId, [204, 404]);
      }
      if (created.agentId) {
        await bdd.deleteAgent(actor, created.agentId);
      }
      await deleteOrgPlanEntitlementFixture(orgId);
    });
    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    const initialOauth = await connectorsApi.startOauth(
      actor,
      "gmail",
      "oauth",
    );
    const initialState = new URL(
      initialOauth.authorizationUrl,
    ).searchParams.get("state");
    if (!initialState) {
      throw new Error("Expected initial Gmail authorization state");
    }
    await connectorsApi.completeOauthCallback("gmail", {
      code: "initial",
      state: initialState,
    });
    const initialConnection = await connectorsApi.readConnectorBySlug(
      actor,
      "gmail",
    );

    mockNow(new Date("2026-07-15T10:00:00.000Z"));
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Refresh replacement agent",
      visibility: "private",
    });
    created.agentId = agent.agentId;
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const workflow = await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsCollectionContract,
      ).create({
        headers,
        body: {
          agentId: agent.agentId,
          name: `refresh-replacement-${randomUUID().slice(0, 8)}`,
          instruction: "Handle incoming Gmail messages.",
        },
      }),
      [201],
    );
    created.workflowId = workflow.body.id;

    const refreshEntered = deferredGate();
    const watchAuthorizations: string[] = [];
    const stopAuthorizations: string[] = [];
    server.use(
      http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        if (body.get("grant_type") === "refresh_token") {
          refreshEntered.release();
          await refreshResume.promise;
          return HttpResponse.json({
            access_token: "stale-refreshed-gmail-token",
            refresh_token: "stale-rotated-gmail-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "https://www.googleapis.com/auth/gmail.modify",
          });
        }
        return HttpResponse.json({
          access_token: "replacement-gmail-token",
          refresh_token: "replacement-gmail-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }),
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        ({ request }) => {
          watchAuthorizations.push(request.headers.get("authorization") ?? "");
          return HttpResponse.json({
            historyId: "100",
            expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
          });
        },
      ),
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/stop",
        ({ request }) => {
          stopAuthorizations.push(request.headers.get("authorization") ?? "");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const firstCreate = accept(
      setupApp({ context, routes: workflowAutomationsRoutes })(
        workflowAutomationsContract,
      ).create({
        headers,
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [400],
    );
    await refreshEntered.promise;

    const replacementOauth = await connectorsApi.startOauth(
      actor,
      "gmail",
      "oauth",
      undefined,
      { intent: "reconnect", connectionId: initialConnection.id },
    );
    const replacementState = new URL(
      replacementOauth.authorizationUrl,
    ).searchParams.get("state");
    if (!replacementState) {
      throw new Error("Expected replacement Gmail authorization state");
    }
    await connectorsApi.completeOauthCallback("gmail", {
      code: "replacement",
      state: replacementState,
    });
    refreshResume.release();

    const rejected = await firstCreate;
    expect(rejected.body.error.message).toBe(
      "Reconnect Gmail before using Gmail event automations",
    );
    await expect(
      connectorsApi.readConnectorBySlug(actor, "gmail"),
    ).resolves.toMatchObject({
      connectionStatus: "connected",
      reconnectReason: null,
    });

    await accept(
      setupApp({ context, routes: workflowAutomationsRoutes })(
        workflowAutomationsContract,
      ).create({
        headers,
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [201],
    );
    expect(watchAuthorizations).toStrictEqual([
      "Bearer replacement-gmail-token",
      "Bearer replacement-gmail-token",
    ]);
    expect(stopAuthorizations).toStrictEqual([
      "Bearer replacement-gmail-token",
    ]);
  });

  it("preserves the authorization-start scope snapshot across catalog updates", async () => {
    mockDatadogConnectorOAuth();
    configureSource();
    const matching = buildRelease({
      version: "2026-07-15.external-connected-status",
      connectorSlug: "datadog",
      label: "Datadog",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "auth-code",
        });
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          datadogPrivateAuthMethod(["dashboards_read", "logs_read_index_data"]),
        ]);
      },
    });
    serveObjects(catalogObjects([matching], matching));
    await syncCatalog();
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: false,
    });
    const cleanupConnector = createConnectorCleanup(actor, "datadog");
    onTestFinished(async () => {
      await cleanupConnector();
      await connectorsApi.deleteFeatureSwitches(actor);
    });
    const start = await connectorsApi.startOauth(actor, "datadog", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Datadog authorization state");
    }
    const changedScopes = buildRelease({
      version: "2026-07-15.external-scope-change",
      connectorSlug: "datadog",
      label: "Datadog",
      mutateCatalog: (artifact) => {
        const method = publicAuthMethod({
          id: "oauth",
          grantKind: "auth-code",
        });
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          datadogPrivateAuthMethod([
            "dashboards_read",
            "logs_read_index_data",
            "future_scope",
          ]),
        ]);
      },
    });
    serveObjects(catalogObjects([matching, changedScopes], changedScopes));
    await syncCatalog();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: false,
    });
    const callback = await connectorsApi.completeOauthCallback("datadog", {
      code: "external-catalog-status",
      state,
      domain: "us3.datadoghq.com",
    });
    const callbackLocation = callback.headers.get("location");
    expect(callbackLocation).not.toBeNull();
    expect(
      new URL(callbackLocation ?? "https://invalid.example").pathname,
    ).toBe("/connector/success");
    const hiddenConnectedList = await connectorsApi.listConnectors(actor);
    expect(hiddenConnectedList.connectors).toContainEqual(
      expect.objectContaining({ slug: "datadog", authMethod: "oauth" }),
    );
    expect(hiddenConnectedList.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "datadog",
        authMethod: "oauth",
        name: "DATADOG_TOKEN",
      }),
    );
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: true,
    });

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const mismatched = await accept(catalogClient.status({ headers }), [200]);
    expect(mismatched.body.connectors[0]).toMatchObject({
      slug: "datadog",
      connected: true,
      connectionStatus: "scope-mismatch",
      scopeMismatch: true,
      authMethodSupportsRefresh: true,
      tokenExpiresAt: expect.any(String),
      singleAuthCodeAuthMethodId: "oauth",
      connection: {
        authMethod: "oauth",
        externalUsername: "us3.datadoghq.com",
        externalEmail: null,
        reconnectReason: null,
      },
    });
    expect(mismatched.body.connectors[0]?.connection).not.toHaveProperty(
      "oauthScopes",
    );
    await expect(
      connectorsApi.readScopeDiff(actor, "datadog"),
    ).resolves.toStrictEqual({
      addedScopes: ["future_scope"],
      removedScopes: [],
      currentScopes: [
        "dashboards_read",
        "logs_read_index_data",
        "future_scope",
      ],
      storedScopes: ["dashboards_read", "logs_read_index_data"],
    });
  });

  it("preserves the GitHub app setup scope snapshot across catalog updates", async () => {
    configureSource();
    const requestedScopes = ["repo", "project", "workflow"];
    const matching = buildRelease({
      version: "2026-07-15.github-app-setup-start",
      connectorSlug: "github",
      label: "GitHub",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          githubPrivateAuthMethod(requestedScopes),
        ]);
      },
    });
    const changedScopes = buildRelease({
      version: "2026-07-15.github-app-setup-scope-change",
      connectorSlug: "github",
      label: "GitHub",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          githubPrivateAuthMethod([...requestedScopes, "future_scope"]),
        ]);
      },
    });
    serveObjects(catalogObjects([matching], matching));
    await syncCatalog();

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "GitHub setup scope snapshot",
    });
    const installed = await githubApi.installGithubApp(actor, agent.agentId, {
      oauthCode: {
        code: `github-scope-snapshot-${randomUUID()}`,
        githubUserId: newGithubUserId(),
      },
      beforeCallback: async () => {
        serveObjects(catalogObjects([matching, changedScopes], changedScopes));
        await syncCatalog();
      },
    });

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const status = await accept(
      catalogClient.status({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.connectors[0]).toMatchObject({
      slug: "github",
      connected: true,
      connectionStatus: "scope-mismatch",
      scopeMismatch: true,
    });
    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual({
      addedScopes: ["future_scope"],
      removedScopes: [],
      currentScopes: [...requestedScopes, "future_scope"],
      storedScopes: requestedScopes,
    });

    const parsedState: unknown = JSON.parse(installed.state);
    if (!isJsonRecord(parsedState)) {
      throw new Error("Expected GitHub app setup state to be an object");
    }
    const tampered = await githubApi.requestSetupCallback(
      new URLSearchParams({
        installation_id: installed.remoteInstallationId,
        setup_action: "install",
        state: JSON.stringify({
          ...parsedState,
          oauthRequestedScopes: [...requestedScopes, "tampered_scope"],
        }),
      }).toString(),
    );
    expect(tampered.location).toContain("Invalid%20state%20signature");
  });

  it("fails closed without accepted catalog state", async () => {
    configureSource();
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const callsBeforeRead = context.mocks.s3.send.mock.calls.length;
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const headers = { authorization: "Bearer clerk-session" };

    const catalogResponse = await accept(
      catalogClient.list({ headers }),
      [503],
    );
    const catalogStatusResponse = await accept(
      catalogClient.status({ headers }),
      [503],
    );
    const searchResponse = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsSearchContract,
      ).search({
        headers,
        query: {},
      }),
      [503],
    );
    const expectedError = {
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Connector catalog is temporarily unavailable",
      },
    };
    expect(catalogResponse.body).toStrictEqual(expectedError);
    expect(catalogStatusResponse.body).toStrictEqual(expectedError);
    expect(searchResponse.body).toStrictEqual(expectedError);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeRead);
  });

  it("accepts a complete generated firewall projection", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.generated-firewall",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
  });

  it("merges duplicate dynamic firewall execution templates", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.duplicate-dynamic-firewall-base",
      connectorSlug: "dynamic-firewall",
      label: "Dynamic Firewall",
      generatedFirewall: true,
      mutateRuntime: addDynamicFirewallVariableBinding,
      mutateFirewall: addDuplicateDynamicPrivateFirewallApi,
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const diagnostic = await accept(
      setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      ).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "url",
          method: "GET",
          url: "https://tenant.example.test/v1/items",
          connectorSlug: "dynamic-firewall",
        },
      }),
      [200],
    );
    expect(diagnostic.body).toMatchObject({
      outcome: "resolved",
      connector: {
        connectorSlug: "dynamic-firewall",
        label: "Dynamic Firewall",
      },
      permission: {
        kind: "matched",
        permissions: [{ name: "items.read" }],
      },
    });
  });

  it("accepts canonical firewall bases with authority parameters", async () => {
    configureSource();
    const base = "https://{awsHost+}.amazonaws.com";
    const release = buildRelease({
      version: "2026-07-15.parameterized-firewall",
      generatedFirewall: true,
      mutateFirewall: (artifact) => {
        setFirewallBase(artifact, base);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts a complete bundled skill descriptor", async () => {
    configureSource();
    const resolvedStorageName = `connector-skill@resolved-${randomUUID().replaceAll("-", "")}`;
    const storage = createOwnedVolumeStorageFixture(resolvedStorageName);
    const skill = buildBundledSkillFixture(
      "external-test",
      createHash("sha256").update(randomUUID()).digest("hex"),
      storage,
    );
    await claimOwnedVolumeStorage({ orgId: SYSTEM_ORG_ID, ...skill });
    onTestFinished(async () => {
      await cleanupOwnedVolumeStorages([skill.storageId]);
    });
    const release = buildRelease({
      version: "2026-07-15.bundled-skill",
      mutateRuntime: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        connector.skill = skill.descriptor;
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
    await expect(
      readOwnedVolumeStorageState(skill.storageId),
    ).resolves.toStrictEqual({
      s3_prefix: skill.s3Prefix,
      size: skill.contentSize,
      file_count: 1,
      head_version_id: skill.versionId,
    });
    const requestedKeys = context.mocks.s3.send.mock.calls.map((call) => {
      const input = commandInput(call[0]);
      return typeof input.Key === "string" ? input.Key : null;
    });
    expect(requestedKeys).not.toContain(skill.manifestKey);
    expect(requestedKeys).not.toContain(skill.archiveKey);
  });

  it("rejects incomplete or out-of-range bundled skill metadata", async () => {
    const cases = [
      {
        field: "size",
        label: "missing-size",
        value: undefined,
      },
      {
        field: "archiveSize",
        label: "oversized-archive",
        value: 2 * 1024 * 1024 + 1,
      },
      {
        field: "fileCount",
        label: "empty-manifest",
        value: 0,
      },
    ] as const;

    for (const testCase of cases) {
      configureSource();
      const connectorSlug = `skill-${testCase.label}-${randomUUID().slice(0, 8)}`;
      const skill = buildBundledSkillFixture(
        connectorSlug,
        createHash("sha256")
          .update(`${testCase.label}:${randomUUID()}`)
          .digest("hex"),
      );
      const release = buildRelease({
        version: `2026-07-22.skill-${testCase.label}-${randomUUID().slice(0, 8)}`,
        connectorSlug,
        mutateRuntime: (artifact) => {
          const descriptor = structuredClone(skill.descriptor);
          if (testCase.value === undefined) {
            delete descriptor[testCase.field];
          } else {
            descriptor[testCase.field] = testCase.value;
          }
          firstRecord(artifact.connectors, "connectors").skill = descriptor;
        },
      });
      serveObjects(catalogObjects([release], release));

      const response = await syncCatalog();
      expect(response.body).toMatchObject({
        outcome: "rejected",
        state: "never-synced",
        active: null,
        lastAttempt: { failureCode: "invalid-artifact" },
      });
      await expect(
        readVolumeStorageState({
          orgId: SYSTEM_ORG_ID,
          storageName: skill.storageName,
        }),
      ).resolves.toBeNull();
    }
  });

  it("reuses immutable skill versions without regressing HEAD", async () => {
    configureSource();
    const connectorSlug = `skill-cache-${randomUUID().slice(0, 8)}`;
    const storage = createBundledSkillStorageFixture(connectorSlug);
    const firstSkill = buildBundledSkillFixture(
      connectorSlug,
      createHash("sha256").update(`first:${randomUUID()}`).digest("hex"),
      storage,
    );
    const secondSkill = buildBundledSkillFixture(
      connectorSlug,
      createHash("sha256").update(`second:${randomUUID()}`).digest("hex"),
      storage,
    );
    await claimOwnedVolumeStorage({ orgId: SYSTEM_ORG_ID, ...storage });
    onTestFinished(async () => {
      await cleanupOwnedVolumeStorages([storage.storageId]);
    });
    const firstRelease = buildRelease({
      version: `2026-07-22.skill-cache-first-${randomUUID().slice(0, 8)}`,
      connectorSlug,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill =
          firstSkill.descriptor;
      },
    });
    const secondRelease = buildRelease({
      version: `2026-07-22.skill-cache-second-${randomUUID().slice(0, 8)}`,
      connectorSlug,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill =
          secondSkill.descriptor;
      },
    });
    const oldRetryRelease = buildRelease({
      version: `2026-07-22.skill-cache-old-${randomUUID().slice(0, 8)}`,
      connectorSlug,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill =
          firstSkill.descriptor;
      },
    });

    serveObjects(catalogObjects([firstRelease], firstRelease));
    expect((await syncCatalog()).body.outcome).toBe("accepted");

    serveObjects(catalogObjects([firstRelease, secondRelease], secondRelease));
    expect((await syncCatalog()).body.outcome).toBe("accepted");

    context.mocks.s3.send.mockClear();
    serveObjects(
      catalogObjects(
        [firstRelease, secondRelease, oldRetryRelease],
        oldRetryRelease,
      ),
    );
    expect((await syncCatalog()).body.outcome).toBe("accepted");
    const requestedKeys = context.mocks.s3.send.mock.calls.map((call) => {
      const input = commandInput(call[0]);
      return typeof input.Key === "string" ? input.Key : null;
    });
    expect(requestedKeys).not.toContain(firstSkill.manifestKey);
    expect(requestedKeys).not.toContain(firstSkill.archiveKey);
    await expect(
      readOwnedVolumeStorageState(storage.storageId),
    ).resolves.toMatchObject({
      head_version_id: secondSkill.versionId,
    });
  });

  it("rolls back all skill registrations and retries a repaired conflict", async () => {
    configureSource();
    const suffix = randomUUID().slice(0, 8);
    const firstConnectorSlug = `skill-atomic-a-${suffix}`;
    const conflictingConnectorSlug = `skill-atomic-b-${suffix}`;
    const firstSkill = buildBundledSkillFixture(
      firstConnectorSlug,
      createHash("sha256").update(`first:${randomUUID()}`).digest("hex"),
    );
    const conflictingSkill = buildBundledSkillFixture(
      conflictingConnectorSlug,
      createHash("sha256").update(`conflict:${randomUUID()}`).digest("hex"),
    );
    const wrongPrefix = `${SYSTEM_ORG_ID}/volume/wrong-${conflictingSkill.storageName}`;
    await claimOwnedVolumeStorages([
      { orgId: SYSTEM_ORG_ID, ...firstSkill },
      {
        orgId: SYSTEM_ORG_ID,
        ...conflictingSkill,
        s3Prefix: wrongPrefix,
      },
    ]);
    onTestFinished(async () => {
      await cleanupOwnedVolumeStorages([
        firstSkill.storageId,
        conflictingSkill.storageId,
      ]);
    });
    const existingVersionId = createHash("sha256")
      .update(`existing:${randomUUID()}`)
      .digest("hex");
    await seedOwnedVolumeStorageVersion({
      storageId: conflictingSkill.storageId,
      versionId: existingVersionId,
      s3Key: `${wrongPrefix}/${existingVersionId}`,
    });
    const conflictingIconBytes = Buffer.from(
      `<svg>${conflictingConnectorSlug}</svg>`,
    );
    const conflictingIconDigest = digest(conflictingIconBytes);
    const release = buildRelease({
      version: `2026-07-22.skill-conflict-${randomUUID().slice(0, 8)}`,
      connectorSlug: firstConnectorSlug,
      mutateCatalog: (artifact) => {
        arrayValue(artifact.connectors, "connectors").push(
          buildCatalogConnector({
            connectorSlug: conflictingConnectorSlug,
            label: "Conflicting Skill",
            iconKey:
              "platform/views/zero-page/components/settings/icons/" +
              `${conflictingConnectorSlug}-${conflictingIconDigest.slice("sha256:".length, 19)}.svg`,
          }),
        );
      },
      mutateRuntime: (artifact) => {
        const connectors = arrayValue(artifact.connectors, "connectors");
        firstRecord(connectors, "connectors").skill = firstSkill.descriptor;
        const conflictingConnector = recordValue(
          connectors[1],
          "connectors[1]",
        );
        const conflictingPrivateName = "ATOMIC_SKILL_B_TOKEN";
        const conflictingMethod = firstRecord(
          conflictingConnector.authMethods,
          "authMethods",
        );
        recordValue(conflictingMethod.storage, "storage").secrets = [
          conflictingPrivateName,
        ];
        firstRecord(
          recordValue(conflictingMethod.grant, "grant").fields,
          "grant.fields",
        ).privateName = conflictingPrivateName;
        recordValue(
          recordValue(conflictingMethod.access, "access").envBindings,
          "envBindings",
        ).SERVICE_TOKEN = `$secrets.${conflictingPrivateName}`;
        conflictingConnector.skill = conflictingSkill.descriptor;
      },
    });
    const objects = catalogObjects([release], release);
    serveObjects(objects);

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      active: null,
      lastAttempt: { failureCode: "invalid-reference" },
    });
    await expect(
      readOwnedVolumeStorageState(firstSkill.storageId),
    ).resolves.toStrictEqual({
      s3_prefix: firstSkill.s3Prefix,
      size: 0,
      file_count: 0,
      head_version_id: null,
    });
    await expect(
      readVolumeStorageVersion({
        orgId: SYSTEM_ORG_ID,
        storageName: firstSkill.storageName,
        versionId: firstSkill.versionId,
      }),
    ).resolves.toBeNull();
    await expect(
      readOwnedVolumeStorageState(conflictingSkill.storageId),
    ).resolves.toStrictEqual({
      s3_prefix: wrongPrefix,
      size: 1,
      file_count: 1,
      head_version_id: existingVersionId,
    });

    await cleanupOwnedVolumeStorages([conflictingSkill.storageId]);
    await claimOwnedVolumeStorage({
      orgId: SYSTEM_ORG_ID,
      ...conflictingSkill,
    });
    serveObjects(objects);
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
    for (const skill of [firstSkill, conflictingSkill]) {
      await expect(
        readOwnedVolumeStorageState(skill.storageId),
      ).resolves.toMatchObject({
        s3_prefix: skill.s3Prefix,
        head_version_id: skill.versionId,
      });
    }
  });

  it("rejects a connector skill version owned by another storage", async () => {
    configureSource();
    const connectorSlug = `skill-owner-${randomUUID().slice(0, 8)}`;
    const skill = buildBundledSkillFixture(
      connectorSlug,
      createHash("sha256").update(`shared:${randomUUID()}`).digest("hex"),
    );
    const ownerStorageName = `connector-skill@owner-${randomUUID().replaceAll("-", "")}`;
    const ownerPrefix = `${SYSTEM_ORG_ID}/volume/${ownerStorageName}`;
    const ownerStorage = createOwnedVolumeStorageFixture(
      ownerStorageName,
      ownerPrefix,
    );
    await claimOwnedVolumeStorage({
      orgId: SYSTEM_ORG_ID,
      ...ownerStorage,
    });
    onTestFinished(async () => {
      await cleanupOwnedVolumeStorages([ownerStorage.storageId]);
    });
    await seedOwnedVolumeStorageVersion({
      storageId: ownerStorage.storageId,
      versionId: skill.versionId,
      s3Key: `${ownerPrefix}/${skill.versionId}`,
    });
    const release = buildRelease({
      version: `2026-07-22.skill-owner-${randomUUID().slice(0, 8)}`,
      connectorSlug,
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill = skill.descriptor;
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      active: null,
      lastAttempt: { failureCode: "invalid-reference" },
    });
    await expect(
      readVolumeStorageState({
        orgId: SYSTEM_ORG_ID,
        storageName: skill.storageName,
      }),
    ).resolves.toBeNull();
    const requestedKeys = context.mocks.s3.send.mock.calls.map((call) => {
      const input = commandInput(call[0]);
      return typeof input.Key === "string" ? input.Key : null;
    });
    expect(requestedKeys).not.toContain(skill.manifestKey);
    expect(requestedKeys).not.toContain(skill.archiveKey);
  });

  it.each(["storage name", "version ID"] as const)(
    "rejects bundled skills sharing one %s across connectors",
    async (sharedIdentity) => {
      configureSource();
      const suffix = randomUUID().slice(0, 8);
      const firstConnectorSlug = `skill-identity-a-${suffix}`;
      const secondConnectorSlug = `skill-identity-b-${suffix}`;
      const firstSkill = buildBundledSkillFixture(
        firstConnectorSlug,
        createHash("sha256").update(`first:${randomUUID()}`).digest("hex"),
      );
      const secondSkill = buildBundledSkillFixture(
        secondConnectorSlug,
        createHash("sha256").update(`second:${randomUUID()}`).digest("hex"),
      );
      const secondDescriptor = structuredClone(secondSkill.descriptor);
      if (sharedIdentity === "storage name") {
        secondDescriptor.storageName = firstSkill.storageName;
        secondDescriptor.storageVersionPrefix =
          `__system__/volume/${firstSkill.storageName}/` +
          `${secondSkill.versionId}`;
      } else {
        secondDescriptor.versionId = firstSkill.versionId;
        secondDescriptor.storageVersionPrefix =
          `__system__/volume/${secondSkill.storageName}/` +
          `${firstSkill.versionId}`;
      }
      const release = buildRelease({
        version:
          `2026-07-23.skill-identity-` +
          `${sharedIdentity === "storage name" ? "storage-name" : "version-id"}-${suffix}`,
        connectorSlug: firstConnectorSlug,
        mutateRuntime: (artifact) => {
          const connectors = arrayValue(artifact.connectors, "connectors");
          const first = firstRecord(connectors, "connectors");
          first.skill = firstSkill.descriptor;

          const second = structuredClone(first);
          second.slug = secondConnectorSlug;
          second.label = "Second Skill Identity";
          const secondMethod = firstRecord(second.authMethods, "authMethods");
          recordValue(secondMethod.storage, "storage").secrets = [
            "SECOND_SKILL_IDENTITY_TOKEN",
          ];
          firstRecord(
            recordValue(secondMethod.grant, "grant").fields,
            "grant.fields",
          ).privateName = "SECOND_SKILL_IDENTITY_TOKEN";
          recordValue(
            recordValue(secondMethod.access, "access").envBindings,
            "envBindings",
          ).SERVICE_TOKEN = "$secrets.SECOND_SKILL_IDENTITY_TOKEN";
          second.skill = secondDescriptor;
          connectors.push(second);
        },
      });
      serveObjects(catalogObjects([release], release));

      expect((await syncCatalog()).body).toMatchObject({
        outcome: "rejected",
        state: "never-synced",
        active: null,
        lastAttempt: { failureCode: "relationship-mismatch" },
      });
    },
  );

  it("accepts source identities and platform requirements without local support", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-15.future-capability",
      mutateCatalog: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        firstRecord(connector.authMethods, "authMethods").id =
          "service-account";
      },
      mutateRuntime: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        const method = firstRecord(connector.authMethods, "authMethods");
        method.id = "service-account";
        const access = recordValue(method.access, "access");
        access.platformSecrets = ["FUTURE_PLATFORM_KEY"];
        recordValue(access.envBindings, "envBindings").PLATFORM_KEY =
          "$secrets.FUTURE_PLATFORM_KEY";
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: release.version },
    });
    const response = await accept(
      runnerFirewallClient().resolve({
        headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
        body: {},
      }),
      [200],
    );
    expect(response.body.firewalls).not.toHaveProperty(release.connectorSlug);
  });

  it("serializes overlapping syncs without a mixed snapshot", async () => {
    configureSource();
    const release = buildRelease({ version: "2026-07-15.concurrent" });
    serveObjects(catalogObjects([release], release));
    const results = await Promise.all([syncCatalog(), syncCatalog()]);
    expect(
      results
        .map((result) => {
          return result.body.outcome;
        })
        .sort(),
    ).toStrictEqual(["accepted", "unchanged"]);
    expect((await readStatus()).body).toMatchObject({
      state: "current",
      active: { catalogVersion: release.version },
    });
  });

  it("rolls back a candidate snapshot when its state compare-and-swap loses", async () => {
    configureSource();
    const losing = buildRelease({
      version: "2026-07-15.losing",
      label: "Losing Candidate",
    });
    const winning = buildRelease({
      version: "2026-07-15.winning",
      label: "Winning Candidate",
    });
    const replacement = buildRelease({
      version: losing.version,
      label: "Replacement Candidate",
    });
    const objects = catalogObjects([losing, winning], winning);
    const losingPublicKey = releaseKeys(losing.version).catalog;
    const blocked = deferredGate();
    const resume = deferredGate();
    const activePointers = [losing.pointer, winning.pointer, winning.pointer];
    let activeReads = 0;
    let blockedLosingPublic = false;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const key = commandInput(command).Key;
      if (key === losingPublicKey && !blockedLosingPublic) {
        blockedLosingPublic = true;
        blocked.release();
        await resume.promise;
      }
      const bytes =
        key === ACTIVE_KEY
          ? activePointers[activeReads++]
          : typeof key === "string"
            ? objects.get(key)
            : undefined;
      if (!bytes) {
        throw new Error("Object unavailable");
      }
      return {
        ContentLength: bytes.length,
        Body: s3Body(bytes),
      };
    });

    const losingSync = syncCatalog();
    await blocked.promise;
    const settledWinningResult = await settle(syncCatalog(), context.signal);
    resume.release();
    if (!settledWinningResult.ok) {
      throw settledWinningResult.error;
    }
    const winningResult = settledWinningResult.value;
    const losingResult = await losingSync;
    expect(winningResult.body.outcome).toBe("accepted");
    expect(losingResult.body.outcome).toBe("unchanged");

    serveObjects(catalogObjects([replacement], replacement));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: replacement.version },
    });
  });

  it("advances on the next sync when active changes during validation", async () => {
    configureSource();
    const observed = buildRelease({ version: "2026-07-15.observed" });
    const current = buildRelease({ version: "2026-07-15.current" });
    const objects = catalogObjects([observed, current], current);
    let activePointer = observed.pointer;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const key = commandInput(command).Key;
      if (key === observed.catalogKey) {
        activePointer = current.pointer;
      }
      const bytes =
        key === ACTIVE_KEY
          ? activePointer
          : typeof key === "string"
            ? objects.get(key)
            : undefined;
      if (!bytes) {
        return Promise.reject(new Error("Object unavailable"));
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: s3Body(bytes),
      });
    });

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: observed.version },
    });
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: current.version },
    });
  });
});

describe("connector catalog executable compatibility", () => {
  it("writes a deterministic empty compatibility evaluation", async () => {
    configureSource();
    mockApiTestConnectorProviderConfiguration();
    const release = buildRelease({
      version: "2026-07-31.empty-evaluation",
    });
    serveObjects(catalogObjects([release], release));

    const synced = await syncCatalog();
    const evaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();
    expect(evaluations).toHaveLength(1);
    const [evaluation] = evaluations;

    expect(evaluation?.capabilityDigest).toBe(EXPECTED_CAPABILITY_DIGEST);
    expect(synced.body.filtering).toStrictEqual({
      capabilityDigest: EXPECTED_CAPABILITY_DIGEST,
      evaluatedAt: FIRST_SYNC_TIME,
      stale: false,
      filteredAuthMethods: [],
    });
    expect(evaluation?.payload).toStrictEqual({ filteredAuthMethods: [] });

    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const headers = { authorization: "Bearer clerk-session" };
    const client = diagnosticsClient();
    await accept(client.list({ headers }), [200]);
    await accept(client.status({ headers }), [200]);
    await accept(
      client.get({
        headers,
        params: { connectorSlug: release.connectorSlug },
      }),
      [200],
    );
  });

  it("persists canonical non-empty filtering", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-31.filtered-evaluation",
      connectorSlug: "future-auth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "device-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [devicePrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));

    const synced = await syncCatalog();
    const evaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();
    expect(evaluations).toHaveLength(1);
    const [evaluation] = evaluations;
    const wireMethods = synced.body.filtering.filteredAuthMethods;
    const expectedMethods = wireMethods.map((method) => {
      return {
        connectorSlug: method.connectorSlug,
        authMethodId: method.authMethodId,
        reasons: method.reasons,
      };
    });

    expect(evaluation?.payload).toStrictEqual({
      filteredAuthMethods: expectedMethods,
    });
    expect(wireMethods).toStrictEqual(expectedMethods);
  });

  it("derives and reconciles a missing compatibility evaluation", async () => {
    configureSource();
    mockApiTestConnectorProviderConfiguration();
    const release = buildRelease({
      version: "2026-07-31.missing-canonical-evaluation",
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();

    await deleteApiTestConnectorCatalogCompatibilityEvaluation(
      EXPECTED_CAPABILITY_DIGEST,
    );
    await expect(
      readApiTestConnectorCatalogCompatibilityEvaluations(),
    ).resolves.toHaveLength(0);

    const stale = await readStatus();
    expect(stale.body.filtering).toStrictEqual({
      capabilityDigest: EXPECTED_CAPABILITY_DIGEST,
      evaluatedAt: null,
      stale: true,
      filteredAuthMethods: [],
    });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const beforeReconciliation = await accept(
      catalogClient.list({ headers }),
      [200],
    );
    expect(beforeReconciliation.body).toMatchObject({
      connectors: [expect.objectContaining({ slug: release.connectorSlug })],
    });
    await expect(
      readApiTestConnectorCatalogCompatibilityEvaluations(),
    ).resolves.toHaveLength(0);

    mockNow(new Date("2026-07-31T08:01:00.000Z"));
    const reconciled = await syncCatalog();
    const evaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();

    expect(reconciled.body.outcome).toBe("unchanged");
    expect(reconciled.body.filtering.capabilityDigest).toBe(
      EXPECTED_CAPABILITY_DIGEST,
    );
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.payload).toStrictEqual({
      filteredAuthMethods: [],
    });
    expect(
      (await accept(catalogClient.list({ headers }), [200])).body,
    ).toMatchObject({
      connectors: [expect.objectContaining({ slug: release.connectorSlug })],
    });
  });

  it("replaces the compatibility evaluation with a new catalog", async () => {
    configureSource();
    const first = buildRelease({
      version: "2026-07-31.replacement-1",
    });
    serveObjects(catalogObjects([first], first));
    await syncCatalog();
    const firstEvaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();
    expect(firstEvaluations).toHaveLength(1);
    const firstCatalogDigest = firstEvaluations[0]?.catalogDigest;
    if (firstCatalogDigest === undefined) {
      throw new Error("Expected initial compatibility evaluations");
    }

    const second = buildRelease({
      version: "2026-07-31.replacement-2",
    });
    serveObjects(catalogObjects([first, second], second));
    const replaced = await syncCatalog();
    const replacementEvaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();

    expect(replacementEvaluations).toHaveLength(1);
    expect(
      replacementEvaluations.every((evaluation) => {
        return evaluation.catalogDigest === replaced.body.active?.catalogDigest;
      }),
    ).toBeTruthy();
    expect(
      replacementEvaluations.some((evaluation) => {
        return evaluation.catalogDigest === firstCatalogDigest;
      }),
    ).toBeFalsy();
    expect(replacementEvaluations[0]?.payload).toStrictEqual({
      filteredAuthMethods: [],
    });
  });

  it("repairs missing and preserves newer validator package authorities", async () => {
    configureSource();
    const release = buildRelease({
      version: "2026-07-27.validation-authority-repair",
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    const currentAuthority = apiTestConnectorCatalogValidationAuthority();
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual(currentAuthority);

    await setApiTestConnectorCatalogValidationAuthority(null);
    mockNow(new Date("2026-07-27T08:01:00.000Z"));
    expect((await syncCatalog()).body.outcome).toBe("unchanged");
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual(currentAuthority);

    const newerAuthority = {
      ...currentAuthority,
      validatorVersion: "999999.0.0",
    };
    await setApiTestConnectorCatalogValidationAuthority(newerAuthority);
    mockNow(new Date("2026-07-27T08:02:00.000Z"));
    expect((await syncCatalog()).body.outcome).toBe("unchanged");
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual(newerAuthority);
  });

  it("preserves accepted authority across an API-only release", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const release = buildRelease({
      version: "2026-07-27.validation-backend-release",
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    const currentAuthority = apiTestConnectorCatalogValidationAuthority();
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual(currentAuthority);

    setApiVersion("1.319.0");
    mockNow(new Date("2026-07-27T08:01:00.000Z"));
    expect((await syncCatalog()).body.outcome).toBe("unchanged");
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual(currentAuthority);
    const evaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();
    expect(evaluations).toHaveLength(1);
    expect(
      evaluations.map((evaluation) => {
        return evaluation.validationAuthority;
      }),
    ).toStrictEqual([currentAuthority]);
  });

  it("repairs accepted validation authority after a preview build", async () => {
    configureSource();
    mockEnv("ENV", "preview");
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    mockEnv("GIT_COMMIT_SHA", firstCommit);
    const release = buildRelease({
      version: "2026-07-27.validation-preview-build",
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog();
    const validatorVersion =
      apiTestConnectorCatalogValidationAuthority().validatorVersion;
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual({
      validatorVersion,
      buildCommitSha: firstCommit,
    });

    mockEnv("GIT_COMMIT_SHA", secondCommit);
    mockNow(new Date("2026-07-27T08:01:00.000Z"));
    expect((await syncCatalog()).body.outcome).toBe("unchanged");
    await expect(
      readApiTestConnectorCatalogValidationAuthority(),
    ).resolves.toStrictEqual({
      validatorVersion,
      buildCommitSha: secondCommit,
    });
    await expect(
      readApiTestConnectorCatalogRuntimeProjectionAuthority(),
    ).resolves.toStrictEqual({
      validatorVersion,
      buildCommitSha: secondCommit,
    });
  });

  it("accepts inline confidential test clients and applies rollout at request time", async () => {
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const provider = mockTestOAuthAuthCodeProvider({
      refreshToken: "catalog-test-oauth-refresh",
    });
    configureSource();
    const method = publicAuthMethod({
      id: "oauth",
      grantKind: "auth-code",
    });
    const release = buildRelease({
      version: "2026-07-24.inline-confidential-test-client",
      connectorSlug: "test-oauth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [method]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [testOauthPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body.filtering).toMatchObject({
      stale: false,
      filteredAuthMethods: [],
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

    expect(
      (await accept(catalogClient.list({ headers }), [200])).body,
    ).toStrictEqual({
      connectors: [],
      categoryMetadata: { categories: [], groups: [] },
    });
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
    expect(enabled.body.connectors).toMatchObject([
      {
        slug: "test-oauth",
        authMethods: [{ id: "oauth", grantKind: "auth-code" }],
      },
    ]);
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

  it("filters unsupported grant, access, and revoke handlers independently", async () => {
    configureSource();
    const publicMethods = [
      publicAuthMethod({ id: "oauth", grantKind: "device-auth" }),
      publicAuthMethod({
        id: "api-token",
        grantKind: "manual",
        manual: true,
      }),
      publicAuthMethod({ id: "cli", grantKind: "manual", manual: true }),
      publicAuthMethod({ id: "api", grantKind: "manual", manual: true }),
    ];
    const privateMethods = [
      devicePrivateAuthMethod(),
      manualPrivateAuthMethod({
        id: "api-token",
        prefix: "ACCESS",
        access: "refresh-token",
        revoke: "none",
      }),
      manualPrivateAuthMethod({
        id: "cli",
        prefix: "REVOKE",
        access: "static",
        revoke: "token-revoke",
      }),
      manualPrivateAuthMethod({
        id: "api",
        prefix: "GENERIC",
        access: "static",
        revoke: "none",
      }),
    ];
    const partial = buildRelease({
      version: "2026-07-15.partial-compatibility",
      connectorSlug: "future-auth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, publicMethods);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, privateMethods);
      },
    });
    serveObjects(catalogObjects([partial], partial));

    expect((await syncCatalog()).body.filtering).toMatchObject({
      stale: false,
      filteredAuthMethods: [
        {
          connectorSlug: "future-auth",
          authMethodId: "api-token",
          reasons: ["missing-access-provider"],
        },
        {
          connectorSlug: "future-auth",
          authMethodId: "cli",
          reasons: ["missing-revoke-provider"],
        },
        {
          connectorSlug: "future-auth",
          authMethodId: "oauth",
          reasons: ["missing-grant-provider"],
        },
      ],
    });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const diagnostic = await accept(
      setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      ).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "environment",
          environmentName: "TEST_OAUTH_DEVICE_TOKEN",
        },
      }),
      [200],
    );
    expect(diagnostic.body).toStrictEqual({
      outcome: "unknown-environment",
    });

    const allFiltered = buildRelease({
      version: "2026-07-15.all-filtered",
      connectorSlug: "future-auth",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, publicMethods.slice(0, 3));
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, privateMethods.slice(0, 3));
      },
    });
    serveObjects(catalogObjects([partial, allFiltered], allFiltered));
    expect(
      (await syncCatalog()).body.filtering.filteredAuthMethods,
    ).toHaveLength(3);
  });

  it("ignores filtered sibling methods when choosing the callback origin", async () => {
    configureSource();
    mockEnv("OKOU_WEB_URL", "https://app.okou.test");
    mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_ID", "cloudflare-client-id");
    mockOptionalEnv(
      "CLOUDFLARE_OAUTH_CLIENT_SECRET",
      "cloudflare-client-secret",
    );
    const release = buildRelease({
      version: "2026-07-15.filtered-callback-origin",
      connectorSlug: "cloudflare",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
          publicAuthMethod({ id: "future-web", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          cloudflarePrivateAuthMethod(),
          unsupportedWebAuthCodePrivateAuthMethod(),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect(
      (await syncCatalog()).body.filtering.filteredAuthMethods,
    ).toStrictEqual([
      {
        connectorSlug: "cloudflare",
        authMethodId: "future-web",
        reasons: ["missing-grant-provider", "provider-contract-mismatch"],
      },
    ]);

    const response = await requestOauthCallbackRaw(context, {
      origin: "https://api.okou.ai",
      connectorSlug: "cloudflare",
      query: { code: "missing-state" },
    });
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://app.okou.test");
    expect(location.pathname).toBe("/connector/error");
    expect(location.searchParams.get("message")).toBe(
      "Missing state parameter",
    );
  });

  it("rejects unapproved configuration identities without reading them", async () => {
    configureSource();
    const unapprovedName = "FUTURE_PLATFORM_KEY";
    const release = buildRelease({
      version: "2026-07-15.unapproved-configuration",
      mutateRuntime: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        const access = recordValue(method.access, "access");
        access.platformSecrets = [unapprovedName];
        recordValue(access.envBindings, "envBindings").FUTURE_KEY =
          `$secrets.${unapprovedName}`;
      },
    });
    serveObjects(catalogObjects([release], release));
    const accepted = await syncCatalog();
    expect(accepted.body.filtering).toMatchObject({
      evaluatedAt: FIRST_SYNC_TIME,
      stale: false,
      filteredAuthMethods: [
        {
          connectorSlug: release.connectorSlug,
          authMethodId: "api-token",
          reasons: ["provider-contract-mismatch"],
        },
      ],
    });

    mockNow(new Date("2026-07-15T08:10:00.000Z"));
    mockOptionalEnv(unapprovedName, "must-not-affect-capabilities");
    const unchanged = await syncCatalog();
    expect(unchanged.body.filtering).toStrictEqual(accepted.body.filtering);
    expect(JSON.stringify(unchanged.body)).not.toContain(unapprovedName);
  });

  it("matches provider fields without pinning catalog storage names", async () => {
    configureSource();
    mockOptionalEnv("DEEL_OAUTH_CLIENT_ID", "configured-client-id");
    mockOptionalEnv("DEEL_OAUTH_CLIENT_SECRET", "configured-client-secret");
    const release = buildRelease({
      version: "2026-07-15.deel-storage-mapping",
      connectorSlug: "deel",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "oauth", grantKind: "auth-code" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [deelPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([release], release));

    const response = await syncCatalog();
    expect(response.body.filtering).toMatchObject({
      evaluatedAt: FIRST_SYNC_TIME,
      stale: false,
      filteredAuthMethods: [],
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "CATALOG_DEEL_ACCESS_TOKEN",
    );
  });

  it("reconciles configuration changes and retains rolling-build evaluations", async () => {
    configureSource();
    mockOptionalEnv("STEAM_WEB_API_KEY", undefined);
    const first = buildRelease({
      version: "2026-07-15.steam-1",
      connectorSlug: "steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [steamPrivateAuthMethod()]);
      },
    });
    serveObjects(catalogObjects([first], first));
    const missingConfiguration = await syncCatalog();
    expect(missingConfiguration.body.filtering).toMatchObject({
      evaluatedAt: FIRST_SYNC_TIME,
      stale: false,
      filteredAuthMethods: [
        {
          connectorSlug: "steam",
          authMethodId: "openid",
          reasons: ["missing-platform-configuration"],
        },
      ],
    });
    const firstDigest = missingConfiguration.body.filtering.capabilityDigest;
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const headers = { authorization: "Bearer clerk-session" };
    expect(
      (await accept(catalogClient.list({ headers }), [200])).body,
    ).toMatchObject({ connectors: [] });

    mockOptionalEnv("STEAM_WEB_API_KEY", "configured");
    const callsBeforeStaleStatus = context.mocks.s3.send.mock.calls.length;
    const stale = await readStatus();
    expect(stale.body.filtering).toMatchObject({
      evaluatedAt: null,
      stale: true,
      filteredAuthMethods: [],
    });
    expect(stale.body.filtering.capabilityDigest).not.toBe(firstDigest);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStaleStatus);
    const stalePublicRead = await accept(
      catalogClient.list({ headers }),
      [200],
    );
    expect(stalePublicRead.body.connectors).toStrictEqual([
      expect.objectContaining({ slug: "steam" }),
    ]);
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStaleStatus);

    mockNow(new Date("2026-07-15T08:20:00.000Z"));
    const rejected = buildRelease({
      version: "2026-07-15.rejected-after-config-change",
      mutatePointer: (pointer) => {
        pointer.extra = true;
      },
    });
    serveObjects(catalogObjects([first, rejected], rejected));
    const configured = await syncCatalog();
    expect(configured.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      active: { catalogVersion: first.version },
    });
    expect(configured.body.filtering).toMatchObject({
      evaluatedAt: "2026-07-15T08:20:00.000Z",
      stale: false,
      filteredAuthMethods: [],
    });
    expect(configured.body.filtering.capabilityDigest).not.toBe(firstDigest);
    expect(
      (await accept(catalogClient.list({ headers }), [200])).body.connectors,
    ).toStrictEqual([expect.objectContaining({ slug: "steam" })]);

    mockOptionalEnv("STEAM_WEB_API_KEY", undefined);
    expect((await readStatus()).body.filtering).toStrictEqual(
      missingConfiguration.body.filtering,
    );
    const rollingEvaluations =
      await readApiTestConnectorCatalogCompatibilityEvaluations();
    expect(rollingEvaluations).toHaveLength(2);
    expect(
      rollingEvaluations.every(({ payload }) => {
        return !Array.isArray(payload);
      }),
    ).toBeTruthy();
    expect(
      new Set(
        rollingEvaluations.map((evaluation) => {
          return evaluation.catalogDigest;
        }),
      ),
    ).toStrictEqual(new Set([missingConfiguration.body.active?.catalogDigest]));

    const second = buildRelease({
      version: "2026-07-15.steam-2",
      connectorSlug: "steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [steamPrivateAuthMethod()]);
      },
    });
    mockOptionalEnv("STEAM_WEB_API_KEY", "configured");
    serveObjects(catalogObjects([first, second], second));
    await syncCatalog();
    mockOptionalEnv("STEAM_WEB_API_KEY", undefined);
    expect((await readStatus()).body.filtering).toMatchObject({
      capabilityDigest: firstDigest,
      evaluatedAt: null,
      stale: true,
      filteredAuthMethods: [],
    });
    expect(
      (await accept(catalogClient.list({ headers }), [200])).body.connectors,
    ).toStrictEqual([]);

    mockNow(new Date("2026-07-15T08:40:00.000Z"));
    const rolledBack = await syncCatalog();
    expect(rolledBack.body).toMatchObject({
      outcome: "unchanged",
      filtering: {
        capabilityDigest: firstDigest,
        evaluatedAt: "2026-07-15T08:40:00.000Z",
        stale: false,
        filteredAuthMethods: [
          {
            connectorSlug: "steam",
            authMethodId: "openid",
            reasons: ["missing-platform-configuration"],
          },
        ],
      },
    });
    expect(
      (await accept(catalogClient.list({ headers }), [200])).body.connectors,
    ).toStrictEqual([]);
  });

  it("reports a known provider contract mismatch without private details", async () => {
    configureSource();
    mockOptionalEnv("STEAM_WEB_API_KEY", "configured");
    const release = buildRelease({
      version: "2026-07-15.provider-contract-mismatch",
      connectorSlug: "steam",
      mutateCatalog: (artifact) => {
        setArtifactAuthMethods(artifact, [
          publicAuthMethod({ id: "openid", grantKind: "openid-auth" }),
        ]);
      },
      mutateRuntime: (artifact) => {
        setArtifactAuthMethods(artifact, [
          steamPrivateAuthMethod({ callbackOrigin: "web" }),
        ]);
      },
    });
    serveObjects(catalogObjects([release], release));

    const response = await syncCatalog();
    expect(response.body.filtering.filteredAuthMethods).toStrictEqual([
      {
        connectorSlug: "steam",
        authMethodId: "openid",
        reasons: ["provider-contract-mismatch"],
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain("STEAM_WEB_API_KEY");
  });
});

describe("connector catalog rejection and latest-valid retention", () => {
  it("accepts 64 MiB in a rollback-isolated source generation and rejects 64 MiB plus one with latest-valid retention", async () => {
    const bucket = configureSource();
    const previousSourceId = previousConnectorCatalogSourceId(bucket);
    await installApiTestConnectorCatalog({
      catalogVersion: "2026-07-14.rollback-compatible",
      sourceId: previousSourceId,
    });
    const previousSnapshot =
      await readApiTestConnectorCatalogSnapshot(previousSourceId);
    expect(previousSnapshot.catalogRawSize).toBeLessThanOrEqual(
      PREVIOUS_CONNECTOR_CATALOG_MAX_RAW_BYTES,
    );
    const previousRawBytes = gunzipSync(previousSnapshot.catalogGzip, {
      maxOutputLength: PREVIOUS_CONNECTOR_CATALOG_MAX_RAW_BYTES,
    });
    expect(previousRawBytes.byteLength).toBe(previousSnapshot.catalogRawSize);
    expect(digest(previousRawBytes)).toBe(previousSnapshot.catalogDigest);

    expect(CONNECTOR_CATALOG_MAX_RAW_BYTES).toBe(64 * 1024 * 1024);
    const acceptedVersion = "2026-07-15.sixty-four-mib-limit";
    const unpadded = buildRelease({
      version: acceptedVersion,
      mutateCatalog: (artifact) => {
        firstRecord(artifact.connectors, "connectors").description = "";
      },
    });
    const descriptionBytes =
      CONNECTOR_CATALOG_MAX_RAW_BYTES -
      releaseCatalogBytes(unpadded).byteLength;
    const accepted = buildRelease({
      version: acceptedVersion,
      mutateCatalog: (artifact) => {
        firstRecord(artifact.connectors, "connectors").description = "x".repeat(
          descriptionBytes,
        );
      },
    });
    const acceptedBytes = releaseCatalogBytes(accepted);
    expect(acceptedBytes.byteLength).toBe(CONNECTOR_CATALOG_MAX_RAW_BYTES);
    serveObjects(catalogObjects([accepted], accepted));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: accepted.version },
    });
    await expect(
      readApiTestConnectorCatalogSnapshot(previousSourceId),
    ).resolves.toStrictEqual(previousSnapshot);

    const rejected = buildRelease({
      version: "2026-07-15.over-sixty-four-mib-limit",
      catalogBytes: Buffer.alloc(CONNECTOR_CATALOG_MAX_RAW_BYTES + 1),
    });
    serveObjects(catalogObjects([rejected], rejected));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      active: { catalogVersion: accepted.version },
      lastAttempt: {
        outcome: "rejected",
        failureCode: "object-too-large",
      },
    });
    await expect(
      readApiTestConnectorCatalogSnapshot(previousSourceId),
    ).resolves.toStrictEqual(previousSnapshot);
  });

  it("classifies unavailable and oversized objects before acceptance", async () => {
    expect.hasAssertions();
    configureSource();
    context.mocks.s3.send.mockRejectedValue(
      new Error("private source credentials and URL must stay private"),
    );
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "source-unavailable",
    );

    configureSource();
    context.mocks.s3.send.mockResolvedValue({
      ContentLength: 16 * 1024 + 1,
      Body: s3Body(Buffer.from("oversized")),
    });
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );

    configureSource();
    context.mocks.s3.send.mockResolvedValue({
      Body: s3Body(Buffer.alloc(16 * 1024 + 1)),
    });
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );
  });

  it("accepts one connector sharing storage names across auth methods", async () => {
    configureSource();
    const release = buildRelease({
      version: "same-connector-storage-sharing",
      mutateCatalog: (artifact) => {
        const connector = firstRecord(artifact.connectors, "connectors");
        const methods = arrayValue(connector.authMethods, "authMethods");
        const second = structuredClone(firstRecord(methods, "authMethods"));
        second.id = "backup-token";
        second.label = "Backup Token";
        methods.push(second);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts producer connector order and scopes private-value leak detection", async () => {
    configureSource();
    const release = buildRelease({
      version: "cross-connector-private-name-placeholder",
      mutateCatalog: (artifact) => {
        const connectors = arrayValue(artifact.connectors, "connectors");
        const first = firstRecord(connectors, "connectors");
        const firstMethod = firstRecord(first.authMethods, "authMethods");
        firstRecord(
          recordValue(firstMethod.grant, "grant").fields,
          "grant.fields",
        ).placeholder = "your-second-api-key";

        const second = structuredClone(first);
        second.slug = "aa-external-other";
        second.label = "External Other";
        const secondMethod = firstRecord(second.authMethods, "authMethods");
        recordValue(secondMethod.storage, "storage").secrets = [
          "SECOND_API_KEY",
        ];
        const secondField = firstRecord(
          recordValue(secondMethod.grant, "grant").fields,
          "grant.fields",
        );
        secondField.privateName = "SECOND_API_KEY";
        secondField.placeholder = null;
        recordValue(
          recordValue(secondMethod.access, "access").envBindings,
          "envBindings",
        ).SERVICE_TOKEN = "$secrets.SECOND_API_KEY";
        connectors.push(second);
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts credentialed path variables without a host policy", async () => {
    configureSource();
    const release = buildRelease({
      version: "credentialed-firewall-path-variable",
      generatedFirewall: true,
      mutateRuntime: (artifact) => {
        const method = firstRecord(
          firstRecord(artifact.connectors, "connectors").authMethods,
          "authMethods",
        );
        recordValue(method.storage, "storage").variables = [
          "QUICKBOOKS_REALM_ID",
        ];
        recordValue(
          recordValue(method.access, "access").envBindings,
          "envBindings",
        ).QUICKBOOKS_REALM_ID = "$vars.QUICKBOOKS_REALM_ID";
      },
      mutateFirewall: (artifact) => {
        setFirewallBase(
          artifact,
          `https://api.example.test/v3/company/${catalogTemplate("vars.QUICKBOOKS_REALM_ID")}`,
        );
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
  });

  it("accepts a shared fixed host for auth.base placeholder routes", async () => {
    configureSource();
    const release = buildRelease({
      version: "shared-firewall-placeholder-host",
      connectorSlug: "collision-a",
      generatedFirewall: true,
      mutateCatalog: (artifact) => {
        const connectors = arrayValue(artifact.connectors, "connectors");
        const first = firstRecord(connectors, "connectors");
        const firstFirewall = recordValue(first.firewall, "firewall");
        const firstConfig = recordValue(
          firstFirewall.config,
          "firewall.config",
        );
        const firstApi = firstRecord(firstConfig.apis, "firewall.apis");
        firstApi.base = "https://firewall-placeholder.vm3.ai/collision-a/hook";
        recordValue(firstApi.auth, "firewall auth").base = catalogTemplate(
          "secrets.SERVICE_TOKEN",
        );

        const second = structuredClone(first);
        second.slug = "collision-b";
        second.label = "Collision B";
        const secondMethod = firstRecord(second.authMethods, "authMethods");
        recordValue(secondMethod.storage, "storage").secrets = [
          "SECOND_SECRET_TOKEN",
        ];
        firstRecord(
          recordValue(secondMethod.grant, "grant").fields,
          "grant.fields",
        ).privateName = "SECOND_SECRET_TOKEN";
        recordValue(
          recordValue(secondMethod.access, "access").envBindings,
          "envBindings",
        ).SERVICE_TOKEN = "$secrets.SECOND_SECRET_TOKEN";
        const secondFirewall = recordValue(second.firewall, "firewall");
        const secondConfig = recordValue(
          secondFirewall.config,
          "firewall.config",
        );
        firstRecord(secondConfig.apis, "firewall.apis").base =
          "https://firewall-placeholder.vm3.ai/collision-b/hook";
        connectors.push(second);
        connectors.reverse();
      },
    });
    serveObjects(catalogObjects([release], release));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: release.version },
    });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const diagnostic = await accept(
      setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      ).check({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          mode: "url",
          method: "GET",
          url: "https://firewall-placeholder.vm3.ai/collision-a/hook/items",
        },
      }),
      [200],
    );
    expect(diagnostic.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "collision-a" },
    });
  });

  it.each([
    {
      name: "invalid JSON",
      expected: "invalid-json",
      release: () => {
        const fixture = buildRelease({ version: "invalid-json" });
        return { ...fixture, pointer: Buffer.from("{") };
      },
    },
    {
      name: "strict pointer property",
      expected: "invalid-pointer",
      release: () => {
        return buildRelease({
          version: "invalid-pointer",
          mutatePointer: (pointer) => {
            pointer.extra = true;
          },
        });
      },
    },
    {
      name: "overlong catalog version",
      expected: "invalid-pointer",
      release: () => {
        return buildRelease({ version: "a".repeat(256) });
      },
    },
    {
      name: "legacy pointer reference",
      expected: "invalid-pointer",
      release: () => {
        return buildRelease({
          version: "legacy-pointer-reference",
          mutatePointer: (pointer) => {
            pointer.integrity = {
              key: "connectors/v3/releases/legacy-pointer-reference/integrity/catalog.json",
              digest: pointer.catalogDigest,
            };
            delete pointer.catalogDigest;
          },
        });
      },
    },
    {
      name: "catalog digest mismatch",
      expected: "digest-mismatch",
      release: () => {
        return buildRelease({
          version: "bad-catalog-digest",
          mutatePointer: (pointer) => {
            pointer.catalogDigest = ZERO_DIGEST;
          },
        });
      },
    },
    {
      name: "unsupported schema",
      expected: "unsupported-schema",
      release: () => {
        return buildRelease({
          version: "unsupported-schema",
          mutateArtifact: (artifact) => {
            artifact.artifactSchemaVersion = 4;
          },
        });
      },
    },
    {
      name: "legacy catalog source property",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "legacy-catalog-source-property",
          mutateArtifact: (artifact) => {
            artifact.catalogSource = {
              key: "catalog/catalog.yaml",
              digest: ZERO_DIGEST,
            };
          },
        });
      },
    },
    {
      name: "strict artifact property",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "invalid-artifact",
          mutateCatalog: (artifact) => {
            artifact.extra = true;
          },
        });
      },
    },
    {
      name: "missing storage version",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "missing-storage-version",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const method = firstRecord(connector.authMethods, "authMethods");
            delete recordValue(method.storage, "storage").version;
          },
        });
      },
    },
    {
      name: "non-positive storage version",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "non-positive-storage-version",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const method = firstRecord(connector.authMethods, "authMethods");
            recordValue(method.storage, "storage").version = 0;
          },
        });
      },
    },
    {
      name: "unsafe storage version",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "unsafe-storage-version",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const method = firstRecord(connector.authMethods, "authMethods");
            recordValue(method.storage, "storage").version =
              Number.MAX_SAFE_INTEGER + 1;
          },
        });
      },
    },
    {
      name: "legacy auth-method visibility field",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "legacy-auth-method-visibility",
          mutateCatalog: (artifact) => {
            const method = firstRecord(
              firstRecord(artifact.connectors, "connectors").authMethods,
              "authMethods",
            );
            method.defaultVisible = method.visible;
            delete method.visible;
          },
        });
      },
    },
    {
      name: "invalid UTF-8 artifact",
      expected: "invalid-json",
      release: () => {
        return buildRelease({
          version: "invalid-utf8",
          catalogBytes: Buffer.from([0xc3, 0x28]),
        });
      },
    },
    {
      name: "header mismatch",
      expected: "invalid-reference",
      release: () => {
        return buildRelease({
          version: "header-mismatch",
          mutateCatalog: (artifact) => {
            artifact.catalogVersion = "other";
          },
        });
      },
    },
    {
      name: "public private-value leak",
      expected: "public-leakage",
      release: () => {
        return buildRelease({
          version: "public-leak",
          mutateCatalog: (artifact) => {
            firstRecord(artifact.connectors, "connectors").description =
              PRIVATE_VALUE;
          },
        });
      },
    },
    {
      name: "duplicate connector slug",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "duplicate-connector-slug",
          mutateCatalog: (artifact) => {
            const connectors = arrayValue(artifact.connectors, "connectors");
            connectors.push(
              structuredClone(firstRecord(connectors, "connectors")),
            );
          },
        });
      },
    },
    {
      name: "unknown category group",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "unknown-category-group",
          mutateCatalog: (artifact) => {
            const categoryMetadata = recordValue(
              artifact.categoryMetadata,
              "categoryMetadata",
            );
            firstRecord(categoryMetadata.categories, "categories").groupId =
              "unknown";
          },
        });
      },
    },
    {
      name: "duplicate auth method id",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "duplicate-auth-method-id",
          mutateCatalog: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const methods = arrayValue(connector.authMethods, "authMethods");
            methods.push(structuredClone(firstRecord(methods, "authMethods")));
          },
        });
      },
    },
    {
      name: "cross-connector storage secret collision",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "cross-connector-storage-secret",
          mutateCatalog: (artifact) => {
            const connectors = arrayValue(artifact.connectors, "connectors");
            const second = structuredClone(
              firstRecord(connectors, "connectors"),
            );
            second.slug = "zz-external-other";
            second.label = "External Other";
            connectors.push(second);
          },
        });
      },
    },
    {
      name: "cross-connector storage variable collision",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "cross-connector-storage-variable",
          mutateCatalog: (artifact) => {
            const connectors = arrayValue(artifact.connectors, "connectors");
            const second = structuredClone(
              firstRecord(connectors, "connectors"),
            );
            second.slug = "zz-external-other";
            second.label = "External Other";
            connectors.push(second);
          },
          mutateRuntime: (artifact) => {
            const connectors = arrayValue(artifact.connectors, "connectors");
            const firstConnector = firstRecord(connectors, "connectors");
            const firstMethod = firstRecord(
              firstConnector.authMethods,
              "authMethods",
            );
            recordValue(firstMethod.storage, "storage").variables = [
              "SHARED_VARIABLE",
            ];
            recordValue(
              recordValue(firstMethod.access, "access").envBindings,
              "envBindings",
            ).SHARED_VARIABLE = "$vars.SHARED_VARIABLE";

            const second = recordValue(connectors[1], "connectors[1]");
            const secondMethod = firstRecord(second.authMethods, "authMethods");
            recordValue(secondMethod.storage, "storage").variables = [
              "SHARED_VARIABLE",
            ];
            recordValue(secondMethod.storage, "storage").secrets = [
              "OTHER_TOKEN",
            ];
            firstRecord(
              recordValue(secondMethod.grant, "grant").fields,
              "fields",
            ).privateName = "OTHER_TOKEN";
            recordValue(
              recordValue(secondMethod.access, "access").envBindings,
              "envBindings",
            ).SERVICE_TOKEN = "$secrets.OTHER_TOKEN";
          },
        });
      },
    },
    {
      name: "reserved model-provider identity",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "model-provider-ref",
          mutateCatalog: (artifact) => {
            firstRecord(artifact.connectors, "connectors").slug =
              "model-provider:external";
          },
        });
      },
    },
    {
      name: "invalid icon reference",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "invalid-icon-reference",
          mutateCatalog: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const icon = recordValue(connector.icon, "icon");
            icon.key = "../icon.svg";
          },
        });
      },
    },
    {
      name: "invalid skill reference",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "invalid-skill-reference",
          mutateRuntime: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const skill = buildBundledSkill("wrong");
            skill.storageVersionPrefix =
              `__system__/volume/connector-skill@other-${randomUUID().replaceAll("-", "")}/` +
              createHash("sha256").update(randomUUID()).digest("hex");
            connector.skill = skill;
          },
        });
      },
    },
    {
      name: "generated firewall missing canonical config",
      expected: "invalid-artifact",
      release: () => {
        return buildRelease({
          version: "firewall-mismatch",
          mutateCatalog: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            connector.firewall = {
              kind: "generated",
              permissions: [],
              categories: null,
              defaultAllowed: null,
              defaultUnknownPolicy: "allow",
            };
          },
        });
      },
    },
    {
      name: "non-HTTPS firewall base URL",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-http-base",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            firstRecord(config.apis, "firewall.apis").base =
              "http://api.example.test/v1";
          },
        });
      },
    },
    {
      name: "non-canonical firewall base hostname",
      expected: "relationship-mismatch",
      release: () => {
        const base = "https://API.EXAMPLE.TEST/v1";
        return buildRelease({
          version: "firewall-noncanonical-hostname",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            setFirewallBase(artifact, base);
          },
        });
      },
    },
    {
      name: "unsafe firewall base path",
      expected: "relationship-mismatch",
      release: () => {
        const base = "https://api.example.test/v1/../admin";
        return buildRelease({
          version: "firewall-unsafe-base-path",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            setFirewallBase(artifact, base);
          },
        });
      },
    },
    {
      name: "non-canonical firewall host policy",
      expected: "invalid-artifact",
      release: () => {
        const hostPolicy = {
          kind: "providerOwned",
          exactHosts: ["API.EXAMPLE.TEST"],
        };
        return buildRelease({
          version: "firewall-noncanonical-host-policy",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            firstRecord(config.apis, "firewall.apis").hostPolicy = hostPolicy;
          },
        });
      },
    },
    {
      name: "invalid firewall auth base URL",
      expected: "relationship-mismatch",
      release: () => {
        const authBase = "http://webhook.example.test/token";
        return buildRelease({
          version: "firewall-invalid-auth-base",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            const api = firstRecord(config.apis, "firewall.apis");
            recordValue(api.auth, "firewall auth").base = authBase;
          },
        });
      },
    },
    {
      name: "unknown firewall environment binding",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-unknown-binding",
          generatedFirewall: true,
          mutateFirewall: (artifact) => {
            const connector = firstRecord(artifact.connectors, "connectors");
            const firewall = recordValue(connector.firewall, "firewall");
            const config = recordValue(firewall.config, "firewall.config");
            const api = firstRecord(config.apis, "firewall.apis");
            const auth = recordValue(api.auth, "firewall api auth");
            recordValue(auth.headers, "firewall auth headers")["X-Unknown"] =
              catalogTemplate("secrets.UNKNOWN_SECRET");
          },
        });
      },
    },
    {
      name: "conflicting duplicate dynamic firewall host policies",
      expected: "relationship-mismatch",
      release: () => {
        return buildRelease({
          version: "firewall-dynamic-base-host-policy-conflict",
          generatedFirewall: true,
          mutateRuntime: addDynamicFirewallVariableBinding,
          mutateFirewall: (artifact) => {
            addDuplicateDynamicPrivateFirewallApi(artifact, {
              conflictingHostPolicy: true,
            });
          },
        });
      },
    },
  ])("rejects $name", async ({ expected, release }) => {
    expect.hasAssertions();
    configureSource();
    const fixture = release();
    serveObjects(catalogObjects([fixture], fixture));
    expectRejectedBeforeAcceptance((await syncCatalog()).body, expected);
  });

  it("retains the latest valid snapshot and exposes sanitized status", async () => {
    configureSource();
    const accepted = buildRelease({ version: "2026-07-15.valid" });
    serveObjects(catalogObjects([accepted], accepted));
    const acceptedResponse = await syncCatalog();
    const acceptedDigest = acceptedResponse.body.active?.catalogDigest;

    const invalid = buildRelease({
      version: "2026-07-15.invalid",
      mutatePointer: (pointer) => {
        pointer.extra = `private-${PRIVATE_VALUE}`;
      },
    });
    serveObjects(catalogObjects([accepted, invalid], invalid));
    const rejected = await syncCatalog();
    expect(rejected.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      active: {
        catalogVersion: accepted.version,
        catalogDigest: acceptedDigest,
      },
      lastAttempt: {
        outcome: "rejected",
        failureCode: "invalid-pointer",
      },
      lastSuccessAt: FIRST_SYNC_TIME,
    });

    const callsBeforeStatus = context.mocks.s3.send.mock.calls.length;
    expect((await readStatus()).body).toStrictEqual(
      (({ outcome: _outcome, ...status }) => {
        return status;
      })(rejected.body),
    );
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeStatus);
    expect(JSON.stringify(rejected.body)).not.toContain(PRIVATE_VALUE);

    serveObjects(catalogObjects([accepted], accepted));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "unchanged",
      state: "current",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: null,
    });
  });

  it("skips large artifacts for a deterministically rejected candidate", async () => {
    configureSource();
    const accepted = buildRelease({ version: "2026-07-15.cache-valid" });
    serveObjects(catalogObjects([accepted], accepted));
    await syncCatalog();

    const invalid = buildRelease({
      version: "2026-07-15.cache-invalid",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([accepted, invalid], invalid));
    const callsBeforeFirstRejection = context.mocks.s3.send.mock.calls.length;
    const freshRejection = await syncCatalog();
    expect(freshRejection.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      lastAttempt: {
        failureCode: "invalid-artifact",
        reusedCachedRejection: false,
      },
      rejectedCandidate: {
        catalogVersion: invalid.version,
        failureCode: "invalid-artifact",
        backendVersion: DEFAULT_API_VERSION,
      },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeFirstRejection,
    ).toBe(2);

    const callsBeforeCachedRejection = context.mocks.s3.send.mock.calls.length;
    const cachedRejection = await syncCatalog();
    expect(cachedRejection.body).toMatchObject({
      outcome: "rejected",
      state: "stale",
      lastAttempt: {
        failureCode: "invalid-artifact",
        reusedCachedRejection: true,
      },
      rejectedCandidate: {
        catalogVersion: invalid.version,
        failureCode: "invalid-artifact",
        backendVersion: DEFAULT_API_VERSION,
      },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedRejection,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeCachedRejection]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(invalid.pointer),
    });
    expect(JSON.stringify(cachedRejection.body)).not.toContain(
      invalid.catalogKey,
    );
    expect(JSON.stringify(cachedRejection.body)).not.toContain(
      objectEtag(invalid.pointer),
    );
  });

  it("revalidates a rejection when the production backend version advances", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const invalid = buildRelease({
      version: "2026-07-25.backend-version-rejection",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));

    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: "1.318.0" },
    });

    setApiVersion("1.319.0");
    const callsBeforeNewBackend = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeNewBackend,
    ).toBe(2);

    setApiVersion("1.318.0");
    const callsBeforeOlderBackend = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: true },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeOlderBackend,
    ).toBe(1);
  });

  it("activates a candidate after backend-version revalidation succeeds", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const candidate = buildRelease({
      version: "2026-07-25.backend-version-acceptance",
    });
    const rejectedObjects = new Map(catalogObjects([candidate], candidate));
    rejectedObjects.set(candidate.catalogKey, Buffer.from("{}"));
    serveObjects(rejectedObjects);
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: {
        failureCode: "digest-mismatch",
        reusedCachedRejection: false,
      },
      rejectedCandidate: { backendVersion: "1.318.0" },
    });

    setApiVersion("1.319.0");
    serveObjects(catalogObjects([candidate], candidate));
    const callsBeforeAcceptance = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: candidate.version },
      lastAttempt: {
        failureCode: null,
        reusedCachedRejection: false,
      },
      rejectedCandidate: null,
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeAcceptance,
    ).toBe(2);
  });

  it("uses build commits to invalidate preview rejections", async () => {
    configureSource();
    mockEnv("ENV", "preview");
    mockEnv("GIT_COMMIT_SHA", "a".repeat(40));
    const invalid = buildRelease({
      version: "2026-07-25.preview-commit-rejection",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: DEFAULT_API_VERSION },
    });

    mockEnv("GIT_COMMIT_SHA", "b".repeat(40));
    const callsBeforeNewCommit = context.mocks.s3.send.mock.calls.length;
    const revalidated = await syncCatalog();
    expect(revalidated.body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: DEFAULT_API_VERSION },
    });
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeNewCommit).toBe(
      2,
    );

    const callsBeforeCachedCommit = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: true },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedCommit,
    ).toBe(1);
    expect(JSON.stringify(revalidated.body)).not.toContain("a".repeat(40));
    expect(JSON.stringify(revalidated.body)).not.toContain("b".repeat(40));
  });

  it("keeps the newer rejection authority across concurrent backend versions", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const invalid = buildRelease({
      version: "2026-07-25.concurrent-backend-rejection",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    const objects = catalogObjects([invalid], invalid);
    const blocked = deferredGate();
    const resume = deferredGate();
    let blockedFirstCatalogRead = false;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      const key = typeof input.Key === "string" ? input.Key : undefined;
      const bytes = key ? objects.get(key) : undefined;
      if (!bytes) {
        throw new Error("Object unavailable");
      }
      if (key === invalid.catalogKey && !blockedFirstCatalogRead) {
        blockedFirstCatalogRead = true;
        blocked.release();
        await resume.promise;
      }
      const etag = objectEtag(bytes);
      if (input.IfNoneMatch === etag) {
        throw Object.assign(new Error("Not modified"), {
          $metadata: { httpStatusCode: 304 },
        });
      }
      return {
        ContentLength: bytes.length,
        Body: s3Body(bytes),
        ETag: etag,
      };
    });

    const olderSync = syncCatalog();
    await blocked.promise;
    setApiVersion("1.319.0");
    const newerResult = await syncCatalog();
    resume.release();
    const olderResult = await olderSync;

    expect(newerResult.body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: false },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect(olderResult.body).toMatchObject({
      outcome: "rejected",
      lastAttempt: { reusedCachedRejection: true },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
    expect((await readStatus()).body).toMatchObject({
      lastAttempt: { reusedCachedRejection: true },
      rejectedCandidate: { backendVersion: "1.319.0" },
    });
  });

  it("re-evaluates a rejected identity when the pointer ETag changes", async () => {
    configureSource();
    const invalid = buildRelease({
      version: "2026-07-15.changed-rejection-etag",
      mutateCatalog: (artifact) => {
        artifact.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-artifact",
    );

    const changedPointer = Buffer.concat([invalid.pointer, Buffer.from("\n")]);
    const changedObjects = new Map(catalogObjects([invalid], invalid));
    changedObjects.set(ACTIVE_KEY, changedPointer);
    serveObjects(changedObjects);
    const callsBeforeReevaluation = context.mocks.s3.send.mock.calls.length;
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-artifact",
    );
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeReevaluation,
    ).toBe(2);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeReevaluation]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(invalid.pointer),
    });
  });

  it("caches an oversized active pointer by its observed ETag", async () => {
    configureSource();
    const oversizedPointer = Buffer.alloc(16 * 1024 + 1);
    const etag = objectEtag(oversizedPointer);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (input.IfNoneMatch === etag) {
        return Promise.reject(
          Object.assign(new Error("Not modified"), {
            $metadata: { httpStatusCode: 304 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: oversizedPointer.length,
        Body: s3Body(oversizedPointer),
        ETag: etag,
      });
    });
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );

    const callsBeforeCachedRejection = context.mocks.s3.send.mock.calls.length;
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "object-too-large",
    );
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedRejection,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeCachedRejection]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: etag,
    });
  });

  it("revalidates an ETag-only pointer rejection after a backend release", async () => {
    configureSource();
    mockEnv("ENV", "production");
    setApiVersion("1.318.0");
    const invalid = buildRelease({
      version: "2026-07-15.malformed-pointer-cache",
      mutatePointer: (pointer) => {
        pointer.extra = true;
      },
    });
    serveObjects(catalogObjects([invalid], invalid));
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-pointer",
    );

    const callsBeforeCachedRejection = context.mocks.s3.send.mock.calls.length;
    expectRejectedBeforeAcceptance(
      (await syncCatalog()).body,
      "invalid-pointer",
    );
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeCachedRejection,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeCachedRejection]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(invalid.pointer),
    });

    setApiVersion("1.319.0");
    const callsBeforeNewBackend = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      lastAttempt: {
        failureCode: "invalid-pointer",
        reusedCachedRejection: false,
      },
      rejectedCandidate: {
        catalogVersion: null,
        catalogDigest: null,
        backendVersion: "1.319.0",
      },
    });
    expect(
      context.mocks.s3.send.mock.calls.length - callsBeforeNewBackend,
    ).toBe(1);
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeNewBackend]?.[0],
      ),
    ).toMatchObject({
      Key: ACTIVE_KEY,
    });
    expect(
      commandInput(
        context.mocks.s3.send.mock.calls[callsBeforeNewBackend]?.[0],
      ),
    ).toMatchObject({
      IfNoneMatch: undefined,
    });
  });

  it("retries transient candidate download failures", async () => {
    configureSource();
    const candidate = buildRelease({
      version: "2026-07-15.transient-candidate",
    });
    const unavailableObjects = new Map(catalogObjects([candidate], candidate));
    unavailableObjects.delete(releaseKeys(candidate.version).catalog);
    serveObjects(unavailableObjects);
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "rejected",
      state: "never-synced",
      lastAttempt: { failureCode: "source-unavailable" },
    });

    serveObjects(catalogObjects([candidate], candidate));
    const callsBeforeRetry = context.mocks.s3.send.mock.calls.length;
    expect((await syncCatalog()).body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: candidate.version },
    });
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeRetry).toBe(2);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[callsBeforeRetry]?.[0]),
    ).toMatchObject({
      Key: ACTIVE_KEY,
      IfNoneMatch: objectEtag(candidate.pointer),
    });
  });

  it("replaces current content when a catalog version is reused", async () => {
    configureSource();
    const original = buildRelease({ version: "2026-07-15.conflict" });
    serveObjects(catalogObjects([original], original));
    const originalResponse = await syncCatalog();

    const conflicting = buildRelease({
      version: original.version,
      label: "Conflicting Content",
    });
    serveObjects(catalogObjects([conflicting], conflicting));
    const replacementResponse = await syncCatalog();
    expect(replacementResponse.body).toMatchObject({
      outcome: "accepted",
      state: "current",
      active: { catalogVersion: original.version },
    });
    expect(replacementResponse.body.active?.catalogDigest).not.toBe(
      originalResponse.body.active?.catalogDigest,
    );
  });

  it("does not return raw source failures", async () => {
    const bucket = configureSource();
    const privateError =
      `credential=${PRIVATE_VALUE} bucket=${bucket} key=${ACTIVE_KEY} ` +
      "url=https://signed.example.test/private";
    context.mocks.s3.send.mockRejectedValue(new Error(privateError));
    const response = await syncCatalog();

    expectRejectedBeforeAcceptance(response.body, "source-unavailable");
    for (const privateText of [
      PRIVATE_VALUE,
      bucket,
      ACTIVE_KEY,
      "signed.example.test",
    ]) {
      expect(JSON.stringify(response.body)).not.toContain(privateText);
    }
  });
});
