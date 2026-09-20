import { randomUUID } from "node:crypto";
import {
  modelProviderCooldownDiagnosticsContract,
  modelProvidersByTypeContract,
  modelProvidersMainContract,
} from "@okouai/api-contracts/contracts/model-provider-routes";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { webhookFirewallAuthContract } from "@okouai/api-contracts/contracts/webhooks";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now, withMockNowForTest } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { setBuiltInCandidateCooldownFixture } from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { modelProvidersRoutes } from "../model-providers";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);

function uniqueOrgUser(prefix: string): {
  readonly orgId: string;
  readonly userId: string;
} {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

type CodexWorkspaceClaim =
  | "organization.title"
  | "organization.name"
  | "workspace.name"
  | "workspace.title"
  | "chatgpt_workspace_name"
  | "chatgpt_workspace_display_name";

function makeIdToken(opts: {
  readonly accountId: string | null;
  readonly exp?: number | null;
  readonly planType: string | null;
  readonly workspaceClaim?: CodexWorkspaceClaim;
  readonly workspaceName?: string | null;
}): string {
  const auth: Record<string, unknown> = {};
  if (opts.accountId !== null) {
    auth.chatgpt_account_id = opts.accountId;
  }
  if (opts.planType !== null) {
    auth.chatgpt_plan_type = opts.planType;
  }
  if (opts.workspaceName !== undefined && opts.workspaceName !== null) {
    switch (opts.workspaceClaim ?? "organization.title") {
      case "organization.title": {
        auth.organization = { title: opts.workspaceName };
        break;
      }
      case "organization.name": {
        auth.organization = { name: opts.workspaceName };
        break;
      }
      case "workspace.name": {
        auth.workspace = { name: opts.workspaceName };
        break;
      }
      case "workspace.title": {
        auth.workspace = { title: opts.workspaceName };
        break;
      }
      case "chatgpt_workspace_name": {
        auth.chatgpt_workspace_name = opts.workspaceName;
        break;
      }
      case "chatgpt_workspace_display_name": {
        auth.chatgpt_workspace_display_name = opts.workspaceName;
        break;
      }
    }
  }

  const payload: Record<string, unknown> = {
    "https://api.openai.com/auth": auth,
  };
  const exp =
    opts.exp === undefined ? Math.floor(now() / 1000) + 3600 : opts.exp;
  if (exp !== null) {
    payload.exp = exp;
  }
  return makeJwt(payload);
}

function makeAuthJson(overrides?: {
  readonly accessToken?: string;
  readonly accountId?: string | null;
  readonly idToken?: string;
  readonly idTokenExpiresAt?: number | null;
  readonly refreshToken?: string;
  readonly planType?: string | null;
  readonly withApiKey?: boolean;
  readonly workspaceClaim?: CodexWorkspaceClaim;
  readonly workspaceName?: string | null;
}): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  const workspaceName =
    overrides?.workspaceName === undefined
      ? "Org Acme"
      : overrides.workspaceName;
  return JSON.stringify({
    OPENAI_API_KEY: overrides?.withApiKey ? "sk-test" : null,
    tokens: {
      access_token: overrides?.accessToken ?? makeJwt({ exp: accessExp }),
      refresh_token: overrides?.refreshToken ?? "rt_org_synthetic_high_entropy",
      account_id: "ws_acct_plain",
      id_token:
        overrides?.idToken ??
        makeIdToken({
          accountId:
            overrides?.accountId === undefined
              ? "ws_acct_from_id_token_org"
              : overrides.accountId,
          exp: overrides?.idTokenExpiresAt,
          planType:
            overrides?.planType === undefined ? "plus" : overrides.planType,
          workspaceClaim: overrides?.workspaceClaim,
          workspaceName,
        }),
    },
  });
}

function secretTemplate(name: string): string {
  return `\${{ secrets.${name} }}`;
}

function encryptedSecretsBody(values: Record<string, string>): string {
  return encryptSecretForTests(JSON.stringify(values));
}

interface EntitledRunActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
}

async function entitledRunActor(): Promise<EntitledRunActor> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Firewall Auth Test",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId };
}

async function markOrgCodexProviderStaleViaFirewall(
  entitled: EntitledRunActor,
  accessToken: string,
): Promise<void> {
  const api = createRunsApi(context);
  const { actor, agentId } = entitled;
  if (!actor.orgId) {
    throw new Error("Entitled actor must be org-scoped");
  }
  const run = await api.createRun(actor, {
    agentId,
    prompt: "trigger firewall auth token refresh",
    modelProvider: "anthropic-api-key",
  });

  server.use(
    http.post("https://auth.openai.com/oauth/token", () => {
      return HttpResponse.json(
        {
          error: {
            code: "refresh_token_expired",
            message: "expired refresh token",
          },
        },
        { status: 401 },
      );
    }),
  );

  const client = setupApp({ context, routes: webhooksAgentFirewallAuthRoutes })(
    webhookFirewallAuthContract,
  );
  const failed = await accept(
    client.resolve({
      headers: {
        authorization: `Bearer ${generateSandboxToken(
          actor.userId,
          run.runId,
          actor.orgId,
        )}`,
      },
      body: {
        encryptedSecrets: encryptedSecretsBody({
          CHATGPT_ACCESS_TOKEN: accessToken,
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        },
        secretConnectorMap: {
          CHATGPT_ACCESS_TOKEN: "codex-oauth-token",
        },
      },
    }),
    [502],
  );

  expect(failed.body.error.code).toBe("TOKEN_REFRESH_FAILED");
  expect(failed.body.error.failureReason).toBe("reconnect_required");
}

describe("GET /api/model-providers", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns empty list when no org providers exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toStrictEqual([]);
  });

  it("allows organization members to list org providers", async () => {
    const fixture = uniqueOrgUser("zmp-list-member");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toStrictEqual([]);
  });

  it("lists org providers", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders).toHaveLength(1);
    expect(response.body.modelProviders[0]?.type).toBe("anthropic-api-key");
  });

  it("does not show first provider as default", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.modelProviders[0]?.isDefault).toBeFalsy();
  });

  it("does not show same-framework providers as default", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "claude-code-oauth-token", secret: "sk-claude-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const anthropic = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "anthropic-api-key";
      },
    );
    const oauth = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "claude-code-oauth-token";
      },
    );
    expect(anthropic?.isDefault).toBeFalsy();
    expect(oauth?.isDefault).toBeFalsy();
  });

  it("does not mark provider rows as framework defaults via list", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const defaultProvider = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.isDefault && provider.framework === "claude-code";
      },
    );
    expect(defaultProvider).toBeUndefined();
  });

  it("has no default for framework when no providers exist", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const defaultProvider = response.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.isDefault && provider.framework === "claude-code";
      },
    );
    expect(defaultProvider).toBeUndefined();
  });

  it("surfaces OAuth refresh state on listed providers", async () => {
    const entitled = await entitledRunActor();
    mocks.clerk.session(
      entitled.actor.userId,
      entitled.actor.orgId,
      "org:admin",
    );
    const expiredAccess = makeJwt({
      exp: Math.floor(now() / 1000) - 60,
      sub: "expired",
    });

    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: makeAuthJson({ accessToken: expiredAccess }),
          },
        },
      }),
      [201],
    );
    await markOrgCodexProviderStaleViaFirewall(entitled, expiredAccess);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const provider = response.body.modelProviders.find(
      (candidate: ModelProviderResponse) => {
        return candidate.type === "codex-oauth-token";
      },
    );
    expect(provider?.needsReconnect).toBeTruthy();
    expect(provider?.lastRefreshErrorCode).toBe("refresh_token_expired");
  });
});

describe("GET /api/model-providers/cooldown-diagnostics", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when OkouDebug is disabled", async () => {
    const fixture = uniqueOrgUser("cooldown-disabled");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Built-in model cooldown diagnostics are not enabled",
      code: "FORBIDDEN",
    });
  });

  it("returns active global cooldowns", async () => {
    const fixture = uniqueOrgUser("cooldown-active");
    const selectedModelPrefix = `diagnostic-${randomUUID()}`;
    const startedAt = Date.UTC(2026, 7, 23, 12, 0, 0);
    const earlierDeadline = new Date(startedAt + 30_000);
    const laterDeadline = new Date(startedAt + 60_000);
    const expiredDeadline = new Date(startedAt - 1);
    const firstRoute = {
      provider_type: "openai-api-key",
      upstream_model: `${selectedModelPrefix}-upstream-b`,
      model_key_id: randomUUID(),
    };
    const secondRoute = {
      provider_type: "openrouter-codex",
      upstream_model: `${selectedModelPrefix}-upstream-a`,
      model_key_id: randomUUID(),
    };
    const expiredRoute = {
      provider_type: "openai-api-key",
      upstream_model: `${selectedModelPrefix}-expired`,
      model_key_id: randomUUID(),
    };
    await setBuiltInCandidateCooldownFixture(
      context,
      `${selectedModelPrefix}-b`,
      firstRoute,
      earlierDeadline,
    );
    await setBuiltInCandidateCooldownFixture(
      context,
      `${selectedModelPrefix}-b`,
      firstRoute,
      laterDeadline,
    );
    await setBuiltInCandidateCooldownFixture(
      context,
      `${selectedModelPrefix}-a`,
      secondRoute,
      earlierDeadline,
    );
    await setBuiltInCandidateCooldownFixture(
      context,
      `${selectedModelPrefix}-expired`,
      expiredRoute,
      expiredDeadline,
    );
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    onTestFinished(async () => {
      await deleteFeatureSwitchesForUser(context, fixture);
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );

    const response = await withMockNowForTest(startedAt, async () => {
      return await accept(
        client.get({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
    });
    const ownedCooldowns = response.body.activeCooldowns.filter((cooldown) => {
      return cooldown.selectedModel.startsWith(selectedModelPrefix);
    });

    expect(response.body.canCancelCooldowns).toBeFalsy();
    expect(ownedCooldowns).toStrictEqual([
      {
        selectedModel: `${selectedModelPrefix}-a`,
        providerType: secondRoute.provider_type,
        upstreamModel: secondRoute.upstream_model,
        unavailableUntil: earlierDeadline.toISOString(),
      },
      {
        selectedModel: `${selectedModelPrefix}-b`,
        providerType: firstRoute.provider_type,
        upstreamModel: firstRoute.upstream_model,
        unavailableUntil: laterDeadline.toISOString(),
      },
    ]);
  });
});

describe("DELETE /api/model-providers/cooldown-diagnostics", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );

    const response = await accept(
      client.cancel({
        headers: {},
        body: {
          selectedModel: "gpt-5.6-luna",
          providerType: "openai-api-key",
          upstreamModel: "gpt-5.6-luna-2026-08-01",
        },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects non-staff callers without changing the cooldown", async () => {
    const fixture = uniqueOrgUser("cooldown-cancel-non-staff");
    const selectedModel = `diagnostic-${randomUUID()}`;
    const unavailableUntil = new Date(now() + 60_000);
    const route = {
      provider_type: "openai-api-key",
      upstream_model: `${selectedModel}-upstream`,
      model_key_id: randomUUID(),
    };
    await setBuiltInCandidateCooldownFixture(
      context,
      selectedModel,
      route,
      unavailableUntil,
    );
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    onTestFinished(async () => {
      await deleteFeatureSwitchesForUser(context, fixture);
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );

    const response = await accept(
      client.cancel({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          selectedModel,
          providerType: route.provider_type,
          upstreamModel: route.upstream_model,
        },
      }),
      [403],
    );
    expect(response.body.error).toStrictEqual({
      message: "Only staff can cancel built-in model cooldowns",
      code: "FORBIDDEN",
    });

    const diagnostics = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(diagnostics.body.canCancelCooldowns).toBeFalsy();
    expect(
      diagnostics.body.activeCooldowns.filter((cooldown) => {
        return cooldown.selectedModel === selectedModel;
      }),
    ).toStrictEqual([
      {
        selectedModel,
        providerType: route.provider_type,
        upstreamModel: route.upstream_model,
        unavailableUntil: unavailableUntil.toISOString(),
      },
    ]);
  });

  it("lets staff cancel only the selected cooldown", async () => {
    const fixture = {
      orgId: createUniqueStaffOrgIdFixture(),
      userId: `user_cooldown-cancel-staff_${randomUUID().slice(0, 8)}`,
    };
    const selectedModel = `diagnostic-${randomUUID()}`;
    const unavailableUntil = new Date(now() + 60_000);
    const selectedRoute = {
      provider_type: "openai-api-key",
      upstream_model: `${selectedModel}-selected`,
      model_key_id: randomUUID(),
    };
    const siblingRoute = {
      provider_type: "openrouter-codex",
      upstream_model: `${selectedModel}-sibling`,
      model_key_id: randomUUID(),
    };
    await setBuiltInCandidateCooldownFixture(
      context,
      selectedModel,
      selectedRoute,
      unavailableUntil,
    );
    await setBuiltInCandidateCooldownFixture(
      context,
      selectedModel,
      siblingRoute,
      unavailableUntil,
    );
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    onTestFinished(async () => {
      await deleteFeatureSwitchesForUser(context, fixture);
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );

    const before = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(before.body.canCancelCooldowns).toBeTruthy();
    expect(
      before.body.activeCooldowns.filter((cooldown) => {
        return cooldown.selectedModel === selectedModel;
      }),
    ).toHaveLength(2);

    await accept(
      client.cancel({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          selectedModel,
          providerType: selectedRoute.provider_type,
          upstreamModel: selectedRoute.upstream_model,
        },
      }),
      [204],
    );

    const after = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      after.body.activeCooldowns.filter((cooldown) => {
        return cooldown.selectedModel === selectedModel;
      }),
    ).toStrictEqual([
      {
        selectedModel,
        providerType: siblingRoute.provider_type,
        upstreamModel: siblingRoute.upstream_model,
        unavailableUntil: unavailableUntil.toISOString(),
      },
    ]);
  });
});

describe("POST /api/model-providers", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.upsert({
        headers: {},
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the caller is not an org admin", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-member");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Only admins can manage org model providers",
    );
  });

  it("creates and updates an org single-secret provider", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-single");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const first = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "anthropic-api-key",
          secret: "sk-ant-v1",
        },
      }),
      [201],
    );
    const second = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "anthropic-api-key",
          secret: "sk-ant-v2",
        },
      }),
      [200],
    );

    expect(first.body.created).toBeTruthy();
    expect(second.body.created).toBeFalsy();
    expect(second.body.provider.id).toBe(first.body.provider.id);
    expect(second.body.provider.selectedModel).toBeNull();
    expect(second.body.provider.isDefault).toBeFalsy();

    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const provider = list.body.modelProviders.find(
      (candidate: ModelProviderResponse) => {
        return candidate.type === "anthropic-api-key";
      },
    );
    expect(provider?.id).toBe(first.body.provider.id);
    expect(provider?.secretName).toBe("ANTHROPIC_API_KEY");
  });

  it("rejects whitespace-only org single-secret provider secrets", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-blank-secret");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "openrouter-api-key",
          secret: "   ",
        },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      'Provider "openrouter-api-key" requires a non-empty secret',
    );
    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "openrouter-api-key";
      }),
    ).toBeUndefined();
  });

  it("creates org-level AWS Bedrock multi-auth provider", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-bedrock");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "aws-bedrock",
          authMethod: "access-keys",
          secrets: {
            AWS_ACCESS_KEY_ID: "test-access-key",
            AWS_SECRET_ACCESS_KEY: "test-secret-key",
            AWS_REGION: "us-east-1",
          },
        },
      }),
      [201],
    );

    expect(response.body.provider.type).toBe("aws-bedrock");
    expect(response.body.provider.authMethod).toBe("access-keys");
    expect(response.body.provider.secretNames).toStrictEqual(
      expect.arrayContaining([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
      ]),
    );
    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const provider = list.body.modelProviders.find(
      (candidate: ModelProviderResponse) => {
        return candidate.type === "aws-bedrock";
      },
    );
    expect(provider?.authMethod).toBe("access-keys");
    expect(provider?.secretNames).toStrictEqual(
      expect.arrayContaining([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION",
      ]),
    );
  });

  it("rejects invalid multi-auth shape for single-secret providers", async () => {
    const fixture = uniqueOrgUser("zmp-upsert-bad-multi");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "anthropic-api-key",
          authMethod: "api-key",
          secrets: { ANTHROPIC_API_KEY: "sk-ant-test" },
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("creates an openai-api-key provider by default", async () => {
    const fixture = uniqueOrgUser("zmp-openai");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "openai-api-key",
          secret: "sk-proj-test",
        },
      }),
      [201],
    );
    expect(response.body.provider.framework).toBe("codex");
    expect(response.body.provider.type).toBe("openai-api-key");

    const other = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
    expect(other.body.provider.type).toBe("anthropic-api-key");
  });

  it("does not mark provider rows as defaults across frameworks", async () => {
    const fixture = uniqueOrgUser("zmp-cross-framework");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "openai-api-key",
          secret: "sk-proj-test",
        },
      }),
      [201],
    );

    const list = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.filter((provider: ModelProviderResponse) => {
        return provider.isDefault;
      }),
    ).toHaveLength(0);
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "anthropic-api-key";
      })?.isDefault,
    ).toBeFalsy();
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "openai-api-key";
      })?.isDefault,
    ).toBeFalsy();
  });

  it("handles codex auth_json paste", async () => {
    const fixture = uniqueOrgUser("zmp-codex-paste");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        expect(request.headers.get("chatgpt-account-id")).toBe(
          "ws_acct_from_id_token_org",
        );
        return HttpResponse.json({
          plan_type: "pro",
          workspace_name: "Usage Org Acme",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 18_000,
              reset_at: 1_893_441_600,
            },
            secondary_window: {
              limit_window_seconds: 604_800,
              reset_at: 1_893_456_000,
            },
          },
        });
      }),
    );
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const response = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson({ workspaceName: null }) },
        },
      }),
      [201],
    );

    expect(response.body.provider.type).toBe("codex-oauth-token");
    expect(response.body.provider.authMethod).toBe("auth_json");
    expect(response.body.provider.workspaceName).toBe("Usage Org Acme");
    expect(response.body.provider.planType).toBe("pro");
    expect(response.body.provider).toMatchObject({
      workspaceName: "Usage Org Acme",
      planType: "pro",
      subscriptionResetPeriod: "weekly",
      subscriptionNextResetAt: "2030-01-01T00:00:00.000Z",
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("handles codex auth_json claim variants through provider upsert", async () => {
    const fixture = uniqueOrgUser("zmp-codex-claims");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const withApiKey = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson({ withApiKey: true }) },
        },
      }),
      [201],
    );
    expect(withApiKey.body.provider).toMatchObject({
      workspaceName: "Org Acme",
      planType: "plus",
    });

    for (const variant of [
      {
        workspaceClaim: "organization.name" as const,
        workspaceName: "Organization Name Claim",
      },
      {
        workspaceClaim: "workspace.name" as const,
        workspaceName: "Workspace Claim",
      },
      {
        workspaceClaim: "workspace.title" as const,
        workspaceName: "Workspace Title Claim",
      },
      {
        workspaceClaim: "chatgpt_workspace_name" as const,
        workspaceName: "Legacy Workspace Claim",
      },
      {
        workspaceClaim: "chatgpt_workspace_display_name" as const,
        workspaceName: "Workspace Display Claim",
      },
      {
        workspaceClaim: "organization.title" as const,
        workspaceName: null,
      },
    ]) {
      const response = await accept(
        client.upsert({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            type: "codex-oauth-token",
            authMethod: "auth_json",
            secrets: { CODEX_AUTH_JSON: makeAuthJson(variant) },
          },
        }),
        [200],
      );
      expect(response.body.provider).toMatchObject({
        workspaceName: variant.workspaceName,
        planType: "plus",
      });
    }
  });

  it("returns typed codex auth_json validation errors", async () => {
    const fixture = uniqueOrgUser("zmp-codex-invalid");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    const malformed = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: "{ not json" },
        },
      }),
      [400],
    );
    expect(malformed.body.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");

    const free = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson({ planType: "free" }) },
        },
      }),
      [400],
    );
    expect(free.body.error.code).toBe("CODEX_FREE_PLAN_REJECTED");

    const missing = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {},
        },
      }),
      [400],
    );
    expect(missing.body.error.code).toBe("BAD_REQUEST");

    const missingRefresh = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: JSON.stringify({
              tokens: {
                access_token: makeJwt({ exp: Math.floor(now() / 1000) + 7200 }),
                account_id: "ws_acct",
                id_token: makeIdToken({
                  accountId: "ws_acct",
                  planType: "plus",
                }),
              },
            }),
          },
        },
      }),
      [400],
    );
    expect(missingRefresh.body.error.code).toBe(
      "CODEX_AUTH_JSON_SHAPE_INVALID",
    );
  });

  it("returns typed codex auth_json validation errors for token claims", async () => {
    const fixture = uniqueOrgUser("zmp-codex-token-invalid");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    for (const authJson of [
      JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
      makeAuthJson({ idToken: "not-a-jwt-at-all" }),
      makeAuthJson({ accountId: null }),
      makeAuthJson({
        accessToken: makeJwt({ sub: "user" }),
        idTokenExpiresAt: null,
      }),
      " ".repeat(17 * 1024) + makeAuthJson(),
    ]) {
      const response = await accept(
        client.upsert({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            type: "codex-oauth-token",
            authMethod: "auth_json",
            secrets: { CODEX_AUTH_JSON: authJson },
          },
        }),
        [400],
      );
      expect(response.body.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
    }
  });

  it("re-paste clears codex reconnect state", async () => {
    const entitled = await entitledRunActor();
    mocks.clerk.session(
      entitled.actor.userId,
      entitled.actor.orgId,
      "org:admin",
    );
    const expiredAccess = makeJwt({
      exp: Math.floor(now() / 1000) - 60,
      sub: "expired",
    });
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );

    await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: makeAuthJson({ accessToken: expiredAccess }),
          },
        },
      }),
      [201],
    );
    await markOrgCodexProviderStaleViaFirewall(entitled, expiredAccess);
    const stale = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const staleProvider = stale.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "codex-oauth-token";
      },
    );
    expect(staleProvider?.needsReconnect).toBeTruthy();

    const freshAccess = makeJwt({
      exp: Math.floor(now() / 1000) + 7200,
      sub: "fresh",
    });
    const repaste = await accept(
      client.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: makeAuthJson({
              accessToken: freshAccess,
              refreshToken: "rt_fresh_org",
            }),
          },
        },
      }),
      [200],
    );
    expect(repaste.body.created).toBeFalsy();
    expect(repaste.body.provider.needsReconnect).toBeFalsy();
    expect(repaste.body.provider.lastRefreshErrorCode).toBeNull();
  });
});

describe("DELETE /api/model-providers/:type", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersByTypeContract,
    );

    const response = await accept(
      client.delete({ headers: {}, params: { type: "anthropic-api-key" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersByTypeContract,
    );

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for non-admin members", async () => {
    const fixture = uniqueOrgUser("zmp-delete-member");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersByTypeContract,
    );

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Only admins can manage org model providers",
    );
  });

  it("returns 404 when the target provider is absent", async () => {
    const fixture = uniqueOrgUser("zmp-delete-missing");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersByTypeContract,
    );

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Resource not found");
  });

  it("deletes an org single-secret provider", async () => {
    const fixture = uniqueOrgUser("zmp-delete-legacy");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const mainClient = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );
    const byTypeClient = setupApp({
      context,
      routes: modelProvidersRoutes,
    })(modelProvidersByTypeContract);

    await accept(
      mainClient.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );

    const response = await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const list = await accept(
      mainClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "anthropic-api-key";
      }),
    ).toBeUndefined();

    const deletedAgain = await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [404],
    );
    expect(deletedAgain.body.error.message).toBe("Resource not found");
  });

  it("deletes a codex auth_json provider", async () => {
    const fixture = uniqueOrgUser("zmp-delete-multiauth");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const mainClient = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );
    const byTypeClient = setupApp({
      context,
      routes: modelProvidersRoutes,
    })(modelProvidersByTypeContract);

    await accept(
      mainClient.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeAuthJson() },
        },
      }),
      [201],
    );

    await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "codex-oauth-token" },
      }),
      [204],
    );

    const list = await accept(
      mainClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      list.body.modelProviders.find((provider: ModelProviderResponse) => {
        return provider.type === "codex-oauth-token";
      }),
    ).toBeUndefined();

    const deletedAgain = await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "codex-oauth-token" },
      }),
      [404],
    );
    expect(deletedAgain.body.error.message).toBe("Resource not found");
  });

  it("does not promote another provider when deleting a provider", async () => {
    const fixture = uniqueOrgUser("zmp-delete-default");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const mainClient = setupApp({ context, routes: modelProvidersRoutes })(
      modelProvidersMainContract,
    );
    const byTypeClient = setupApp({
      context,
      routes: modelProvidersRoutes,
    })(modelProvidersByTypeContract);

    await accept(
      mainClient.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "anthropic-api-key", secret: "sk-ant-test" },
      }),
      [201],
    );
    await accept(
      mainClient.upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: { type: "openai-api-key", secret: "sk-proj-test" },
      }),
      [201],
    );

    await accept(
      byTypeClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );

    const list = await accept(
      mainClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const remaining = list.body.modelProviders.find(
      (provider: ModelProviderResponse) => {
        return provider.type === "openai-api-key";
      },
    );
    expect(remaining?.isDefault).toBeFalsy();
  });
});
