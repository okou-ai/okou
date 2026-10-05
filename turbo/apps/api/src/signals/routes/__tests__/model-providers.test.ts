import { randomUUID } from "node:crypto";
import { modelProviderCooldownDiagnosticsContract } from "@okouai/api-contracts/contracts/model-provider-routes";
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
import { insertCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { createPublicModelFailureFixture } from "./helpers/public-model-failure";
import { createRouteMocks } from "./helpers/route-test";

import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { modelProvidersRoutes } from "../model-providers";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);

async function customOrgUser(fixture: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<typeof fixture> {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

  return fixture;
}

async function uniqueOrgUser(prefix: string) {
  return await customOrgUser({
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  });
}

interface DiagnosticRuntimeRoute {
  readonly provider_type: "openai-api-key" | "openrouter-codex";
  readonly upstream_model: string;
}

async function configureDiagnosticModel(
  selectedModel: string,
  routes: readonly DiagnosticRuntimeRoute[],
): Promise<void> {
  const restore = await insertCatalogModelFixture({
    model: selectedModel,
    displayName: "Owned cooldown diagnostic model",
    sortOrder: 100_000,
    // These exact arbitrary upstream identities use the supported native
    // Codex protocols; they are not substituted with a Pi catalog model.
    builtInRoutes: routes.map((route, priority) => {
      return {
        concreteProviderType: route.provider_type,
        upstreamModel: route.upstream_model,
        priority,
        efforts: ["medium"],
        defaultEffort: "medium",
      };
    }),
  });
  onTestFinished(restore);
  await seedBuiltInModelCandidateKeys(context, selectedModel);
}

async function reportDiagnosticCooldown(
  producer: Awaited<ReturnType<typeof createPublicModelFailureFixture>>,
  selectedModel: string,
  route: DiagnosticRuntimeRoute,
  receivedAt: number,
  durations: readonly number[],
): Promise<void> {
  await withMockNowForTest(receivedAt, async () => {
    const claimed = await producer.claim(selectedModel);
    expect(claimed.log).toMatchObject({
      selectedModel,
      modelRuntimeProvider: route.provider_type,
      modelRuntimeModel: route.upstream_model,
    });
    for (const retryAfterSeconds of durations) {
      await expect(
        createRunsApi(context).reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "rate_limit",
          retryAfterSeconds,
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });
    }
    await producer.finish(claimed.runId);
  });
}

describe("GET /api/model-providers/cooldown-diagnostics", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when OkouDebug is disabled", async () => {
    const fixture = await uniqueOrgUser("cooldown-disabled");
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
    const fixture = await uniqueOrgUser("cooldown-active");
    const selectedModelPrefix = `diagnostic-${randomUUID()}`;
    const startedAt = Date.UTC(2026, 7, 23, 12, 0, 0);
    const earlierDeadline = new Date(startedAt + 30_000);
    const laterDeadline = new Date(startedAt + 60_000);
    const expiredDeadline = new Date(startedAt - 1);
    const firstRoute = {
      provider_type: "openai-api-key" as const,
      upstream_model: `${selectedModelPrefix}-upstream-b`,
    };
    const secondRoute = {
      provider_type: "openrouter-codex" as const,
      upstream_model: `${selectedModelPrefix}-upstream-a`,
    };
    const expiredRoute = {
      provider_type: "openai-api-key" as const,
      upstream_model: `${selectedModelPrefix}-expired`,
    };
    await configureDiagnosticModel(`${selectedModelPrefix}-b`, [firstRoute]);
    await configureDiagnosticModel(`${selectedModelPrefix}-a`, [secondRoute]);
    await configureDiagnosticModel(`${selectedModelPrefix}-expired`, [
      expiredRoute,
    ]);
    const producer = await withMockNowForTest(startedAt - 60_000, async () => {
      return await createPublicModelFailureFixture(context, [
        `${selectedModelPrefix}-b`,
        `${selectedModelPrefix}-a`,
        `${selectedModelPrefix}-expired`,
      ]);
    });
    await reportDiagnosticCooldown(
      producer,
      `${selectedModelPrefix}-b`,
      firstRoute,
      startedAt,
      [30, 60],
    );
    await reportDiagnosticCooldown(
      producer,
      `${selectedModelPrefix}-a`,
      secondRoute,
      startedAt,
      [30],
    );
    await reportDiagnosticCooldown(
      producer,
      `${selectedModelPrefix}-expired`,
      expiredRoute,
      expiredDeadline.getTime() - 30_000,
      [30],
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
    const fixture = await uniqueOrgUser("cooldown-cancel-non-staff");
    const selectedModel = `diagnostic-${randomUUID()}`;
    const unavailableUntil = new Date(now() + 60_000);
    const route = {
      provider_type: "openai-api-key" as const,
      upstream_model: `${selectedModel}-upstream`,
    };
    await configureDiagnosticModel(selectedModel, [route]);
    const producer = await withMockNowForTest(
      unavailableUntil.getTime() - 120_000,
      async () => {
        return await createPublicModelFailureFixture(context, [selectedModel]);
      },
    );
    await reportDiagnosticCooldown(
      producer,
      selectedModel,
      route,
      unavailableUntil.getTime() - 60_000,
      [60],
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
      provider_type: "openai-api-key" as const,
      upstream_model: `${selectedModel}-selected`,
    };
    const siblingRoute = {
      provider_type: "openrouter-codex" as const,
      upstream_model: `${selectedModel}-sibling`,
    };
    await configureDiagnosticModel(selectedModel, [
      selectedRoute,
      siblingRoute,
    ]);
    const producer = await withMockNowForTest(
      unavailableUntil.getTime() - 120_000,
      async () => {
        return await createPublicModelFailureFixture(context, [selectedModel]);
      },
    );
    await reportDiagnosticCooldown(
      producer,
      selectedModel,
      selectedRoute,
      unavailableUntil.getTime() - 60_000,
      [60],
    );
    await reportDiagnosticCooldown(
      producer,
      selectedModel,
      siblingRoute,
      unavailableUntil.getTime() - 60_000,
      [60],
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
