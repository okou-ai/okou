import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { delay } from "signal-timers";
import { describe, expect, it, onTestFinished } from "vitest";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  setSecretKmsClientForTests,
  type SecretKmsClient,
  type SecretKmsDataKey,
  type SecretKmsGenerateDataKeyRequest,
} from "../../../lib/secret-kms-client";
import { now } from "../../../lib/time";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settle } from "../../utils";
import {
  basicTemplate,
  createFirewallApi,
  secretTemplate,
  varTemplate,
} from "./helpers/api-bdd-firewall";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
  mockAwsExternalCodeProvider,
  mockTestOAuthAuthCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import {
  transitionRunToTerminal,
  transitionRunToTimeout,
  type TestTerminalRunStatus,
} from "./helpers/api-bdd-run-timeout";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  setConnectorCredentialStorageState,
  setBuiltinOAuthScopeFacts,
} from "./helpers/connector-credential-storage-state";

const ORG_SENTINEL_USER_ID = "__org__";
const TEST_DATA_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

/**
 * HOOK-02 / FW: firewall auth template resolution and connector refresh
 * through POST /api/webhooks/agent/firewall/auth.
 *
 * Given state is constructed through public routes. The narrow test-only
 * connector credential state route is used only for persisted metadata that
 * an old deployment can leave behind but no production API exposes.
 *
 * Unreachable through public APIs (kept out of this file deliberately):
 * - Advisory-lock concurrency branches (locked refresh divergence and
 *   mid-request row deletion) need pg locks or row deletes.
 * - TOKEN_ACCESS_RESOLUTION_FAILED needs a current token whose backing secret
 *   row is missing; public seeding writes both atomically.
 * - The 402/5s low-credit billable lease needs a public API that drains an
 *   org's credits below the threshold while keeping the tier active.
 */

const context = testContext();
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const satisfies readonly TestTerminalRunStatus[];

async function firewallRun(existingActor?: ApiTestUser): Promise<{
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly headers: { readonly authorization: string };
}> {
  const bdd = createBddApi(context);
  const runsApi = createRunsApi(context);
  const fw = createFirewallApi(context);
  const actor = existingActor ?? bdd.user();
  bdd.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  runsApi.configureRunnerGroup();
  await fw.provisionRunReadyOrg(actor);
  await runsApi.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD firewall agent",
    description: "Exercises firewall auth resolution.",
    visibility: "private",
  });
  const run = await runsApi.createRun(actor, {
    agentId: agent.agentId,
    prompt: "resolve firewall auth",
    modelProvider: "anthropic-api-key",
  });
  return {
    actor,
    runId: run.runId,
    headers: fw.sandboxHeaders(actor, run.runId),
  };
}

async function exactSecretConnectorSources(
  actor: ApiTestUser,
  sources: Readonly<Record<string, ConnectorSlug>>,
  platformSecretNames: readonly string[] = [],
): Promise<{
  readonly secretConnectorMap: Readonly<Record<string, ConnectorSlug>>;
  readonly secretConnectorMetadataMap: Readonly<
    Record<
      string,
      | { readonly sourceType: "connector"; readonly sourceId: string }
      | { readonly sourceType: "platform-secret" }
    >
  >;
}> {
  const connectors = createConnectorBddApi(context);
  const entries = await Promise.all(
    Object.entries(sources).map(async ([secretName, connectorSlug]) => {
      const metadata = !platformSecretNames.includes(secretName)
        ? {
            sourceType: "connector" as const,
            sourceId: (
              await connectors.readConnectorBySlug(actor, connectorSlug)
            ).id,
          }
        : { sourceType: "platform-secret" as const };
      return [secretName, { connectorSlug, metadata }] as const;
    }),
  );
  return {
    secretConnectorMap: Object.fromEntries(
      entries.map(([secretName, source]) => {
        return [secretName, source.connectorSlug];
      }),
    ),
    secretConnectorMetadataMap: Object.fromEntries(
      entries.map(([secretName, source]) => {
        return [secretName, source.metadata];
      }),
    ),
  };
}

function gateFirstStoredSecretDecrypt(): {
  readonly started: Promise<void>;
  readonly release: () => void;
} {
  const started = createDeferredPromise<void>(context.signal);
  const resume = createDeferredPromise<void>(context.signal);
  let decryptCalls = 0;
  const release = (): void => {
    if (!resume.settled()) {
      resume.resolve(undefined);
    }
  };
  onTestFinished(release);

  const client: SecretKmsClient = {
    generateDataKey(
      request: SecretKmsGenerateDataKeyRequest,
    ): Promise<SecretKmsDataKey> {
      return Promise.resolve({
        keyId: request.keyId,
        plaintext: TEST_DATA_KEY,
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${request.keyId}`,
          "utf8",
        ),
      });
    },
    async decrypt(): Promise<Uint8Array> {
      decryptCalls += 1;
      // The encrypted request payload is first. The second decrypt starts after
      // the connector credential SELECT has captured its statement snapshot.
      if (decryptCalls === 2) {
        started.resolve(undefined);
        await resume.promise;
      }
      return TEST_DATA_KEY;
    },
  };
  setSecretKmsClientForTests(client);
  return { started: started.promise, release };
}

describe("FW-1: firewall auth boundaries", () => {
  it("rejects missing, malformed, and runless firewall auth requests", async () => {
    const fw = createFirewallApi(context);
    const bdd = createBddApi(context);
    const outsider = bdd.user();
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {},
    };

    const missingAuth = await fw.requestFirewallAuth({}, body, [401]);
    expectApiError(missingAuth.body);

    const junkToken = await fw.requestFirewallAuth(
      { authorization: "Bearer junk" },
      body,
      [401],
    );
    expectApiError(junkToken.body);

    const headers = fw.sandboxHeaders(outsider, randomUUID());
    const invalidJson = await fw.requestFirewallAuthRaw("not json", headers);
    expect(invalidJson.status).toBe(400);

    const missingFields = await fw.requestFirewallAuthRaw(
      JSON.stringify({ authHeaders: {} }),
      headers,
    );
    expect(missingFields.status).toBe(400);

    const missingRun = await fw.requestFirewallAuth(headers, body, [400]);
    expectApiError(missingRun.body);
    expect(missingRun.body.error.message).toContain("Run not found");
  });

  it("rejects undecryptable secret payloads for a real run", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const garbage = await fw.requestFirewallAuth(
      headers,
      { encryptedSecrets: "garbage", authHeaders: {} },
      [400],
    );
    expectApiError(garbage.body);
    expect(garbage.body.error.message).toContain("Failed to decrypt");
  });
});

describe("FW-2: template resolution without connector refresh", () => {
  it("resolves secret, var, and basic templates across headers, base, and query", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          API_KEY: "secret-value",
          BASIC_USER: "alice",
          BASE_SECRET: "base-secret",
          QUERY_SECRET: "query-secret",
          SCRAPENINJA_TOKEN: "rapidapi-secret",
          SHARED: "secret-shared",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
          "X-RapidAPI-Host": "scrapeninja.p.rapidapi.com",
          "X-RapidAPI-Key": secretTemplate("SCRAPENINJA_TOKEN"),
          "X-Tenant": varTemplate("TENANT"),
          "X-Basic": basicTemplate("secrets.BASIC_USER", "vars.BASIC_PASS"),
          "X-Literal-Basic": basicTemplate('"alice"', '"literal-pass"'),
          "X-Shared": `${secretTemplate("SHARED")}:${varTemplate("SHARED")}`,
        },
        authBase: `https://api.example.test/${secretTemplate("BASE_SECRET")}`,
        authQuery: { token: secretTemplate("QUERY_SECRET") },
        vars: {
          TENANT: "tenant-1",
          BASIC_PASS: "var-pass",
          SHARED: "var-shared",
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected firewall auth resolution to succeed");
    }
    expect(resolved.body.headers.Authorization).toBe("Bearer secret-value");
    expect(resolved.body.headers["X-RapidAPI-Host"]).toBe(
      "scrapeninja.p.rapidapi.com",
    );
    expect(resolved.body.headers["X-RapidAPI-Key"]).toBe("rapidapi-secret");
    expect(resolved.body.headers["X-Tenant"]).toBe("tenant-1");
    expect(resolved.body.headers["X-Basic"]).toBe(
      `Basic ${Buffer.from("alice:var-pass").toString("base64")}`,
    );
    expect(resolved.body.headers["X-Literal-Basic"]).toBe(
      `Basic ${Buffer.from("alice:literal-pass").toString("base64")}`,
    );
    expect(resolved.body.headers["X-Shared"]).toBe("secret-shared:var-shared");
    expect(resolved.body.base).toBe("https://api.example.test/base-secret");
    expect(resolved.body.query).toStrictEqual({ token: "query-secret" });
    expect(resolved.body.expiresAt).toBeNull();
    expect(resolved.body.refreshedConnectors).toStrictEqual([]);
    expect(resolved.body.refreshedSecrets).toStrictEqual([]);
    expect(resolved.body.resolvedSecrets).toStrictEqual(
      [...resolved.body.resolvedSecrets].sort(),
    );
    expect(resolved.body.resolvedSecrets).toContain("BASE_SECRET");
    expect(resolved.body.resolvedSecrets).toContain("QUERY_SECRET");
    expect(resolved.body.resolvedSecrets).toContain("SCRAPENINJA_TOKEN");
  });

  it("reports unresolvable template references as connector-not-configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NEVER_SET")}`,
        },
        secretConnectorMap: {},
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected unresolved secret to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("uses pinned routing variables and current auth-only variables for builtin connectors", async () => {
    const fw = createFirewallApi(context);
    const connectorsApi = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    const jiraConnection = await connectorsApi.connectManualGrant(
      actor,
      "jira",
      "api-token",
      {
        apiToken: "current-jira-token",
        domain: "current.atlassian.net",
        email: "current@example.test",
      },
    );
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {
        "X-Domain": varTemplate("JIRA_DOMAIN"),
        "X-Email": varTemplate("JIRA_EMAIL"),
      },
      vars: {
        JIRA_DOMAIN: "run-start.atlassian.net",
        JIRA_EMAIL: "run-start@example.test",
      },
      matchedFirewall: {
        name: "jira",
        apiId: "jira:0",
        connectorSlug: "jira" as const,
        sourceId: jiraConnection.id,
        routingVariables: {
          JIRA_DOMAIN: "run-start.atlassian.net",
        },
      },
    };

    const resolved = await fw.requestFirewallAuth(headers, body, [200]);
    if (resolved.status !== 200) {
      throw new Error("Expected builtin connector auth resolution to succeed");
    }
    expect(resolved.body.headers).toStrictEqual({
      "X-Domain": "run-start.atlassian.net",
      "X-Email": "current@example.test",
    });

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "jira");
    const disconnected = await fw.requestFirewallAuth(headers, body, [424]);
    if (disconnected.status !== 424) {
      throw new Error("Expected disconnected builtin connector auth to fail");
    }
    expect(disconnected.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("passes literals through query templates and keeps basic-literal templates opaque", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    // The quoted basic arguments are literals: the embedded secret template
    // must neither be collected as a reference nor resolved, so the request
    // succeeds even though NEVER_SET is absent from the secret payload.
    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({ PASS: "pass-secret" }),
        authHeaders: {
          "X-Empty-Basic": basicTemplate("", ""),
          "X-Literal-Template": basicTemplate(
            `"${secretTemplate("NEVER_SET")}"`,
            "secrets.PASS",
          ),
          "X-Quoted-Namespace": basicTemplate('"secrets.PASS"', "secrets.PASS"),
        },
        authQuery: {
          token: "literal-query-value",
          workspace: varTemplate("WORKSPACE_ID"),
        },
        vars: { WORKSPACE_ID: "workspace-9" },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected the literal template resolution to succeed");
    }
    expect(resolved.body.headers["X-Empty-Basic"]).toBe(
      `Basic ${Buffer.from(":").toString("base64")}`,
    );
    expect(resolved.body.headers["X-Literal-Template"]).toBe(
      `Basic ${Buffer.from(`${secretTemplate("NEVER_SET")}:pass-secret`).toString("base64")}`,
    );
    expect(resolved.body.headers["X-Quoted-Namespace"]).toBe(
      `Basic ${Buffer.from("secrets.PASS:pass-secret").toString("base64")}`,
    );
    expect(resolved.body.query).toStrictEqual({
      token: "literal-query-value",
      workspace: "workspace-9",
    });
    expect(resolved.body.resolvedSecrets).toStrictEqual(["PASS"]);

    const withoutQuery = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: { Authorization: "Bearer static-token" },
      },
      [200],
    );
    if (withoutQuery.status !== 200) {
      throw new Error("Expected the query-less resolution to succeed");
    }
    expect(withoutQuery.body.query).toBeUndefined();
    expect(withoutQuery.body.headers.Authorization).toBe("Bearer static-token");
  });
});

describe("FW-3: billable firewall lease", () => {
  it("leases billable auth for limited-free-1 workspaces with spendable credits", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    if (!actor.orgId) {
      throw new Error("Expected firewall actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId ?? "",
      tier: "limited-free-1",
      credits: 20_000,
    });

    const before = Math.floor(now() / 1000);
    const leased = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
        },
        firewallBillable: true,
      },
      [200],
    );
    if (leased.status !== 200) {
      throw new Error("Expected limited-free-1 billable auth to succeed");
    }
    expect(leased.body.expiresAt).not.toBeNull();
    expect(leased.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 25);
    expect(leased.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 35);
  });

  it("denies billable auth for pro-suspend workspaces even with credits", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    if (!actor.orgId) {
      throw new Error("Expected firewall actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId ?? "",
      tier: "pro-suspend",
      credits: 20_000,
    });

    const denied = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
        },
        firewallBillable: true,
      },
      [402],
    );
    if (denied.status !== 402) {
      throw new Error("Expected pro-suspend billable auth to be denied");
    }
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("does not refresh an expired connector when billable auth is denied", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    let refreshRequests = 0;
    fw.mockTestOauthTokenRefresh(() => {
      refreshRequests += 1;
      return fw.oauthTokenResponse({
        accessToken: "should-not-refresh",
        expiresIn: 3600,
      });
    });
    if (!actor.orgId) {
      throw new Error("Expected firewall actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 20_000,
    });

    const denied = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
        firewallBillable: true,
      },
      [402],
    );
    if (denied.status !== 402) {
      throw new Error("Expected billable connector auth to be denied");
    }
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(refreshRequests).toBe(0);
  });

  it("bounds billable auth expiry by the credit authorization lease", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const before = Math.floor(now() / 1000);
    const leased = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
        },
        firewallBillable: true,
      },
      [200],
    );
    if (leased.status !== 200) {
      throw new Error("Expected billable firewall auth to succeed");
    }
    expect(leased.body.expiresAt).not.toBeNull();
    expect(leased.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 25);
    expect(leased.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 35);
  });

  it("merges the billable lease with refreshed connector token expiries", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });

    // A long-lived refreshed token leaves the 30 s billable lease as the
    // earlier bound.
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "long-lived-access",
        expiresIn: 3600,
      });
    });
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
      firewallBillable: true,
    };
    const leaseBefore = Math.floor(now() / 1000);
    const leaseBound = await fw.requestFirewallAuth(headers, body, [200]);
    if (leaseBound.status !== 200) {
      throw new Error("Expected the long-lived billable refresh to succeed");
    }
    expect(leaseBound.body.headers.Authorization).toBe(
      "Bearer long-lived-access",
    );
    expect(leaseBound.body.expiresAt ?? 0).toBeGreaterThanOrEqual(
      leaseBefore + 25,
    );
    expect(leaseBound.body.expiresAt ?? 0).toBeLessThanOrEqual(
      leaseBefore + 35,
    );

    // A short-lived refreshed token undercuts the lease and becomes the
    // effective expiry.
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "short-lived-access",
        expiresIn: 5,
      });
    });
    const tokenBefore = Math.floor(now() / 1000);
    const tokenBound = await fw.requestFirewallAuth(
      headers,
      {
        ...body,
        // The forced snapshot must match the stored token, otherwise the
        // request is served from the concurrently refreshed current access.
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "long-lived-access",
        }),
        forceRefresh: true,
      },
      [200],
    );
    if (tokenBound.status !== 200) {
      throw new Error("Expected the short-lived billable refresh to succeed");
    }
    expect(tokenBound.body.headers.Authorization).toBe(
      "Bearer short-lived-access",
    );
    expect(tokenBound.body.expiresAt ?? 0).toBeGreaterThanOrEqual(
      tokenBefore + 1,
    );
    expect(tokenBound.body.expiresAt ?? 0).toBeLessThanOrEqual(
      tokenBefore + 10,
    );
  });

  it("continues billable firewall auth after subscription deletion when credits remain", async () => {
    const bdd = createBddApi(context);
    const runsApi = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const fw = createFirewallApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    runsApi.configureRunnerGroup();
    const granted = await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD billable suspension agent",
      visibility: "private",
    });
    const run = await runsApi.createRun(actor, {
      agentId: agent.agentId,
      prompt: "billable auth across a subscription deletion",
      modelProvider: "anthropic-api-key",
    });
    const headers = fw.sandboxHeaders(actor, run.runId);
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("API_KEY")}`,
      },
      firewallBillable: true,
    };

    const leased = await fw.requestFirewallAuth(headers, body, [200]);
    if (leased.status !== 200) {
      throw new Error("Expected the entitled billable auth to lease");
    }
    expect(leased.body.expiresAt).not.toBeNull();

    webhooks.configureStripeBillingEnv();
    await webhooks.postStripeEvent(
      {
        id: `evt_bdd_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: granted.subscriptionId, metadata: {} } },
      },
      [200],
    );

    const downgraded = await runsApi.readBillingStatus(actor);
    expect(downgraded.tier).toBe("limited-free-1");
    expect(downgraded.subscriptionStatus).toBe("canceled");

    const postDeletionBefore = Math.floor(now() / 1000);
    const postDeletionLease = await fw.requestFirewallAuth(
      headers,
      body,
      [200],
    );
    if (postDeletionLease.status !== 200) {
      throw new Error("Expected the limited-free-1 billable auth to lease");
    }
    expect(postDeletionLease.body.expiresAt).not.toBeNull();
    expect(postDeletionLease.body.expiresAt ?? 0).toBeGreaterThanOrEqual(
      postDeletionBefore + 25,
    );
    expect(postDeletionLease.body.expiresAt ?? 0).toBeLessThanOrEqual(
      postDeletionBefore + 35,
    );

    await runsApi.requestCancelRun(actor, run.runId, [200]);
  });

  it("denies billable firewall auth when the granted credits already expired", async () => {
    const bdd = createBddApi(context);
    const runsApi = createRunsApi(context);
    const fw = createFirewallApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    runsApi.configureRunnerGroup();
    // The credit expiry is the subscription period end plus one month, so a
    // period that ended two months ago yields a pro org whose entire balance
    // is expired but unsettled.
    await runsApi.grantProEntitlement(actor, {
      periodEndUnix: Math.floor(now() / 1000) - 60 * 86_400,
    });
    await runsApi.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD expired-credit billable agent",
      visibility: "private",
    });
    const run = await runsApi.createRun(actor, {
      agentId: agent.agentId,
      prompt: "billable auth with expired credits",
      modelProvider: "anthropic-api-key",
    });

    const denied = await fw.requestFirewallAuth(
      fw.sandboxHeaders(actor, run.runId),
      {
        encryptedSecrets: fw.encryptedSecretsBody({ API_KEY: "paid" }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("API_KEY")}`,
        },
        firewallBillable: true,
      },
      [402],
    );
    if (denied.status !== 402) {
      throw new Error("Expected the expired-credit billable auth to be denied");
    }
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");

    await runsApi.requestCancelRun(actor, run.runId, [200]);
  });
});

describe("FW-4: connector refresh and replacement snapshots", () => {
  it("does not call the provider for a known storage version mismatch", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    await setConnectorCredentialStorageState(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
      connectorSlug: "test-oauth",
      storageVersion: 2,
    });
    let providerCalls = 0;
    fw.mockTestOauthTokenRefresh(() => {
      providerCalls += 1;
      return fw.oauthTokenResponse({
        accessToken: "must-not-be-written",
        expiresIn: 3600,
      });
    });

    const response = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      },
      [424],
    );
    if (response.status !== 424) {
      throw new Error("Expected mismatched storage version to be unavailable");
    }
    expect(response.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
    expect(providerCalls).toBe(0);
  });

  it("defaults the refreshed expiry when the provider omits expires_in", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({ accessToken: "fresh-no-expiry" });
    });

    const before = Math.floor(now() / 1000);
    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe("Bearer fresh-no-expiry");
    expect(refreshed.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 800);
    expect(refreshed.body.expiresAt ?? 0).toBeLessThanOrEqual(before + 1000);
  });

  it("re-runs refresh for a current connector when forceRefresh is set", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "current-access",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "forced-access",
        expiresIn: 3600,
      });
    });

    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "current-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
        forceRefresh: true,
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected forced refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe("Bearer forced-access");
    expect(refreshed.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
  });

  it.each([
    {
      registration: "cimd" as const,
      refreshError: "invalid_grant" as const,
      failureReason: "reconnect_required",
      connectedAfterFailure: false,
    },
    {
      registration: "cimd" as const,
      refreshError: "temporarily_unavailable" as const,
      failureReason: "upstream_provider",
      connectedAfterFailure: true,
    },
    {
      registration: "dcr" as const,
      refreshError: "invalid_client" as const,
      failureReason: "reconnect_required",
      connectedAfterFailure: false,
    },
  ])(
    "classifies Automatic MCP OAuth $refreshError refresh failures",
    async ({
      registration,
      refreshError,
      failureReason,
      connectedAfterFailure,
    }) => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        initialExpiresIn: 3600,
        ...(refreshError === "temporarily_unavailable"
          ? { refreshErrors: [refreshError] }
          : { refreshError }),
      });
      const fw = createFirewallApi(context);
      const connectors = createConnectorBddApi(context);
      const { actor, headers } = await firewallRun();
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorMcp]: true,
      });
      const mcp = await connectors.createCustomConnector(actor, {
        kind: "mcp",
        displayName: `BDD Automatic MCP ${refreshError}`,
        endpoint: provider.endpoint,
        transport: "streamable-http",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "automatic",
      });
      const authorizationUrl = await connectors.startCustomConnectorOAuth2(
        actor,
        mcp.id,
      );
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected Automatic MCP OAuth state");
      }
      await connectors.completeCustomConnectorOAuth2Callback({
        code: `automatic-mcp-${refreshError}-code`,
        state,
        iss: provider.issuer,
      });
      if (refreshError === "invalid_client") {
        const secondAuthorization = await connectors.startCustomConnectorOAuth2(
          actor,
          mcp.id,
          undefined,
          { intent: "add", displayName: "Second" },
        );
        const secondState = new URL(secondAuthorization).searchParams.get(
          "state",
        );
        if (!secondState) {
          throw new Error("Expected second Automatic MCP OAuth state");
        }
        await connectors.completeCustomConnectorOAuth2Callback({
          code: "automatic-mcp-invalid-client-second-code",
          state: secondState,
          iss: provider.issuer,
        });
      }
      const accounts = await connectors.listCustomConnectorAccounts(
        actor,
        mcp.id,
      );
      const [account] = accounts;
      if (!account) {
        throw new Error("Expected an Automatic MCP OAuth account");
      }
      const internalName = `custom_connector_${mcp.id.replaceAll("-", "")}`;
      const secretKey = `CUSTOM_${mcp.id.replaceAll("-", "")}_S___OAUTH_ACCESS_TOKEN`;
      const authBody = {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate(secretKey)}`,
        },
        matchedFirewall: {
          name: internalName,
          apiId: `${internalName}:0`,
          customConnectorId: mcp.id,
          sourceId: account.id,
          routingVariables: {},
        },
        forceRefresh: true,
      };

      const failed = await fw.requestFirewallAuth(headers, authBody, [502]);
      if (failed.status !== 502) {
        throw new Error("Expected Automatic MCP OAuth refresh failure");
      }
      expect(failed.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        connectors: [mcp.id],
        failureReason,
      });
      await expect(
        connectors.readCustomConnector(actor, mcp.id),
      ).resolves.toMatchObject({
        connected: connectedAfterFailure,
      });
      expect(
        provider.tokenBodies.map((body) => {
          return body.get("grant_type");
        }),
      ).toStrictEqual(
        refreshError === "invalid_client"
          ? ["authorization_code", "authorization_code", "refresh_token"]
          : ["authorization_code", "refresh_token"],
      );
      const verifyOutcome: Record<typeof refreshError, () => Promise<void>> = {
        invalid_grant: async () => {
          for (const forceRefresh of [false, true]) {
            const repeated = await fw.requestFirewallAuth(
              headers,
              { ...authBody, forceRefresh },
              [502],
            );
            expect(repeated.body).toMatchObject({
              error: { failureReason: "reconnect_required" },
            });
          }
          expect(provider.tokenBodies).toHaveLength(4);
        },
        invalid_client: async () => {
          const retiredAccounts = await connectors.listCustomConnectorAccounts(
            actor,
            mcp.id,
          );
          expect(retiredAccounts).toHaveLength(2);
          expect(
            retiredAccounts.map((item) => {
              return item.connectionStatus;
            }),
          ).toStrictEqual(["reconnect-required", "reconnect-required"]);
          await connectors.startCustomConnectorOAuth2(
            actor,
            mcp.id,
            undefined,
            { intent: "reconnect", connectionId: account.id },
          );
          expect(provider.registrationBodies).toHaveLength(2);
        },
        temporarily_unavailable: async () => {
          const recovered = await fw.requestFirewallAuth(
            headers,
            authBody,
            [200],
          );
          expect(recovered.body).toMatchObject({
            headers: {
              Authorization: "Bearer automatic-refreshed-access-token",
            },
            refreshedConnectors: [mcp.id],
          });
          expect(provider.tokenBodies[2]?.get("grant_type")).toBe(
            "refresh_token",
          );
          expect(provider.tokenBodies[2]?.get("resource")).toBe(
            provider.endpoint,
          );
        },
      };
      await verifyOutcome[refreshError]();
    },
  );

  it("maintains authoritative and unknown OAuth grants across refresh", async () => {
    const fw = createFirewallApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    if (!actor.orgId) {
      throw new Error("Expected firewall actor to have an organization");
    }
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mockTestOAuthAuthCodeProvider({
      accessToken: "initial-scoped-access",
      refreshToken: "initial-scoped-refresh",
      scope: "read provider-added",
    });
    const start = await connectors.startOauth(actor, "test-oauth", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected test OAuth authorization state");
    }
    await connectors.completeOauthCallback("test-oauth", {
      code: "scoped-refresh-code",
      state,
    });

    const connected = await connectors.readConnectorBySlug(actor, "test-oauth");
    expect(connected.oauthScopes).toStrictEqual(["read", "provider-added"]);
    expect(connected.connectionStatus).toBe("connected");
    const connectorSources = await exactSecretConnectorSources(actor, {
      TEST_OAUTH_TOKEN: "test-oauth",
    });
    const forceRefresh = async (currentAccessToken: string) => {
      const response = await fw.requestFirewallAuth(
        headers,
        {
          encryptedSecrets: fw.encryptedSecretsBody({
            TEST_OAUTH_TOKEN: currentAccessToken,
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
          },
          ...connectorSources,
          forceRefresh: true,
        },
        [200],
      );
      if (response.status !== 200) {
        throw new Error("Expected scoped connector refresh to succeed");
      }
      return response.body;
    };

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "narrow-scoped-access",
        refreshToken: "narrow-scoped-refresh",
        expiresIn: 3600,
        scope: "provider-added",
      });
    });
    const narrowed = await forceRefresh("initial-scoped-access");
    expect(narrowed.headers.Authorization).toBe("Bearer narrow-scoped-access");
    const narrowedConnector = await connectors.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(narrowedConnector.oauthScopes).toStrictEqual(["provider-added"]);
    expect(narrowedConnector.connectionStatus).toBe("connected");
    await expect(
      connectors.readScopeDiff(actor, "test-oauth"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: ["read"],
      storedScopes: ["read"],
    });

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "omitted-scope-access",
        refreshToken: "omitted-scope-refresh",
        expiresIn: 3600,
      });
    });
    await forceRefresh("narrow-scoped-access");
    const preservedConnector = await connectors.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(preservedConnector.oauthScopes).toStrictEqual(["provider-added"]);

    await setBuiltinOAuthScopeFacts(context, {
      orgId: actor.orgId,
      userId: actor.userId,
      connectorSlug: "test-oauth",
      connectorId: connected.id,
      oauthScopes: ["legacy-requested"],
      oauthGrantedScopes: null,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "legacy-unknown-access",
        refreshToken: "legacy-unknown-refresh",
        expiresIn: 3600,
      });
    });
    await forceRefresh("omitted-scope-access");
    const legacyUnknownConnector = await connectors.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(legacyUnknownConnector.oauthScopes).toBeNull();
  });

  it("resolves a current connector token missing from the runtime namespace", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "db-access",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    });

    const synced = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      },
      [200],
    );
    if (synced.status !== 200) {
      throw new Error("Expected stored-token sync to succeed");
    }
    expect(synced.body.headers.Authorization).toBe("Bearer db-access");
    expect(synced.body.refreshedConnectors).toStrictEqual([]);
  });

  it("keeps multi-secret connector auth on one replacement snapshot", async () => {
    const fw = createFirewallApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const oldCredentials = {
      accessKeyId: "old-aws-access-key-id",
      secretAccessKey: "old-aws-secret-access-key",
      sessionToken: "old-aws-session-token",
    };
    const newCredentials = {
      accessKeyId: "new-aws-access-key-id",
      secretAccessKey: "new-aws-secret-access-key",
      sessionToken: "new-aws-session-token",
    };
    const provider = mockAwsExternalCodeProvider({
      credentialsByRequest: [oldCredentials, newCredentials],
    });

    async function connectAws(): Promise<void> {
      const session = await connectors.startExternalCode(actor, "aws", "cli");
      await connectors.completeExternalCode(actor, "aws", {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      });
    }

    await connectAws();
    const decryptGate = gateFirstStoredSecretDecrypt();
    const awsSecretSources = await exactSecretConnectorSources(actor, {
      AWS_ACCESS_KEY_ID: "aws",
      AWS_SECRET_ACCESS_KEY: "aws",
      AWS_SESSION_TOKEN: "aws",
    });
    const pendingAuth = fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          "X-AWS-Access-Key-ID": secretTemplate("AWS_ACCESS_KEY_ID"),
          "X-AWS-Secret-Access-Key": secretTemplate("AWS_SECRET_ACCESS_KEY"),
          "X-AWS-Session-Token": secretTemplate("AWS_SESSION_TOKEN"),
        },
        ...awsSecretSources,
      },
      [200],
    );
    await decryptGate.started;
    const replacement = await settle(connectAws());
    decryptGate.release();
    const resolved = await pendingAuth;
    if (!replacement.ok) {
      throw replacement.error;
    }
    if (resolved.status !== 200) {
      throw new Error("Expected AWS firewall auth to resolve");
    }

    expect(provider.tokenRequests).toHaveLength(2);
    expect(resolved.body.headers).toStrictEqual({
      "X-AWS-Access-Key-ID": oldCredentials.accessKeyId,
      "X-AWS-Secret-Access-Key": oldCredentials.secretAccessKey,
      "X-AWS-Session-Token": oldCredentials.sessionToken,
    });

    await connectors.deleteDefaultBuiltinConnectorAccount(actor, "aws");
  });

  it.each([
    { subtype: undefined, reason: "authorization_expired_or_revoked" },
    { subtype: "invalid_rapt", reason: "provider_session_expired" },
  ])(
    "retries standard OAuth $reason quietly and recovers",
    async ({ subtype, reason }) => {
      const fw = createFirewallApi(context);
      const connectorsApi = createConnectorBddApi(context);
      const { actor, headers } = await firewallRun();
      await connectorsApi.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.TestOauthConnector]: true,
      });
      mockTestOAuthAuthCodeProvider({
        refreshToken: "original-refresh",
        userId: actor.userId,
      });
      const started = await connectorsApi.startOauth(
        actor,
        "test-oauth",
        "oauth",
      );
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected OAuth authorization state");
      }
      await connectorsApi.completeOauthCallbackResult("test-oauth", {
        code: "initial-code",
        state,
      });
      const [account] = await connectorsApi.listBuiltinConnectorAccounts(
        actor,
        "test-oauth",
      );
      if (!account) {
        throw new Error("Expected connected OAuth account");
      }
      let failedRefreshCalls = 0;
      fw.mockTestOauthTokenRefresh(() => {
        failedRefreshCalls += 1;
        return HttpResponse.json(
          {
            error: "invalid_grant",
            ...(subtype ? { error_subtype: subtype } : {}),
          },
          { status: 400 },
        );
      });
      const body = {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      };
      context.mocks.sentry.captureException.mockClear();
      for (const forceRefresh of [true, false, true]) {
        const failed = await fw.requestFirewallAuth(
          headers,
          { ...body, forceRefresh },
          [502],
        );
        expect(failed.body).toMatchObject({
          error: {
            code: "TOKEN_REFRESH_FAILED",
            failureReason: "reconnect_required",
            connectors: ["test-oauth"],
          },
        });
      }
      expect(failedRefreshCalls).toBe(3);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
      await expect(
        connectorsApi.listBuiltinConnectorAccounts(actor, "test-oauth"),
      ).resolves.toContainEqual(
        expect.objectContaining({
          id: account.id,
          connectionStatus: "reconnect-required",
          reconnectReason: reason,
        }),
      );

      fw.mockTestOauthTokenRefresh(() => {
        return fw.oauthTokenResponse({
          accessToken: "recovered-without-reconnect",
          expiresIn: 3600,
        });
      });
      const retried = await fw.requestFirewallAuth(headers, body, [200]);
      expect(retried.body).toMatchObject({
        headers: { Authorization: "Bearer recovered-without-reconnect" },
      });
      await expect(
        connectorsApi.listBuiltinConnectorAccounts(actor, "test-oauth"),
      ).resolves.toContainEqual(
        expect.objectContaining({
          id: account.id,
          connectionStatus: "connected",
          reconnectReason: null,
        }),
      );

      const provider = mockTestOAuthAuthCodeProvider({
        accessToken: "reconnected-access",
        refreshToken: "replacement-refresh",
        userId: actor.userId,
      });
      const reconnect = await connectorsApi.startOauth(
        actor,
        "test-oauth",
        "oauth",
        undefined,
        {
          intent: "reconnect",
          connectionId: account.id,
        },
      );
      const reconnectState = new URL(
        reconnect.authorizationUrl,
      ).searchParams.get("state");
      if (!reconnectState) {
        throw new Error("Expected OAuth reconnect state");
      }
      await connectorsApi.completeOauthCallbackResult("test-oauth", {
        code: "reconnect-code",
        state: reconnectState,
      });
      await expect(
        connectorsApi.listBuiltinConnectorAccounts(actor, "test-oauth"),
      ).resolves.toContainEqual(
        expect.objectContaining({
          id: account.id,
          connectionStatus: "connected",
          reconnectReason: null,
        }),
      );
      const recovered = await fw.requestFirewallAuth(
        headers,
        { ...body, forceRefresh: true },
        [200],
      );
      expect(recovered.body).toMatchObject({
        headers: { Authorization: "Bearer reconnected-access" },
      });
      expect(provider.tokenBodies.at(-1)?.get("refresh_token")).toBe(
        "replacement-refresh",
      );
    },
  );

  it("requires reconnect for unknown OAuth refresh error subtypes", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    const longSubtype = `invalid_rapt:${"x".repeat(200)}`;
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json(
        {
          error: "invalid_grant",
          error_description: "Session control expired",
          error_subtype: longSubtype,
        },
        { status: 400 },
      );
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected invalid_grant to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("reconnect_required");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    const connectorsApi = createConnectorBddApi(context);
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const connector = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(connector.connectionStatus).toBe("reconnect-required");
    expect(connector.reconnectReason).toBeNull();
  });

  it("classifies transient OAuth refresh errors as upstream failures", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json(
        { error: "temporarily_unavailable" },
        { status: 400 },
      );
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected temporarily_unavailable to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("upstream_provider");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-temporary-outage",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected refresh after temporary outage to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer after-temporary-outage",
    );
  });

  it("classifies provider 500s as upstream failures without marking reconnect", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return new HttpResponse(null, { status: 500 });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected provider 500 to fail with 502");
    }
    expect(failed.body.error.failureReason).toBe("upstream_provider");

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-outage",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected refresh after outage to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe("Bearer after-outage");
  });

  it("treats refresh responses without an access token as upstream failures", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json({ ok: true });
    });

    const failed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      },
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected malformed refresh body to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);
  });

  it("requires reconnect when the stored connector never kept a refresh token", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      expiresIn: -60,
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected the refresh-token-less refresh to fail");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBe("reconnect_required");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    // The connector is now flagged for reconnect and keeps failing without
    // reaching any provider endpoint.
    const flagged = await fw.requestFirewallAuth(headers, body, [502]);
    if (flagged.status !== 502) {
      throw new Error("Expected the flagged connector to keep failing");
    }
    expect(flagged.body.error.failureReason).toBe("reconnect_required");

    // The reconnect flag is visible through the public connector read.
    const connectorsApi = createConnectorBddApi(context);
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const connector = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(connector.connectionStatus).toBe("reconnect-required");
  });

  it("classifies refresh timeouts as upstream without marking reconnect", async () => {
    const fw = createFirewallApi(context);
    mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", "25");
    onTestFinished(() => {
      mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
    });
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(async () => {
      await delay(300, { signal: context.signal });
      return fw.oauthTokenResponse({
        accessToken: "too-late",
        expiresIn: 3600,
      });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
    };

    const timedOut = await fw.requestFirewallAuth(headers, body, [502]);
    if (timedOut.status !== 502) {
      throw new Error("Expected the refresh timeout to fail with 502");
    }
    expect(timedOut.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(timedOut.body.error.failureReason).toBe("upstream_provider");
    expect(timedOut.body.error.connectors).toStrictEqual(["test-oauth"]);

    // The connector was not flagged for reconnect: with the normal timeout
    // restored and a fast provider, the next call refreshes successfully.
    mockOptionalEnv("FIREWALL_AUTH_REFRESH_TIMEOUT_MS", undefined);
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-timeout",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected the refresh after the timeout to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe("Bearer after-timeout");
    expect(recovered.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
  });

  it("classifies network refresh failures as upstream and recovers", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.error();
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected the network failure to fail with 502");
    }
    expect(failed.body.error.failureReason).toBe("upstream_provider");
    expect(failed.body.error.connectors).toStrictEqual(["test-oauth"]);

    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "after-network-outage",
        expiresIn: 3600,
      });
    });
    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected the refresh after the outage to succeed");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer after-network-outage",
    );
  });

  it("treats malformed and failing provider token responses as upstream failures", async () => {
    const fw = createFirewallApi(context);
    const connectorsApi = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    await connectorsApi.connectManualGrant(actor, "lark", "api-token", {
      appId: "lark-app-id",
      appSecret: "lark-app-secret",
    });
    server.use(
      http.post(
        "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        () => {
          return HttpResponse.json({ code: 0, msg: "ok" });
        },
      ),
    );

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("LARK_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        LARK_TOKEN: "lark",
      })),
    };

    const malformed = await fw.requestFirewallAuth(headers, body, [502]);
    if (malformed.status !== 502) {
      throw new Error("Expected the malformed lark response to fail with 502");
    }
    expect(malformed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(malformed.body.error.failureReason).toBe("upstream_provider");
    expect(malformed.body.error.connectors).toStrictEqual(["lark"]);

    // Provider HTTP failures classify the same way without flagging the
    // connector for reconnect.
    server.use(
      http.post(
        "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        () => {
          return new HttpResponse(null, { status: 500 });
        },
      ),
    );
    const failing = await fw.requestFirewallAuth(headers, body, [502]);
    if (failing.status !== 502) {
      throw new Error("Expected the failing lark endpoint to fail with 502");
    }
    expect(failing.body.error.failureReason).toBe("upstream_provider");
    expect(failing.body.error.connectors).toStrictEqual(["lark"]);
  });

  it("refreshes mapped-input connector access and stores its variable outputs", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "api",
      accessToken: "stale-api-access",
      refreshToken: "api-refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return fw.oauthTokenResponse({
        accessToken: "fresh-api-access",
        refreshToken: "api-refresh-2",
        expiresIn: 3600,
      });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-api-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_TOKEN: "test-oauth",
      })),
    };

    const refreshed = await fw.requestFirewallAuth(headers, body, [200]);
    if (refreshed.status !== 200) {
      throw new Error("Expected the mapped-input refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer fresh-api-access",
    );
    expect(refreshed.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
    expect(refreshed.body.refreshedSecrets).toStrictEqual(["TEST_OAUTH_TOKEN"]);

    const served = await fw.requestFirewallAuth(headers, body, [200]);
    if (served.status !== 200) {
      throw new Error("Expected the stored mapped-input token to resolve");
    }
    expect(served.body.headers.Authorization).toBe("Bearer fresh-api-access");
    expect(served.body.refreshedConnectors).toStrictEqual([]);
  });
});

describe("FW-5: timeout closes firewall credential authority", () => {
  it.each(TERMINAL_RUN_STATUSES)(
    "rejects a %s run before connector refresh",
    async (status) => {
      const fw = createFirewallApi(context);
      const { actor, runId, headers } = await firewallRun();
      await fw.seedTestConnector(actor, {
        connectorSlug: "test-oauth",
        authMethod: "oauth",
        accessToken: "stale-access",
        refreshToken: "refresh-1",
        expiresIn: -60,
      });
      let refreshRequests = 0;
      fw.mockTestOauthTokenRefresh(() => {
        refreshRequests += 1;
        return fw.oauthTokenResponse({
          accessToken: "must-not-refresh",
          expiresIn: 3600,
        });
      });

      const terminal = await transitionRunToTerminal(context, runId, status);
      expect(terminal.body.ok).toBeTruthy();
      const denied = await fw.requestFirewallAuth(
        headers,
        {
          encryptedSecrets: fw.encryptedSecretsBody({
            TEST_OAUTH_TOKEN: "stale-access",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
          },
          ...(await exactSecretConnectorSources(actor, {
            TEST_OAUTH_TOKEN: "test-oauth",
          })),
        },
        [403],
      );
      if (denied.status !== 403) {
        throw new Error("Expected timed-out firewall auth to be forbidden");
      }
      expect(denied.body.error.code).toBe("FORBIDDEN");
      expect(refreshRequests).toBe(0);
    },
  );

  it("withholds static connector credentials when timeout wins during resolution", async () => {
    const fw = createFirewallApi(context);
    const { actor, runId, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "current-access",
      refreshToken: "refresh-1",
      expiresIn: 3600,
    });
    const decryptGate = gateFirstStoredSecretDecrypt();
    const pending = fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      },
      [403],
    );
    await decryptGate.started;
    const timeout = await transitionRunToTimeout(context, runId);
    expect(timeout.body.ok).toBeTruthy();
    decryptGate.release();

    const denied = await pending;
    if (denied.status !== 403) {
      throw new Error("Expected final firewall admission to be forbidden");
    }
    expect(denied.body.error.code).toBe("FORBIDDEN");
  });

  it("preserves shared refresh state while withholding it from the timed-out run", async () => {
    const fw = createFirewallApi(context);
    const { actor, runId, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    const refreshStarted = createDeferredPromise<void>(context.signal);
    const releaseRefresh = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseRefresh.settled()) {
        releaseRefresh.resolve(undefined);
      }
    });
    let refreshRequests = 0;
    fw.mockTestOauthTokenRefresh(async () => {
      refreshRequests += 1;
      refreshStarted.resolve(undefined);
      await releaseRefresh.promise;
      return fw.oauthTokenResponse({
        accessToken: "shared-fresh-access",
        refreshToken: "shared-refresh-2",
        expiresIn: 3600,
      });
    });
    const sources = await exactSecretConnectorSources(actor, {
      TEST_OAUTH_TOKEN: "test-oauth",
    });
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        TEST_OAUTH_TOKEN: "stale-access",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
      },
      ...sources,
    };

    const pending = fw.requestFirewallAuth(headers, body, [403]);
    await refreshStarted.promise;
    const timeout = await transitionRunToTimeout(context, runId);
    expect(timeout.body.ok).toBeTruthy();
    releaseRefresh.resolve(undefined);
    const denied = await pending;
    if (denied.status !== 403) {
      throw new Error("Expected refreshed credential response to be forbidden");
    }
    expect(denied.body.error.code).toBe("FORBIDDEN");

    const activeRun = await firewallRun(actor);
    const served = await fw.requestFirewallAuth(activeRun.headers, body, [200]);
    if (served.status !== 200) {
      throw new Error("Expected refreshed shared state to remain usable");
    }
    expect(served.body.headers.Authorization).toBe(
      "Bearer shared-fresh-access",
    );
    expect(refreshRequests).toBe(1);
  });
});

describe("FW-6: manual-grant api-token refresh without a provider client", () => {
  it("resolves a missing alias through the synchronous input-driven refresh", async () => {
    const fw = createFirewallApi(context);
    const connectorsApi = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    await connectorsApi.connectManualGrant(actor, "test-oauth", "api-token", {
      apiToken: "manual-secret",
      inputVariable: "manual-var",
      tenantId: "tenant-x",
    });

    const before = Math.floor(now() / 1000);
    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_API_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_API_TOKEN: "test-oauth",
        })),
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected api-token refresh to succeed");
    }
    expect(resolved.body.headers.Authorization).toBe(
      "Bearer fresh-test-oauth-api-token:manual-secret:manual-var",
    );
    expect(resolved.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
    expect(resolved.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 3500);
  });
});

describe("FW-7: client-unconfigured and mixed-reason refresh failures", () => {
  it("fails without a failure reason when the provider client is unconfigured", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "notion",
      authMethod: "oauth",
      accessToken: "stale-notion",
      refreshToken: "notion-refresh",
      expiresIn: -60,
    });

    const failed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          NOTION_TOKEN: "stale-notion",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          NOTION_TOKEN: "notion",
        })),
      },
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected unconfigured client refresh to fail with 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.connectors).toStrictEqual(["notion"]);
    expect(failed.body.error.failureReason).toBeUndefined();
  });

  it("omits the failure reason when connectors fail for different reasons", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "notion",
      authMethod: "oauth",
      accessToken: "stale-notion",
      refreshToken: "notion-refresh",
      expiresIn: -60,
    });
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth",
      authMethod: "oauth",
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    fw.mockTestOauthTokenRefresh(() => {
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    });

    const failed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          NOTION_TOKEN: "stale-notion",
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          "X-Test": `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          NOTION_TOKEN: "notion",
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      },
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected mixed-reason refresh to fail with 502");
    }
    expect(failed.body.error.connectors?.slice().sort()).toStrictEqual([
      "notion",
      "test-oauth",
    ]);
    expect(failed.body.error.failureReason).toBeUndefined();
  });
});

describe("FW-8: static access tokens and unavailable sources", () => {
  it("requires reconnect for expired static tokens and syncs current ones", async () => {
    const fw = createFirewallApi(context);
    const connectors = createConnectorBddApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "stale-device",
      expiresIn: -60,
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("TEST_OAUTH_DEVICE_TOKEN")}`,
      },
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_DEVICE_TOKEN: "test-oauth-device",
      })),
    };

    const expired = await fw.requestFirewallAuth(headers, body, [502]);
    if (expired.status !== 502) {
      throw new Error("Expected expired static token to fail with 502");
    }
    expect(expired.body.error.failureReason).toBe("reconnect_required");
    expect(expired.body.error.connectors).toStrictEqual(["test-oauth-device"]);

    const [expiredAccount] = await connectors.listBuiltinConnectorAccounts(
      actor,
      "test-oauth-device",
    );
    if (!expiredAccount) {
      throw new Error("Expected the expired device account");
    }
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      "test-oauth-device",
      expiredAccount.id,
    );

    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "current-device",
      expiresIn: 3600,
    });
    const currentBody = {
      ...body,
      ...(await exactSecretConnectorSources(actor, {
        TEST_OAUTH_DEVICE_TOKEN: "test-oauth-device",
      })),
    };
    const synced = await fw.requestFirewallAuth(headers, currentBody, [200]);
    if (synced.status !== 200) {
      throw new Error("Expected current static token to resolve");
    }
    expect(synced.body.headers.Authorization).toBe("Bearer current-device");
    expect(synced.body.refreshedConnectors).toStrictEqual([]);
  });

  it("serves static device tokens that were stored without an expiry", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "test-oauth-device",
      authMethod: "oauth",
      accessToken: "no-expiry-device",
    });

    const synced = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_DEVICE_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_DEVICE_TOKEN: "test-oauth-device",
        })),
      },
      [200],
    );
    if (synced.status !== 200) {
      throw new Error("Expected the expiry-less static token to resolve");
    }
    expect(synced.body.headers.Authorization).toBe("Bearer no-expiry-device");
    expect(synced.body.refreshedConnectors).toStrictEqual([]);
    expect(synced.body.expiresAt).toBeNull();
  });

  it("reports aliases for never-connected connector slugs as not configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
        },
        secretConnectorMap: { NOTION_TOKEN: "notion" },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected unconnected connector alias to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });
});

describe("FW-9: codex model-provider access", () => {
  it("resolves static model-provider auth from an empty runtime namespace", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          "x-api-key": secretTemplate("ANTHROPIC_API_KEY"),
        },
        secretConnectorMap: { ANTHROPIC_API_KEY: "anthropic-api-key" },
        secretConnectorMetadataMap: {
          ANTHROPIC_API_KEY: {
            sourceType: "model-provider" as const,
            sourceUserId: ORG_SENTINEL_USER_ID,
            metadataKey: "anthropic-api-key",
          },
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected static model-provider auth to resolve");
    }
    expect(resolved.body.headers["x-api-key"]).toBe("test-anthropic-key");
    expect(resolved.body.resolvedSecrets).toStrictEqual(["ANTHROPIC_API_KEY"]);
    expect(resolved.body.refreshedConnectors).toStrictEqual([]);
  });

  it("derives static model-provider auth when metadata is omitted", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          "x-api-key": secretTemplate("ANTHROPIC_API_KEY"),
        },
        secretConnectorMap: { ANTHROPIC_API_KEY: "anthropic-api-key" },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected derived static model-provider auth to resolve");
    }
    expect(resolved.body.headers["x-api-key"]).toBe("test-anthropic-key");
    expect(resolved.body.resolvedSecrets).toStrictEqual(["ANTHROPIC_API_KEY"]);
    expect(resolved.body.refreshedConnectors).toStrictEqual([]);
  });

  it("refreshes an expired org codex provider and serves the stored token afterwards", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "fresh-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
      },
      secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      secretConnectorMetadataMap: {
        CHATGPT_ACCESS_TOKEN: {
          sourceType: "model-provider" as const,
          sourceUserId: ORG_SENTINEL_USER_ID,
          metadataKey: "codex-oauth-token",
        },
      },
    };

    const refreshed = await fw.requestFirewallAuth(headers, body, [200]);
    if (refreshed.status !== 200) {
      throw new Error("Expected codex refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer fresh-chatgpt-token",
    );
    expect(refreshed.body.refreshedConnectors).toStrictEqual([
      "codex-oauth-token",
    ]);
    expect(refreshed.body.refreshedSecrets).toStrictEqual([
      "CHATGPT_ACCESS_TOKEN",
    ]);

    const served = await fw.requestFirewallAuth(headers, body, [200]);
    if (served.status !== 200) {
      throw new Error("Expected stored codex token to resolve");
    }
    expect(served.body.headers.Authorization).toBe(
      "Bearer fresh-chatgpt-token",
    );
    expect(served.body.refreshedConnectors).toStrictEqual([]);
  });

  it("derives the model-provider source when metadata is omitted", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "derived-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected derived-source codex refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer derived-chatgpt-token",
    );
  });

  it("rejects cross-user model-provider sources and unknown aliases", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });

    const crossUser = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
        secretConnectorMetadataMap: {
          CHATGPT_ACCESS_TOKEN: {
            sourceType: "model-provider" as const,
            sourceUserId: "user_someone_else",
            metadataKey: "codex-oauth-token",
          },
        },
      },
      [403],
    );
    expectApiError(crossUser.body);

    const unknownAlias = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_REFRESH_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_REFRESH_TOKEN: "codex-oauth-token" },
        secretConnectorMetadataMap: {
          CHATGPT_REFRESH_TOKEN: {
            sourceType: "model-provider" as const,
            sourceUserId: ORG_SENTINEL_USER_ID,
            metadataKey: "codex-oauth-token",
          },
        },
      },
      [424],
    );
    if (unknownAlias.status !== 424) {
      throw new Error("Expected unknown codex alias to fail with 424");
    }
    expect(unknownAlias.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");

    const userScoped = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
        secretConnectorMetadataMap: {
          CHATGPT_ACCESS_TOKEN: {
            sourceType: "model-provider" as const,
            sourceUserId: actor.userId,
            metadataKey: "codex-oauth-token",
          },
        },
      },
      [424],
    );
    if (userScoped.status !== 424) {
      throw new Error("Expected user-scoped lookup to miss the org row");
    }
    expect(userScoped.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("recovers an unclassified reconnect-flagged codex provider after a successful refresh", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_other",
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "recovered-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const recovered = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [200],
    );
    if (recovered.status !== 200) {
      throw new Error("Expected reconnect-flagged refresh to recover");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer recovered-chatgpt-token",
    );
  });

  it("re-refreshes unclassified reconnect-flagged codex providers before their token expires", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "current-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: 3600,
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_other",
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json({
        access_token: "reauthorized-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });

    const refreshed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: "current-chatgpt-token",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error("Expected the unexpired reconnect refresh to succeed");
    }
    expect(refreshed.body.headers.Authorization).toBe(
      "Bearer reauthorized-chatgpt-token",
    );
    expect(refreshed.body.refreshedConnectors).toStrictEqual([
      "codex-oauth-token",
    ]);
  });

  it("reports missing codex providers as not configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected missing codex provider to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("stops retrying terminal chatgpt refresh failures", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    const terminalErrorCodes = [
      "refresh_token_reused",
      "refresh_token_expired",
      "refresh_token_invalidated",
    ] as const;
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
      },
      secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
    };

    for (const errorCode of terminalErrorCodes) {
      await fw.seedOrgCodexProvider(actor, {
        accessToken: "stale-chatgpt-token",
        refreshToken: `chatgpt-refresh-${errorCode}`,
        accountId: "acct-bdd",
        idToken: "id-token-bdd",
        expiresIn: -60,
      });
      let refreshCalls = 0;
      fw.mockCodexTokenRefresh(() => {
        refreshCalls += 1;
        return HttpResponse.json(
          {
            error: {
              code: errorCode,
              message: `${errorCode} refresh token`,
            },
          },
          { status: 401 },
        );
      });

      for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
        const failed = await fw.requestFirewallAuth(headers, body, [502]);
        if (failed.status !== 502) {
          throw new Error("Expected the chatgpt reconnect failure to be 502");
        }
        expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
        expect(failed.body.error.failureReason).toBe("reconnect_required");
        expect(failed.body.error.connectors).toStrictEqual([
          "codex-oauth-token",
        ]);
      }

      expect(refreshCalls).toBe(1);
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    }
  });

  it("keeps terminal Codex failure on the exact account until reconnect", async () => {
    const fw = createFirewallApi(context);
    const authDevice = createAuthDeviceApiActions(context);
    const support = createAuthDeviceSupportApi(context);
    const { actor, headers } = await firewallRun();
    await support.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });
    const accounts: string[] = [];
    for (const accountId of ["expired-account", "healthy-account"]) {
      mockCodexDeviceAuthProvider({
        tokenScope: "personal",
        accountId,
        accessTokenExpiresAt:
          Math.floor(now() / 1000) +
          (accountId === "expired-account" ? -60 : 7200),
      });
      const started = await authDevice.requestCodexStart(
        actor,
        "personal",
        [200],
        { mode: "add" },
      );
      if (started.status !== 200) {
        throw new Error("Expected Codex account connection to start");
      }
      const completed = await authDevice.requestCodexComplete(
        actor,
        started.body.sessionToken,
        [200],
      );
      if (
        !("status" in completed.body) ||
        completed.body.status !== "complete"
      ) {
        throw new Error("Expected Codex account connection to complete");
      }
      accounts.push(completed.body.provider.id);
    }
    const [expiredAccountId, healthyAccountId] = accounts;
    if (!expiredAccountId || !healthyAccountId) {
      throw new Error("Expected both concrete accounts");
    }
    await support.activatePersonalModelProviderAccount(actor, healthyAccountId);
    let refreshCalls = 0;
    fw.mockCodexTokenRefresh(() => {
      refreshCalls += 1;
      return HttpResponse.json(
        { error: { code: "refresh_token_reused", message: "reused token" } },
        { status: 401 },
      );
    });
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({}),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
      },
      secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      secretConnectorMetadataMap: {
        CHATGPT_ACCESS_TOKEN: {
          sourceType: "model-provider" as const,
          sourceUserId: actor.userId,
          sourceId: expiredAccountId,
          metadataKey: "codex-oauth-token",
        },
      },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await fw.requestFirewallAuth(headers, body, [502]);
      expect(failed.body).toMatchObject({
        error: {
          code: "TOKEN_REFRESH_FAILED",
          failureReason: "reconnect_required",
        },
      });
    }
    expect(refreshCalls).toBe(1);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    const failedAccounts = await support.listPersonalModelProviders(
      actor,
      [200],
    );
    expect(failedAccounts.body).toMatchObject({
      modelProviders: expect.arrayContaining([
        expect.objectContaining({
          id: expiredAccountId,
          needsReconnect: true,
          lastRefreshErrorCode: "refresh_token_reused",
        }),
        expect.objectContaining({
          id: healthyAccountId,
          isActive: true,
          needsReconnect: false,
          lastRefreshErrorCode: null,
        }),
      ]),
    });

    const reconnected = mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "expired-account",
    });
    const started = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      {
        mode: "reconnect",
        modelProviderId: expiredAccountId,
      },
    );
    if (started.status !== 200) {
      throw new Error("Expected exact Codex account reconnect to start");
    }
    await authDevice.requestCodexComplete(
      actor,
      started.body.sessionToken,
      [200],
    );
    const recoveredAccounts = await support.listPersonalModelProviders(
      actor,
      [200],
    );
    expect(recoveredAccounts.body).toMatchObject({
      modelProviders: expect.arrayContaining([
        expect.objectContaining({
          id: expiredAccountId,
          needsReconnect: false,
          lastRefreshErrorCode: null,
        }),
      ]),
    });
    const resolved = await fw.requestFirewallAuth(headers, body, [200]);
    expect(resolved.body).toMatchObject({
      headers: {
        Authorization: `Bearer ${reconnected.oauthTokenResponses[0]?.access_token}`,
      },
      refreshedConnectors: [],
    });
    expect(reconnected.oauthToken).toHaveLength(1);
  });

  it("retries a transient codex refresh failure", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });
    let refreshCalls = 0;
    fw.mockCodexTokenRefresh(() => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return HttpResponse.json({ error: "server_error" }, { status: 503 });
      }
      return HttpResponse.json({
        access_token: "recovered-chatgpt-token",
        refresh_token: "rotated-chatgpt-refresh",
        expires_in: 3600,
      });
    });
    const body = {
      encryptedSecrets: fw.encryptedSecretsBody({
        CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
      }),
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
      },
      secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
    };

    const failed = await fw.requestFirewallAuth(headers, body, [502]);
    if (failed.status !== 502) {
      throw new Error("Expected the transient codex failure to be 502");
    }
    expect(failed.body.error.failureReason).toBe("upstream_provider");

    const recovered = await fw.requestFirewallAuth(headers, body, [200]);
    if (recovered.status !== 200) {
      throw new Error("Expected the transient codex failure to recover");
    }
    expect(recovered.body.headers.Authorization).toBe(
      "Bearer recovered-chatgpt-token",
    );
    expect(refreshCalls).toBe(2);
  });

  it("omits the failure reason for unknown chatgpt refresh error codes", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedOrgCodexProvider(actor, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh",
      accountId: "acct-bdd",
      idToken: "id-token-bdd",
      expiresIn: -60,
    });
    fw.mockCodexTokenRefresh(() => {
      return HttpResponse.json(
        {
          error: {
            code: "totally_novel_failure",
            message: "unrecognized refresh failure",
          },
        },
        { status: 401 },
      );
    });

    const failed = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
      },
      [502],
    );
    if (failed.status !== 502) {
      throw new Error("Expected the unknown chatgpt failure to be 502");
    }
    expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
    expect(failed.body.error.failureReason).toBeUndefined();
    expect(failed.body.error.connectors).toStrictEqual(["codex-oauth-token"]);
  });
});

describe("FW-10: platform connector secrets", () => {
  it("resolves platform-secret aliases from current API env", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token-current");

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_TOKEN: "google-ads-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("GOOGLE_ADS_TOKEN")}`,
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
        ...(await exactSecretConnectorSources(
          actor,
          {
            GOOGLE_ADS_TOKEN: "google-ads",
            GOOGLE_ADS_DEVELOPER_TOKEN: "google-ads",
          },
          ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        )),
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected platform-secret alias to resolve");
    }
    expect(resolved.body.headers.Authorization).toBe(
      "Bearer google-ads-access",
    );
    expect(resolved.body.headers["developer-token"]).toBe(
      "developer-token-current",
    );
    expect(resolved.body.resolvedSecrets).toStrictEqual([
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_TOKEN",
    ]);
  });

  it("reports missing platform env as connector-not-configured", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", undefined);
    await installApiTestConnectorCatalog();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_TOKEN: "google-ads-access",
        }),
        authHeaders: {
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
        secretConnectorMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: "google-ads",
        },
        secretConnectorMetadataMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: {
            sourceType: "platform-secret" as const,
          },
        },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected missing platform env to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("does not fall back to stale encrypted values for platform metadata", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", " ");

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_DEVELOPER_TOKEN: "stale-developer-token",
        }),
        authHeaders: {
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
        secretConnectorMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: "google-ads",
        },
        secretConnectorMetadataMap: {
          GOOGLE_ADS_DEVELOPER_TOKEN: {
            sourceType: "platform-secret" as const,
          },
        },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected stale encrypted platform value to be ignored");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("rejects platform metadata for non-platform connector aliases", async () => {
    const fw = createFirewallApi(context);
    const { actor, headers } = await firewallRun();
    await fw.seedTestConnector(actor, {
      connectorSlug: "google-ads",
      authMethod: "oauth",
      accessToken: "google-ads-access",
      refreshToken: "google-ads-refresh",
    });
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "developer-token-current");

    const invalid = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_TOKEN: "google-ads-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("GOOGLE_ADS_TOKEN")}`,
        },
        secretConnectorMap: {
          GOOGLE_ADS_TOKEN: "google-ads",
        },
        secretConnectorMetadataMap: {
          GOOGLE_ADS_TOKEN: {
            sourceType: "platform-secret" as const,
          },
        },
      },
      [424],
    );
    if (invalid.status !== 424) {
      throw new Error("Expected invalid platform alias to fail with 424");
    }
    expect(invalid.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("keeps old encrypted platform-secret payloads working without metadata", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();
    mockOptionalEnv("GOOGLE_ADS_DEVELOPER_TOKEN", undefined);
    await installApiTestConnectorCatalog();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          GOOGLE_ADS_DEVELOPER_TOKEN: "old-encrypted-developer-token",
        }),
        authHeaders: {
          "developer-token": secretTemplate("GOOGLE_ADS_DEVELOPER_TOKEN"),
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected old encrypted platform payload to resolve");
    }
    expect(resolved.body.headers["developer-token"]).toBe(
      "old-encrypted-developer-token",
    );
  });
});

describe("FW-11: aws sigv4 template resolution", () => {
  it("resolves aws sigv4 credentials from secret and var templates", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const resolved = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          AWS_SECRET_ACCESS_KEY: "secret-access-key",
          AWS_SESSION_TOKEN: "session-token",
        }),
        authHeaders: {},
        authAwsSigv4: {
          accessKeyId: varTemplate("AWS_ACCESS_KEY_ID"),
          secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
          sessionToken: secretTemplate("AWS_SESSION_TOKEN"),
        },
        vars: { AWS_ACCESS_KEY_ID: "access-key-id" },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected the sigv4 resolution to succeed");
    }
    expect(resolved.body.headers).toStrictEqual({});
    expect(resolved.body.awsSigv4).toStrictEqual({
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
      sessionToken: "session-token",
    });
    expect(resolved.body.resolvedSecrets).toStrictEqual([
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]);
    expect(resolved.body.expiresAt).toBeNull();
  });

  it("rejects empty resolved aws sigv4 credentials as connector-not-configured", async () => {
    const fw = createFirewallApi(context);
    const { headers } = await firewallRun();

    const missing = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          AWS_ACCESS_KEY_ID: "",
          AWS_SECRET_ACCESS_KEY: "secret-access-key",
        }),
        authHeaders: {},
        authAwsSigv4: {
          accessKeyId: secretTemplate("AWS_ACCESS_KEY_ID"),
          secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
        },
      },
      [424],
    );
    if (missing.status !== 424) {
      throw new Error("Expected the empty sigv4 credential to fail with 424");
    }
    expect(missing.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });
});
