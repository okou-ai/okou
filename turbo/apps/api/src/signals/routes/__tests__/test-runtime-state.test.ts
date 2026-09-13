import { randomUUID } from "node:crypto";

import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { ALL_RUN_STATUSES } from "@okouai/api-contracts/contracts/runs";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import {
  setRunModelProviderFixture,
  setRunModelRuntimeRouteFixture,
} from "../../../test-fixtures/agent-runs";
import {
  holdBuiltInModelRouteLockFixture,
  withBuiltInModelRuntimeRouteCandidateUnavailableForTest,
} from "../../../test-fixtures/built-in-model-runtime-route";
import {
  deleteBuiltInCandidateCooldownFixture,
  resolveBuiltInModelRouteFixture,
  registerBuiltInCandidateCooldownCleanup,
  seedBuiltInModelCandidateKeys,
  seedBuiltInModelKey,
  setBuiltInCandidateCooldownFixture,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const reads = createRunReadsApi(context);

interface ClaimedBuiltInRun {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly runId: string;
  readonly selectedModel: string;
}

async function createClaimedBuiltInRun(): Promise<ClaimedBuiltInRun> {
  const keyFixture = await seedBuiltInModelCandidateKeys(
    context,
    DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  );
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD built-in model failure report agent",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "report a built-in model provider failure",
    modelProvider: "built-in",
  });
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 7,
  };
  await runs.heartbeatRunner(runnerGroup);
  await runs.claimRunnerJob(run.runId, { runnerIdentity });
  onTestFinished(async () => {
    await runs.requestCancelRun(actor, run.runId, [200, 400]);
  });
  return {
    actor,
    agentId: agent.agentId,
    runId: run.runId,
    selectedModel: keyFixture.selectedModel,
  };
}

describe("POST /api/test/runtime-state/action", () => {
  it("keeps overlapping built-in model-key fixtures independently releasable", async () => {
    const first = await seedBuiltInModelKey(context, "gpt-5.6-terra");
    const second = await seedBuiltInModelKey(context, "gpt-5.6-terra");

    expect(first.selectedModel).toBe("gpt-5.6-terra");
    expect(second.selectedModel).toBe("gpt-5.6-terra");

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });

  it("scopes unavailable built-in model candidates to one async flow", async () => {
    const selectedModel = "deepseek-v4-flash";
    await seedBuiltInModelCandidateKeys(context, selectedModel);
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      selectedModel,
    );
    if (!primary || primary.provider_type === "openrouter-codex") {
      throw new Error("Expected a primary DeepSeek route");
    }

    const scopedRouteResolved = createDeferredPromise<void>(context.signal);
    const releaseScopedRoute = createDeferredPromise<void>(context.signal);
    const scopedResolution =
      withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
        {
          selectedModel,
          providerType: primary.provider_type,
          upstreamModel: primary.upstream_model,
        },
        async () => {
          const route = await resolveBuiltInModelRouteFixture(
            context,
            selectedModel,
          );
          scopedRouteResolved.resolve(undefined);
          await releaseScopedRoute.promise;
          return route;
        },
      );
    onTestFinished(async () => {
      if (!releaseScopedRoute.settled()) {
        releaseScopedRoute.resolve(undefined);
      }
      await scopedResolution;
    });

    await scopedRouteResolved.promise;
    const unscopedRoute = await resolveBuiltInModelRouteFixture(
      context,
      selectedModel,
    );
    releaseScopedRoute.resolve(undefined);
    const scopedRoute = await scopedResolution;

    expect(unscopedRoute).toMatchObject({
      provider_type: primary.provider_type,
      upstream_model: primary.upstream_model,
    });
    expect(scopedRoute).toMatchObject({
      provider_type: "openrouter-codex",
    });
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
    "disables Codex apply patch for the built-in %s OpenRouter fallback",
    async (selectedModel) => {
      await seedBuiltInModelCandidateKeys(context, selectedModel);
      const startedAt = Date.UTC(2026, 7, 23, 0, 0, 0);
      const primaryCooldownUntil = new Date(startedAt + 60 * 1000);
      const primary = await withMockNowForTest(startedAt, async () => {
        return await resolveBuiltInModelRouteFixture(context, selectedModel);
      });
      if (!primary) {
        throw new Error(`Expected a primary route for ${selectedModel}`);
      }
      await setBuiltInCandidateCooldownFixture(
        context,
        selectedModel,
        primary,
        primaryCooldownUntil,
      );
      const fallback = await withMockNowForTest(startedAt, async () => {
        return await resolveBuiltInModelRouteFixture(context, selectedModel);
      });
      if (!fallback || fallback.provider_type !== "openrouter-codex") {
        throw new Error(`Expected an OpenRouter fallback for ${selectedModel}`);
      }

      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected built-in fallback actor to have an org");
      }
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: `BDD ${selectedModel} fallback catalog agent`,
      });
      await runs.updateOrgModelPolicies(actor, [
        {
          model: selectedModel,
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      const sent = await withMockNowForTest(startedAt, async () => {
        return await chat.requestSendEvent(
          actor,
          {
            agentId: agent.agentId,
            prompt: `use the ${selectedModel} OpenRouter fallback`,
            model: selectedModel,
          },
          [201],
        );
      });
      if (sent.status !== 201 || sent.body.runId === null) {
        throw new Error(`Expected a ${selectedModel} run`);
      }
      const runId = sent.body.runId;
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(runId);
      onTestFinished(async () => {
        await runs.requestCancelRun(actor, runId, [200, 400]);
      });

      expect(claim.environment?.OPENAI_MODEL).toBe(fallback.upstream_model);
      expect(claim.codexRuntimeConfig?.providerId).toBe("openrouter-codex");
      expect(claim.codexRuntimeConfig?.modelCatalog?.models).toStrictEqual([
        expect.objectContaining({
          slug: fallback.upstream_model,
          apply_patch_tool_type: null,
        }),
      ]);
      const detail = await reads.requestReadLogById(actor, runId, [200]);
      expect(detail.body).toMatchObject({
        modelProvider: "built-in",
        selectedModel,
        modelRuntimeProvider: fallback.provider_type,
        modelRuntimeModel: fallback.upstream_model,
      });
    },
  );

  it("isolates expiry-based cooldowns to exact built-in model routes", async () => {
    await seedBuiltInModelCandidateKeys(context, "claude-fable-5-1");
    await seedBuiltInModelCandidateKeys(context, "gpt-5.6-sol");
    const startedAt = Date.UTC(2026, 7, 20, 0, 0, 0);
    const routeCooldownUntil = new Date(startedAt + 60 * 1000);

    const gptPrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, "gpt-5.6-sol");
    });
    expect(gptPrimary).toMatchObject({
      provider_type: "openai-api-key",
      upstream_model: "gpt-5.6-sol",
    });
    if (!gptPrimary) {
      throw new Error("Expected a primary GPT route");
    }

    await setBuiltInCandidateCooldownFixture(
      context,
      "gpt-5.6-sol",
      gptPrimary,
      routeCooldownUntil,
    );
    const gptFallback = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, "gpt-5.6-sol");
    });
    expect(gptFallback?.provider_type).toBe("openrouter-codex");
    if (!gptFallback) {
      throw new Error("Expected a fallback GPT route");
    }

    await setBuiltInCandidateCooldownFixture(
      context,
      "gpt-5.6-sol",
      gptFallback,
      routeCooldownUntil,
    );

    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, "gpt-5.6-sol"),
      ).resolves.toBeNull();
      await expect(
        resolveBuiltInModelRouteFixture(context, "gpt-5.6-terra"),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
    });

    const gptTerraPrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, "gpt-5.6-terra");
    });
    if (!gptTerraPrimary) {
      throw new Error("Expected a primary GPT Terra route");
    }
    await setBuiltInCandidateCooldownFixture(
      context,
      "gpt-5.6-terra",
      gptTerraPrimary,
      routeCooldownUntil,
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, "gpt-5.6-terra"),
      ).resolves.toMatchObject({ provider_type: "openrouter-codex" });
    });

    const claudePrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, "claude-fable-5-1");
    });
    expect(claudePrimary?.provider_type).toBe("anthropic-api-key");
    if (!claudePrimary) {
      throw new Error("Expected a primary Claude route");
    }
    await setBuiltInCandidateCooldownFixture(
      context,
      "claude-fable-5-1",
      claudePrimary,
      routeCooldownUntil,
    );
    const claudeFallback = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, "claude-fable-5-1");
    });
    expect(claudeFallback?.provider_type).toBe("openrouter-api-key");
    if (!claudeFallback) {
      throw new Error("Expected a fallback Claude route");
    }
    await setBuiltInCandidateCooldownFixture(
      context,
      "claude-fable-5-1",
      claudeFallback,
      routeCooldownUntil,
    );

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD built-in fallback unavailable agent",
    });
    await runs.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    if (!actor.orgId) {
      throw new Error("Expected built-in fallback actor to have an org");
    }
    const rejected = await withMockNowForTest(startedAt, async () => {
      return await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "reject before constructing a built-in-model run",
          model: "gpt-5.6-sol",
          clientEventId: randomUUID(),
        },
        [503],
      );
    });
    expect(rejected.body).toStrictEqual({
      error: {
        code: "MODEL_PROVIDER_UNAVAILABLE",
        message:
          "Every built-in model route for this model is temporarily unavailable",
      },
    });
    await expect(
      runs.listAgentRuns(actor, {
        status: ALL_RUN_STATUSES.join(","),
        limit: 20,
      }),
    ).resolves.toStrictEqual({ runs: [] });

    await withMockNowForTest(routeCooldownUntil.getTime(), async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, "gpt-5.6-sol"),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
      await expect(
        resolveBuiltInModelRouteFixture(context, "claude-fable-5-1"),
      ).resolves.toMatchObject({ provider_type: "anthropic-api-key" });
    });
  });

  it("reads and deletes a built-in candidate cooldown", async () => {
    const selectedModel = "gpt-5.6-terra";
    const startedAt = Date.UTC(2026, 7, 20, 2, 0, 0);
    await seedBuiltInModelCandidateKeys(context, selectedModel);
    const primary = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, selectedModel);
    });
    if (!primary) {
      throw new Error("Expected a primary GPT Terra route");
    }

    await setBuiltInCandidateCooldownFixture(
      context,
      selectedModel,
      primary,
      new Date(startedAt + 60_000),
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, selectedModel),
      ).resolves.toMatchObject({ provider_type: "openrouter-codex" });
    });

    await deleteBuiltInCandidateCooldownFixture(
      context,
      selectedModel,
      primary,
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, selectedModel),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
    });
  });
});

describe("POST /api/runners/runs/:runId/model-provider-failures", () => {
  it.each([
    {
      caseName: "authentication intervention",
      body: { failureKind: "authentication", retryAfterSeconds: 1 },
      cooldownSeconds: 30 * 60,
    },
    {
      caseName: "billing intervention",
      body: { failureKind: "billing", retryAfterSeconds: 1 },
      cooldownSeconds: 30 * 60,
    },
    {
      caseName: "rate limit default",
      body: { failureKind: "rate_limit" },
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "provider unavailable default",
      body: { failureKind: "provider_unavailable" },
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "timeout default",
      body: { failureKind: "timeout" },
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "provider-response connection default",
      body: {
        failureKind: "connection",
        connectionSource: "provider_response",
      },
      cooldownSeconds: 5 * 60,
    },
    {
      caseName: "bounded provider retry delay",
      body: { failureKind: "rate_limit", retryAfterSeconds: 120 },
      cooldownSeconds: 120,
    },
  ] as const)(
    "records the $caseName cooldown for only the persisted built-in model route",
    async ({ body, cooldownSeconds }) => {
      const startedAt = Date.UTC(2026, 7, 21, 0, 0, 0);
      await withMockNowForTest(startedAt, async () => {
        const claimed = await createClaimedBuiltInRun();
        const primary = await resolveBuiltInModelRouteFixture(
          context,
          claimed.selectedModel,
        );
        if (!primary) {
          throw new Error("Expected a built-in model primary route");
        }
        registerBuiltInCandidateCooldownCleanup(
          context,
          claimed.selectedModel,
          primary,
        );

        await expect(
          runs.reportRunnerModelProviderFailure(claimed.runId, body),
        ).resolves.toStrictEqual({ outcome: "recorded" });
        await expect(
          runs.readRun(claimed.actor, claimed.runId),
        ).resolves.toMatchObject({ status: "running" });
        await expect(
          resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
        ).resolves.not.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });

        await seedBuiltInModelCandidateKeys(context, "deepseek-v4-flash");
        await expect(
          resolveBuiltInModelRouteFixture(context, "deepseek-v4-flash"),
        ).resolves.toMatchObject({ provider_type: "deepseek" });

        await withMockNowForTest(
          startedAt + cooldownSeconds * 1000 - 1,
          async () => {
            await expect(
              resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
            ).resolves.not.toMatchObject({
              provider_type: primary.provider_type,
              upstream_model: primary.upstream_model,
            });
          },
        );
        await withMockNowForTest(
          startedAt + cooldownSeconds * 1000,
          async () => {
            await expect(
              resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
            ).resolves.toMatchObject({
              provider_type: primary.provider_type,
              upstream_model: primary.upstream_model,
            });
          },
        );
      });
    },
  );

  it("requires an inclusive 60-second upstream transport streak", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 15, 0);
    const claimed = await createClaimedBuiltInRun();
    const secondClaimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(secondClaimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "observed" });
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });

    await withMockNowForTest(startedAt + 60_000, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.not.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
    await expect(
      runs.readRun(claimed.actor, claimed.runId),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("keeps an observation-only route selectable to an in-flight resolver", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 16, 0);
    const claimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );

    await withMockNowForTest(startedAt, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "observed" });
    });

    // A resolver can capture time before the observation transaction commits.
    await withMockNowForTest(startedAt - 1, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
  });

  it("does not extend an active cooldown for one transport observation", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 17, 0);
    const claimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );

    await withMockNowForTest(startedAt, async () => {
      await runs.reportRunnerModelProviderFailure(claimed.runId, {
        failureKind: "rate_limit",
        retryAfterSeconds: 60,
      });
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "observed" });
    });

    await withMockNowForTest(startedAt + 60_000, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
  });

  it("restarts after a gap greater than 60 seconds", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 20, 0);
    const claimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );
    const report = async (at: number) => {
      return await withMockNowForTest(at, async () => {
        return await runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        });
      });
    };

    await expect(report(startedAt)).resolves.toStrictEqual({
      outcome: "observed",
    });
    await expect(report(startedAt + 60_001)).resolves.toStrictEqual({
      outcome: "observed",
    });
    await expect(report(startedAt + 120_001)).resolves.toStrictEqual({
      outcome: "recorded",
    });
  });

  it("keeps an active longer cooldown and clears transport evidence silently", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 25, 0);
    const claimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );
    await withMockNowForTest(startedAt, async () => {
      await runs.reportRunnerModelProviderFailure(claimed.runId, {
        failureKind: "authentication",
      });
    });
    await withMockNowForTest(startedAt + 100_000, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "observed" });
    });
    await withMockNowForTest(startedAt + 120_000, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "timeout",
          retryAfterSeconds: 1,
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });
    });
    for (const [offset, outcome] of [
      [160_000, "observed"],
      [220_000, "recorded"],
    ] as const) {
      await withMockNowForTest(startedAt + offset, async () => {
        await expect(
          runs.reportRunnerModelProviderFailure(claimed.runId, {
            failureKind: "connection",
            connectionSource: "upstream_transport",
          }),
        ).resolves.toStrictEqual({ outcome });
      });
    }
    await withMockNowForTest(startedAt + 280_000, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "observed" });
    });

    await withMockNowForTest(startedAt + 8 * 60_000, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.not.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
    await withMockNowForTest(startedAt + 30 * 60_000, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
  });

  it("merges connected receipts when body processing is reversed", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 35, 0);
    const claimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );
    const earlier = await withMockNowForTest(startedAt, async () => {
      return await runs.startRunnerModelProviderFailureWithDelayedBody(
        claimed.runId,
        {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        },
      );
    });
    onTestFinished(() => {
      earlier.releaseBody();
    });

    await withMockNowForTest(startedAt + 60_000, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "observed" });
    });
    earlier.releaseBody();
    await expect(earlier.response).resolves.toStrictEqual({
      status: 200,
      body: { outcome: "recorded" },
    });
    await withMockNowForTest(startedAt + 60_000, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.not.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
  });

  it("ignores an older disjoint receipt without replacing newer evidence", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 45, 0);
    const claimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      primary,
    );
    const report = async (at: number) => {
      return await withMockNowForTest(at, async () => {
        return await runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        });
      });
    };

    await expect(report(startedAt + 120_000)).resolves.toStrictEqual({
      outcome: "observed",
    });
    await expect(report(startedAt)).resolves.toStrictEqual({
      outcome: "observed",
    });
    await expect(report(startedAt + 180_000)).resolves.toStrictEqual({
      outcome: "recorded",
    });
  });

  it.each([
    {
      cooldownExpiresAfterMs: 341_000,
      elapsedMs: 59_000,
      followupOutcome: "recorded",
      outcome: "observed",
    },
    {
      cooldownExpiresAfterMs: 300_000,
      elapsedMs: 60_000,
      followupOutcome: "observed",
      outcome: "recorded",
    },
  ] as const)(
    "uses receipt time across a route lock wait at $elapsedMs ms",
    async ({ cooldownExpiresAfterMs, elapsedMs, followupOutcome, outcome }) => {
      const startedAt = Date.UTC(2026, 7, 21, 0, 55, 0) + elapsedMs;
      const claimed = await createClaimedBuiltInRun();
      const primary = await resolveBuiltInModelRouteFixture(
        context,
        claimed.selectedModel,
      );
      if (!primary) {
        throw new Error("Expected a built-in model primary route");
      }
      registerBuiltInCandidateCooldownCleanup(
        context,
        claimed.selectedModel,
        primary,
      );
      const route = {
        selectedModel: claimed.selectedModel,
        providerType: primary.provider_type,
        upstreamModel: primary.upstream_model,
      };
      await withMockNowForTest(startedAt - elapsedMs, async () => {
        await runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        });
      });
      const held = await holdBuiltInModelRouteLockFixture({
        route,
        signal: context.signal,
      });
      onTestFinished(async () => {
        held.release();
        await held.done;
      });

      await withMockNowForTest(startedAt, async () => {
        const response = runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        });
        await expect.poll(held.blockedWaiterCount).toBe(1);
        mockNow(startedAt + 5 * 60_000);
        held.release();
        await held.done;
        await expect(response).resolves.toStrictEqual({ outcome });
      });

      await withMockNowForTest(startedAt + (100_000 - elapsedMs), async () => {
        await expect(
          runs.reportRunnerModelProviderFailure(claimed.runId, {
            failureKind: "connection",
            connectionSource: "upstream_transport",
          }),
        ).resolves.toStrictEqual({ outcome: followupOutcome });
      });
      await withMockNowForTest(startedAt + cooldownExpiresAfterMs, async () => {
        await expect(
          resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
        ).resolves.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });
      });
    },
  );

  it("writes a reported cooldown to the built-in table", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 30, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedBuiltInRun();
      const primary = await resolveBuiltInModelRouteFixture(
        context,
        claimed.selectedModel,
      );
      if (!primary) {
        throw new Error("Expected a built-in model primary route");
      }
      registerBuiltInCandidateCooldownCleanup(
        context,
        claimed.selectedModel,
        primary,
      );

      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "rate_limit",
          retryAfterSeconds: 300,
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });

      const expiredDeadline = new Date(startedAt - 1);
      await setBuiltInCandidateCooldownFixture(
        context,
        claimed.selectedModel,
        primary,
        expiredDeadline,
      );
      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
  });

  it("records failure cooldowns for the canonical built-in discriminator", async () => {
    const claimed = await createClaimedBuiltInRun();
    await setRunModelProviderFixture({
      runId: claimed.runId,
      modelProvider: "built-in",
    });
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    const fixtureRoute = {
      ...primary,
      upstream_model: `fixture-${randomUUID()}`,
    };
    await setRunModelRuntimeRouteFixture({
      runId: claimed.runId,
      modelRuntimeProvider: fixtureRoute.provider_type,
      modelRuntimeModel: fixtureRoute.upstream_model,
    });
    registerBuiltInCandidateCooldownCleanup(
      context,
      claimed.selectedModel,
      fixtureRoute,
    );

    await expect(
      runs.reportRunnerModelProviderFailure(claimed.runId, {
        failureKind: "rate_limit",
        retryAfterSeconds: 60,
      }),
    ).resolves.toStrictEqual({ outcome: "recorded" });
    await expect(
      resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
    ).resolves.toMatchObject({
      provider_type: primary.provider_type,
      upstream_model: primary.upstream_model,
    });
  });

  it("monotonically extends concurrent bounded reports from receipt time", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 1, 0, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedBuiltInRun();
      const primary = await resolveBuiltInModelRouteFixture(
        context,
        claimed.selectedModel,
      );
      if (!primary) {
        throw new Error("Expected a built-in model primary route");
      }
      registerBuiltInCandidateCooldownCleanup(
        context,
        claimed.selectedModel,
        primary,
      );

      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "rate_limit",
          retryAfterSeconds: 300,
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });

      await withMockNowForTest(startedAt + 100_000, async () => {
        await expect(
          Promise.all([
            runs.reportRunnerModelProviderFailure(claimed.runId, {
              failureKind: "timeout",
              retryAfterSeconds: 1,
            }),
            runs.reportRunnerModelProviderFailure(claimed.runId, {
              failureKind: "provider_unavailable",
              retryAfterSeconds: 300,
            }),
          ]),
        ).resolves.toStrictEqual([
          { outcome: "recorded" },
          { outcome: "recorded" },
        ]);
      });

      await withMockNowForTest(startedAt + 350_000, async () => {
        await expect(
          resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
        ).resolves.not.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });
      });
      await withMockNowForTest(startedAt + 401_000, async () => {
        await expect(
          resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
        ).resolves.toMatchObject({
          provider_type: primary.provider_type,
          upstream_model: primary.upstream_model,
        });
      });
    });
  });

  it("preserves the application error boundary when a report query fails", async () => {
    const claimed = await createClaimedBuiltInRun();
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      claimed.selectedModel,
    );
    if (!primary) {
      throw new Error("Expected a built-in model primary route");
    }
    // Give the infrastructure failure a run-owned route so its row lock cannot
    // block or cancel another test's provider report.
    const fixtureRoute = {
      ...primary,
      upstream_model: `fixture-${randomUUID()}`,
    };
    await setRunModelRuntimeRouteFixture({
      runId: claimed.runId,
      modelRuntimeProvider: fixtureRoute.provider_type,
      modelRuntimeModel: fixtureRoute.upstream_model,
    });
    await setBuiltInCandidateCooldownFixture(
      context,
      claimed.selectedModel,
      fixtureRoute,
      new Date(0),
    );
    const held = await holdBuiltInModelRouteLockFixture({
      route: {
        selectedModel: claimed.selectedModel,
        providerType: fixtureRoute.provider_type,
        upstreamModel: fixtureRoute.upstream_model,
      },
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const report = await runs.startRunnerModelProviderFailureWithDelayedBody(
      claimed.runId,
      { failureKind: "rate_limit" },
    );
    onTestFinished(async () => {
      report.releaseBody();
      held.release();
      await report.response;
    });
    report.releaseBody();
    await expect.poll(held.blockedWaiterCount).toBe(1);

    // Infrastructure can fail a query; the production API cannot request that
    // state. Fail only this fixture's waiter, keeping the request signal live.
    await expect(held.cancelBlockedQueries()).resolves.toBe(1);
    await expect(report.response).resolves.toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    held.release();
    await held.done;

    expect(context.signal.aborted).toBeFalsy();
    expect(context.mocks.sentry.captureException).toHaveBeenCalledTimes(1);
    await expect(
      runs.readRun(claimed.actor, claimed.runId),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
    ).resolves.toMatchObject({
      provider_type: primary.provider_type,
      upstream_model: primary.upstream_model,
    });
  });

  it("rejects untrusted or invalid reports and ignores ineligible runs", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 2, 0, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createClaimedBuiltInRun();
      const primary = await resolveBuiltInModelRouteFixture(
        context,
        claimed.selectedModel,
      );
      if (!primary) {
        throw new Error("Expected a built-in model primary route");
      }
      registerBuiltInCandidateCooldownCleanup(
        context,
        claimed.selectedModel,
        primary,
      );

      const missingAuth = await runs.requestRunnerModelProviderFailureAs(
        undefined,
        claimed.runId,
        [401],
        {
          failureKind: "connection",
          connectionSource: "provider_response",
        },
      );
      expectApiError(missingAuth.body);

      const sandboxAuth = await runs.requestRunnerModelProviderFailureAs(
        `Bearer ${runs.sandboxTokenForRun(claimed.actor, claimed.runId)}`,
        claimed.runId,
        [401],
        {
          failureKind: "connection",
          connectionSource: "provider_response",
        },
      );
      expectApiError(sandboxAuth.body);

      const pat = await runs.createCliToken(claimed.actor);
      const patAuth = await runs.requestRunnerModelProviderFailureAs(
        `Bearer ${pat.token}`,
        claimed.runId,
        [403],
        {
          failureKind: "connection",
          connectionSource: "provider_response",
        },
      );
      expectApiError(patAuth.body);

      for (const body of [
        {
          failureKind: "connection",
        },
        {
          failureKind: "connection",
          connectionSource: "provider_response",
          selectedModel: claimed.selectedModel,
        },
        {
          failureKind: "success",
        },
        {
          failureKind: "connection",
          connectionSource: "provider_response",
          retryAfterSeconds: 301,
        },
        {
          failureKind: "timeout",
          connectionSource: "upstream_transport",
        },
        {
          failureKind: "connection",
          connectionSource: "network",
        },
      ]) {
        const invalid = await runs.requestRawRunnerModelProviderFailure(
          true,
          claimed.runId,
          [400],
          body,
        );
        expectApiError(invalid.body);
      }

      for (const failureKind of [
        "unclassified",
        "semantic",
        "request",
        "schema",
        "tool_capability",
        "user_code",
        "cancellation",
      ]) {
        const invalid = await runs.requestRawRunnerModelProviderFailure(
          true,
          claimed.runId,
          [400],
          {
            failureKind,
          },
        );
        expectApiError(invalid.body);
      }

      const byokRun = await runs.createRun(claimed.actor, {
        agentId: claimed.agentId,
        prompt: "ignore a BYOK model provider failure",
        modelProvider: "anthropic-api-key",
      });
      const byokRunnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 8,
      };
      await runs.claimRunnerJob(byokRun.runId, {
        runnerIdentity: byokRunnerIdentity,
      });
      onTestFinished(async () => {
        await runs.requestCancelRun(claimed.actor, byokRun.runId, [200, 400]);
      });
      await expect(
        runs.reportRunnerModelProviderFailure(byokRun.runId, {
          failureKind: "billing",
        }),
      ).resolves.toStrictEqual({ outcome: "ignored" });

      await expect(
        resolveBuiltInModelRouteFixture(context, claimed.selectedModel),
      ).resolves.toMatchObject({
        provider_type: primary.provider_type,
        upstream_model: primary.upstream_model,
      });
    });
  });
});
