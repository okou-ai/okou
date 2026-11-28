import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runnerDispatchEnvelopeSchema } from "../runner-dispatch";

import {
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  CONNECTOR_RUNTIME_SYNC_TARGETS_MAX,
  connectorRuntimeSyncResultSchema,
  elapsedSinceApiStartMs,
  executionContextSchema,
  nativeContinuationSchema,
  sessionContinuationSchema,
  piModelConfigSchema,
  piModelConfigV2Schema,
  piModelConfigV3Schema,
  piModelConfigV5Schema,
  heartbeatBodySchema,
  heldHomeStateSchema,
  RUNNER_CANCELLATION_RECOVERY_GRACE_MS,
  RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX,
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  sandboxReuseResultSchema as runnersSandboxReuseResultSchema,
  storageMountEntrySchema,
  preparedExecutionContextSchema,
  homeReuseResultSchema as runnersHomeReuseResultSchema,
  runnerPreferenceSchema,
} from "../runners";
import {
  runnerHeartbeatGenerationSchema,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxReuseResultSchema,
  homeReuseResultSchema,
} from "../runner-primitives";
import { runRunnerContract } from "../run-routes";
import {
  sandboxReuseResultSchema as webhookSandboxReuseResultSchema,
  homeReuseResultSchema as webhookHomeReuseResultSchema,
} from "../webhooks";

describe("agent execution timing contract", () => {
  it("keeps one run bounded to two hours", () => {
    expect(AGENT_EXECUTION_TIMEOUT_SECONDS).toBe(2 * 60 * 60);
  });
});

describe("cancellation recovery timing contract", () => {
  it("keeps the API stale fallback beyond the runner recovery deadline", () => {
    expect(RUNNER_CANCELLATION_RECOVERY_GRACE_MS).toBe(90_000);
    expect(CANCELLATION_RECOVERY_STALE_AFTER_MS).toBe(120_000);
    expect(
      CANCELLATION_RECOVERY_STALE_AFTER_MS -
        RUNNER_CANCELLATION_RECOVERY_GRACE_MS,
    ).toBe(30_000);
  });
});

describe("run runner response contract", () => {
  it("accepts nullable startup attribution with optional runner metadata", () => {
    expect(
      runRunnerContract.getRunner.responses[200].parse({
        sandboxStartupPath: null,
      }),
    ).toStrictEqual({ sandboxStartupPath: null });

    const currentResponse = {
      sandboxStartupPath: null,
      runnerHostname: null,
      runnerVersion: null,
      runnerId: null,
      runnerHeartbeatGeneration: null,
    };
    expect(
      runRunnerContract.getRunner.responses[200].parse(currentResponse),
    ).toStrictEqual(currentResponse);
  });

  it("accepts a ready runner lifecycle snapshot", () => {
    const readyResponse = {
      sandboxStartupPath: "sandbox",
      runnerHostname: "prod-1.aws.vm3.ai",
      runnerVersion: "1.381.12",
      runnerId: "00000000-0000-4000-8000-000000000001",
      runnerHeartbeatGeneration: 1,
    } as const;

    expect(
      runRunnerContract.getRunner.responses[200].parse(readyResponse),
    ).toStrictEqual(readyResponse);
  });

  it("rejects invalid runner readiness metadata", () => {
    expect(runnerHeartbeatGenerationSchema.safeParse(0).success).toBe(false);
    expect(runnerHostnameSchema.safeParse("").success).toBe(false);
    expect(runnerVersionSchema.safeParse("").success).toBe(false);
  });
});

describe("runner lifecycle schema ownership", () => {
  it("keeps runner and webhook compatibility exports on one schema instance", () => {
    expect(runnersSandboxReuseResultSchema).toBe(sandboxReuseResultSchema);
    expect(webhookSandboxReuseResultSchema).toBe(sandboxReuseResultSchema);
    expect(runnersHomeReuseResultSchema).toBe(homeReuseResultSchema);
    expect(webhookHomeReuseResultSchema).toBe(homeReuseResultSchema);
  });
});

function loadRunnerExecutionContextFixture(): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "fixtures/runner-execution-context.json",
      ),
      "utf-8",
    ),
  );
}

it("ignores additional dispatch metadata and validates known fields", () => {
  const envelope = {
    runnerId: "00000000-0000-4000-8000-000000000001",
    heartbeatGeneration: 1,
    profile: "vm0/default",
    notAfter: 2_000,
    executionContext: loadRunnerExecutionContextFixture(),
  };
  expect(
    runnerDispatchEnvelopeSchema.parse({
      ...envelope,
      futureDispatchMetadata: { version: 1 },
    }),
  ).toStrictEqual(runnerDispatchEnvelopeSchema.parse(envelope));
  expect(
    runnerDispatchEnvelopeSchema.safeParse({ ...envelope, notAfter: "2000" })
      .success,
  ).toBe(false);
  const preferredHomeCheckout = {
    predecessorRunId: "00000000-0000-4000-8000-000000000002",
    waitUntil: 1_500,
  };
  expect(
    runnerDispatchEnvelopeSchema.parse({ ...envelope, preferredHomeCheckout })
      .preferredHomeCheckout,
  ).toStrictEqual(preferredHomeCheckout);
  expect(
    runnerDispatchEnvelopeSchema.safeParse({
      ...envelope,
      preferredHomeCheckout: { ...preferredHomeCheckout, waitUntil: -1 },
    }).success,
  ).toBe(false);
});

function preparedExecutionContextFixture() {
  return {
    cliAgentType: "claude-code",
    officialWorkflowBundles: [],
    seedSkillBundles: [],
    templateGuidanceBundles: [],
    storageMounts: [],
    connectorRuntimeTargets: [],
    environment: null,
    platformEnvironment: {},
    vars: null,
    sessionContinuation: {
      continueNative: false,
      expectedSourceRunId: null,
      recoveryPrompt: null,
    },
    nativeContinuation: {
      sessionId: null,
      generationRunId: null,
      recoveryPrompt: null,
    },
    secretConnectorMap: null,
    secretConnectorMetadataMap: null,
    firewalls: [],
    networkPolicies: {},
    featureFlags: {},
    billableFirewalls: [],
    disallowedTools: [],
  };
}

describe("runner execution context contract", () => {
  it("ignores unknown fields in explicit startup inputs", () => {
    const context = executionContextSchema.parse(
      loadRunnerExecutionContextFixture(),
    );
    const memory = { storageId: "memory", versionId: "version", empty: true };
    const bundle = {
      sha256: "a".repeat(64),
      archiveBytes: 128,
      downloadUrl: "https://example.test/archive",
    };
    const parsed = executionContextSchema.parse({
      ...context,
      startupInputs: {
        memory: { ...memory, futureMemory: true },
        contentBundles: {
          format: "tar-gzip-v1",
          skills: [
            {
              name: "example",
              bundle: { ...bundle, futureReference: true },
              futureSkill: true,
            },
          ],
          futurePackages: true,
        },
        futureInputs: true,
      },
    });
    expect(parsed.startupInputs).toEqual({
      memory,
      contentBundles: {
        format: "tar-gzip-v1",
        skills: [{ name: "example", bundle }],
      },
    });
  });

  it("accepts a one-character Skill name", () => {
    const context = executionContextSchema.parse(
      loadRunnerExecutionContextFixture(),
    );
    const contentBundles = context.startupInputs.contentBundles;
    const skill = { ...contentBundles.skills[0]!, name: "x" };
    const execution = executionContextSchema.parse({
      ...context,
      startupInputs: {
        ...context.startupInputs,
        contentBundles: { ...contentBundles, skills: [skill] },
      },
    });
    expect(execution.startupInputs.contentBundles.skills).toStrictEqual([
      skill,
    ]);
  });

  it("accepts the shared execution context fixture", () => {
    const context = executionContextSchema.parse(
      loadRunnerExecutionContextFixture(),
    );

    expect(context).toMatchObject({
      runId: "00000000-0000-4000-8000-000000020985",
      reuseKey: "thread:00000000-0000-4000-8000-000000020986",
      modelUsageProvider: "fixture-model",
      modelUsageLongContextMinTotalInputTokens: 272_001,
      platformEnvironment: { OKOU_CHAT_THREAD_ID: "fixture-thread-id" },
      startupInputs: {
        contentBundles: {
          format: "tar-gzip-v1",
          instructions: { sha256: "a".repeat(64), archiveBytes: 128 },
          skills: [{ name: "fixture-skill" }],
        },
      },
    });
    expect(context.environment).not.toHaveProperty("OKOU_CHAT_THREAD_ID");
    expect(context).not.toHaveProperty("experimentalProfile");
  });

  it.each([
    { featureFlags: { retainedDiagnosticFlag: false } },
    {
      featureFlags: {
        retainedDiagnosticFlag: true,
      },
    },
  ])(
    "preserves execution environments and captured admission decisions",
    ({ featureFlags }) => {
      const preparedContext = preparedExecutionContextSchema.parse({
        ...preparedExecutionContextFixture(),
        cliAgentType: "codex",
        environment: {
          USER_VALUE: "user-value",
        },
        platformEnvironment: { OKOU_CHAT_THREAD_ID: "prepared-thread-id" },
        featureFlags,
      });
      expect(preparedContext.platformEnvironment).toStrictEqual({
        OKOU_CHAT_THREAD_ID: "prepared-thread-id",
      });
      expect(preparedContext.environment).toStrictEqual({
        USER_VALUE: "user-value",
      });
      expect(preparedContext.featureFlags).toStrictEqual(featureFlags);

      const emptyTrustedContext = preparedExecutionContextSchema.parse({
        ...preparedContext,
        platformEnvironment: {},
      });
      expect(emptyTrustedContext.platformEnvironment).toStrictEqual({});
    },
  );
});

describe("prepared Seed Skill bundle contract", () => {
  const context = {
    ...preparedExecutionContextFixture(),
    platformEnvironment: {
      OKOU_TOKEN: "captured-run-token",
      CUSTOM_PLATFORM_VALUE: "explicit",
    },
    userTimezone: "Asia/Shanghai",
  };

  it.each(["x", "workflow-setup", "x".repeat(64)])(
    "preserves captured Skill %s for all supported roots",
    (skillName) => {
      for (const root of [".claude", ".codex", ".pi/agent"]) {
        const bundle = {
          sha256: "a".repeat(64),
          archiveBytes: 200,
          mountPath: `/home/user/${root}/skills/${skillName}`,
        };
        const captured = { ...context, seedSkillBundles: [bundle] };
        expect(
          preparedExecutionContextSchema.parse(captured).seedSkillBundles,
        ).toStrictEqual([bundle]);
      }
    },
  );

  it("requires immutable references within a supported skill directory", () => {
    for (const mountPath of [
      "/etc/workflow-setup",
      "/home/user/.codex/skills/../workflow-setup",
      "/home/user/.codex/skills/",
      "/home/user/.codex/skills/-x",
      "/home/user/.codex/skills/x-",
      "/home/user/.codex/skills/x_y",
      `/home/user/.codex/skills/${"x".repeat(65)}`,
    ]) {
      expect(
        preparedExecutionContextSchema.safeParse({
          ...context,
          seedSkillBundles: [
            { sha256: "a".repeat(64), archiveBytes: 200, mountPath },
          ],
        }).success,
      ).toBe(false);
    }
  });
});

describe("Pi sandbox execution contract", () => {
  const piSessionId = "22222222-2222-4222-8222-222222222222";
  const preparedContext = {
    ...preparedExecutionContextFixture(),
    cliAgentType: "pi",
  };
  const piPreparedContext = {
    piSessionId,
    piLaunchConfig: { schemaVersion: 2 as const },
    piModelConfig: {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-6-luna",
      schemaVersion: 5,
      dialect: "openai-completions",
      transport: "sse",
      credentialBindings: [
        {
          kind: "api-key",
          environment: "OPENAI_API_KEY",
          secretName: "OPENROUTER_API_KEY",
        },
      ],
    },
  };
  const piRunnerContext = {
    piSessionId: piPreparedContext.piSessionId,
    piLaunchConfig: piPreparedContext.piLaunchConfig,
    piModelConfig: piPreparedContext.piModelConfig,
  };

  it("accepts only the exact generation 5 Chat Completions route", () => {
    const chatCompletions = {
      schemaVersion: 5,
      dialect: "openai-completions",
      transport: "sse",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "@preset/okou-1-0",
      catalogModel: "okou-1.0",
      credentialBindings: [
        {
          kind: "api-key",
          environment: "OPENAI_API_KEY",
          secretName: "OPENROUTER_API_KEY",
        },
      ],
    } as const;
    expect(piModelConfigV5Schema.parse(chatCompletions)).toEqual(
      chatCompletions,
    );
    expect(piModelConfigSchema.parse(chatCompletions)).toEqual(chatCompletions);
    for (const candidate of [
      { ...chatCompletions, serviceTier: "priority" },
      { ...chatCompletions, provider: "openai-codex" },
      { ...chatCompletions, dialect: "openai-responses" },
      { ...chatCompletions, schemaVersion: 3 },
      { ...chatCompletions, schemaVersion: 4 },
      { ...chatCompletions, credentialBindings: [] },
      {
        ...chatCompletions,
        credentialBindings: [
          {
            kind: "access-token",
            environment: "CHATGPT_ACCESS_TOKEN",
            secretName: "CHATGPT_ACCESS_TOKEN",
          },
        ],
      },
    ]) {
      expect(piModelConfigSchema.safeParse(candidate).success).toBe(false);
    }
    for (const schemaVersion of [2, 3] as const) {
      expect(
        piModelConfigSchema.safeParse({ ...chatCompletions, schemaVersion })
          .success,
      ).toBe(false);
    }
  });

  it.each([2, 3] as const)(
    "accepts only exact generation %s dialect-aware credential binding sets",
    (schemaVersion) => {
      const schema =
        schemaVersion === 2 ? piModelConfigV2Schema : piModelConfigV3Schema;
      const publicResponses = {
        schemaVersion,
        dialect: "openai-responses",
        transport: "sse",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-6-luna",
        thinkingLevel: "low",
        credentialBindings: [
          {
            kind: "api-key",
            environment: "OPENAI_API_KEY",
            secretName: "OPENROUTER_API_KEY",
          },
        ],
      } as const;
      const codexResponses = {
        schemaVersion,
        dialect: "openai-codex-responses",
        transport: "sse",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-6-luna",
        thinkingLevel: "low",
        credentialBindings: [
          {
            kind: "account-id",
            environment: "CHATGPT_ACCOUNT_ID",
            secretName: "CHATGPT_ACCOUNT_ID",
          },
          {
            kind: "access-token",
            environment: "CHATGPT_ACCESS_TOKEN",
            secretName: "CHATGPT_ACCESS_TOKEN",
          },
        ],
      } as const;

      expect(schema.parse(publicResponses)).toEqual(publicResponses);
      expect(schema.parse(codexResponses)).toEqual(codexResponses);
      expect(piModelConfigSchema.parse(publicResponses)).toEqual(
        publicResponses,
      );
      expect(piModelConfigSchema.parse(codexResponses)).toEqual(codexResponses);

      for (const serviceTier of [
        undefined,
        "priority",
        "fast",
        "default",
        "unknown",
        null,
      ]) {
        for (const config of [publicResponses, codexResponses]) {
          const candidate = {
            ...config,
            ...(serviceTier === undefined ? {} : { serviceTier }),
          };
          const expected =
            serviceTier === undefined ||
            (config.dialect === "openai-responses"
              ? serviceTier === "priority"
              : schemaVersion === 3 && serviceTier === "fast");
          expect(piModelConfigSchema.safeParse(candidate).success).toBe(
            expected,
          );
          expect(schema.safeParse(candidate).success).toBe(expected);
          if (schemaVersion === 3) {
            expect(piModelConfigV2Schema.safeParse(candidate).success).toBe(
              false,
            );
          }
        }
      }

      for (const invalid of [
        { ...publicResponses, transport: "auto" },
        { ...publicResponses, extra: true },
        { ...publicResponses, thinkingLevel: "future" },
        { ...publicResponses, catalogModel: "x".repeat(513) },
        { ...codexResponses, catalogModel: "gpt-6-luna" },
        { ...codexResponses, provider: "openrouter" },
        { ...publicResponses, provider: "openai" },
        {
          ...codexResponses,
          credentialBindings: [
            codexResponses.credentialBindings[0],
            codexResponses.credentialBindings[0],
          ],
        },
        { ...publicResponses, provider: "openai-codex" },
        { ...publicResponses, credentialBindings: [] },
        {
          ...publicResponses,
          credentialBindings: [
            publicResponses.credentialBindings[0],
            publicResponses.credentialBindings[0],
          ],
        },
        {
          ...publicResponses,
          credentialBindings: [
            {
              kind: "api-key",
              environment: "CHATGPT_ACCESS_TOKEN",
              secretName: "OPENAI_API_KEY",
            },
          ],
        },
        {
          ...publicResponses,
          credentialBindings: [
            {
              kind: "api-key",
              environment: "OPENAI_API_KEY",
              secretName: "CHATGPT_REFRESH_TOKEN",
            },
          ],
        },
        {
          ...codexResponses,
          credentialBindings: [codexResponses.credentialBindings[1]],
        },
        {
          ...codexResponses,
          serviceTier: "priority",
        },
        {
          ...codexResponses,
          credentialBindings: [
            ...codexResponses.credentialBindings,
            {
              kind: "id-token",
              environment: "CHATGPT_ID_TOKEN",
              secretName: "CHATGPT_ID_TOKEN",
            },
          ],
        },
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    },
  );

  it("preserves the Chat Thread session across prepared and Runner-facing contexts", () => {
    const prepared = preparedExecutionContextSchema.parse({
      ...preparedContext,
      ...piPreparedContext,
    });
    const execution = executionContextSchema.parse({
      ...executionContextSchema.parse(loadRunnerExecutionContextFixture()),
      cliAgentType: "pi",
      ...piRunnerContext,
    });

    expect(prepared.piSessionId).toBe(piPreparedContext.piSessionId);
    expect(execution.piSessionId).toBe(piPreparedContext.piSessionId);
  });

  it.each([
    {
      name: "old launch config",
      launchConfig: { schemaVersion: 1 },
    },
  ])("rejects $name without a Sandbox compatibility path", (fixture) => {
    expect(
      preparedExecutionContextSchema.safeParse({
        ...preparedContext,
        ...piPreparedContext,
        piLaunchConfig: fixture.launchConfig,
      }).success,
    ).toBe(false);
  });

  it.each(["piSessionId", "piLaunchConfig", "piModelConfig"])(
    "rejects a prepared Pi context without %s",
    (missingField) => {
      const incompleteContext: Record<string, unknown> = {
        ...piPreparedContext,
      };
      Reflect.deleteProperty(incompleteContext, missingField);

      expect(
        preparedExecutionContextSchema.safeParse({
          ...preparedContext,
          ...incompleteContext,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a prepared Pi framework without the entire hard-cut bundle", () => {
    expect(
      preparedExecutionContextSchema.safeParse(preparedContext).success,
    ).toBe(false);
  });

  it.each(["piLaunchConfig", "piModelConfig"] as const)(
    "rejects prepared %s for another framework",
    (field) => {
      const invalidPreparedContext = {
        ...preparedContext,
        cliAgentType: "claude-code",
        [field]: piPreparedContext[field],
      };

      expect(
        preparedExecutionContextSchema.safeParse(invalidPreparedContext)
          .success,
      ).toBe(false);
    },
  );

  it("requires all Pi fields on a Pi execution context", () => {
    const fixture = executionContextSchema.parse(
      loadRunnerExecutionContextFixture(),
    );
    for (const field of [
      "piSessionId",
      "piLaunchConfig",
      "piModelConfig",
    ] as const) {
      const incomplete: Record<string, unknown> = {
        ...fixture,
        cliAgentType: "pi",
        ...piRunnerContext,
      };
      Reflect.deleteProperty(incomplete, field);
      expect(executionContextSchema.safeParse(incomplete).success).toBe(false);
    }
  });

  it("rejects Pi fields for non-Pi execution frameworks", () => {
    expect(
      executionContextSchema.safeParse({
        ...executionContextSchema.parse(loadRunnerExecutionContextFixture()),
        ...piRunnerContext,
      }).success,
    ).toBe(false);
  });
});

describe("connector runtime synchronization contract", () => {
  const customConnectorId = "00000000-0000-4000-8000-000000000001";

  it("limits sync batches without limiting run targets", () => {
    const fixture = executionContextSchema.parse(
      loadRunnerExecutionContextFixture(),
    );
    const targets = Array.from(
      { length: CONNECTOR_RUNTIME_SYNC_TARGETS_MAX + 1 },
      (_, index) => {
        return {
          kind: "builtin" as const,
          connectorSlug: `connector-${index}`,
        };
      },
    );

    expect(
      executionContextSchema.safeParse({
        ...fixture,
        connectorRuntimeTargets: targets,
      }).success,
    ).toBe(true);
    expect(
      runnersConnectorRuntimeSyncContract.sync.body.safeParse({
        targets,
      }).success,
    ).toBe(false);
  });

  it("requires unique tagged targets", () => {
    const firstTarget = {
      kind: "custom" as const,
      customConnectorId,
      baseUrlVars: { subdomain: "first" },
      sourceId: "10000000-0000-4000-8000-000000000001",
    };
    const secondTarget = {
      ...firstTarget,
      baseUrlVars: { subdomain: "second" },
      sourceId: "10000000-0000-4000-8000-000000000002",
    };

    expect(
      runnersConnectorRuntimeSyncContract.sync.body.safeParse({
        targets: [firstTarget, secondTarget],
      }).success,
    ).toBe(false);
  });

  it("requires custom routing values in target registrations", () => {
    const fixture = executionContextSchema.parse(
      loadRunnerExecutionContextFixture(),
    );
    const target = {
      kind: "custom" as const,
      customConnectorId,
      baseUrlVars: { subdomain: "acme" },
      sourceId: "10000000-0000-4000-8000-000000000001",
    };

    const execution = executionContextSchema.parse({
      ...fixture,
      connectorRuntimeTargets: [target],
    });
    const request = runnersConnectorRuntimeSyncContract.sync.body.parse({
      targets: [target],
    });

    expect(execution.connectorRuntimeTargets).toEqual([target]);
    expect(request.targets).toEqual([target]);
    expect(
      runnersConnectorRuntimeSyncContract.sync.body.safeParse({
        targets: [{ kind: "custom", customConnectorId }],
      }).success,
    ).toBe(false);
    expect(
      runnersConnectorRuntimeSyncContract.sync.body.safeParse({
        targets: [{ kind: "custom", customConnectorId, baseUrlVars: {} }],
      }).success,
    ).toBe(true);
  });

  it("preserves canonical built-in targets and pinned routing values", () => {
    const fixture = executionContextSchema.parse(
      loadRunnerExecutionContextFixture(),
    );
    const target = {
      kind: "builtin" as const,
      connectorSlug: "test-subdomain",
      baseUrlVars: { SUBDOMAIN_TEST_SUBDOMAIN: "xn--mnich-kva" },
      sourceId: "10000000-0000-4000-8000-000000000001",
    };

    const execution = executionContextSchema.parse({
      ...fixture,
      connectorRuntimeTargets: [target],
    });

    expect(execution.connectorRuntimeTargets).toEqual([target]);
  });

  it("accepts legacy builtin policy refreshes without an account binding", () => {
    const result = {
      target: { kind: "builtin", connectorSlug: "plaud-mcp" },
      state: "available",
      networkPolicy: { allow: [], deny: [], ask: [], unknownPolicy: "deny" },
    };

    expect(connectorRuntimeSyncResultSchema.parse(result)).toEqual(result);
    expect(
      connectorRuntimeSyncResultSchema.parse({
        ...result,
        firewall: {
          kind: "builtin",
          name: "plaud-mcp",
          sourceId: "10000000-0000-4000-8000-000000000001",
        },
      }),
    ).toStrictEqual(result);
  });

  it.each(["builtin", "custom"] as const)(
    "preserves an optional exact account binding on available %s results",
    (kind) => {
      const connectionId = "10000000-0000-4000-8000-000000000001";
      const baseUrlVars = { workspace: "account-b" };
      const result = {
        target:
          kind === "builtin"
            ? { kind, connectorSlug: "slack" }
            : { kind, customConnectorId },
        state: "available",
        networkPolicy: { allow: [], deny: [], ask: [], unknownPolicy: "ask" },
        ...(kind === "custom"
          ? {
              firewall: {
                kind: "inline",
                customConnectorId,
                sourceId: connectionId,
                firewall: { name: "custom-connector", apis: [] },
              },
              baseUrlVars,
            }
          : {}),
        accountBinding: { connectionId, baseUrlVars },
      };

      expect(connectorRuntimeSyncResultSchema.parse(result)).toStrictEqual(
        result,
      );
      expect(
        connectorRuntimeSyncResultSchema.safeParse({
          ...result,
          accountBinding: { connectionId },
        }).success,
      ).toBe(false);
    },
  );

  it("requires stable API identities on available custom firewalls", () => {
    const result = {
      target: { kind: "custom" as const, customConnectorId },
      state: "available" as const,
      firewall: {
        kind: "inline" as const,
        firewall: {
          name: "custom_connector_fixture",
          apis: [
            {
              id: "custom_connector_fixture:0",
              base: "https://api.example.com",
              auth: { headers: { Authorization: "Bearer token" } },
            },
          ],
        },
        customConnectorId,
        sourceId: "10000000-0000-4000-8000-000000000001",
      },
      networkPolicy: {
        allow: [],
        deny: [],
        ask: [],
        unknownPolicy: "allow" as const,
      },
      baseUrlVars: { subdomain: "acme" },
    };

    expect(connectorRuntimeSyncResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        ...result,
        baseUrlVars: undefined,
      }).success,
    ).toBe(false);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        ...result,
        firewall: {
          ...result.firewall,
          firewall: {
            ...result.firewall.firewall,
            apis: result.firewall.firewall.apis.map((api) => {
              return { base: api.base, auth: api.auth };
            }),
          },
        },
      }).success,
    ).toBe(false);
  });

  it("allows target-specific absence while keeping retry reasons distinct", () => {
    const builtinTarget = {
      kind: "builtin" as const,
      connectorSlug: "slack",
    };
    const customTarget = { kind: "custom" as const, customConnectorId };

    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: builtinTarget,
        state: "unresolved",
        reason: "connector-unavailable",
      }).success,
    ).toBe(true);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: customTarget,
        state: "absent",
        reason: "connector-unavailable",
      }).success,
    ).toBe(true);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: builtinTarget,
        state: "absent",
        reason: "connector-unavailable",
      }).success,
    ).toBe(true);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: customTarget,
        state: "unresolved",
        reason: "permission-bundle-unavailable",
      }).success,
    ).toBe(true);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: customTarget,
        state: "unresolved",
        reason: "runtime-configuration-unavailable",
      }).success,
    ).toBe(true);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: customTarget,
        state: "unresolved",
        reason: "connector-unavailable",
      }).success,
    ).toBe(false);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: customTarget,
        state: "absent",
        reason: "permission-bundle-unavailable",
      }).success,
    ).toBe(false);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: customTarget,
        state: "absent",
        reason: "runtime-configuration-unavailable",
      }).success,
    ).toBe(false);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: builtinTarget,
        state: "absent",
        reason: "permission-bundle-unavailable",
      }).success,
    ).toBe(false);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: {
          kind: "builtin",
          connectorSlug: "model-provider:openrouter-codex",
        },
        state: "absent",
        reason: "connector-unavailable",
      }).success,
    ).toBe(false);
    expect(
      connectorRuntimeSyncResultSchema.safeParse({
        target: builtinTarget,
        state: "unresolved",
        reason: "runtime-configuration-unavailable",
      }).success,
    ).toBe(false);
  });
});

describe("runner storage manifest contract", () => {
  it("accepts canonical read-only and writeback mounts", () => {
    expect(
      storageMountEntrySchema.parse({
        name: "workspace",
        storageId: "storage-id-1",
        versionId: "version-1",
        mountPath: "/workspace",
        archiveUrl: "https://storage.example/workspace.tar.gz",
      }),
    ).toMatchObject({
      name: "workspace",
      storageId: "storage-id-1",
      versionId: "version-1",
      mountPath: "/workspace",
    });

    expect(
      storageMountEntrySchema.parse({
        name: "memory",
        storageId: "storage-id-2",
        versionId: "version-2",
        mountPath: "/memory",
        empty: true,
        writeback: true,
      }),
    ).toMatchObject({
      name: "memory",
      empty: true,
      writeback: true,
    });
  });

  it("rejects canonical mounts that cannot preserve current behavior", () => {
    const base = {
      name: "workspace",
      storageId: "storage-id-1",
      versionId: "version-1",
      mountPath: "/workspace",
    };

    expect(storageMountEntrySchema.safeParse(base).success).toBe(false);
    expect(
      storageMountEntrySchema.safeParse({
        ...base,
        archiveUrl: "https://storage.example/workspace.tar.gz",
        empty: true,
      }).success,
    ).toBe(false);
    expect(
      storageMountEntrySchema.safeParse({
        ...base,
        archiveUrl: "https://storage.example/workspace.tar.gz",
        missingRootPolicy: "fail",
      }).success,
    ).toBe(false);
  });
});

describe("runner reuse preference contract", () => {
  it("accepts every strict positive runner preference tier", () => {
    const runnerPreference = {
      kind: "preference" as const,
      runnerIdentity: {
        runnerId: "22222222-2222-4222-8222-222222222222",
        heartbeatGeneration: 7,
      },
      expiresAt: "2026-08-03T00:00:01.000Z",
    };

    for (const tier of [
      "exactSandbox",
      "finalizingPredecessor",
      "reusableSandbox",
      "homeCache",
    ] as const) {
      const preference = {
        ...runnerPreference,
        tier,
        ...(tier === "exactSandbox" || tier === "finalizingPredecessor"
          ? { predecessorRunId: "11111111-1111-4111-8111-111111111111" }
          : {}),
      };
      expect(runnerPreferenceSchema.parse(preference)).toStrictEqual(
        preference,
      );
    }
    expect(
      runnerPreferenceSchema.safeParse({
        ...runnerPreference,
        tier: "reusableSandbox",
        reason: "noReuseKey",
      }).success,
    ).toBe(false);
    expect(
      runnerPreferenceSchema.safeParse({
        ...runnerPreference,
        tier: "reusableSandbox",
        expiresAt: undefined,
      }).success,
    ).toBe(false);
    expect(
      runnerPreferenceSchema.safeParse({
        ...runnerPreference,
        runnerIdentity: {
          ...runnerPreference.runnerIdentity,
          runnerId: "not-a-uuid",
        },
        tier: "reusableSandbox",
      }).success,
    ).toBe(false);
    expect(
      runnerPreferenceSchema.safeParse({
        ...runnerPreference,
        tier: "reusableSandbox",
        expiresAt: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("accepts every strict no-preference reason", () => {
    for (const reason of [
      "noReuseKey",
      "expired",
      "noViableHolder",
      "lookupError",
    ] as const) {
      expect(
        runnerPreferenceSchema.parse({ kind: "noPreference", reason }),
      ).toStrictEqual({ kind: "noPreference", reason });
    }
    expect(
      runnerPreferenceSchema.safeParse({
        kind: "noPreference",
        reason: "noReuseKey",
        tier: "homeCache",
      }).success,
    ).toBe(false);
  });

  it("accepts ordered heartbeat snapshots", () => {
    const heartbeat = {
      runnerId: "33333333-3333-4333-8333-333333333333",
      group: "vm0/test",
      snapshotGeneration: 1,
      snapshotSequence: 1,
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: 4,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: 0,
      admittableProfiles: ["vm0/default"],
      heldSandboxStates: [],
      heldHomeStates: [],
      activeReuseProducers: [],
      mode: "running",
    } as const;

    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        snapshotGeneration: 7,
        snapshotSequence: 42,
        heldSandboxStates: [
          {
            reuseKey: "thread:current",
            lastCompletedAt: "2026-07-15T00:00:00.000Z",
            reusableSandbox: {
              sourceRunId: "33333333-3333-4333-8333-333333333333",
              profile: "vm0/default",
            },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        snapshotGeneration: Number.MAX_SAFE_INTEGER,
        snapshotSequence: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    for (const invalidOrder of [
      { snapshotGeneration: 0, snapshotSequence: 1 },
      { snapshotGeneration: -1, snapshotSequence: 1 },
      { snapshotGeneration: 1.5, snapshotSequence: 1 },
      { snapshotGeneration: 1, snapshotSequence: 0 },
      { snapshotGeneration: 1, snapshotSequence: -1 },
      { snapshotGeneration: 1, snapshotSequence: 1.5 },
    ]) {
      expect(
        heartbeatBodySchema.safeParse({
          ...heartbeat,
          ...invalidOrder,
        }).success,
      ).toBe(false);
    }
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        snapshotGeneration: Number.MAX_SAFE_INTEGER + 1,
        snapshotSequence: 42,
      }).success,
    ).toBe(false);
  });

  it("requires canonical heartbeat state", () => {
    const heartbeat = {
      runnerId: "33333333-3333-4333-8333-333333333333",
      group: "vm0/test",
      snapshotGeneration: 1,
      snapshotSequence: 1,
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: 4,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: 0,
      admittableProfiles: ["vm0/default"],
      heldSandboxStates: [],
      heldHomeStates: [],
      activeReuseProducers: [],
      mode: "running",
    } as const;

    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        heldSandboxStates: undefined,
      }).success,
    ).toBe(false);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        activeReuseProducers: undefined,
      }).success,
    ).toBe(false);

    const parsed = heartbeatBodySchema.parse({
      ...heartbeat,
      heldSandboxStates: [
        {
          reuseKey: "thread:canonical",
          lastCompletedAt: "2026-07-15T00:00:00.000Z",
          reusableSandbox: {
            sourceRunId: "33333333-3333-4333-8333-333333333333",
            profile: "vm0/default",
          },
        },
      ],
    });
    expect(parsed.heldSandboxStates).toHaveLength(1);
    expect(parsed.heldSandboxStates[0]?.reuseKey).toBe("thread:canonical");
    expect(parsed.activeReuseProducers).toStrictEqual([]);

    const producer = {
      runId: "22222222-2222-4222-8222-222222222222",
      reuseKey: "thread:canonical",
      profile: "vm0/default",
    };
    expect(
      heartbeatBodySchema.parse({
        ...heartbeat,
        activeReuseProducers: [producer],
      }).activeReuseProducers,
    ).toStrictEqual([producer]);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        activeReuseProducers: [{ ...producer, runId: "not-a-run" }],
      }).success,
    ).toBe(false);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        activeReuseProducers: Array.from({ length: 1025 }, () => {
          return producer;
        }),
      }).success,
    ).toBe(false);
  });

  it("bounds profile-qualified home cache heartbeat state", () => {
    const heartbeat = {
      runnerId: "33333333-3333-4333-8333-333333333333",
      group: "vm0/test",
      snapshotGeneration: 1,
      snapshotSequence: 1,
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: 4,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: 0,
      admittableProfiles: ["vm0/default"],
      heldSandboxStates: [],
      heldHomeStates: [],
      activeReuseProducers: [],
      mode: "running",
    } as const;
    const homeCaches = Array.from({ length: 8 }, (_, index) => {
      return {
        sourceRunId: "33333333-3333-4333-8333-333333333333",
        profile: `vm0/profile-${index}`,
        homeAffinityVersion: 1 as const,
      };
    });
    const heldHomeStates = Array.from({ length: 512 }, (_, index) => {
      return {
        reuseKey: `thread:${index}`,
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        homeCaches,
      };
    });

    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        heldHomeStates,
      }).success,
    ).toBe(true);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        heldHomeStates: [
          ...heldHomeStates,
          {
            reuseKey: "thread:over-global-cap",
            lastCompletedAt: "2026-07-15T00:00:00.000Z",
            homeCaches: [
              {
                sourceRunId: "33333333-3333-4333-8333-333333333333",
                profile: "vm0/default",
                homeAffinityVersion: 1,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({
        reuseKey: "thread:over-parent-cap",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        homeCaches: [
          ...homeCaches,
          {
            sourceRunId: "33333333-3333-4333-8333-333333333333",
            profile: "vm0/profile-over-cap",
            homeAffinityVersion: 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({
        reuseKey: "thread:without-home",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        homeCaches: [],
      }).success,
    ).toBe(false);
    expect(
      heldHomeStateSchema.safeParse({
        reuseKey: "thread:invalid-capability",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        homeCaches: [
          {
            sourceRunId: "33333333-3333-4333-8333-333333333333",
            profile: "vm0/default",
            homeAffinityVersion: 2,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("runner builtin firewall resolve contract", () => {
  it("accepts omitted names for full catalog resolution", () => {
    const result =
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({});

    expect(result.success).toBe(true);
  });

  it("accepts connector and model-provider names", () => {
    const result =
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["github", "model-provider:openrouter-codex"],
      });

    expect(result.success).toBe(true);
  });

  it("rejects malformed and oversized requests", () => {
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse(null)
        .success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse([]).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["ModelProvider:openrouter-codex"],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["model-provider:"],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: [],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: null,
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: "github",
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: [""],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        name: ["github"],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["github"],
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: Array.from(
          { length: RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX + 1 },
          (_, index) => {
            return `github-${index}`;
          },
        ),
      }).success,
    ).toBe(false);
  });
});

describe("runner firewall entry contract", () => {
  it("accepts compact builtin firewall entries", () => {
    const firewalls = [
      {
        kind: "builtin",
        name: "test-subdomain",
        baseUrlVars: { SUBDOMAIN_TEST_SUBDOMAIN: "acme" },
        sourceId: "10000000-0000-4000-8000-000000000001",
      },
    ];

    expect(
      preparedExecutionContextSchema.shape.firewalls.safeParse(firewalls)
        .success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
  });

  it("accepts inline firewall entries", () => {
    const firewalls = [
      {
        kind: "inline",
        sourceId: "10000000-0000-4000-8000-000000000001",
        firewall: {
          name: "internal-api",
          apis: [
            {
              base: "https://api.internal.example.com",
              auth: { headers: { Authorization: "${{ secrets.TOKEN }}" } },
              permissions: [{ name: "read", rules: ["GET /items"] }],
            },
          ],
        },
      },
    ];

    expect(
      preparedExecutionContextSchema.shape.firewalls.safeParse(firewalls)
        .success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
  });

  it("rejects malformed connector source identities", () => {
    for (const firewall of [
      { kind: "builtin", name: "github", sourceId: "not-a-uuid" },
      {
        kind: "inline",
        sourceId: "not-a-uuid",
        firewall: { name: "custom", apis: [] },
      },
    ]) {
      expect(
        executionContextSchema.shape.firewalls.safeParse([firewall]).success,
      ).toBe(false);
    }
  });

  it("rejects legacy expanded firewall entries in execution contexts", () => {
    const firewalls = [
      {
        name: "github",
        apis: [{ base: "https://api.github.com", auth: { headers: {} } }],
      },
    ];

    expect(
      preparedExecutionContextSchema.shape.firewalls.safeParse(firewalls)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
  });

  it("rejects unsupported execution firewall kinds", () => {
    const firewalls = [
      {
        kind: "unknown",
        name: "github",
        apis: [{ base: "https://api.github.com", auth: { headers: {} } }],
      },
    ];

    expect(
      preparedExecutionContextSchema.shape.firewalls.safeParse(firewalls)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
  });
});

describe("runner apiStartTime contract", () => {
  it("accepts Unix epoch millisecond integers", () => {
    const timestamp = 1_700_000_000_000;

    expect(
      preparedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(true);
  });

  it("rejects fractional timestamps", () => {
    const timestamp = 1_700_000_000_000.5;

    expect(
      preparedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(false);
  });

  it("rejects negative timestamps", () => {
    expect(
      preparedExecutionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
  });

  it("rejects seconds-shaped timestamps", () => {
    const timestamp = 1_700_000_000;

    expect(
      preparedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(false);
  });

  it("computes elapsed milliseconds for valid apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000_000, 1_700_000_001_250)).toBe(
      1_250,
    );
  });

  it("clamps future apiStartTime values to zero elapsed milliseconds", () => {
    expect(elapsedSinceApiStartMs(1_700_000_001_250, 1_700_000_000_000)).toBe(
      0,
    );
  });

  it("skips seconds-shaped apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000, 1_700_000_001_250)).toBe(
      undefined,
    );
  });

  it("skips fractional apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000_000.5, 1_700_000_001_250)).toBe(
      undefined,
    );
  });
});

describe("native continuation intent", () => {
  it("preserves fresh, resumed and Chat recovery launches", () => {
    for (const intent of [
      { sessionId: null, generationRunId: null, recoveryPrompt: null },
      {
        sessionId: "native-session",
        generationRunId: "22222222-2222-4222-8222-222222222222",
        recoveryPrompt: null,
      },
      {
        sessionId: null,
        generationRunId: null,
        recoveryPrompt:
          "Read context with okou chat messages --output-dir threads before proceeding",
      },
    ])
      expect(nativeContinuationSchema.parse(intent)).toStrictEqual(intent);
  });
  it("requires the native session and producing Run as one identity", () => {
    for (const intent of [
      {
        sessionId: "native-session",
        generationRunId: null,
        recoveryPrompt: null,
      },
      {
        sessionId: null,
        generationRunId: "22222222-2222-4222-8222-222222222222",
        recoveryPrompt: null,
      },
    ])
      expect(nativeContinuationSchema.safeParse(intent).success).toBe(false);
  });

  it("accepts valid sessionContinuation intents and rejects continueNative without expectedSourceRunId", () => {
    for (const intent of [
      {
        continueNative: false,
        expectedSourceRunId: null,
        recoveryPrompt: null,
      },
      {
        continueNative: true,
        expectedSourceRunId: "22222222-2222-4222-8222-222222222222",
        recoveryPrompt:
          "Read context with okou chat messages --output-dir threads before proceeding",
      },
      {
        continueNative: false,
        expectedSourceRunId: null,
        recoveryPrompt:
          "Read context with okou chat messages --output-dir threads before proceeding",
      },
    ])
      expect(sessionContinuationSchema.parse(intent)).toStrictEqual(intent);

    expect(
      sessionContinuationSchema.safeParse({
        continueNative: true,
        expectedSourceRunId: null,
        recoveryPrompt: null,
      }).success,
    ).toBe(false);
    expect(
      sessionContinuationSchema.safeParse({
        continueNative: false,
        expectedSourceRunId: "22222222-2222-4222-8222-222222222222",
        recoveryPrompt: null,
      }).success,
    ).toBe(false);
  });
});

describe("pinned Official Workflow prepared metadata", () => {
  const context = preparedExecutionContextFixture();
  it("preserves exact descriptors through execution preparation", () => {
    const officialWorkflowBundles = [
      {
        sha256: "a".repeat(64),
        archiveBytes: 200,
        mountPath: "/home/user/.claude/skills/morning-brief",
      },
    ];
    const prepared = { ...context, officialWorkflowBundles };
    expect(
      preparedExecutionContextSchema.parse(prepared).officialWorkflowBundles,
    ).toStrictEqual(officialWorkflowBundles);
    expect(
      preparedExecutionContextSchema.parse(context).officialWorkflowBundles,
    ).toStrictEqual([]);
  });
  it("rejects unsafe destinations and incomplete bundle references", () => {
    for (const reference of [
      { sha256: "a".repeat(64), archiveBytes: 200, mountPath: "/tmp/escape" },
      {
        sha256: "a".repeat(64),
        archiveBytes: 0,
        mountPath: "/home/user/.codex/skills/morning-brief",
      },
      {
        archiveBytes: 200,
        mountPath: "/home/user/.codex/skills/morning-brief",
      },
    ])
      expect(
        preparedExecutionContextSchema.safeParse({
          ...context,
          officialWorkflowBundles: [reference],
        }).success,
      ).toBe(false);
  });
});
