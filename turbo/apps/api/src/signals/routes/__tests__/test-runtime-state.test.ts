import { randomUUID } from "node:crypto";

import { ALL_RUN_STATUSES } from "@okouai/api-contracts/contracts/runs";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import { insertBuiltInModelMirrorFixture } from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import {
  setRunModelProviderFixture,
  setRunModelRuntimeRouteFixture,
} from "../../../test-fixtures/agent-runs";
import {
  deleteBuiltInCandidateCooldownFixture,
  resolveBuiltInModelRouteFixture,
  registerBuiltInCandidateCooldownCleanup,
  seedBuiltInModelCandidateKeys,
  seedBuiltInModelKey,
  setBuiltInCandidateCooldownFixture,
} from "./helpers/runtime-state";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const reads = createRunReadsApi(context);

/**
 * Sends a prompt whose background pick finds no built-in route, and returns
 * the thread events the rejected pick appended.
 */
async function sendRejectedByUnavailableModel(
  actor: ReturnType<typeof bdd.user>,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly model: string;
  },
) {
  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    { ...body, clientEventId },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the chat send to be queued");
  }
  await flushWaitUntilForTest();
  const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
  return {
    rejected: events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === clientEventId
      );
    }),
    guidance: events.find((event) => {
      return event.eventType === "output.error";
    }),
  };
}

interface ClaimedBuiltInRun {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly runId: string;
  readonly selectedModel: string;
}

async function createClaimedBuiltInRun(
  selectedModel: string = SEEDED_SYSTEM_DEFAULT_MODEL,
): Promise<ClaimedBuiltInRun> {
  const keyFixture = await seedBuiltInModelCandidateKeys(
    context,
    selectedModel,
  );
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  const { providerId } = await runs.ensureOrgModelProvider(actor);
  // A BYOK default route and an explicitly selectable built-in fixture route.
  await runs.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      preferred: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
    {
      model: selectedModel,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD built-in model failure report agent",
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "report a built-in model provider failure",
    model: SEEDED_SYSTEM_DEFAULT_MODEL,
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
    const first = await seedBuiltInModelKey(context, "gpt-6-luna");
    const second = await seedBuiltInModelKey(context, "gpt-6-luna");

    expect(first.selectedModel).toBe("gpt-6-luna");
    expect(second.selectedModel).toBe("gpt-6-luna");

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });

  it.each(["deepseek-v4.1-flash", "deepseek-v4-flash"] as const)(
    "serves built-in %s on OpenRouter and recovers after its cooldown",
    async (sourceModel) => {
      const mirror = await insertBuiltInModelMirrorFixture(sourceModel);
      onTestFinished(mirror.restore);
      const selectedModel = mirror.model;
      await seedBuiltInModelCandidateKeys(context, selectedModel);
      const startedAt = Date.UTC(2026, 7, 23, 0, 0, 0);
      const cooldownUntil = new Date(startedAt + 5 * 60 * 1000);
      const route = await withMockNowForTest(startedAt, async () => {
        return await resolveBuiltInModelRouteFixture(context, selectedModel);
      });
      if (!route) {
        throw new Error(`Expected a route for ${selectedModel}`);
      }
      expect(route.provider_type).toBe("openrouter-codex");

      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: `BDD ${sourceModel} route catalog agent`,
      });
      await runs.updateOrgModelPolicies(actor, [
        {
          model: selectedModel,
          preferred: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      const { runId } = await withMockNowForTest(startedAt, async () => {
        return await chat.sendAndLaunch(actor, {
          agentId: agent.agentId,
          prompt: `use the ${sourceModel} OpenRouter route`,
          model: selectedModel,
        });
      });
      onTestFinished(async () => {
        await runs.requestCancelRun(actor, runId, [200]);
      });
      const detail = await reads.requestReadLogById(actor, runId, [200]);
      expect(detail.body).toMatchObject({
        modelProvider: "built-in",
        selectedModel,
        modelRuntimeProvider: route.provider_type,
        modelRuntimeModel: route.upstream_model,
      });

      await setBuiltInCandidateCooldownFixture(
        context,
        selectedModel,
        route,
        cooldownUntil,
      );
      const unavailable = await withMockNowForTest(startedAt, async () => {
        return await sendRejectedByUnavailableModel(actor, {
          agentId: agent.agentId,
          prompt: "reject while the built-in OpenRouter route is cooling down",
          model: selectedModel,
        });
      });
      expect(unavailable.rejected).toMatchObject({
        error: "model_provider_unavailable",
      });
      expect(unavailable.guidance).toMatchObject({
        error: "model_provider_unavailable",
      });

      await withMockNowForTest(cooldownUntil.getTime(), async () => {
        await expect(
          resolveBuiltInModelRouteFixture(context, selectedModel),
        ).resolves.toMatchObject({
          provider_type: route.provider_type,
          upstream_model: route.upstream_model,
        });
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
        resolveBuiltInModelRouteFixture(context, "gpt-6-luna"),
      ).resolves.toMatchObject({ provider_type: "openai-api-key" });
    });

    const gptLunaPrimary = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, "gpt-6-luna");
    });
    if (!gptLunaPrimary) {
      throw new Error("Expected a primary GPT Luna route");
    }
    await setBuiltInCandidateCooldownFixture(
      context,
      "gpt-6-luna",
      gptLunaPrimary,
      routeCooldownUntil,
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(
        resolveBuiltInModelRouteFixture(context, "gpt-6-luna"),
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
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    if (!actor.orgId) {
      throw new Error("Expected built-in fallback actor to have an org");
    }
    const unavailable = await withMockNowForTest(startedAt, async () => {
      return await sendRejectedByUnavailableModel(actor, {
        agentId: agent.agentId,
        prompt: "reject before constructing a built-in-model run",
        model: "gpt-5.6-sol",
      });
    });
    expect(unavailable.rejected).toMatchObject({
      error: "model_provider_unavailable",
    });
    expect(unavailable.guidance).toMatchObject({
      error: "model_provider_unavailable",
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
    const selectedModel = "gpt-6-luna";
    const startedAt = Date.UTC(2026, 7, 20, 2, 0, 0);
    await seedBuiltInModelCandidateKeys(context, selectedModel);
    const primary = await withMockNowForTest(startedAt, async () => {
      return await resolveBuiltInModelRouteFixture(context, selectedModel);
    });
    if (!primary) {
      throw new Error("Expected a primary GPT Luna route");
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
        ).resolves.toMatchObject({ provider_type: "openrouter-codex" });

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

  it("keeps the intervention deadline against a competing bounded report on an owned model", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 10, 0);
    const mirror = await insertBuiltInModelMirrorFixture(
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    onTestFinished(mirror.restore);
    const claimed = await createClaimedBuiltInRun(mirror.model);
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
      const outcomes = await Promise.all([
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "authentication",
        }),
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "rate_limit",
          retryAfterSeconds: 120,
        }),
      ]);
      expect(outcomes).toStrictEqual([
        { outcome: "recorded" },
        { outcome: "recorded" },
      ]);
    });
    await withMockNowForTest(startedAt + 30 * 60_000 - 1, async () => {
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

      const byokRun = await runs.createThreadRun(claimed.actor, {
        agentId: claimed.agentId,
        prompt: "ignore a BYOK model provider failure",
        model: "claude-sonnet-5",
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
