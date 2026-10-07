import { randomUUID } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { modelProviderCooldownDiagnosticsContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { setupApp } from "../../../__tests__/test-helpers";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { modelProvidersRoutes } from "../model-providers";
import { createRouteMocks } from "./helpers/route-test";
import {
  updateFeatureSwitchesForUser,
  deleteFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { accept, testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createPublicModelFailureFixture } from "./helpers/public-model-failure";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import {
  setRunModelProviderFixture,
  setRunModelRuntimeRouteFixture,
} from "../../../test-fixtures/agent-runs";
import {
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
  await runs.ensurePersonalSubscriptionModel(actor);
  // A personal subscription default route and an explicitly selectable built-in fixture route.
  await runs.updateUserModelPreference(actor, selectedModel);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD built-in model failure report agent",
  });
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "report a built-in model provider failure",
    model: selectedModel,
  });
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 7,
  };
  await runs.heartbeatRunner(runnerGroup);
  await runs.claimRunnerJob(run.runId, { runnerIdentity });
  onTestFinished(async () => {
    await runs.requestCancelRun(actor, run.runId, [200, 400]);
    await flushWaitUntilForTest();
  });
  return {
    actor,
    agentId: agent.agentId,
    runId: run.runId,
    selectedModel: keyFixture.selectedModel,
  };
}

async function createObservedBuiltInRun(
  startedAt: number,
  existingModel?: string,
) {
  let selectedModel = existingModel;
  if (selectedModel === undefined) {
    selectedModel = SEEDED_SYSTEM_DEFAULT_MODEL;
  }
  await seedBuiltInModelCandidateKeys(context, selectedModel);
  const { fixture, claimed } = await withMockNowForTest(
    startedAt - 60_000,
    async () => {
      const fixture = await createPublicModelFailureFixture(context, [
        selectedModel,
      ]);
      const claimed = await fixture.claim(selectedModel);
      return { fixture, claimed };
    },
  );
  return {
    ...claimed,
    finish: async () => {
      await fixture.finish(claimed.runId);
    },
    readAdmission: async () => {
      return await fixture.readAdmission(claimed.selectedModel);
    },
    readAdmissionRejection: async () => {
      return await fixture.readAdmissionRejection(claimed.selectedModel);
    },
    readUnrelatedAdmission: async () => {
      const run = await runs.createThreadRun(fixture.actor, {
        agentId: fixture.agentId,
        prompt: "Observe unrelated personal subscription admission",
        model: "claude-fable-5-1",
      });
      const response = await reads.requestReadLogById(
        fixture.actor,
        run.runId,
        [200],
      );
      await runs.requestCancelRun(fixture.actor, run.runId, [200]);
      await flushWaitUntilForTest();
      if (response.status !== 200) {
        throw new Error("Expected personal run Log");
      }
      return response.body;
    },
  };
}

describe("POST /api/test/runtime-state/action", () => {
  it("keeps overlapping built-in model-key fixtures independently releasable", async () => {
    const first = await seedBuiltInModelKey(
      context,
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    const second = await seedBuiltInModelKey(
      context,
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );

    expect(first.selectedModel).toBe(SEEDED_SYSTEM_DEFAULT_MODEL);
    expect(second.selectedModel).toBe(SEEDED_SYSTEM_DEFAULT_MODEL);

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });

  it("serves built-in okou-1.0 on OpenRouter and recovers after its cooldown", async () => {
    const selectedModel = SEEDED_SYSTEM_DEFAULT_MODEL;
    await seedBuiltInModelCandidateKeys(context, selectedModel);
    const startedAt = Date.UTC(2026, 7, 23, 0, 0, 0);
    const cooldownUntil = new Date(startedAt + 5 * 60 * 1000);
    const fixture = await withMockNowForTest(startedAt - 60_000, async () => {
      return await createPublicModelFailureFixture(context, [selectedModel]);
    });
    const claimed = await withMockNowForTest(startedAt, async () => {
      return await fixture.claim(selectedModel);
    });
    const route = claimed.log;
    expect(route.modelRuntimeProvider).toBe("openrouter-codex");
    const expectedUpstreamModel = "@preset/okou-1-0";
    expect(route.modelRuntimeModel).toBe(expectedUpstreamModel);
    const { actor, agentId, runId } = claimed;
    const detail = await reads.requestReadLogById(actor, runId, [200]);
    expect(detail.body).toMatchObject({
      modelProvider: "built-in",
      selectedModel,
      modelRuntimeProvider: route.modelRuntimeProvider,
      modelRuntimeModel: expectedUpstreamModel,
    });
    await withMockNowForTest(startedAt, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(runId, {
          failureKind: "rate_limit",
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });
    });
    const unavailable = await withMockNowForTest(startedAt, async () => {
      return await sendRejectedByUnavailableModel(actor, {
        agentId,
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
      await expect(fixture.readAdmission(selectedModel)).resolves.toMatchObject(
        {
          modelRuntimeProvider: route.modelRuntimeProvider,
          modelRuntimeModel: expectedUpstreamModel,
        },
      );
    });
  });

  it("reads and deletes a built-in candidate cooldown", async () => {
    const selectedModel = SEEDED_SYSTEM_DEFAULT_MODEL;
    const startedAt = Date.UTC(2026, 7, 20, 2, 0, 0);
    await seedBuiltInModelCandidateKeys(context, selectedModel);
    const fixture = await withMockNowForTest(startedAt - 60_000, async () => {
      return await createPublicModelFailureFixture(context, [selectedModel]);
    });
    const primary = await withMockNowForTest(startedAt, async () => {
      const claimed = await fixture.claim(selectedModel);
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "rate_limit",
          retryAfterSeconds: 60,
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });
      return claimed.log;
    });
    await withMockNowForTest(startedAt, async () => {
      await expect(
        fixture.readAdmissionRejection(selectedModel),
      ).resolves.toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
      });
    });
    const staffOrgId = createUniqueStaffOrgIdFixture();
    const staff = bdd.user({ orgId: staffOrgId });
    const featureActor = { orgId: staffOrgId, userId: staff.userId };
    await updateFeatureSwitchesForUser(context, featureActor, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    onTestFinished(async () => {
      await deleteFeatureSwitchesForUser(context, featureActor);
    });
    createRouteMocks(context).clerk.session(
      staff.userId,
      staff.orgId,
      staff.orgRole,
    );
    const diagnostics = setupApp({ context, routes: modelProvidersRoutes })(
      modelProviderCooldownDiagnosticsContract,
    );
    if (!primary.modelRuntimeProvider || !primary.modelRuntimeModel) {
      throw new Error("Expected the actual primary runtime tuple");
    }
    await accept(
      diagnostics.cancel({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          selectedModel,
          providerType: primary.modelRuntimeProvider,
          upstreamModel: primary.modelRuntimeModel,
        },
      }),
      [204],
    );
    await withMockNowForTest(startedAt, async () => {
      await expect(fixture.readAdmission(selectedModel)).resolves.toMatchObject(
        { modelRuntimeProvider: "openrouter-codex" },
      );
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
        const claimed = await createObservedBuiltInRun(startedAt);
        const primary = claimed.log;

        await expect(
          runs.reportRunnerModelProviderFailure(claimed.runId, body),
        ).resolves.toStrictEqual({ outcome: "recorded" });
        await expect(
          runs.readRun(claimed.actor, claimed.runId),
        ).resolves.toMatchObject({ status: "running" });
        await expect(claimed.readAdmissionRejection()).resolves.toMatchObject({
          eventType: "input.rejected",
          error: "model_provider_unavailable",
        });

        await expect(claimed.readUnrelatedAdmission()).resolves.toMatchObject({
          modelProvider: "claude-code-oauth-token",
          selectedModel: "claude-fable-5-1",
        });

        await withMockNowForTest(
          startedAt + cooldownSeconds * 1000 - 1,
          async () => {
            await expect(
              claimed.readAdmissionRejection(),
            ).resolves.toMatchObject({
              eventType: "input.rejected",
              error: "model_provider_unavailable",
            });
          },
        );
        await withMockNowForTest(
          startedAt + cooldownSeconds * 1000,
          async () => {
            await expect(claimed.readAdmission()).resolves.toMatchObject({
              modelRuntimeProvider: primary.modelRuntimeProvider,
              modelRuntimeModel: primary.modelRuntimeModel,
            });
          },
        );
      });
    },
  );

  it("keeps the intervention deadline against a competing bounded report on an owned model", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 10, 0);

    const claimed = await createObservedBuiltInRun(
      startedAt,
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    await expect(
      runs.readRun(claimed.actor, claimed.runId),
    ).resolves.toMatchObject({
      source: { model: SEEDED_SYSTEM_DEFAULT_MODEL },
    });
    const primary = claimed.log;
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
      await expect(claimed.readAdmissionRejection()).resolves.toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
      });
    });
    await withMockNowForTest(startedAt + 30 * 60_000, async () => {
      await expect(claimed.readAdmission()).resolves.toMatchObject({
        modelRuntimeProvider: primary.modelRuntimeProvider,
        modelRuntimeModel: primary.modelRuntimeModel,
      });
    });
  });

  it("requires an inclusive 60-second upstream transport streak", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 15, 0);
    const claimed = await createObservedBuiltInRun(startedAt);
    const secondClaimed = await createObservedBuiltInRun(
      startedAt,
      claimed.selectedModel,
    );
    onTestFinished(async () => {
      await secondClaimed.finish();
      await claimed.finish();
    });
    const primary = claimed.log;
    await withMockNowForTest(startedAt, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(secondClaimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "observed" });
      await expect(claimed.readAdmission()).resolves.toMatchObject({
        modelRuntimeProvider: primary.modelRuntimeProvider,
        modelRuntimeModel: primary.modelRuntimeModel,
      });
    });

    await withMockNowForTest(startedAt + 60_000, async () => {
      await expect(
        runs.reportRunnerModelProviderFailure(claimed.runId, {
          failureKind: "connection",
          connectionSource: "upstream_transport",
        }),
      ).resolves.toStrictEqual({ outcome: "recorded" });
      await expect(claimed.readAdmissionRejection()).resolves.toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
      });
    });
    await expect(
      runs.readRun(claimed.actor, claimed.runId),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("keeps an observation-only route selectable to an in-flight resolver", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 16, 0);
    const claimed = await createObservedBuiltInRun(startedAt);
    const primary = claimed.log;

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
      await expect(claimed.readAdmission()).resolves.toMatchObject({
        modelRuntimeProvider: primary.modelRuntimeProvider,
        modelRuntimeModel: primary.modelRuntimeModel,
      });
    });
  });

  it("does not extend an active cooldown for one transport observation", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 17, 0);
    const claimed = await createObservedBuiltInRun(startedAt);
    const primary = claimed.log;

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
      await expect(claimed.readAdmission()).resolves.toMatchObject({
        modelRuntimeProvider: primary.modelRuntimeProvider,
        modelRuntimeModel: primary.modelRuntimeModel,
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
    const claimed = await createObservedBuiltInRun(startedAt);
    const primary = claimed.log;
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
      await expect(claimed.readAdmissionRejection()).resolves.toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
      });
    });
    await withMockNowForTest(startedAt + 30 * 60_000, async () => {
      await expect(claimed.readAdmission()).resolves.toMatchObject({
        modelRuntimeProvider: primary.modelRuntimeProvider,
        modelRuntimeModel: primary.modelRuntimeModel,
      });
    });
  });

  it("merges connected receipts when body processing is reversed", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 0, 35, 0);
    const claimed = await createObservedBuiltInRun(startedAt);
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
      await expect(claimed.readAdmissionRejection()).resolves.toMatchObject({
        eventType: "input.rejected",
        error: "model_provider_unavailable",
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
      const claimed = await createObservedBuiltInRun(startedAt);
      const primary = claimed.log;

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
        await expect(claimed.readAdmissionRejection()).resolves.toMatchObject({
          eventType: "input.rejected",
          error: "model_provider_unavailable",
        });
      });
      await withMockNowForTest(startedAt + 401_000, async () => {
        await expect(claimed.readAdmission()).resolves.toMatchObject({
          modelRuntimeProvider: primary.modelRuntimeProvider,
          modelRuntimeModel: primary.modelRuntimeModel,
        });
      });
    });
  });

  it("rejects untrusted or invalid reports and ignores ineligible runs", async () => {
    const startedAt = Date.UTC(2026, 7, 21, 2, 0, 0);
    await withMockNowForTest(startedAt, async () => {
      const claimed = await createObservedBuiltInRun(startedAt);
      const primary = claimed.log;

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

      const personalRun = await runs.createThreadRun(claimed.actor, {
        agentId: claimed.agentId,
        prompt: "ignore a personal subscription provider failure",
        model: "claude-fable-5-1",
      });
      const ownedPersonal: { sandboxToken?: string } = {};
      onTestFinished(async () => {
        await withMockNowForTest(startedAt, async () => {
          const cleanupRuns = createRunsApi(context);
          const current = await cleanupRuns.readRun(
            claimed.actor,
            personalRun.runId,
          );
          if (current.status === "pending" || current.status === "running") {
            await cleanupRuns.requestCancelRun(
              claimed.actor,
              personalRun.runId,
              [200],
            );
          }
          if (
            ownedPersonal.sandboxToken &&
            (current.status === "pending" ||
              current.status === "running" ||
              current.status === "cancelled")
          ) {
            await createWebhookCallbackApi(context).requestAgentComplete(
              {
                runId: personalRun.runId,
                exitCode: 1,
                error: "Cancelled ineligible report Run",
              },
              { authorization: `Bearer ${ownedPersonal.sandboxToken}` },
              [200],
            );
          }
          await flushWaitUntilForTest();
        });
      });
      const personalRunnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 8,
      };
      const personalClaim = await runs.claimRunnerJob(personalRun.runId, {
        runnerIdentity: personalRunnerIdentity,
      });
      ownedPersonal.sandboxToken = personalClaim.sandboxToken;
      await expect(
        runs.reportRunnerModelProviderFailure(personalRun.runId, {
          failureKind: "billing",
        }),
      ).resolves.toStrictEqual({ outcome: "ignored" });

      await expect(claimed.readAdmission()).resolves.toMatchObject({
        modelRuntimeProvider: primary.modelRuntimeProvider,
        modelRuntimeModel: primary.modelRuntimeModel,
      });
    });
  });
});
