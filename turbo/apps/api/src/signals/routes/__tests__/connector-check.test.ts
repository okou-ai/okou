import { randomUUID } from "node:crypto";

import {
  type ConnectorCheckRequest,
  type ConnectorCheckRequestBody,
  connectorCheckContract,
} from "@okouai/api-contracts/contracts/connector-check";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import {
  seedConnectorStorageRow,
  setConnectorDefaultState,
  setConnectorCredentialStorageState,
  setConnectorVariableOwner,
} from "./helpers/connector-credential-storage-state";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/org-membership";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { connectorCheckRoutes } from "../connector-check";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";

const TEST_APP_ROUTES = Object.freeze([
  ...connectorCheckRoutes,
  ...testCronCleanupSandboxesStateRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const runsApi = createRunsApi(context);
const store = createStore();

interface ConnectedFixture {
  readonly actor: ApiTestUser;
  readonly connectorSlug:
    | "cloudflare"
    | "github"
    | "reap"
    | "removed-connector";
}

const trackConnectedFixture = createFixtureTracker<ConnectedFixture>(
  async (fixture) => {
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      fixture.actor,
      fixture.connectorSlug,
    );
  },
);
const trackOrgMembershipFixture = createFixtureTracker<OrgMembershipFixture>(
  async (fixture) => {
    await store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

function client() {
  return setupApp({ context, routes: TEST_APP_ROUTES })(connectorCheckContract);
}

function stateClient() {
  return setupApp({ context, routes: TEST_APP_ROUTES })(
    testCronCleanupSandboxesStateContract,
  );
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  return actor.orgId;
}

async function checkWithSession(
  actor: ApiTestUser,
  body: ConnectorCheckRequest,
) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    client().check({
      headers: { authorization: "Bearer clerk-session" },
      body,
    }),
    [200],
  );
}

async function checkWithToken(token: string, body: ConnectorCheckRequestBody) {
  return await accept(
    client().check({
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
    [200],
  );
}

async function issueDevicePat(actor: ApiTestUser): Promise<string> {
  const started = await authDevice.startCliDevice();
  const approved = await authDevice.requestCliApproval(
    actor,
    { device_code: started.device_code },
    [200],
  );
  expect(approved.body).toStrictEqual({ success: true });

  const token = await authDevice.requestCliToken(started.device_code, [200]);
  if (token.status !== 200) {
    throw new Error(`Expected CLI token exchange, got ${token.status}`);
  }
  return token.body.access_token;
}

async function seedAdminMembership(actor: ApiTestUser): Promise<void> {
  await trackOrgMembershipFixture(
    store.set(
      seedOrgMembership$,
      {
        orgId: requireOrgId(actor),
        userId: actor.userId,
        role: "admin",
      },
      context.signal,
    ),
  );
}

function okouToken(
  actor: ApiTestUser,
  runId: string,
  capabilities: readonly string[],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: actor.userId,
    orgId: requireOrgId(actor),
    runId,
    capabilities,
    iat: seconds,
    exp: seconds + 600,
  });
}

async function connectReap(
  actor: ApiTestUser,
  apiBaseUrl: string,
): Promise<string> {
  const connector = await connectorsApi.connectManualGrant(
    actor,
    "reap",
    "api-token",
    {
      apiKey: "reap-test-api-key",
      apiBaseUrl,
    },
  );
  await trackConnectedFixture(
    Promise.resolve({ actor, connectorSlug: "reap" }),
  );
  return connector.id;
}

async function createOwnedRun(
  actor: ApiTestUser,
  options: {
    readonly builtinConnectorSlugs?: readonly string[];
    readonly customConnectorIds?: readonly string[];
  } = {},
): Promise<{ readonly runId: string; readonly agentId: string }> {
  bdd.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  runsApi.configureRunnerGroup();
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: `Connector check ${randomUUID()}`,
    visibility: "private",
  });
  if (options.builtinConnectorSlugs) {
    await runsApi.enableAgentConnectors(
      actor,
      agent.agentId,
      options.builtinConnectorSlugs,
    );
  }
  if (options.customConnectorIds) {
    await connectorsApi.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      options.customConnectorIds,
    );
  }
  const run = await runsApi.createRun(actor, {
    agentId: agent.agentId,
    prompt: "Create a connector check fixture",
    modelProvider: "anthropic-api-key",
  });
  return { runId: run.runId, agentId: agent.agentId };
}

beforeEach(() => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.axiom.query.mockResolvedValue([]);
});

describe("POST /api/connectors/diagnostics/check", () => {
  it("requires organization auth and both agent capabilities", async () => {
    const runBase = "https://prod.api.reap.global/v1";
    const body = {
      mode: "url" as const,
      method: "GET",
      url: `${runBase}/users`,
    };
    const unauthenticated = await accept(
      client().check({ headers: {}, body }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const withoutOrganization = await accept(
      client().check({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [401],
    );
    expect(withoutOrganization.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    await seedAdminMembership(actor);
    await connectReap(actor, runBase);
    const { runId } = await createOwnedRun(actor, {
      builtinConnectorSlugs: ["reap"],
    });
    const withoutConnectorRead = await accept(
      client().check({
        headers: {
          authorization: `Bearer ${okouToken(actor, runId, ["agent-run:read"])}`,
        },
        body,
      }),
      [403],
    );
    expect(withoutConnectorRead.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Missing required capability: connector:read",
    });

    const withoutRunRead = await accept(
      client().check({
        headers: {
          authorization: `Bearer ${okouToken(actor, runId, ["connector:read"])}`,
        },
        body,
      }),
      [403],
    );
    expect(withoutRunRead.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Missing required capability: agent-run:read",
    });

    context.mocks.axiom.query.mockRejectedValue(
      new Error("Axiom connector diagnostics must not be queried"),
    );
    const allowed = await checkWithToken(
      okouToken(actor, runId, ["connector:read", "agent-run:read"]),
      body,
    );
    expect(allowed.body).toMatchObject({
      outcome: "resolved",
      mode: "url",
      connector: {
        connectorSlug: "reap",
        label: "Reap",
      },
      run: { status: "configured" },
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "read",
            policy: { outcome: "allow", basis: "allow-list" },
          },
        ],
      },
    });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("enforces strict bodies and returns sanitized unsafe-input outcomes", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const malformed = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request("/api/connectors/diagnostics/check", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "url",
        method: "GET",
        url: "https://api.github.com/repos/vm0-ai/vm0",
        unexpected: true,
      }),
    });
    expect(malformed.status).toBe(400);

    const invalidMethod = await checkWithSession(actor, {
      mode: "url",
      method: "TRACE",
      url: "https://api.github.com/repos/vm0-ai/vm0",
    });
    expect(invalidMethod.body).toStrictEqual({
      outcome: "unsafe-input",
      reason: "invalid-method",
    });

    for (const url of [
      "api.github.com/repos/vm0-ai/vm0",
      "https://user@example.com/path",
      "https://api%2eexample.com/path",
      "https://例子.example/path",
      String.raw`https://example.com\path`,
      "https://example.com/has whitespace",
    ]) {
      const invalidUrl = await checkWithSession(actor, {
        mode: "url",
        method: "GET",
        url,
      });
      expect(invalidUrl.body).toStrictEqual({
        outcome: "unsafe-input",
        reason: "invalid-url",
      });
    }

    const unsafePath = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/%2e%2e/private",
    });
    expect(unsafePath.body).toStrictEqual({
      outcome: "unsafe-input",
      reason: "unsafe-path",
    });
  });

  it("accepts canonical connector identities", async () => {
    const actor = bdd.user();
    const base = {
      mode: "url" as const,
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
    };

    const canonical = await checkWithSession(actor, {
      ...base,
      connectorSlug: "github",
    });
    expect(canonical.body).toMatchObject({
      outcome: "resolved",
      connector: {
        connectorSlug: "github",
      },
    });
  });

  it("ignores stale stored connectors that are absent from the catalog", async () => {
    const actor = bdd.user();
    await seedConnectorStorageRow(context, {
      authMethod: "api",
      connectorSlug: "removed-connector",
      orgId: requireOrgId(actor),
      storageVersion: 1,
      userId: actor.userId,
    });
    await trackConnectedFixture(
      Promise.resolve({ actor, connectorSlug: "removed-connector" }),
    );

    const response = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
    });

    expect(response.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "github" },
    });
  });

  it("supports a real PAT and resolves hidden server-authored metadata without private refs", async () => {
    const actor = bdd.user();
    const token = await issueDevicePat(actor);
    const slack = await checkWithToken(token, {
      mode: "url",
      method: "POST",
      url: "https://slack.com/api/chat.postMessage?query-sentinel=secret#fragment-sentinel",
    });
    expect(slack.body).toMatchObject({
      outcome: "resolved",
      mode: "url",
      connector: {
        connectorSlug: "slack",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      run: { status: "not-scoped" },
      method: "POST",
      base: "https://slack.com/api",
      relativePath: "/chat.postMessage",
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "chat:write",
            policy: {
              outcome: "unavailable",
              basis: "not-run-scoped",
            },
          },
        ],
      },
    });
    const serializedSlack = JSON.stringify(slack.body);
    expect(serializedSlack).not.toContain("query-sentinel");
    expect(serializedSlack).not.toContain("fragment-sentinel");

    const hidden = await checkWithToken(token, {
      mode: "url",
      method: "GET",
      url: "https://tenant.preview.vm6.ai/api/test/oauth-provider/echo",
      connectorSlug: "test-oauth",
    });
    expect(hidden.body).toMatchObject({
      outcome: "resolved",
      connector: {
        connectorSlug: "test-oauth",
        label: "Test OAuth",
        visibility: "unavailable",
      },
      relativePath: "/echo",
    });
    expect(JSON.stringify(hidden.body)).not.toContain("vars.");
    expect(JSON.stringify(hidden.body)).not.toContain("TEST_OAUTH_TENANT_ID");
  });

  it("resolves environment aliases, ambiguity, and URL selectors deterministically", async () => {
    const actor = bdd.user();
    const knownEnvironment = await checkWithSession(actor, {
      mode: "environment",
      environmentName: "GH_TOKEN",
      permission: "contents:read",
    });
    expect(knownEnvironment.body).toStrictEqual({
      outcome: "resolved",
      mode: "environment",
      connector: {
        connectorSlug: "github",
        label: "GitHub",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      environmentName: "GH_TOKEN",
      run: { status: "not-scoped" },
      permission: { outcome: "unavailable", basis: "not-run-scoped" },
    });
    const siblingAlias = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      environmentName: "GH_TOKEN",
    });
    expect(siblingAlias.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "github" },
      environmentNames: ["GH_TOKEN"],
    });
    const unknownEnvironment = await checkWithSession(actor, {
      mode: "environment",
      environmentName: "UNKNOWN_CONNECTOR_VALUE",
    });
    expect(unknownEnvironment.body).toStrictEqual({
      outcome: "unknown-environment",
    });

    const nintendoUrl = "https://api.accounts.nintendo.com/2.0.0/users/me";
    const ambiguous = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: nintendoUrl,
    });
    expect(ambiguous.body).toStrictEqual({
      outcome: "ambiguous",
      candidates: [
        {
          connectorSlug: "nintendo-store",
          label: "Nintendo Store",
        },
        {
          connectorSlug: "nintendo-switch-parental-controls",
          label: "Nintendo Switch Parental Controls",
        },
      ],
    });

    const selected = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: nintendoUrl,
      connectorSlug: "nintendo-switch-parental-controls",
    });
    expect(selected.body).toMatchObject({
      outcome: "resolved",
      connector: {
        connectorSlug: "nintendo-switch-parental-controls",
      },
      environmentNames: ["NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN"],
    });

    const mismatch = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      connectorSlug: "slack",
    });
    expect(mismatch.body).toMatchObject({
      outcome: "connector-mismatch",
      connector: { connectorSlug: "github" },
    });

    const notOwned = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      environmentName: "SLACK_TOKEN",
    });
    expect(notOwned.body).toMatchObject({
      outcome: "environment-not-owned",
      connector: { connectorSlug: "github" },
    });

    const notUsed = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: nintendoUrl,
      connectorSlug: "nintendo-switch-parental-controls",
      environmentName: "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN",
    });
    expect(notUsed.body).toStrictEqual({
      outcome: "environment-not-used",
      connector: {
        connectorSlug: "nintendo-switch-parental-controls",
        label: "Nintendo Switch Parental Controls",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      environmentNames: ["NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN"],
    });

    const unknownConnector = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://example.com/path",
      connectorSlug: "missing-connector",
    });
    expect(unknownConnector.body).toStrictEqual({
      outcome: "unknown-connector",
    });

    const segmentBoundary = await checkWithSession(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com.evil.example/repos/vm0-ai/vm0",
    });
    expect(segmentBoundary.body).toStrictEqual({
      outcome: "no-match",
      scope: "catalog",
    });
  });

  it("uses one isolated stored-state snapshot for opaque dynamic bases", async () => {
    const owner = bdd.user();
    const orgId = requireOrgId(owner);
    const sameOrgOtherUser = bdd.user({ orgId });
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    const storedBase = "https://sandbox.api.reap.global/v1";
    const request = {
      mode: "url" as const,
      method: "GET",
      url: `${storedBase}/users`,
      connectorSlug: "reap",
    };

    const unresolved = await checkWithSession(owner, request);
    expect(unresolved.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorSlug: "reap" },
    });

    const reapConnectorId = await connectReap(owner, storedBase);
    const resolved = await checkWithSession(owner, request);
    expect(resolved.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "reap" },
      base: storedBase,
      relativePath: "/users",
      run: { status: "not-scoped" },
    });
    const serialized = JSON.stringify(resolved.body);
    expect(serialized).not.toContain("REAP_API_BASE_URL");
    expect(serialized).not.toContain("reap-test-api-key");

    await setConnectorDefaultState(context, {
      orgId,
      userId: owner.userId,
      connectorId: reapConnectorId,
      isDefault: false,
    });
    const nonDefault = await checkWithSession(owner, request);
    expect(nonDefault.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorSlug: "reap" },
    });
    await setConnectorDefaultState(context, {
      orgId,
      userId: owner.userId,
      connectorId: reapConnectorId,
      isDefault: true,
    });

    await setConnectorCredentialStorageState(context, {
      connectorSlug: "reap",
      orgId,
      storageVersion: 2,
      userId: owner.userId,
    });
    const incompatible = await checkWithSession(owner, request);
    expect(incompatible.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorSlug: "reap" },
    });
    await setConnectorCredentialStorageState(context, {
      connectorSlug: "reap",
      orgId,
      storageVersion: 1,
      userId: owner.userId,
    });
    await expect(checkWithSession(owner, request)).resolves.toMatchObject({
      body: { outcome: "resolved", base: storedBase },
    });

    const foreignConnectorId = await seedConnectorStorageRow(context, {
      authMethod: "oauth",
      connectorSlug: "github",
      orgId,
      storageVersion: 1,
      userId: owner.userId,
    });
    await trackConnectedFixture(
      Promise.resolve({ actor: owner, connectorSlug: "github" }),
    );
    await setConnectorVariableOwner(context, {
      connectorId: foreignConnectorId,
      name: "REAP_API_BASE_URL",
      orgId,
      userId: owner.userId,
    });
    const wrongOwner = await checkWithSession(owner, request);
    expect(wrongOwner.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorSlug: "reap" },
    });
    await setConnectorVariableOwner(context, {
      connectorId: reapConnectorId,
      name: "REAP_API_BASE_URL",
      orgId,
      userId: owner.userId,
    });
    await expect(checkWithSession(owner, request)).resolves.toMatchObject({
      body: { outcome: "resolved", base: storedBase },
    });

    for (const actor of [sameOrgOtherUser, sameUserOtherOrg]) {
      const isolated = await checkWithSession(actor, request);
      expect(isolated.body).toMatchObject({
        outcome: "unresolved-dynamic-base",
        connector: { connectorSlug: "reap" },
      });
    }
  });

  it("uses pinned builtin registration state with current permission and account authority", async () => {
    await withMockNowForTest(new Date("2026-09-07T08:00:00.000Z"), async () => {
      const owner = bdd.user();
      await seedAdminMembership(owner);
      const runBase = "https://prod.api.reap.global/v1";
      const changedBase = "https://changed.api.reap.global/v1";
      const connectorId = await connectReap(owner, runBase);
      const firewallApi = createFirewallApi(context);
      await firewallApi.provisionRunReadyOrg(owner);
      await firewallApi.seedTestConnector(owner, {
        connectorSlug: "cloudflare",
        authMethod: "oauth",
        accessToken: "cloudflare-test-access-token",
      });
      await trackConnectedFixture(
        Promise.resolve({ actor: owner, connectorSlug: "cloudflare" }),
      );
      const { runId, agentId } = await createOwnedRun(owner, {
        builtinConnectorSlugs: ["reap", "cloudflare"],
      });
      const request = {
        mode: "url" as const,
        method: "GET",
        url: `${runBase}/users`,
      };
      context.mocks.axiom.query.mockRejectedValue(
        new Error("Axiom connector diagnostics must not be queried"),
      );

      await runsApi.applyUserPermissionGrant(owner, {
        agentId,
        connectorSlug: "reap",
        permission: "read",
        action: "deny",
      });

      const initial = await checkWithToken(
        okouToken(owner, runId, ["connector:read", "agent-run:read"]),
        request,
      );
      expect(initial.body).toMatchObject({
        outcome: "resolved",
        connector: { connectorSlug: "reap" },
        run: { status: "configured", bases: [runBase] },
        base: runBase,
        permission: {
          kind: "matched",
          permissions: [
            {
              name: "read",
              policy: { outcome: "deny", basis: "deny-list" },
            },
          ],
        },
      });

      await runsApi.applyUserPermissionGrant(owner, {
        agentId,
        connectorSlug: "cloudflare",
        permission: "dns-firewall.write",
        action: "allow",
        expiresIn: "1h",
      });
      const expiringRequest = {
        mode: "url" as const,
        method: "POST",
        url: "https://api.cloudflare.com/client/v4/accounts/test/dns_firewall/rules",
      };
      const allowed = await checkWithToken(
        okouToken(owner, runId, ["connector:read", "agent-run:read"]),
        expiringRequest,
      );
      expect(allowed.body).toMatchObject({
        outcome: "resolved",
        connector: { connectorSlug: "cloudflare" },
        permission: {
          permissions: [
            {
              name: "dns-firewall.write",
              policy: { outcome: "allow", basis: "allow-list" },
            },
          ],
        },
      });

      mockNow(new Date("2026-09-07T09:00:00.000Z"));
      const expired = await checkWithToken(
        okouToken(owner, runId, ["connector:read", "agent-run:read"]),
        expiringRequest,
      );
      expect(expired.body).toMatchObject({
        outcome: "resolved",
        connector: { connectorSlug: "cloudflare" },
        permission: {
          permissions: [
            {
              name: "dns-firewall.write",
              policy: { outcome: "deny", basis: "deny-list" },
            },
          ],
        },
      });

      await connectorsApi.connectManualGrant(
        owner,
        "reap",
        "api-token",
        {
          apiKey: "reap-updated-api-key",
          apiBaseUrl: changedBase,
        },
        undefined,
        { intent: "reconnect", connectionId: connectorId },
      );
      await setConnectorDefaultState(context, {
        orgId: requireOrgId(owner),
        userId: owner.userId,
        connectorId,
        isDefault: false,
      });

      const pinned = await checkWithToken(
        okouToken(owner, runId, ["connector:read", "agent-run:read"]),
        request,
      );
      expect(pinned.body).toMatchObject({
        outcome: "resolved",
        base: runBase,
        run: { status: "configured", bases: [runBase] },
      });
      const changed = await checkWithToken(
        okouToken(owner, runId, ["connector:read", "agent-run:read"]),
        { ...request, url: `${changedBase}/users` },
      );
      expect(changed.body).toStrictEqual({ outcome: "no-match", scope: "run" });

      await setConnectorCredentialStorageState(context, {
        connectorSlug: "reap",
        orgId: requireOrgId(owner),
        storageVersion: 2,
        userId: owner.userId,
      });
      const unavailable = await checkWithToken(
        okouToken(owner, runId, ["connector:read", "agent-run:read"]),
        request,
      );
      expect(unavailable.body).toMatchObject({
        outcome: "resolved",
        connector: { connectorSlug: "reap" },
        run: { status: "configured", bases: [runBase] },
        permission: {
          permissions: [
            {
              name: "read",
              policy: {
                outcome: "unavailable",
                basis: "policies-unavailable",
              },
            },
          ],
        },
      });

      const intruder = bdd.user({ orgId: requireOrgId(owner) });
      await seedAdminMembership(intruder);
      const wrongOwner = await accept(
        client().check({
          headers: {
            authorization: `Bearer ${okouToken(intruder, runId, [
              "connector:read",
              "agent-run:read",
            ])}`,
          },
          body: request,
        }),
        [404],
      );
      expect(wrongOwner.body.error).toStrictEqual({
        code: "NOT_FOUND",
        message: "Agent run not found",
      });
      expect(context.mocks.axiom.query).not.toHaveBeenCalled();
      await setConnectorCredentialStorageState(context, {
        connectorSlug: "reap",
        orgId: requireOrgId(owner),
        storageVersion: 1,
        userId: owner.userId,
      });
      await setConnectorDefaultState(context, {
        orgId: requireOrgId(owner),
        userId: owner.userId,
        connectorId,
        isDefault: true,
      });
    });
  });

  it("keeps legacy requests builtin-only and resolves admitted custom targets on explicit requests", async () => {
    const actor = bdd.user();
    await seedAdminMembership(actor);
    const pinnedHost = "prod.api.reap.global";
    const changedHost = "changed.api.reap.global";
    const runBase = `https://${pinnedHost}/v1`;
    await connectReap(actor, runBase);

    const customBody = manualHttpCustomConnectorCreateBody({
      displayName: "Run Reap Overlay",
      slug: `_run-reap-overlay-${randomUUID().slice(0, 8)}`,
      prefixTemplates: ["https://{{variables.host}}/v1/"],
      permissionBundleRef: "builtin:slack@1",
    });
    const custom = await connectorsApi.createCustomConnector(actor, {
      ...customBody,
      fields: [
        ...customBody.fields,
        {
          key: "host",
          label: "Host",
          kind: "variable",
          required: true,
        },
      ],
    });
    const connectedCustom = await connectorsApi.setCustomConnectorValues(
      actor,
      custom.id,
      [
        { key: "secret", kind: "secret", value: "custom-secret-before" },
        { key: "host", kind: "variable", value: pinnedHost },
      ],
    );
    if (!connectedCustom.connectedAccountId) {
      throw new Error("Expected a connected custom connector account");
    }
    const customConnectionId = connectedCustom.connectedAccountId;
    const { runId, agentId } = await createOwnedRun(actor, {
      builtinConnectorSlugs: ["reap"],
      customConnectorIds: [custom.id],
    });
    const token = okouToken(actor, runId, ["connector:read", "agent-run:read"]);
    const url = `${runBase}/chat.postMessage`;
    context.mocks.axiom.query.mockRejectedValue(
      new Error("Axiom connector diagnostics must not be queried"),
    );

    const legacy = await checkWithToken(token, {
      mode: "url",
      method: "POST",
      url,
    });
    expect(legacy.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "reap" },
    });
    expect(JSON.stringify(legacy.body)).not.toContain(custom.id);

    const customRequest = {
      mode: "url" as const,
      method: "POST",
      url,
      target: { kind: "custom" as const, customConnectorId: custom.id },
    };
    const selected = await checkWithToken(token, customRequest);
    expect(selected.body).toMatchObject({
      outcome: "resolved",
      connector: {
        target: { kind: "custom", customConnectorId: custom.id },
        label: "Run Reap Overlay",
        visibility: "available",
        credentialResolution: "network-boundary",
      },
      run: { status: "configured", bases: [runBase] },
      base: runBase,
      relativePath: "/chat.postMessage",
      permission: {
        kind: "matched",
        permissions: [
          {
            name: "chat:write",
            policy: { outcome: "deny", basis: "deny-list" },
          },
        ],
      },
    });
    const serialized = JSON.stringify(selected.body);
    for (const forbidden of [
      "custom-secret-before",
      customConnectionId,
      "Authorization",
      "sourceId",
      "baseUrlVars",
      "networkPolicy",
      "secrets.secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const grantResponse =
      await connectorsApi.requestUpdateAgentCustomConnectorGrants(
        actor,
        agentId,
        [
          {
            customConnectorId: custom.id,
            permissionNames: ["chat:write"],
          },
        ],
        [200],
      );
    expect(grantResponse.status).toBe(200);
    const allowed = await checkWithToken(token, customRequest);
    expect(allowed.body).toMatchObject({
      permission: {
        permissions: [
          {
            name: "chat:write",
            policy: { outcome: "allow", basis: "allow-list" },
          },
        ],
      },
    });
    await runsApi.applyUserPermissionGrant(actor, {
      agentId,
      connectorSlug: "reap",
      permission: "write",
      action: "deny",
    });
    const includedCustom = await checkWithToken(token, {
      mode: "url",
      method: "POST",
      url,
      includeCustomConnectors: true,
    });
    expect(includedCustom.body).toMatchObject({
      outcome: "resolved",
      connector: {
        target: { kind: "custom", customConnectorId: custom.id },
        label: "Run Reap Overlay",
      },
      permission: {
        permissions: [
          {
            name: "chat:write",
            policy: { outcome: "allow", basis: "allow-list" },
          },
        ],
      },
    });

    await connectorsApi.setCustomConnectorValues(
      actor,
      custom.id,
      [
        { key: "secret", kind: "secret", value: "custom-secret-after" },
        { key: "host", kind: "variable", value: changedHost },
      ],
      { intent: "reconnect", connectionId: customConnectionId },
    );
    await connectorsApi.updateCustomConnector(actor, custom.id, {
      displayName: "Updated Run Reap Overlay",
      prefixTemplates: ["https://{{variables.host}}/v2/"],
      fields: connectedCustom.fields,
      headerInjections: customBody.headerInjections,
      queryInjections: customBody.queryInjections,
      permissionBundleRef: customBody.permissionBundleRef,
    });
    const updatedCustomRequest = {
      ...customRequest,
      url: `https://${pinnedHost}/v2/chat.postMessage`,
    };
    const pinned = await checkWithToken(token, updatedCustomRequest);
    expect(pinned.body).toMatchObject({
      outcome: "resolved",
      connector: { label: "Updated Run Reap Overlay" },
      base: `https://${pinnedHost}/v2`,
      run: {
        status: "configured",
        bases: [`https://${pinnedHost}/v2`],
      },
    });
    const changedBase = await checkWithToken(token, {
      ...updatedCustomRequest,
      url: `https://${changedHost}/v2/chat.postMessage`,
    });
    expect(changedBase.body).toStrictEqual({
      outcome: "no-match",
      scope: "run",
    });

    const addedAfterLaunch = await connectorsApi.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        displayName: "Added After Launch",
        slug: `_added-after-launch-${randomUUID().slice(0, 8)}`,
        prefixTemplates: ["https://after-launch.example.test/"],
      }),
    );
    const notAdmitted = await checkWithToken(token, {
      mode: "url",
      method: "GET",
      url: "https://after-launch.example.test/items",
      target: {
        kind: "custom",
        customConnectorId: addedAfterLaunch.id,
      },
    });
    expect(notAdmitted.body).toStrictEqual({
      outcome: "target-unavailable",
      target: { kind: "custom", customConnectorId: addedAfterLaunch.id },
      reason: "not-admitted",
    });

    await connectorsApi.deleteCustomConnector(actor, custom.id);
    const deleted = await checkWithToken(token, updatedCustomRequest);
    expect(deleted.body).toStrictEqual({
      outcome: "target-unavailable",
      target: { kind: "custom", customConnectorId: custom.id },
      reason: "connector-unavailable",
    });
    await connectorsApi.deleteCustomConnector(actor, addedAfterLaunch.id);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("propagates malformed registration and distinguishes missing from terminal state", async () => {
    const actor = bdd.user();
    await seedAdminMembership(actor);
    const { runId } = await createOwnedRun(actor);
    const token = okouToken(actor, runId, ["connector:read", "agent-run:read"]);

    await accept(
      stateClient().action({
        body: {
          action: "corrupt-connector-diagnostic-registration",
          run_id: runId,
        },
      }),
      [200],
    );
    const malformed = await accept(
      client().check({
        headers: { authorization: `Bearer ${token}` },
        body: {
          mode: "environment",
          environmentName: "GH_TOKEN",
        },
      }),
      [500],
    );
    expect(malformed.body).toStrictEqual({ error: "Internal server error" });

    await accept(
      stateClient().action({
        body: {
          action: "delete-connector-diagnostic-registration",
          run_id: runId,
        },
      }),
      [200],
    );

    const legacy = await checkWithToken(token, {
      mode: "environment",
      environmentName: "GH_TOKEN",
    });
    expect(legacy.body).toStrictEqual({ outcome: "run-context-unavailable" });

    await accept(
      stateClient().action({
        body: {
          action: "transition-run-terminal",
          run_id: runId,
          status: "completed",
        },
      }),
      [200],
    );
    const terminal = await accept(
      client().check({
        headers: { authorization: `Bearer ${token}` },
        body: {
          mode: "environment",
          environmentName: "GH_TOKEN",
        },
      }),
      [404],
    );
    expect(terminal.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: "Agent run not found",
    });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();

    await accept(
      stateClient().action({
        body: { action: "delete-run", run_id: runId },
      }),
      [200],
    );
  });
});
