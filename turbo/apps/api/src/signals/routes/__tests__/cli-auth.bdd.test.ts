import { claimPublicToolRun } from "./helpers/public-tool-actor";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createPublicFirewallConnections } from "./helpers/public-firewall-connections";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { env, mockEnv } from "../../../lib/env";
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

async function issueDevicePat(actor: ReturnType<typeof bdd.user>): Promise<{
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn: number;
}> {
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
  return {
    accessToken: token.body.access_token,
    tokenType: token.body.token_type,
    expiresIn: token.body.expires_in,
  };
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

    const initialPreferences =
      await support.readUninitializedPreferences(actor);
    expect(initialPreferences.body.error.code).toBe(
      "USER_PREFERENCES_UNINITIALIZED",
    );

    const second = await authDevice.startCliDevice();
    await authDevice.requestCliApproval(
      actor,
      { device_code: second.device_code, timezone: "America/Los_Angeles" },
      [200],
    );
    const missingLocale = await support.readUninitializedPreferences(actor);
    expect(missingLocale.body.error.code).toBe(
      "USER_PREFERENCES_UNINITIALIZED",
    );
    const initialized = await support.initializePreferences(actor);
    expect(initialized.body.timezone).toBe("America/Los_Angeles");
    expect(initialized.body.locale).toBe("en-US");
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
    const invalidTimezone =
      await support.readUninitializedPreferences(freshActor);
    expect(invalidTimezone.body.error.code).toBe(
      "USER_PREFERENCES_UNINITIALIZED",
    );
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

describe("CLI credentials acquired through normal user flows", () => {
  it("uses a device-approved PAT for me and reads a normally activated Pro subscription", async () => {
    const actor = bdd.user();
    await publicPlanLifecycle(context, actor).update("active");
    await bdd.completeOnboarding(actor);
    const issued = await issueDevicePat(actor);
    expect(issued.accessToken).toMatch(/^vm0_pat_/);
    expect(issued.tokenType).toBe("Bearer");
    expect(issued.expiresIn).toBe(90 * 24 * 60 * 60);
    const me = await authDevice.readMeWithBearer(
      issued.accessToken,
      actor,
      [200],
    );
    expect(me.body).toStrictEqual({
      userId: actor.userId,
      email: actor.email,
      orgId: actor.orgId,
    });
    expect((await authDevice.readBillingStatus(actor)).tier).toBe("pro");
  });

  it("reads normally connected OAuth and API-method accounts with their expiry", async () => {
    const actor = bdd.user();
    await bdd.completeOnboarding(actor);
    await support.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const connections = createPublicFirewallConnections(context);
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    onTestFinished(async () => {
      mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
      for (const account of await connectors.listBuiltinConnectorAccounts(
        actor,
        "test-oauth",
      )) {
        await connectors.deleteBuiltinConnectorAccount(
          actor,
          "test-oauth",
          account.id,
        );
      }
    });
    await connections.testOAuth(actor, {
      accessToken: "test-oauth-access-token",
      refreshToken: "test-oauth-refresh-token",
      expiresIn: -60,
    });
    const oauthState = await support.readConnectorBySlug(actor, "test-oauth");
    expect(oauthState).toMatchObject({
      authMethod: "oauth",
      externalUsername: "e2e-test-oauth",
    });
    if (!oauthState.tokenExpiresAt) {
      throw new Error("Expected the provider's token expiry");
    }
    expect(Date.parse(oauthState.tokenExpiresAt)).toBeLessThan(now());
    await connections.testOAuth(
      actor,
      {
        accessToken: "test-oauth-api-access-token",
        refreshToken: "test-oauth-api-refresh-token",
      },
      "api",
    );
    await expect(
      connectors.listBuiltinConnectorAccounts(actor, "test-oauth"),
    ).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oauthState.id, authMethod: "oauth" }),
        expect.objectContaining({ authMethod: "api" }),
      ]),
    );
  });
});

describe("Codex auth.json through the personal model-provider API", () => {
  function codexActor() {
    const actor = bdd.user();
    const owned = new Set<string>();
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    onTestFinished(async () => {
      mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
      for (const id of owned) {
        await support.deletePersonalModelProviderAccount(actor, id);
      }
    });
    return {
      actor,
      ownProvider(id: string) {
        owned.add(id);
      },
      async paste(
        authJson: string,
        statuses: readonly (200 | 201 | 400)[] = [200, 201],
      ) {
        const response = await createMiscRoutesApi(
          context,
        ).upsertPersonalModelProvider(
          actor,
          {
            type: "codex-oauth-token",
            authMethod: "auth_json",
            secrets: { CODEX_AUTH_JSON: authJson },
          },
          statuses,
        );
        if (response.status === 200 || response.status === 201) {
          owned.add(response.body.provider.id);
        }
        return response;
      },
    };
  }

  async function readCodexProvider(actor: ReturnType<typeof bdd.user>) {
    const providers = await support.listPersonalModelProviders(actor, [200]);
    if (!("modelProviders" in providers.body)) {
      throw new Error("Expected personal provider list");
    }
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
      error: { code: "CODEX_AUTH_JSON_SHAPE_INVALID", message },
    });
  }

  it("reads pasted Codex metadata and rejects malformed JSON and free subscriptions", async () => {
    const { actor, paste } = codexActor();
    await paste(makeCodexAuthJson());
    await expect(readCodexProvider(actor)).resolves.toMatchObject({
      workspaceName: "Acme",
      planType: "plus",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
    await paste(
      makeCodexAuthJson({
        workspaceName: "Acme Updated",
        planType: "business",
      }),
    );
    await expect(readCodexProvider(actor)).resolves.toMatchObject({
      workspaceName: "Acme Updated",
      planType: "business",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
    expectAuthJsonShapeError(
      (await paste("{ not json", [400])).body,
      "auth.json is not valid JSON",
    );
    expect(
      (await paste(makeCodexAuthJson({ planType: "free" }), [400])).body,
    ).toStrictEqual({
      error: {
        code: "CODEX_FREE_PLAN_REJECTED",
        message:
          "ChatGPT free plan is not supported — upgrade to Plus or higher.",
      },
    });
  });

  it("accepts all pasted auth.json workspace claim variants", async () => {
    const { actor, paste } = codexActor();
    await paste(makeCodexAuthJson({ withApiKey: true }));
    await expect(readCodexProvider(actor)).resolves.toMatchObject({
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
      await paste(makeCodexAuthJson(variant));
      await expect(readCodexProvider(actor)).resolves.toMatchObject({
        workspaceName: variant.workspaceName,
        planType: "plus",
      });
    }
    await paste(makeCodexAuthJson({ workspaceName: null }));
    await expect(readCodexProvider(actor)).resolves.toMatchObject({
      workspaceName: null,
      planType: "plus",
    });
  });

  it("derives pasted auth.json expiry from access tokens and the id-token fallback", async () => {
    const { actor, paste, ownProvider } = codexActor();
    await publicPlanLifecycle(context, actor).update("active");
    await bdd.completeOnboarding(actor);
    const run = await claimPublicToolRun(context, actor, onTestFinished);
    ownProvider(run.providerId);
    const firewall = createFirewallApi(context);
    const cacheExpiry = async (sourceId: string) => {
      const response = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${run.claim.sandboxToken}` },
        {
          encryptedSecrets: firewall.encryptedSecretsBody({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: { CHATGPT_ACCESS_TOKEN: "codex-oauth-token" },
          secretConnectorMetadataMap: {
            CHATGPT_ACCESS_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: actor.userId,
              sourceId,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        [200],
      );
      if (response.status !== 200) {
        throw new Error("Expected authenticated Runner credential resolution");
      }
      expect(response.body.refreshedConnectors).toStrictEqual([]);
      return response.body.expiresAt;
    };
    const accessExp = Math.floor(now() / 1000) + 7200;
    const accessExpiry = await paste(
      makeCodexAuthJson({
        accessToken: makeCodexJwt({ exp: accessExp, sub: "user" }),
        idTokenExpiresAt: accessExp - 3600,
      }),
    );
    if (accessExpiry.status !== 200 && accessExpiry.status !== 201) {
      throw new Error("Expected successful access-token paste");
    }
    await expect(cacheExpiry(accessExpiry.body.provider.id)).resolves.toBe(
      accessExp - 60,
    );
    const idTokenExp = accessExp + 3600;
    const fallback = await paste(
      makeCodexAuthJson({
        accessToken: "opaque-access-token",
        idTokenExpiresAt: idTokenExp,
      }),
    );
    if (fallback.status !== 200 && fallback.status !== 201) {
      throw new Error("Expected successful fallback paste");
    }
    await expect(cacheExpiry(fallback.body.provider.id)).resolves.toBe(
      idTokenExp - 60,
    );
  });

  it("maps all malformed pasted auth.json inputs to endpoint errors", async () => {
    expect.hasAssertions();
    const { paste } = codexActor();
    for (const [authJson, message] of [
      [
        JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
        "auth.json shape unrecognized — your codex CLI may need updating",
      ],
      [
        makeCodexAuthJson({ idToken: "not-a-jwt-at-all" }),
        "auth.json id_token claims unparsable",
      ],
      [
        makeCodexAuthJson({ accountId: null }),
        "auth.json id_token missing required claims",
      ],
      [
        makeCodexAuthJson({
          accessToken: makeCodexJwt({ sub: "user" }),
          idTokenExpiresAt: null,
        }),
        "auth.json access_token has no exp claim",
      ],
      [
        " ".repeat(17 * 1024) + makeCodexAuthJson(),
        "auth.json is unexpectedly large — paste only the contents of ~/.codex/auth.json",
      ],
    ] as const) {
      expectAuthJsonShapeError((await paste(authJson, [400])).body, message);
    }
  });
});
