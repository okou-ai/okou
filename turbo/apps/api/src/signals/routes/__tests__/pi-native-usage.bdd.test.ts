import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { piModelConfigV4Schema } from "@okouai/api-contracts/contracts/pi-native";
import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import { readRunUsageEventsFixture } from "../../../test-fixtures/chat-events";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { recordNativeUsageFixture } from "../../../test-fixtures/pi-native-usage";

const context = testContext();

// Gen4 has no production writer in this preparation release. These fixtures
// exercise the private accounting reader with future native terminal messages;
// run identity is created through the real API, and the ledger is never mocked.
async function nativeRun(model: string) {
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
    displayName: "Native reader fixture",
    description: "Native accounting reader boundary",
    visibility: "private",
  });
  const run = await api.createRun(actor, {
    agentId: agent.agentId,
    prompt: "native accounting fixture",
    modelProvider: "anthropic-api-key",
  });
  if (!actor.orgId) {
    throw new Error("Native fixture organization is missing");
  }
  const nativeModelConfig = piModelConfigV4Schema.parse({
    schemaVersion: 4,
    dialect: "anthropic-messages",
    transport: "sse",
    provider: "anthropic",
    route: "anthropic-api-key",
    baseUrl: "https://api.anthropic.com",
    model,
    catalogModel: model,
    credentialOwner: "builtin",
    billingOwner: "builtin",
    requestPolicy: { maxAttempts: 1, cacheRetention: "short" },
    credentialBindings: [
      {
        kind: "api-key",
        environment: "OKOU_PI_NATIVE_API_KEY",
        secretName: "ANTHROPIC_API_KEY",
        credentialHeader: { name: "x-api-key", valueTemplate: "{{secret}}" },
      },
    ],
  });
  const orgId = actor.orgId;
  const record = (turn: PiApiFirstTurnResult, userOwned = false) => {
    return recordNativeUsageFixture({
      runId: run.runId,
      userId: actor.userId,
      orgId,
      nativeModelConfig: userOwned
        ? {
            ...nativeModelConfig,
            credentialOwner: "member",
            billingOwner: "user",
          }
        : nativeModelConfig,
      turn,
    });
  };
  return {
    record,
    async ledger() {
      return (await readRunUsageEventsFixture(run.runId)).map(
        ({ category, provider, quantity }) => {
          return {
            category,
            provider,
            quantity,
          };
        },
      );
    },
    async cancel() {
      await api.requestCancelRun(actor, run.runId, [200]);
    },
  };
}

function turn(
  stopReason: PiApiFirstTurnResult["assistantMessage"]["stopReason"],
  model: string,
): PiApiFirstTurnResult {
  return {
    assistantMessage: {
      model,
      responseId: randomUUID(),
      timestamp: 1,
      content: [],
      ...(stopReason === "error" || stopReason === "aborted"
        ? {
            stopReason,
            failureDiagnostic: { category: "unknown" as const },
          }
        : { stopReason }),
      usage: {
        input: 11,
        output: 3,
        cacheRead: 7,
        cacheWrite: 5,
        cacheWrite1h: 2,
      },
    },
    sessionJsonl: "private-native-session",
    handoffRequired: stopReason === "toolUse",
    observedServiceTier: undefined,
  };
}

describe("native API-owned billing reader", () => {
  it.each(piNativeCatalogModelSchema.options)(
    "records exact non-overlapping categories for %s across terminal outcomes",
    async (model) => {
      const run = await nativeRun(model);
      for (const stopReason of [
        "stop",
        "toolUse",
        "aborted",
        "error",
        "length",
      ] as const) {
        const result = turn(stopReason, model);
        await run.record(result);
        await run.record(result);
      }
      const ledger = await run.ledger();
      for (const [category, quantity] of [
        ["tokens.input", 11],
        ["tokens.output", 3],
        ["tokens.cache_read", 7],
        ["tokens.cache_creation", 5],
      ] as const) {
        expect(
          ledger.filter((row) => {
            return row.category === category;
          }),
        ).toStrictEqual(
          Array.from({ length: 5 }, () => {
            return {
              category,
              provider: model,
              quantity,
            };
          }),
        );
      }
      expect(ledger).toHaveLength(20);
      await run.cancel();
      // A late/discarded observer of the same cancelled request remains one writer.
      const late = turn("aborted", model);
      await run.record(late);
      await run.record(late);
      await expect(run.ledger()).resolves.toHaveLength(24);
    },
  );

  it("does not charge user-owned native model tokens even with a stale billable marker", async () => {
    const run = await nativeRun("claude-sonnet-4-6");
    await run.record(turn("stop", "claude-sonnet-4-6"), true);
    await expect(run.ledger()).resolves.toStrictEqual([]);
    await run.cancel();
  });

  it("rejects conflicting retries and invalid native cache partitions", async () => {
    const model = "claude-sonnet-4-6";
    const run = await nativeRun(model);
    const result = turn("stop", model);
    await run.record(result);
    await expect(
      run.record({
        ...result,
        assistantMessage: {
          ...result.assistantMessage,
          usage: { ...result.assistantMessage.usage, output: 4 },
        },
      }),
    ).rejects.toThrow("identity collision");
    await expect(
      run.record({
        ...result,
        assistantMessage: {
          ...result.assistantMessage,
          usage: { ...result.assistantMessage.usage, cacheWrite1h: 6 },
        },
      }),
    ).rejects.toThrow("cache TTL partition");
    await expect(run.ledger()).resolves.toHaveLength(4);
    await run.cancel();
  });
});
