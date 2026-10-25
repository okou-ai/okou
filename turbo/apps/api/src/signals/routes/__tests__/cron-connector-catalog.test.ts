import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { readPublishedArchive } from "./helpers/published-archive";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createHash, randomUUID } from "node:crypto";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";

import {
  builtinConnectorOpenIdStartContract,
  builtinConnectorsSearchContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
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
import { singleton } from "../../../lib/singleton";
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
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
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
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";

import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorCheckRoutes } from "../connector-check";
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
  // The catalog digest, which identifies the generation once it serves.
  readonly digest: string;
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

function catalogTemplate(reference: string): string {
  return `\${{ ${reference} }}`;
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
    "manual" | "auth-code" | "openid-auth" | "external-code" | "device-auth";
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
  readonly storageName: string;
}

function createOwnedVolumeStorageFixture(
  storageName: string,
): OwnedVolumeStorageFixture {
  return {
    storageName,
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
  readonly archiveSize: number;
}

function buildBundledSkillFixture(
  connectorSlug: string,
  versionId = createHash("sha256").update(randomUUID()).digest("hex"),
  storage = createBundledSkillStorageFixture(connectorSlug),
): BundledSkillFixture {
  const contentSize = Buffer.byteLength(`# ${connectorSlug}\n`);
  const archiveSize = 321;
  const fileCount = 1;
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
    archiveSize,
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

// The public catalog served from the current pointer, read as a fresh user
// with the given feature switches.
async function servedConnectors(
  switches: Partial<Record<FeatureSwitchKey, boolean>> = {},
) {
  routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const headers = { authorization: "Bearer clerk-session" };
  if (Object.keys(switches).length > 0) {
    await accept(
      setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      ).update({ headers, body: { switches } }),
      [200],
    );
  }
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
    const bucket = configureSource();
    const first = buildRelease({ version: "2026-07-15.1" });
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
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: bucket,
      Key: ACTIVE_KEY,
    });

    mockNow(new Date("2026-07-15T08:01:00.000Z"));
    const callsBeforeUnchanged = context.mocks.s3.send.mock.calls.length;
    const unchanged = await syncCatalog(app);
    expect(unchanged.body).toStrictEqual({
      outcome: "unchanged",
      failureCode: null,
    });
    // An unchanged pointer digest skips the catalog download entirely.
    expect(context.mocks.s3.send.mock.calls.length - callsBeforeUnchanged).toBe(
      1,
    );
    expect(
      commandInput(context.mocks.s3.send.mock.calls[callsBeforeUnchanged]?.[0]),
    ).toMatchObject({ Bucket: bucket, Key: ACTIVE_KEY });

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
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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
    await syncCatalog(app);
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const headers = { authorization: "Bearer clerk-session" };
    const catalogClient = setupApp({
      context,
      routes: connectorCatalogRoutes,
    })(connectorCatalogContract);
    const searchClient = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
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
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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
    await syncCatalog(app);
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

  it("executes an external manual grant with catalog-owned storage", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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
        ).OPTIONAL_SERVICE_TOKEN = {
          valueRef: `$secrets.${optionalSecretName}`,
          optional: true,
        };
      },
    });
    serveObjects(catalogObjects([release], release));
    await syncCatalog(app);

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
      target: { kind: "builtin", connectorSlug: "agora" },
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    const listed = await connectorsApi.listBuiltinConnectors(actor);
    expect(JSON.stringify(listed)).not.toContain("catalog-manual-secret");
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
    await withConnectorRuntime(
      context,
      actor,
      "agora",
      async ({ claim, resolveAuth }) => {
        expect(claim.environment).not.toHaveProperty("OPTIONAL_SERVICE_TOKEN");
        const resolved = await resolveAuth({
          authHeaders: {
            Authorization: "Bearer " + secretTemplate("SERVICE_TOKEN"),
          },
        });
        expect(resolved.headers).toStrictEqual({
          Authorization: "Bearer catalog-manual-secret",
        });
      },
    );
  });

  it("wakes claimed runs when a custom permission bundle changes", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    const connectorSlug = "external-custom-permissions";
    configureSource();
    const initial = buildRelease({
      version: "2026-07-15.external-custom-permissions-1",
      connectorSlug,
      label: "External Custom Permissions",
      generatedFirewall: true,
    });
    serveObjects(catalogObjects([initial], initial));
    await syncCatalog(app);

    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor);
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
        await flushWaitUntilForTest();
      }
      await connectorsApi.deleteCustomConnector(actor, custom.id);
      await bdd.deleteAgent(actor, agent.agentId);
    });
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "Use the custom permission bundle",
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
    await syncCatalog(app);
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
    await syncCatalog(app);
    expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
  }, 15_000);

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

  it("executes an external OpenID grant with catalog-owned storage", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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
    await syncCatalog(app);

    const actor = bdd.user();
    onTestFinished(createConnectorCleanup(actor, "steam"));
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const callsBeforeAction = context.mocks.s3.send.mock.calls.length;
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
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeAction);
    await withConnectorRuntime(context, actor, "steam", ({ claim }) => {
      expect(claim.environment?.STEAM_ID).toBe(STEAM_TEST_ID);
    });
  });

  it("executes an external-code grant with catalog-owned storage", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    const provider = mockAwsExternalCodeProvider();
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
    await syncCatalog(app);

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
    await syncCatalog(app);
    const callsBeforeCompletion = context.mocks.s3.send.mock.calls.length;
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
    await expect(
      connectorsApi.readDefaultBuiltinScopeDiff(actor, "aws"),
    ).resolves.toStrictEqual({
      addedScopes: ["future_scope"],
      removedScopes: [],
      currentScopes: ["openid", "future_scope"],
      storedScopes: ["openid"],
    });
    expect(context.mocks.s3.send).toHaveBeenCalledTimes(callsBeforeCompletion);
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

  it("revokes an external auth-code credential through its selected method", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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
    await syncCatalog(app);

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

  it("merges duplicate dynamic firewall execution templates", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
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
        target: { kind: "builtin", connectorSlug: "dynamic-firewall" },
        label: "Dynamic Firewall",
      },
      permission: {
        kind: "matched",
        permissions: [{ name: "items.read" }],
      },
    });
  });

  it("accepts canonical firewall bases with authority parameters", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
  });

  it("reuses bundled skill registrations across overlapping syncs and later releases", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
    configureSource();
    const skill = buildBundledSkillFixture("agora");
    const release = buildRelease({
      version: "2026-07-15.concurrent",
      connectorSlug: "agora",
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill = skill.descriptor;
      },
    });
    serveObjects(catalogObjects([release], release));
    const results = await Promise.all([syncCatalog(app), syncCatalog(app)]);
    // The last writer wins: both attempts may publish the same generation, or
    // the later one may observe it already serving. Neither reports a failure.
    const outcomes = results.map((result) => {
      return result.body.outcome;
    });
    expect(outcomes).toContain("accepted");
    for (const outcome of outcomes) {
      expect(["accepted", "unchanged"]).toContain(outcome);
    }
    // The serving generation is the release, so a later sync is unchanged.
    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "unchanged",
      failureCode: null,
    });

    const later = buildRelease({
      version: "2026-07-15.reused-bundled-skill",
      connectorSlug: "agora",
      label: "Reused bundled skill",
      mutateRuntime: (artifact) => {
        firstRecord(artifact.connectors, "connectors").skill = skill.descriptor;
      },
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

  it("advances on the next sync when active changes during validation", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    // The first attempt publishes the observed generation, so the next one
    // accepts the current pointer instead of reporting it unchanged.
    expect((await syncCatalog(app)).body).toMatchObject({
      outcome: "accepted",
    });
    expect((await syncCatalog(app)).body).toMatchObject({
      outcome: "accepted",
    });
  });
});

describe("connector catalog executable compatibility", () => {
  it("accepts inline confidential test clients and applies rollout at request time", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body.outcome).toBe("accepted");
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
    ).toStrictEqual({ connectors: [] });
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

  it("matches provider fields without pinning catalog storage names", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body.outcome).toBe("accepted");
    const served = await servedConnectors({
      [FeatureSwitchKey.DeelConnector]: true,
    });
    expect(served).toMatchObject([
      { slug: "deel", authMethods: [{ id: "oauth" }] },
    ]);
    expect(JSON.stringify(served)).not.toContain("CATALOG_DEEL_ACCESS_TOKEN");
  });
});

describe("connector catalog rejection and latest-valid retention", () => {
  it("accepts one connector sharing storage names across auth methods", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
  });

  it("accepts producer connector order and scopes private-value leak detection", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
  });

  it("accepts credentialed path variables without a host policy", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
  });

  it("accepts a shared fixed host for auth.base placeholder routes", async () => {
    const app = await setupApp({
      context,
      routes: cronConnectorCatalogRoutes,
      isolatePg: true,
    });
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

    expect((await syncCatalog(app)).body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
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
      connector: { target: { kind: "builtin", connectorSlug: "collision-a" } },
    });
  });

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
