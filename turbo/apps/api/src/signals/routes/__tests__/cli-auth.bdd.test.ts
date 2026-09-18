import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { generateSandboxToken } from "../../auth/tokens";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  makeCodexAuthJson,
  makeCodexJwt,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const support = createAuthDeviceSupportApi(context);
const connectors = createConnectorBddApi(context);

const DEVICE_CODE_EXPIRY_MS = 16 * 60 * 1000;
const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";

const LEGACY_CODEX_OAUTH_BODY = {
  accessToken: "REAL-AT-7f3a82d1-9b4c-4e5f-a1b2-c3d4e5f60718",
  refreshToken: "REAL-RT-1a2b3c4d-5e6f-7g8h-9i0j-k1l2m3n4o5p6",
  accountId: "ws_REAL_ACCOUNT_test",
  idToken: "hdr.PAYLOAD.SIG",
} as const;

interface OAuthErrorBody {
  readonly error: string;
  readonly error_description: string;
}

interface CliApprovalErrorBody {
  readonly success: false;
  readonly error: string;
}

function expectOAuthError(body: unknown): asserts body is OAuthErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    !("error_description" in body)
  ) {
    throw new Error("Expected OAuth error response body");
  }
}

function expectCliApprovalError(
  body: unknown,
): asserts body is CliApprovalErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("success" in body) ||
    !("error" in body) ||
    body.success !== false
  ) {
    throw new Error("Expected CLI approval error response body");
  }
}

async function issueDevicePat(
  actor: ReturnType<typeof bdd.user>,
): Promise<{ readonly accessToken: string }> {
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
  return { accessToken: token.body.access_token };
}

afterEach(() => {
  clearMockNow();
});

describe("AUTH-02: CLI device code expiry", () => {
  it("expires unexchanged device codes for both token polling and browser approval", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);

    const first = await authDevice.startCliDevice();
    const second = await authDevice.startCliDevice();
    expect(first.device_code).not.toBe(second.device_code);

    mockNow(base + DEVICE_CODE_EXPIRY_MS);

    const expiredExchange = await authDevice.requestCliToken(
      first.device_code,
      [400],
    );
    expectOAuthError(expiredExchange.body);
    expect(expiredExchange.body).toStrictEqual({
      error: "expired_token",
      error_description: "The device code has expired",
    });

    const expiredApproval = await authDevice.requestCliApproval(
      actor,
      { device_code: second.device_code },
      [400],
    );
    expectCliApprovalError(expiredApproval.body);
    expect(expiredApproval.body.error).toBe("Device code has expired");

    clearMockNow();
  });
});

describe("AUTH-02: approval transitions and timezone", () => {
  it("approves a code only once and writes timezone only when valid and unset", async () => {
    const actor = bdd.user();

    const missingDeviceCode = await authDevice.requestCliApproval(
      actor,
      { device_code: "" },
      [400],
    );
    expectCliApprovalError(missingDeviceCode.body);
    expect(missingDeviceCode.body.error).toContain("device_code");

    const first = await authDevice.startCliDevice();
    const approved = await authDevice.requestCliApproval(
      actor,
      { device_code: first.device_code },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });

    const reApproved = await authDevice.requestCliApproval(
      actor,
      { device_code: first.device_code },
      [400],
    );
    expectCliApprovalError(reApproved.body);
    expect(reApproved.body.error).toBe("Invalid or expired device code");

    const initialPreferences = await support.readPreferences(actor);
    expect(initialPreferences.body.timezone).toBeNull();

    const second = await authDevice.startCliDevice();
    await authDevice.requestCliApproval(
      actor,
      { device_code: second.device_code, timezone: "America/Los_Angeles" },
      [200],
    );
    const afterFirstTimezone = await support.readPreferences(actor);
    expect(afterFirstTimezone.body.timezone).toBe("America/Los_Angeles");

    const third = await authDevice.startCliDevice();
    await authDevice.requestCliApproval(
      actor,
      { device_code: third.device_code, timezone: "Asia/Tokyo" },
      [200],
    );
    const afterSecondTimezone = await support.readPreferences(actor);
    expect(afterSecondTimezone.body.timezone).toBe("America/Los_Angeles");

    const freshActor = bdd.user();
    const fourth = await authDevice.startCliDevice();
    await authDevice.requestCliApproval(
      freshActor,
      { device_code: fourth.device_code, timezone: "Not/AZone" },
      [200],
    );
    const invalidTimezone = await support.readPreferences(freshActor);
    expect(invalidTimezone.body.timezone).toBeNull();
  });
});

describe("AUTH-02: no-org approval cannot issue a PAT", () => {
  it("reports missing authenticated identity instead of issuing an unusable token", async () => {
    const noOrgActor = bdd.user({ orgId: null });

    const started = await authDevice.startCliDevice();
    const approved = await authDevice.requestCliApproval(
      noOrgActor,
      { device_code: started.device_code, timezone: "America/Los_Angeles" },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });

    const token = await authDevice.requestCliToken(started.device_code, [500]);
    expectOAuthError(token.body);
    expect(token.body).toStrictEqual({
      error: "server_error",
      error_description:
        "Authenticated device code is missing user or organization identity",
    });
  });
});

describe("AUTH-02: approve credential-type boundaries", () => {
  it("rejects pat and sandbox bearers on approve while the code stays pending", async () => {
    const actor = bdd.user();
    const pat = await issueDevicePat(actor);

    const pending = await authDevice.startCliDevice();

    const patApproval = await authDevice.requestCliApprovalWithBearer(
      pat.accessToken,
      { device_code: pending.device_code },
      [403],
    );
    expectApiError(patApproval.body);
    expect(patApproval.body.error.code).toBe("FORBIDDEN");

    const sandboxToken = generateSandboxToken(
      actor.userId,
      "run_bdd_cli_auth",
      actor.orgId ?? "org_bdd_cli_auth",
    );
    const sandboxApproval = await authDevice.requestCliApprovalWithBearer(
      sandboxToken,
      { device_code: pending.device_code },
      [403],
    );
    expectApiError(sandboxApproval.body);
    expect(sandboxApproval.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });

    const stillPending = await authDevice.requestCliToken(
      pending.device_code,
      [202],
    );
    expectOAuthError(stillPending.body);
    expect(stillPending.body.error).toBe("authorization_pending");
  });
});

describe("CLI-TEST: test-token gating", () => {
  it("hides test-token outside development without a valid preview bypass", async () => {
    mockEnv("ENV", "production");
    const productionResponse = await authDevice.requestTestToken({}, [404]);
    expect(productionResponse.body).toBe("Not found");

    mockEnv("ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const missingHeader = await authDevice.requestTestTokenRaw();
    expect(missingHeader.status).toBe(404);
    expect(missingHeader.body).toBe("Not found");

    const wrongHeader = await authDevice.requestTestTokenRaw({
      "x-vercel-protection-bypass": "wrong-secret",
    });
    expect(wrongHeader.status).toBe(404);
    expect(wrongHeader.body).toBe("Not found");

    const actor = bdd.user();
    authDevice.seedClerkDirectory(actor);
    const bypassed = await authDevice.requestTestTokenRaw({
      "x-vercel-protection-bypass": "preview-secret",
    });
    expect(bypassed.status).toBe(200);
    expect(bypassed.body).toMatchObject({
      token_type: "Bearer",
      user_id: actor.userId,
    });

    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    const rewritten = await authDevice.requestTestToken({}, [200]);
    if (rewritten.status !== 200) {
      throw new Error(
        `Expected preview-rewrite test token, got ${rewritten.status}`,
      );
    }
    expect(rewritten.body.access_token).toMatch(/^vm0_pat_/);
    expect(rewritten.body.user_id).toBe(actor.userId);
  });
});

describe("CLI-TEST: test-token provisioning", () => {
  it("provisions a pro test org whose pat works against me and billing", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected actor with an active organization");
    }
    authDevice.seedClerkDirectory(actor);

    const issued = await authDevice.requestTestToken({}, [200]);
    if (issued.status !== 200) {
      throw new Error(`Expected test token issuance, got ${issued.status}`);
    }
    expect(issued.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 90 * 24 * 60 * 60,
      user_id: actor.userId,
    });
    expect(issued.body.access_token).toMatch(/^vm0_pat_/);
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [DEFAULT_TEST_EMAIL],
    });

    const me = await authDevice.readMeWithBearer(
      issued.body.access_token,
      actor,
      [200],
    );
    expect(me.body).toStrictEqual({
      userId: actor.userId,
      email: actor.email,
      orgId: actor.orgId,
    });

    const billing = await authDevice.readBillingStatus(actor);
    expect(billing.tier).toBe("pro");
    expect(billing.credits).toBe(100_000);

    const reIssued = await authDevice.requestTestToken({}, [200]);
    if (reIssued.status !== 200) {
      throw new Error(
        `Expected repeated test token issuance, got ${reIssued.status}`,
      );
    }
    expect(reIssued.body.user_id).toBe(actor.userId);

    await authDevice.requestTestToken({ email: "custom@test.com" }, [200]);
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });

    context.mocks.clerk.users.getUserList.mockResolvedValue({ data: [] });
    const unresolved = await authDevice.requestTestTokenRaw();
    expect(unresolved.status).toBe(500);
  });

  it("refreshes recreated users and serves downstream setup from cache", async () => {
    const firstActor = bdd.user();
    authDevice.seedClerkDirectory(firstActor);
    const first = await authDevice.requestTestToken(
      { email: firstActor.email },
      [200],
    );
    if (first.status !== 200) {
      throw new Error(`Expected first test token, got ${first.status}`);
    }
    expect(first.body.user_id).toBe(firstActor.userId);

    const recreatedActor = bdd.user({ email: firstActor.email });
    authDevice.seedClerkDirectory(recreatedActor);
    const refreshed = await authDevice.requestTestToken(
      { email: firstActor.email },
      [200],
    );
    if (refreshed.status !== 200) {
      throw new Error(`Expected refreshed test token, got ${refreshed.status}`);
    }
    expect(refreshed.body.user_id).toBe(recreatedActor.userId);

    context.mocks.clerk.users.getUserList.mockRejectedValue(
      new Error("Clerk rate limited"),
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk rate limited"),
    );
    const seeded = await authDevice.requestTestConnector(
      { email: firstActor.email },
      {
        connectorSlug: "github",
        authMethod: "oauth",
        accessToken: "cached-identity-access-token",
      },
      [200],
    );
    if (seeded.status !== 200) {
      throw new Error(`Expected cached identity seed, got ${seeded.status}`);
    }
    expect(seeded.body.orgId).toBe(recreatedActor.orgId);
  });
});

describe("CLI-TEST: test-connector", () => {
  const githubOauthBody = {
    connectorSlug: "github",
    authMethod: "oauth",
    accessToken: "github-access-token",
  } as const;

  it("hides test-connector in production", async () => {
    mockEnv("ENV", "production");
    const response = await authDevice.requestTestConnector(
      {},
      githubOauthBody,
      [404],
    );
    expect(response.body).toBe("Not found");
  });

  it("rejects malformed and unsupported connector seeds", async () => {
    const invalidJson = await authDevice.requestTestConnectorRaw("{ not json");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body).toStrictEqual({ error: "Invalid JSON body" });

    const missingFields = await authDevice.requestTestConnectorRaw(
      JSON.stringify({ connectorSlug: "github" }),
    );
    expect(missingFields.status).toBe(400);
    expect(missingFields.body).toStrictEqual({
      error: "connectorSlug, authMethod, and accessToken are required",
    });

    const emptyRefreshToken = await authDevice.requestTestConnector(
      {},
      { ...githubOauthBody, refreshToken: "" },
      [400],
    );
    expect(emptyRefreshToken.body).toStrictEqual({
      error: "connectorSlug, authMethod, and accessToken are required",
    });

    const malformedSlug = await authDevice.requestTestConnector(
      {},
      { ...githubOauthBody, connectorSlug: "not a connector slug" },
      [400],
    );
    expect(malformedSlug.body).toStrictEqual({
      error: 'Unknown connector slug: "not a connector slug"',
    });

    const unknownSlug = await authDevice.requestTestConnector(
      {},
      { ...githubOauthBody, connectorSlug: "unknown-connector" },
      [400],
    );
    expect(unknownSlug.body).toStrictEqual({
      error: 'Unknown connector slug: "unknown-connector"',
    });

    const freshActor = bdd.user();
    authDevice.seedClerkDirectory(freshActor);
    const noOrg = await authDevice.requestTestConnector(
      { email: freshActor.email },
      githubOauthBody,
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: "Test user has no org — run test-token first",
    });

    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    const wrongGrantKind = await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorSlug: "cloudinary",
        authMethod: "api-token",
        accessToken: "cloudinary-access-token",
      },
      [400],
    );
    expect(wrongGrantKind.body).toStrictEqual({
      error:
        "cloudinary connector auth method api-token does not use an auth-code or device-auth grant",
    });

    const unconfiguredMethod = await authDevice.requestTestConnector(
      { email: actor.email },
      { ...githubOauthBody, authMethod: "api-token" },
      [400],
    );
    expect(unconfiguredMethod.body).toStrictEqual({
      error: "github connector does not configure auth method api-token",
    });
  });

  it("seeds connector state readable through the connectors API", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    await support.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const seeded = await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorSlug: "test-oauth",
        authMethod: "oauth",
        accessToken: "test-oauth-access-token",
        refreshToken: "test-oauth-refresh-token",
        expiresIn: -60,
      },
      [200],
    );
    expect(seeded.body).toStrictEqual({
      ok: true,
      connectorSlug: "test-oauth",
      orgId: actor.orgId,
    });

    const oauthState = await support.readConnectorBySlug(actor, "test-oauth");
    expect(oauthState).toMatchObject({
      authMethod: "oauth",
      externalUsername: "e2e-test-oauth",
    });
    if (!oauthState.tokenExpiresAt) {
      throw new Error("Expected seeded connector token expiry");
    }
    expect(Date.parse(oauthState.tokenExpiresAt)).toBeLessThan(now());

    const reSeeded = await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorSlug: "test-oauth",
        authMethod: "api",
        accessToken: "test-oauth-api-access-token",
        refreshToken: "test-oauth-api-refresh-token",
      },
      [200],
    );
    expect(reSeeded.body).toStrictEqual({
      ok: true,
      connectorSlug: "test-oauth",
      orgId: actor.orgId,
    });
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "test-oauth",
    );
    expect(accounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oauthState.id, authMethod: "oauth" }),
        expect.objectContaining({ authMethod: "api" }),
      ]),
    );

    await authDevice.requestTestConnector(
      { email: "custom@test.com" },
      githubOauthBody,
      [200],
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });
  });
});

describe("CLI-TEST: test-enable-connector", () => {
  const ZERO_COMPOSE_ID = "00000000-0000-0000-0000-000000000000";

  it("hides test-enable-connector in production", async () => {
    mockEnv("ENV", "production");
    const response = await authDevice.requestTestEnableConnector(
      {},
      { composeId: ZERO_COMPOSE_ID, connectorSlugs: ["github"] },
      [404],
    );
    expect(response.body).toBe("Not found");
  });

  it("rejects malformed enable-connector requests", async () => {
    const invalidJson =
      await authDevice.requestTestEnableConnectorRaw("{ not json");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body).toStrictEqual({ error: "Invalid JSON body" });

    for (const rawBody of [
      {},
      { composeId: "not-a-uuid", connectorSlugs: ["github"] },
      { composeId: ZERO_COMPOSE_ID, connectorSlugs: [] },
    ]) {
      const invalidBody = await authDevice.requestTestEnableConnectorRaw(
        JSON.stringify(rawBody),
      );
      expect(invalidBody.status).toBe(400);
      expect(invalidBody.body).toStrictEqual({
        error: "composeId and connectorSlugs are required",
      });
    }

    const malformedSlugs = await authDevice.requestTestEnableConnector(
      {},
      { composeId: ZERO_COMPOSE_ID, connectorSlugs: ["not a connector slug"] },
      [400],
    );
    expect(malformedSlugs.body).toStrictEqual({
      error: "Unknown connector slugs: not a connector slug",
    });

    const unknownSlugs = await authDevice.requestTestEnableConnector(
      {},
      { composeId: ZERO_COMPOSE_ID, connectorSlugs: ["not-a-real-connector"] },
      [400],
    );
    expect(unknownSlugs.body).toStrictEqual({
      error: "Unknown connector slugs: not-a-real-connector",
    });

    const freshActor = bdd.user();
    authDevice.seedClerkDirectory(freshActor);
    const noOrg = await authDevice.requestTestEnableConnector(
      { email: freshActor.email },
      { composeId: ZERO_COMPOSE_ID, connectorSlugs: ["github"] },
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: "Test user has no org — run test-token first",
    });

    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    const missingCompose = await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: ZERO_COMPOSE_ID, connectorSlugs: ["github"] },
      [404],
    );
    expect(missingCompose.body).toStrictEqual({
      error: `Compose not found: ${ZERO_COMPOSE_ID}`,
    });
  });

  it("rejects connector fixtures that would privatize the default agent", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    const status = await bdd.readOnboardingStatus(actor);
    if (!status.defaultAgentId) {
      throw new Error("Expected the workspace default agent");
    }
    const before = await authDevice.readUserConnectors(
      actor,
      status.defaultAgentId,
    );
    const response = await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: status.defaultAgentId, connectorSlugs: ["github"] },
      [400],
    );
    expect(response.body).toMatchObject({
      error: expect.stringContaining("must remain public"),
    });
    await expect(
      bdd.readAgent(actor, status.defaultAgentId),
    ).resolves.toMatchObject({
      isDefaultAgent: true,
      visibility: "public",
    });
    await expect(
      authDevice.readUserConnectors(actor, status.defaultAgentId),
    ).resolves.toStrictEqual(before);
  });

  it("enables connectors on an agent visible through the user-connectors API", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: `CLI auth BDD enable ${actor.userId.slice(-12)}`,
      visibility: "private",
    });

    const enabled = await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: agent.agentId, connectorSlugs: ["github", "slack"] },
      [200],
    );
    expect(enabled.body).toStrictEqual({
      ok: true,
      composeId: agent.agentId,
      connectorSlugs: ["github", "slack"],
    });

    const updatedAgent = await bdd.readAgent(actor, agent.agentId);
    expect(updatedAgent.visibility).toBe("private");

    const userBuiltinConnectors = await authDevice.readUserConnectors(
      actor,
      agent.agentId,
    );
    expect(
      [...userBuiltinConnectors.enabledConnectorSlugs].sort(),
    ).toStrictEqual(["github", "slack"]);

    const publicAgent = await bdd.createAgent(actor, {
      displayName: `Public test agent ${actor.userId.slice(-12)}`,
      visibility: "public",
    });
    await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: publicAgent.agentId, connectorSlugs: ["github"] },
      [200],
    );
    const updatedPublicAgent = await bdd.readAgent(actor, publicAgent.agentId);
    expect(updatedPublicAgent.visibility).toBe("private");
    expect(updatedPublicAgent.displayName).toBe(publicAgent.displayName);

    const customEmailAgent = await bdd.createAgent(actor, {
      displayName: `CLI auth BDD custom ${actor.userId.slice(-12)}`,
      visibility: "private",
    });
    await authDevice.requestTestEnableConnector(
      { email: "custom@test.com" },
      { composeId: customEmailAgent.agentId, connectorSlugs: ["github"] },
      [200],
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });
  });

  it("does not enable connectors for another test user's agent", async () => {
    const owner = bdd.user();
    await authDevice.provisionTestOrg(owner);
    const agent = await bdd.createAgent(owner, {
      displayName: `CLI auth BDD owner ${owner.userId.slice(-12)}`,
      visibility: "private",
    });

    const other = bdd.user();
    await authDevice.provisionTestOrg(other);
    const response = await authDevice.requestTestEnableConnector(
      { email: other.email },
      { composeId: agent.agentId, connectorSlugs: ["github"] },
      [404],
    );
    expect(response.body).toStrictEqual({
      error: `Compose not found: ${agent.agentId}`,
    });
  });

  it("allows protected preview rewrites for enable-connector", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: `CLI auth BDD preview ${actor.userId.slice(-12)}`,
      visibility: "private",
    });

    mockEnv("ENV", "preview");
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    const enabled = await authDevice.requestTestEnableConnector(
      { email: actor.email },
      { composeId: agent.agentId, connectorSlugs: ["github"] },
      [200],
    );
    expect(enabled.body).toStrictEqual({
      ok: true,
      composeId: agent.agentId,
      connectorSlugs: ["github"],
    });
  });
});

describe("CLI-TEST: test-codex-oauth", () => {
  async function readCodexProvider(actor: ReturnType<typeof bdd.user>) {
    const providers = await support.listModelProviders(actor);
    const provider = providers.body.modelProviders.find((candidate) => {
      return candidate.type === "codex-oauth-token";
    });
    if (!provider) {
      throw new Error("Expected codex-oauth-token provider in list");
    }
    return provider;
  }

  function expectAuthJsonShapeError(body: unknown, message: string): void {
    expect(body).toStrictEqual({
      error: `auth.json shape invalid: ${message}`,
    });
  }

  it("hides test-codex-oauth in production and allows preview rewrites", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    mockEnv("ENV", "production");
    const hidden = await authDevice.requestTestCodexOauth(
      {},
      LEGACY_CODEX_OAUTH_BODY,
      [404],
    );
    expect(hidden.body).toBe("Not found");

    mockEnv("ENV", "preview");
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const rewritten = await authDevice.requestTestCodexOauth(
      { email: actor.email },
      LEGACY_CODEX_OAUTH_BODY,
      [200],
    );
    if (rewritten.status !== 200) {
      throw new Error(
        `Expected preview-rewrite codex seed, got ${rewritten.status}`,
      );
    }
    expect(rewritten.body.orgId).toBe(actor.orgId);

    await authDevice.deleteOrgModelProvider(actor, "codex-oauth-token");
  });

  it("rejects malformed codex bodies and unprovisioned users", async () => {
    const invalidJson = await authDevice.requestTestCodexOauthRaw("{ not json");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body).toStrictEqual({ error: "Invalid JSON body" });

    const invalidShape = await authDevice.requestTestCodexOauthRaw(
      JSON.stringify({ accessToken: "missing-others" }),
    );
    expect(invalidShape.status).toBe(400);
    expect(invalidShape.body).toStrictEqual({ error: "Invalid body shape" });

    const freshActor = bdd.user();
    authDevice.seedClerkDirectory(freshActor);
    const noOrg = await authDevice.requestTestCodexOauth(
      { email: freshActor.email },
      LEGACY_CODEX_OAUTH_BODY,
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: "Test user has no org — run test-token first",
    });
  });

  it("seeds codex provider state visible through the model-providers API", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    const legacySeed = await authDevice.requestTestCodexOauth(
      {},
      {
        ...LEGACY_CODEX_OAUTH_BODY,
        expiresIn: 600,
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_failed",
      },
      [200],
    );
    if (legacySeed.status !== 200) {
      throw new Error(`Expected codex legacy seed, got ${legacySeed.status}`);
    }
    expect(legacySeed.body.ok).toBeTruthy();
    expect(legacySeed.body.orgId).toBe(actor.orgId);
    expect(legacySeed.body.tokenExpiresAt).toBeDefined();
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [DEFAULT_TEST_EMAIL],
    });

    const legacyProvider = await readCodexProvider(actor);
    expect(legacyProvider).toMatchObject({
      authMethod: "auth_json",
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_failed",
    });

    const preExpired = await authDevice.requestTestCodexOauth(
      {},
      { ...LEGACY_CODEX_OAUTH_BODY, expiresIn: -60 },
      [200],
    );
    if (preExpired.status !== 200) {
      throw new Error(`Expected pre-expired seed, got ${preExpired.status}`);
    }
    if (!preExpired.body.tokenExpiresAt) {
      throw new Error("Expected pre-expired tokenExpiresAt in response");
    }
    expect(Date.parse(preExpired.body.tokenExpiresAt)).toBeLessThan(now());

    const authJsonSeed = await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson() },
      [200],
    );
    if (authJsonSeed.status !== 200) {
      throw new Error(`Expected auth.json seed, got ${authJsonSeed.status}`);
    }
    expect(authJsonSeed.body.tokenExpiresAt).toBeDefined();
    const pastedProvider = await readCodexProvider(actor);
    expect(pastedProvider).toMatchObject({
      authMethod: "auth_json",
      workspaceName: "Acme",
      planType: "plus",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    await authDevice.requestTestCodexOauth(
      {},
      {
        authJson: makeCodexAuthJson({
          workspaceName: "Acme Preserved",
          planType: "business",
        }),
      },
      [200],
    );
    await authDevice.requestTestCodexOauth(
      {},
      { ...LEGACY_CODEX_OAUTH_BODY, expiresIn: 600 },
      [200],
    );
    const preservedProvider = await readCodexProvider(actor);
    expect(preservedProvider).toMatchObject({
      workspaceName: "Acme Preserved",
      planType: "business",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    const malformed = await authDevice.requestTestCodexOauth(
      {},
      { authJson: "{ not json" },
      [400],
    );
    expect(malformed.body).toStrictEqual({
      error: "auth.json shape invalid: auth.json is not valid JSON",
    });

    const freePlan = await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson({ planType: "free" }) },
      [400],
    );
    expect(freePlan.body).toStrictEqual({
      error: "Free plan rejected by parser",
    });

    await authDevice.requestTestCodexOauth(
      { email: "custom@test.com" },
      LEGACY_CODEX_OAUTH_BODY,
      [200],
    );
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["custom@test.com"],
    });

    await authDevice.deleteOrgModelProvider(actor, "codex-oauth-token");
  });

  it("accepts pasted auth.json claim variants through public API state", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson({ withApiKey: true }) },
      [200],
    );
    const organizationTitleProvider = await readCodexProvider(actor);
    expect(organizationTitleProvider).toMatchObject({
      workspaceName: "Acme",
      planType: "plus",
    });

    for (const variant of [
      {
        workspaceClaim: "workspace.name" as const,
        workspaceName: "Workspace Claim",
      },
      {
        workspaceClaim: "chatgpt_workspace_name" as const,
        workspaceName: "Legacy Workspace Claim",
      },
    ]) {
      await authDevice.requestTestCodexOauth(
        {},
        { authJson: makeCodexAuthJson(variant) },
        [200],
      );
      const variantProvider = await readCodexProvider(actor);
      expect(variantProvider).toMatchObject({
        workspaceName: variant.workspaceName,
        planType: "plus",
      });
    }

    await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson({ workspaceName: null }) },
      [200],
    );
    const missingWorkspaceProvider = await readCodexProvider(actor);
    expect(missingWorkspaceProvider).toMatchObject({
      workspaceName: null,
      planType: "plus",
    });

    await authDevice.deleteOrgModelProvider(actor, "codex-oauth-token");
  });

  it("derives pasted auth.json expiry from API inputs", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    const accessExp = Math.floor(now() / 1000) + 7200;
    const accessExpiry = await authDevice.requestTestCodexOauth(
      {},
      {
        authJson: makeCodexAuthJson({
          accessToken: makeCodexJwt({ exp: accessExp, sub: "user" }),
          idTokenExpiresAt: accessExp - 3600,
        }),
      },
      [200],
    );
    if (accessExpiry.status !== 200) {
      throw new Error(
        `Expected access expiry seed, got ${accessExpiry.status}`,
      );
    }
    if (!accessExpiry.body.tokenExpiresAt) {
      throw new Error("Expected access tokenExpiresAt in response");
    }
    expect(Date.parse(accessExpiry.body.tokenExpiresAt)).toBe(accessExp * 1000);

    const idTokenExp = accessExp + 3600;
    const fallbackExpiry = await authDevice.requestTestCodexOauth(
      {},
      {
        authJson: makeCodexAuthJson({
          accessToken: "opaque-access-token",
          idTokenExpiresAt: idTokenExp,
        }),
      },
      [200],
    );
    if (fallbackExpiry.status !== 200) {
      throw new Error(
        `Expected fallback expiry seed, got ${fallbackExpiry.status}`,
      );
    }
    if (!fallbackExpiry.body.tokenExpiresAt) {
      throw new Error("Expected fallback tokenExpiresAt in response");
    }
    expect(Date.parse(fallbackExpiry.body.tokenExpiresAt)).toBe(
      idTokenExp * 1000,
    );

    await authDevice.deleteOrgModelProvider(actor, "codex-oauth-token");
  });

  it("maps invalid pasted auth.json inputs to endpoint errors", async () => {
    expect.hasAssertions();
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);

    const missingTokens = await authDevice.requestTestCodexOauth(
      {},
      { authJson: JSON.stringify({ OPENAI_API_KEY: "sk-test" }) },
      [400],
    );
    expectAuthJsonShapeError(
      missingTokens.body,
      "auth.json shape unrecognized — your codex CLI may need updating",
    );

    const invalidIdToken = await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson({ idToken: "not-a-jwt-at-all" }) },
      [400],
    );
    expectAuthJsonShapeError(
      invalidIdToken.body,
      "auth.json id_token claims unparsable",
    );

    const missingClaims = await authDevice.requestTestCodexOauth(
      {},
      { authJson: makeCodexAuthJson({ accountId: null }) },
      [400],
    );
    expectAuthJsonShapeError(
      missingClaims.body,
      "auth.json id_token missing required claims",
    );

    const missingExp = await authDevice.requestTestCodexOauth(
      {},
      {
        authJson: makeCodexAuthJson({
          accessToken: makeCodexJwt({ sub: "user" }),
          idTokenExpiresAt: null,
        }),
      },
      [400],
    );
    expectAuthJsonShapeError(
      missingExp.body,
      "auth.json access_token has no exp claim",
    );

    const oversized = await authDevice.requestTestCodexOauth(
      {},
      { authJson: " ".repeat(17 * 1024) + makeCodexAuthJson() },
      [400],
    );
    expectAuthJsonShapeError(
      oversized.body,
      "auth.json is unexpectedly large — paste only the contents of ~/.codex/auth.json",
    );
  });
});
