import { randomUUID } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  customConnectorByIdContract,
  type CreateCustomConnectorBody,
  type CustomConnectorAuthMode,
  type CustomConnectorMcpResponse,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  contentBundleDigest,
  contentBundleKey,
  readContentBundle,
} from "@okouai/core/content-bundle";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { customConnectorsRoutes } from "../custom-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

const OAUTH_FIELDS_MESSAGE =
  "OAuth custom connectors cannot declare fields; remove all fields and their template references";

type McpCreateBody = Extract<CreateCustomConnectorBody, { kind: "mcp" }>;
type McpUpdateBody = Extract<UpdateCustomConnectorBody, { kind: "mcp" }>;
type HttpCreateBody = Exclude<CreateCustomConnectorBody, { kind: "mcp" }>;

interface StoredArchive {
  readonly key: string;
  readonly body: Buffer;
  readonly ifNoneMatch: string | undefined;
}

/** Object storage that keeps published archives until it becomes unavailable. */
function useObjectStorage() {
  const archives: StoredArchive[] = [];
  let available = true;
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (!available) {
      return Promise.reject(
        Object.assign(new Error("Object storage is unavailable"), {
          name: "ServiceUnavailable",
          $metadata: { httpStatusCode: 503 },
        }),
      );
    }
    if (command instanceof HeadObjectCommand) {
      const stored = archives.some((archive) => {
        return archive.key === command.input.Key;
      });
      return stored
        ? Promise.resolve({})
        : Promise.reject(
            Object.assign(new Error("Not found"), {
              name: "NotFound",
              $metadata: { httpStatusCode: 404 },
            }),
          );
    }
    if (command instanceof PutObjectCommand) {
      const { Body, Key, IfNoneMatch } = command.input;
      if (!(Body instanceof Uint8Array) || Key === undefined) {
        throw new Error("Expected a keyed binary archive");
      }
      archives.push({
        key: Key,
        body: Buffer.from(Body),
        ifNoneMatch: IfNoneMatch,
      });
      return Promise.resolve({ ETag: '"archive"' });
    }
    throw new Error("Unexpected object storage command");
  });
  return {
    archives,
    makeUnavailable() {
      available = false;
    },
  };
}

function uniqueHost(label: string): string {
  return `${label}-${randomUUID()}.example.test`;
}

/** Repeated values, an empty value, percent-encoding, a literal plus and `%2f`. */
function endpointWithQuery(): string {
  return `https://${uniqueHost("mcp")}/v1/mcp?tag=a&tag=b&empty=&q=caf%C3%A9%20menu&sum=1+2&path=docs%2fapi`;
}

function oauthConfig() {
  return {
    providerAdapter: "standard" as const,
    clientId: "auth-modes-client",
    authorizationUrl: "https://identity.example.test/oauth/authorize",
    tokenUrl: "https://identity.example.test/oauth/token",
    tokenEndpointAuthMethod: "client_secret_post" as const,
    pkceMethod: "S256" as const,
    scopes: ["mcp.read", "mcp.write"],
    authorizationParams: { audience: "https://mcp.example.test" },
  };
}

function mcpAuth(
  mode: CustomConnectorAuthMode,
  clientSecret?: string,
): Pick<
  McpCreateBody,
  "authMode" | "fields" | "headerInjections" | "queryInjections" | "oauthConfig"
> {
  if (mode === "manual") {
    return {
      authMode: "manual",
      fields: [
        { key: "token", label: "Token", kind: "secret", required: true },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.token}}" },
      ],
      queryInjections: [],
    };
  }
  if (mode === "oauth") {
    return {
      authMode: "oauth",
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      queryInjections: [],
      oauthConfig: {
        ...oauthConfig(),
        ...(clientSecret === undefined ? {} : { clientSecret }),
      },
    };
  }
  return {
    authMode: mode,
    fields: [],
    headerInjections: [],
    queryInjections: [],
  };
}

function mcpBody(args: {
  readonly endpoint: string;
  readonly mode: CustomConnectorAuthMode;
  readonly clientSecret?: string;
  readonly skillMarkdown?: string | null;
}): McpUpdateBody {
  return {
    kind: "mcp",
    displayName: "Research MCP",
    endpoint: args.endpoint,
    transport: "streamable-http",
    ...mcpAuth(args.mode, args.clientSecret),
    ...(args.skillMarkdown === undefined
      ? {}
      : { skillMarkdown: args.skillMarkdown }),
  };
}

function httpOAuthBody(displayName: string): HttpCreateBody {
  return {
    displayName,
    prefixTemplates: [`https://${uniqueHost("api")}/v1/`],
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    queryInjections: [],
    authMode: "oauth",
    oauthConfig: { ...oauthConfig(), clientSecret: `secret-${randomUUID()}` },
  };
}

function expectMcp(
  connector: CustomConnectorResponse,
): CustomConnectorMcpResponse {
  if (connector.kind !== "mcp") {
    throw new Error("Expected an MCP custom connector");
  }
  return connector;
}

function errorOf(body: unknown): { readonly code: string; message: string } {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null ||
    !("code" in body.error) ||
    !("message" in body.error) ||
    typeof body.error.code !== "string" ||
    typeof body.error.message !== "string"
  ) {
    throw new Error("Expected an API error body");
  }
  return { code: body.error.code, message: body.error.message };
}

async function createMcp(
  admin: ApiTestUser,
  body: McpUpdateBody,
): Promise<CustomConnectorMcpResponse> {
  return expectMcp(await connectors.createCustomConnector(admin, body));
}

async function readMcp(admin: ApiTestUser, id: string) {
  return expectMcp(await connectors.readCustomConnector(admin, id));
}

async function updateMcp(admin: ApiTestUser, id: string, body: McpUpdateBody) {
  return expectMcp(await connectors.updateCustomConnector(admin, id, body));
}

/** Create, read, list and Skill-only update of one streamable HTTP MCP connector. */
async function roundTripEndpointQuery(mode: CustomConnectorAuthMode) {
  const admin = bdd.user();
  const endpoint = endpointWithQuery();
  const clientSecret = `secret-${randomUUID()}`;
  const initialSkill = mode === "oauth" ? "Use the research tools." : null;
  const created = await createMcp(
    admin,
    mcpBody({ endpoint, mode, clientSecret, skillMarkdown: initialSkill }),
  );
  const detail = await readMcp(admin, created.id);
  const listed = await connectors.listCustomConnectors(admin);
  const updated = await updateMcp(
    admin,
    created.id,
    mcpBody({ endpoint, mode, skillMarkdown: "Prefer cited sources." }),
  );
  const final = await readMcp(admin, created.id);

  for (const connector of [created, detail, updated, final]) {
    expect(connector.id).toBe(created.id);
    expect(connector.endpoint).toBe(endpoint);
    expect(connector.authMode).toBe(mode);
  }
  expect(listed).toStrictEqual([detail]);
  expect(detail.skillMarkdown ?? null).toBe(initialSkill);
  expect(updated.skillMarkdown).toBe("Prefer cited sources.");
  expect(updated.storageVersion).toBe(created.storageVersion);
  expect(final).toStrictEqual(updated);
  return { clientSecret, created, detail, listed, updated, final };
}

/** Moves a static OAuth MCP connector to `mode` and back to OAuth twice. */
async function switchOAuthModeAndBack(mode: "none" | "manual" | "automatic") {
  const admin = bdd.user();
  const endpoint = `https://${uniqueHost("mcp")}/mcp?tenant=acme`;
  const created = await createMcp(
    admin,
    mcpBody({
      endpoint,
      mode: "oauth",
      clientSecret: `secret-${randomUUID()}`,
    }),
  );

  const switched = await updateMcp(
    admin,
    created.id,
    mcpBody({ endpoint, mode }),
  );
  const switchedDetail = await readMcp(admin, created.id);
  const restored = await updateMcp(
    admin,
    created.id,
    mcpBody({
      endpoint,
      mode: "oauth",
      clientSecret: `secret-${randomUUID()}`,
    }),
  );
  const restoredDetail = await readMcp(admin, created.id);
  const reapplied = await updateMcp(
    admin,
    created.id,
    mcpBody({ endpoint, mode: "oauth" }),
  );
  const reappliedDetail = await readMcp(admin, created.id);

  for (const connector of [
    switched,
    switchedDetail,
    restored,
    restoredDetail,
    reapplied,
    reappliedDetail,
  ]) {
    expect(connector.id).toBe(created.id);
    expect(connector.endpoint).toBe(endpoint);
  }
  return {
    switched: [switched, switchedDetail].map(authOf),
    restored: [restored, restoredDetail, reapplied, reappliedDetail].map(
      authOf,
    ),
  };
}

function authOf(connector: CustomConnectorMcpResponse) {
  return "oauthConfig" in connector
    ? { authMode: connector.authMode, oauthConfig: connector.oauthConfig }
    : { authMode: connector.authMode };
}

function restoredOAuth() {
  return Array.from({ length: 4 }, () => {
    return { authMode: "oauth", oauthConfig: oauthConfig() };
  });
}

describe("Custom connector authentication modes", () => {
  it("custom-connector-auth-modes-017 rejects an insecure HTTP MCP endpoint without echoing it", async () => {
    const admin = bdd.user();
    const endpoint = "http://mcp.example.test/server?hl=en";

    const response = await connectors.requestCreateCustomConnector(
      admin,
      mcpBody({ endpoint, mode: "none" }),
      [400],
    );

    const error = errorOf(response.body);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).not.toContain(endpoint);
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
  });

  it("custom-connector-auth-modes-020 rejects a loopback MCP endpoint without echoing it", async () => {
    const admin = bdd.user();
    const endpoint = "https://127.0.0.1/server?hl=en";

    const response = await connectors.requestCreateCustomConnector(
      admin,
      mcpBody({ endpoint, mode: "none" }),
      [400],
    );

    const error = errorOf(response.body);
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).not.toContain(endpoint);
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
  });

  it("custom-connector-auth-modes-027 rejects an HTTP firewall prefix with a query", async () => {
    const admin = bdd.user();

    const response = await connectors.requestCreateCustomConnector(
      admin,
      {
        displayName: "Query prefix",
        prefixTemplates: [`https://${uniqueHost("api")}/v1/?token=public`],
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "none",
      },
      [400],
    );

    expect(errorOf(response.body).code).toBe("BAD_REQUEST");
  });

  it("custom-connector-auth-modes-004 rejects member fields on HTTP OAuth creation", async () => {
    const admin = bdd.user();
    const body = httpOAuthBody("Regional OAuth");

    const response = await connectors.requestCreateCustomConnector(
      admin,
      {
        ...body,
        fields: [
          { key: "region", label: "Region", kind: "variable", required: true },
        ],
        headerInjections: [
          ...body.headerInjections,
          { name: "X-Region", valueTemplate: "{{variables.region}}" },
        ],
      },
      [400],
    );

    expect(errorOf(response.body).message).toBe(OAUTH_FIELDS_MESSAGE);
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
  });

  it("custom-connector-auth-modes-001 publishes one canonical Skill bundle and keeps identical updates working", async () => {
    const storage = useObjectStorage();
    const admin = bdd.user();
    const skillMarkdown =
      "# Café forecast ☀️  \n\nAsk für Wetter in 東京.\t\nKeep trailing spaces.   \n";
    const body: HttpCreateBody = {
      displayName: "Weather",
      prefixTemplates: [`https://${uniqueHost("weather")}/v1/`],
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "none",
      skillMarkdown,
    };

    const created = await connectors.createCustomConnector(admin, body);
    const detail = await connectors.readCustomConnector(admin, created.id);
    storage.makeUnavailable();
    const updated = await connectors.updateCustomConnector(
      admin,
      created.id,
      body,
    );

    expect(detail.skillMarkdown).toBe(skillMarkdown);
    expect(storage.archives).toHaveLength(1);
    const [archive] = storage.archives;
    if (!archive) {
      throw new Error("Expected one published archive");
    }
    expect(archive.ifNoneMatch).toBe("*");
    const sha256 = contentBundleDigest(archive.body);
    expect(archive.key).toBe(contentBundleKey(sha256));
    const files = readContentBundle(archive.body, {
      sha256,
      archiveBytes: archive.body.byteLength,
    });
    const skill = files.find((file) => {
      return file.path === "SKILL.md";
    });
    expect(skill?.content.toString("utf8")).toContain(skillMarkdown.trim());
    expect(updated.id).toBe(created.id);
    expect(updated.skillMarkdown).toBe(skillMarkdown);
  });

  it("custom-connector-auth-modes-008 keeps an HTTP OAuth definition when field updates are rejected", async () => {
    const admin = bdd.user();
    const body = httpOAuthBody("Static OAuth");
    const created = await connectors.createCustomConnector(admin, body);
    const regionField = {
      key: "region",
      label: "Region",
      kind: "variable" as const,
      required: false,
    };
    const regionHeader = {
      name: "X-Region",
      valueTemplate: "{{variables.region}}",
    };

    const explicit = await connectors.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        ...body,
        oauthConfig: oauthConfig(),
        fields: [regionField],
        headerInjections: [...body.headerInjections, regionHeader],
      },
      [400],
    );
    const afterExplicit = await connectors.readCustomConnector(
      admin,
      created.id,
    );
    const inherited = await connectors.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        displayName: body.displayName,
        prefixTemplates: body.prefixTemplates,
        fields: [regionField],
        headerInjections: [...body.headerInjections, regionHeader],
        queryInjections: [],
      },
      [400],
    );
    const afterInherited = await connectors.readCustomConnector(
      admin,
      created.id,
    );
    const renamed = await connectors.updateCustomConnector(admin, created.id, {
      ...body,
      displayName: "Renamed OAuth",
      oauthConfig: oauthConfig(),
    });

    expect(errorOf(explicit.body).message).toBe(OAUTH_FIELDS_MESSAGE);
    expect(errorOf(inherited.body).message).toBe(OAUTH_FIELDS_MESSAGE);
    expect(afterExplicit).toStrictEqual(created);
    expect(afterInherited).toStrictEqual(created);
    expect(renamed).toMatchObject({
      id: created.id,
      displayName: "Renamed OAuth",
      fields: [],
      storageVersion: created.storageVersion,
    });
  });

  it("custom-connector-auth-modes-010 requires removing member fields when an HTTP definition becomes OAuth", async () => {
    const admin = bdd.user();
    const prefixTemplates = [`https://${uniqueHost("api")}/v1/`];
    const created = await connectors.createCustomConnector(admin, {
      displayName: "Regional API",
      prefixTemplates,
      fields: [
        { key: "region", label: "Region", kind: "variable", required: true },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Region {{variables.region}}" },
      ],
      queryInjections: [],
      authMode: "manual",
    });

    const rejected = await connectors.requestUpdateCustomConnector(
      admin,
      created.id,
      {
        displayName: "Regional API",
        prefixTemplates,
        fields: created.fields,
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{oauth.access_token}}",
          },
          { name: "X-Region", valueTemplate: "{{variables.region}}" },
        ],
        queryInjections: [],
        authMode: "oauth",
        oauthConfig: {
          ...oauthConfig(),
          clientSecret: `secret-${randomUUID()}`,
        },
      },
      [400],
    );
    const unchanged = await connectors.readCustomConnector(admin, created.id);
    const converted = await connectors.updateCustomConnector(
      admin,
      created.id,
      httpOAuthBodyFor(prefixTemplates),
    );

    expect(errorOf(rejected.body).message).toBe(OAUTH_FIELDS_MESSAGE);
    expect(unchanged).toStrictEqual(created);
    expect(converted).toMatchObject({
      id: created.id,
      authMode: "oauth",
      fields: [],
      storageVersion: created.storageVersion + 1,
    });
  });

  it("custom-connector-auth-modes-012 keeps a none MCP endpoint query byte for byte", async () => {
    const { created, final } = await roundTripEndpointQuery("none");

    expect(created).not.toHaveProperty("oauthConfig");
    expect(final).not.toHaveProperty("oauthConfig");
  });

  it("custom-connector-auth-modes-013 keeps a manual MCP endpoint query byte for byte", async () => {
    const { created, final } = await roundTripEndpointQuery("manual");

    expect(created).not.toHaveProperty("oauthConfig");
    expect(final).not.toHaveProperty("oauthConfig");
  });

  it("custom-connector-auth-modes-014 keeps an OAuth MCP endpoint query byte for byte without the client secret", async () => {
    const { clientSecret, created, detail, listed, updated, final } =
      await roundTripEndpointQuery("oauth");

    for (const connector of [created, detail, updated, final]) {
      expect(connector.oauthConfig).toStrictEqual(oauthConfig());
    }
    expect(
      JSON.stringify([created, detail, listed, updated, final]),
    ).not.toContain(clientSecret);
  });

  it("custom-connector-auth-modes-015 keeps an automatic MCP endpoint query byte for byte", async () => {
    const { created, final } = await roundTripEndpointQuery("automatic");

    expect(created).not.toHaveProperty("oauthConfig");
    expect(final).not.toHaveProperty("oauthConfig");
  });

  it("custom-connector-auth-modes-016 preserves a host-only endpoint across a query-only edit", async () => {
    const admin = bdd.user();
    const host = `h${randomUUID().slice(0, 8)}.example.test`;
    const endpoint = `https://${host}?hl=en`;
    const nextEndpoint = `https://${host}?tag=a&tag=b&preview&path=docs%2Fapi&q=a+b`;

    const created = await createMcp(admin, mcpBody({ endpoint, mode: "none" }));
    const updated = await updateMcp(
      admin,
      created.id,
      mcpBody({ endpoint: nextEndpoint, mode: "none" }),
    );
    const detail = await readMcp(admin, created.id);

    expect(created.endpoint).toBe(endpoint);
    expect(created.slug).toMatch(/^_h[0-9a-f]{8}-example-test-[0-9a-f]{6}$/u);
    for (const connector of [updated, detail]) {
      expect(connector.id).toBe(created.id);
      expect(connector.slug).toBe(created.slug);
      expect(connector.endpoint).toBe(nextEndpoint);
    }
  });

  it("custom-connector-auth-modes-028 switches OAuth to none and back", async () => {
    const { switched, restored } = await switchOAuthModeAndBack("none");

    expect(switched).toStrictEqual([
      { authMode: "none" },
      { authMode: "none" },
    ]);
    expect(restored).toStrictEqual(restoredOAuth());
  });

  it("custom-connector-auth-modes-029 switches OAuth to manual and back", async () => {
    const { switched, restored } = await switchOAuthModeAndBack("manual");

    expect(switched).toStrictEqual([
      { authMode: "manual" },
      { authMode: "manual" },
    ]);
    expect(restored).toStrictEqual(restoredOAuth());
  });

  it("custom-connector-auth-modes-031 switches OAuth to automatic and back", async () => {
    const { switched, restored } = await switchOAuthModeAndBack("automatic");

    expect(switched).toStrictEqual([
      { authMode: "automatic" },
      { authMode: "automatic" },
    ]);
    expect(restored).toStrictEqual(restoredOAuth());
  });

  it("custom-connector-auth-modes-032 removes a deleted OAuth definition from public reads", async () => {
    const admin = bdd.user();
    const created = await createMcp(
      admin,
      mcpBody({
        endpoint: `https://${uniqueHost("mcp")}/mcp`,
        mode: "oauth",
        clientSecret: `secret-${randomUUID()}`,
      }),
    );

    await connectors.deleteCustomConnector(admin, created.id);
    createRouteMocks(context).clerk.session(
      admin.userId,
      admin.orgId,
      admin.orgRole,
    );
    const detail = await accept(
      setupApp({ context, routes: customConnectorsRoutes })(
        customConnectorByIdContract,
      ).get({
        params: { id: created.id },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(errorOf(detail.body).code).toBe("NOT_FOUND");
    await expect(connectors.listCustomConnectors(admin)).resolves.toStrictEqual(
      [],
    );
  });
});

function httpOAuthBodyFor(prefixTemplates: string[]): HttpCreateBody {
  return {
    displayName: "Regional API",
    prefixTemplates,
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    queryInjections: [],
    authMode: "oauth",
    oauthConfig: { ...oauthConfig(), clientSecret: `secret-${randomUUID()}` },
  };
}
