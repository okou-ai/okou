import { randomUUID } from "node:crypto";
import { modelProviderCooldownDiagnosticsContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { AUTO_RUN_MODEL } from "@okouai/core/auto-run-model";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { now, withMockNowForTest } from "../../../lib/time";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { setBuiltInCandidateCooldownFixture } from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { modelProvidersRoutes } from "../model-providers";

const context = testContext();
const mocks = createRouteMocks(context);
const auto = {
  selectedModel: AUTO_RUN_MODEL,
  providerType: "openrouter-codex",
  upstreamModel: "@preset/okou-1-0",
} as const;
const memory = {
  selectedModel: "deepseek-v4.1-flash",
  providerType: "openrouter-codex",
  upstreamModel: "deepseek/deepseek-v4.1-flash",
} as const;
const historical = {
  selectedModel: "gpt-5.6-luna",
  providerType: "openai-api-key",
  upstreamModel: "gpt-5.6-luna",
} as const;
function diagnostics() {
  return setupApp({ context, routes: modelProvidersRoutes })(
    modelProviderCooldownDiagnosticsContract,
  );
}
const headers = { authorization: "Bearer clerk-session" } as const;
function actor(staff = false) {
  const fixture = {
    orgId: staff
      ? createUniqueStaffOrgIdFixture()
      : `org_diagnostics_${randomUUID()}`,
    userId: `user_diagnostics_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}
async function enableDiagnostics(fixture: ReturnType<typeof actor>) {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.OkouDebug]: true,
  });
  onTestFinished(() => {
    return deleteFeatureSwitchesForUser(context, fixture);
  });
  mocks.clerk.session(fixture.userId, fixture.orgId);
}
async function storedCooldown(
  binding: typeof auto | typeof memory | typeof historical,
  deadline: Date,
) {
  // Seed authoritative persisted cooldown history, not a new chat selection.
  // Auto and independent memory are the only surviving platform bindings.
  // Runner-report behavior is covered by test-runtime-state.test.ts.
  await setBuiltInCandidateCooldownFixture(
    context,
    binding.selectedModel,
    {
      provider_type: binding.providerType,
      upstream_model: binding.upstreamModel,
    },
    deadline,
  );
}
function ownedCooldowns(rows: { selectedModel: string }[]) {
  return rows.filter((row) => {
    return [
      auto.selectedModel,
      memory.selectedModel,
      historical.selectedModel,
    ].some((model) => {
      return model === row.selectedModel;
    });
  });
}
describe("GET /api/model-providers/cooldown-diagnostics", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(diagnostics().get({ headers: {} }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
  it("returns 403 when OkouDebug is disabled", async () => {
    actor();
    const response = await accept(diagnostics().get({ headers }), [403]);
    expect(response.body.error).toStrictEqual({
      message: "Built-in model cooldown diagnostics are not enabled",
      code: "FORBIDDEN",
    });
  });
  it("returns sorted active global cooldowns and excludes expired history", async () => {
    const fixture = actor();
    const startedAt = Date.UTC(2026, 7, 23, 12);
    const earlier = new Date(startedAt + 30_000);
    const later = new Date(startedAt + 60_000);
    await storedCooldown(auto, later);
    await storedCooldown(memory, earlier);
    await storedCooldown(historical, new Date(startedAt - 1));
    await enableDiagnostics(fixture);
    const response = await withMockNowForTest(startedAt, () => {
      return accept(diagnostics().get({ headers }), [200]);
    });
    expect(response.body.canCancelCooldowns).toBeFalsy();
    expect(ownedCooldowns(response.body.activeCooldowns)).toStrictEqual([
      { ...memory, unavailableUntil: earlier.toISOString() },
      { ...auto, unavailableUntil: later.toISOString() },
    ]);
  });
});
describe("DELETE /api/model-providers/cooldown-diagnostics", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      diagnostics().cancel({ headers: {}, body: auto }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
  it("rejects non-staff callers without changing the cooldown", async () => {
    const fixture = actor();
    const deadline = new Date(now() + 60_000);
    await storedCooldown(auto, deadline);
    await enableDiagnostics(fixture);
    const response = await accept(
      diagnostics().cancel({ headers, body: auto }),
      [403],
    );
    expect(response.body.error).toStrictEqual({
      message: "Only staff can cancel built-in model cooldowns",
      code: "FORBIDDEN",
    });
    const listed = await accept(diagnostics().get({ headers }), [200]);
    expect(listed.body.canCancelCooldowns).toBeFalsy();
    expect(ownedCooldowns(listed.body.activeCooldowns)).toStrictEqual([
      { ...auto, unavailableUntil: deadline.toISOString() },
    ]);
  });
  it("lets staff cancel Auto without clearing the independent memory cooldown", async () => {
    const fixture = actor(true);
    const deadline = new Date(now() + 60_000);
    await storedCooldown(auto, deadline);
    await storedCooldown(memory, deadline);
    await enableDiagnostics(fixture);
    const before = await accept(diagnostics().get({ headers }), [200]);
    expect(before.body.canCancelCooldowns).toBeTruthy();
    expect(ownedCooldowns(before.body.activeCooldowns)).toHaveLength(2);
    await accept(diagnostics().cancel({ headers, body: auto }), [204]);
    const after = await accept(diagnostics().get({ headers }), [200]);
    expect(ownedCooldowns(after.body.activeCooldowns)).toStrictEqual([
      { ...memory, unavailableUntil: deadline.toISOString() },
    ]);
  });
});
