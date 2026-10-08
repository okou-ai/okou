import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  compatibleStoredExecutionContextSchema,
  CONNECTOR_RUNTIME_SYNC_TARGETS_MAX,
  connectorRuntimeSyncResultSchema,
  elapsedSinceApiStartMs,
  executionContextSchema,
  heartbeatBodySchema,
  heldSandboxStateSchema,
  heldWorkspaceStateSchema,
  jobSchema,
  PI_MEMORY_SUMMARY_MAX_BYTES,
  PI_MEMORY_SUMMARY_MAX_TOKENS,
  PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS,
  piLangfuseParentSchema,
  piMemoryRecallSelectionSchema,
  piModelConfigLegacySchema,
  piModelConfigSchema,
  piModelConfigV2Schema,
  piModelConfigV3Schema,
  piModelConfigV5Schema,
  RUNNER_CANCELLATION_RECOVERY_GRACE_MS,
  RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX,
  RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  resumeSessionSchema,
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  runnersJobClaimContract,
  runnersPollContract,
  sandboxReuseResultSchema as runnersSandboxReuseResultSchema,
  storageMountEntrySchema,
  storageManifestSchema,
  storedExecutionContextSchema,
  storedResumeSessionSchema,
  workspaceReuseResultSchema as runnersWorkspaceReuseResultSchema,
} from "../runners";
import {
  runnerHeartbeatGenerationSchema,
  runnerHostnameSchema,
  runnerVersionSchema,
  sandboxReuseResultSchema,
  workspaceReuseResultSchema,
} from "../runner-primitives";
import { runRunnerContract } from "../run-routes";
import {
  sandboxReuseResultSchema as webhookSandboxReuseResultSchema,
  workspaceReuseResultSchema as webhookWorkspaceReuseResultSchema,
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

/** Every claim body must advertise capabilities; the tests below vary the other fields. */
const claimCapabilities = { piModelConfigGenerations: [1, 2, 3] };

describe("runner claim attribution contract", () => {
  it("accepts an optional bounded runner hostname", () => {
    const previousRequest = runnersJobClaimContract.claim.body.parse({
      capabilities: claimCapabilities,
    });
    expect(previousRequest).not.toHaveProperty("runnerHostname");

    expect(
      runnersJobClaimContract.claim.body.parse({
        capabilities: claimCapabilities,
        runnerHostname: "prod-1.aws.vm3.ai",
      }),
    ).toMatchObject({ runnerHostname: "prod-1.aws.vm3.ai" });

    for (const runnerHostname of ["", "x".repeat(256)]) {
      expect(
        runnersJobClaimContract.claim.body.safeParse({
          capabilities: claimCapabilities,
          runnerHostname,
        }).success,
      ).toBe(false);
    }
  });
});

describe("run runner response compatibility", () => {
  it("accepts the previous response and current explicit-null attribution", () => {
    expect(
      runRunnerContract.getRunner.responses[200].parse({
        sandboxReuseResult: null,
      }),
    ).toStrictEqual({ sandboxReuseResult: null });

    const currentResponse = {
      sandboxReuseResult: null,
      workspaceReuseResult: null,
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
      sandboxReuseResult: "reused",
      workspaceReuseResult: "sandboxReused",
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
    expect(runnersWorkspaceReuseResultSchema).toBe(workspaceReuseResultSchema);
    expect(webhookWorkspaceReuseResultSchema).toBe(workspaceReuseResultSchema);
  });
});

function loadRunnerClaimResponseFixture(): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "fixtures/runner-claim-response.json"),
      "utf-8",
    ),
  );
}

describe("runner claim response contract", () => {
  it("accepts the shared current response fixture", () => {
    const context = executionContextSchema.parse(
      loadRunnerClaimResponseFixture(),
    );

    expect(context).toMatchObject({
      runId: "00000000-0000-4000-8000-000000020985",
      reuseKey: "thread:00000000-0000-4000-8000-000000020986",
      modelUsageProvider: "fixture-model",
      modelUsageLongContextMinTotalInputTokens: 272_001,
      platformEnvironment: { OKOU_AGENT_ID: "fixture-agent-id" },
    });
    expect(context.environment).not.toHaveProperty("OKOU_AGENT_ID");
    expect(context).not.toHaveProperty("experimentalProfile");
  });

  it("round-trips canonical trusted environments through stored contexts", () => {
    const storedContext = storedExecutionContextSchema.parse({
      storageMounts: [],
      connectorRuntimeTargets: [],
      environment: {
        USER_VALUE: "user-value",
      },
      platformEnvironment: { OKOU_AGENT_ID: "stored-agent-id" },
      secretValueEnvironmentKeys: null,
      resumeSession: null,
      encryptedSecrets: null,
      cliAgentType: "claude-code",
    });
    const roundTripped = compatibleStoredExecutionContextSchema.parse(
      JSON.parse(JSON.stringify(storedContext)),
    );

    expect(roundTripped.platformEnvironment).toStrictEqual({
      OKOU_AGENT_ID: "stored-agent-id",
    });
    expect(roundTripped.environment).toStrictEqual({
      USER_VALUE: "user-value",
    });

    const emptyTrustedContext = compatibleStoredExecutionContextSchema.parse({
      ...storedContext,
      platformEnvironment: {},
    });
    expect(emptyTrustedContext.platformEnvironment).toStrictEqual({});
  });
});

describe("Pi sandbox execution contract", () => {
  const piSessionId = "22222222-2222-4222-8222-222222222222";
  const storedContext = {
    storageMounts: [],
    connectorRuntimeTargets: [],
    environment: null,
    platformEnvironment: {},
    secretValueEnvironmentKeys: null,
    resumeSession: null,
    encryptedSecrets: null,
    cliAgentType: "pi",
  };
  const piStoredContext = {
    piSessionId,
    piLaunchConfig: { schemaVersion: 2 as const },
    piModelConfig: {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-6-luna",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENROUTER_API_KEY",
    },
  };
  const piRunnerContext = {
    piSessionId: piStoredContext.piSessionId,
    piLaunchConfig: piStoredContext.piLaunchConfig,
    piModelConfig: piStoredContext.piModelConfig,
  };
  const pollJob = {
    runId: "22222222-2222-4222-8222-222222222222",
    prompt: "continue",
    appendSystemPrompt: null,
    vars: null,
    experimentalProfile: "vm0/large",
    runnerPreference: {
      kind: "noPreference" as const,
      reason: "noReuseKey" as const,
    },
  };

  it("preserves canonical Gen1 request policy", () => {
    expect(piModelConfigSchema.parse(piStoredContext.piModelConfig)).toEqual(
      piStoredContext.piModelConfig,
    );
    expect(
      piModelConfigSchema.parse({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-6-luna",
        thinkingLevel: "low",
        serviceTier: "priority",
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OPENROUTER_API_KEY",
      }),
    ).toMatchObject({
      thinkingLevel: "low",
      serviceTier: "priority",
    });
    expect(
      piModelConfigSchema.safeParse({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-6-luna",
        thinkingLevel: "low",
        serviceTier: "fast",
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OPENROUTER_API_KEY",
      }).success,
    ).toBe(false);
  });

  it.each([
    undefined,
    "openai-responses",
    "openai-completions",
    "openai-codex-responses",
  ])(
    "rejects an extra Gen1 api key with value %s at the wire boundary",
    (api) => {
      const config = { ...piStoredContext.piModelConfig, api };
      const result = piModelConfigLegacySchema.safeParse(config);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: "unrecognized_keys", keys: ["api"] }),
      ]);
      expect(piModelConfigSchema.safeParse(config).success).toBe(false);
      expect(
        storedExecutionContextSchema.safeParse({
          ...storedContext,
          ...piStoredContext,
          piModelConfig: config,
        }).success,
      ).toBe(false);
    },
  );

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
      expect(piModelConfigLegacySchema.safeParse(codexResponses).success).toBe(
        false,
      );

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

  it("accepts one strict sampled Langfuse parent", () => {
    const langfuseParent = {
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      traceFlags: 1,
      sessionId: piSessionId,
      sandboxWaitStartedAt: 1_000,
    } as const;

    expect(piLangfuseParentSchema.parse(langfuseParent)).toStrictEqual(
      langfuseParent,
    );
    for (const invalidParent of [
      { ...langfuseParent, traceId: "0".repeat(32) },
      { ...langfuseParent, traceId: "1".repeat(31) },
      { ...langfuseParent, spanId: "0".repeat(16) },
      { ...langfuseParent, spanId: "2".repeat(15) },
      { ...langfuseParent, traceFlags: 0 },
      { ...langfuseParent, sandboxWaitStartedAt: undefined },
      { ...langfuseParent, sandboxWaitStartedAt: -1 },
      { ...langfuseParent, sandboxWaitStartedAt: 1.5 },
      { ...langfuseParent, extra: true },
    ]) {
      expect(piLangfuseParentSchema.safeParse(invalidParent).success).toBe(
        false,
      );
    }
  });

  it("preserves the Chat Thread session across stored and Runner-facing contexts", () => {
    const stored = storedExecutionContextSchema.parse({
      ...storedContext,
      ...piStoredContext,
    });
    const compatible = compatibleStoredExecutionContextSchema.parse({
      ...storedContext,
      ...piStoredContext,
    });
    const claimed = executionContextSchema.parse({
      ...executionContextSchema.parse(loadRunnerClaimResponseFixture()),
      cliAgentType: "pi",
      ...piRunnerContext,
    });

    expect(stored.piSessionId).toBe(piStoredContext.piSessionId);
    expect(compatible.piSessionId).toBe(piStoredContext.piSessionId);
    expect(claimed.piSessionId).toBe(piStoredContext.piSessionId);
    expect(jobSchema.parse(pollJob)).not.toHaveProperty("piExecutionMode");
  });

  it.each([
    {
      name: "old launch config",
      launchConfig: { schemaVersion: 1 },
    },
  ])("rejects $name without a Sandbox compatibility path", (fixture) => {
    expect(
      storedExecutionContextSchema.safeParse({
        ...storedContext,
        ...piStoredContext,
        piLaunchConfig: fixture.launchConfig,
      }).success,
    ).toBe(false);
  });

  it.each(["piSessionId", "piLaunchConfig", "piModelConfig"])(
    "rejects a stored Pi context without %s",
    (missingField) => {
      const incompleteContext: Record<string, unknown> = { ...piStoredContext };
      Reflect.deleteProperty(incompleteContext, missingField);

      expect(
        storedExecutionContextSchema.safeParse({
          ...storedContext,
          ...incompleteContext,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a stored Pi framework without the entire hard-cut bundle", () => {
    expect(storedExecutionContextSchema.safeParse(storedContext).success).toBe(
      false,
    );
    expect(
      compatibleStoredExecutionContextSchema.safeParse(storedContext).success,
    ).toBe(false);
  });

  it.each(["piLaunchConfig", "piModelConfig"] as const)(
    "rejects stored %s without piSessionId",
    (field) => {
      const invalidStoredContext = {
        ...storedContext,
        cliAgentType: "claude-code",
        [field]: piStoredContext[field],
      };

      expect(
        storedExecutionContextSchema.safeParse(invalidStoredContext).success,
      ).toBe(false);
      expect(
        compatibleStoredExecutionContextSchema.safeParse(invalidStoredContext)
          .success,
      ).toBe(false);
    },
  );

  it("requires all Pi fields on a claimed Pi context", () => {
    const fixture = executionContextSchema.parse(
      loadRunnerClaimResponseFixture(),
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

  it("rejects Pi fields for non-Pi claimed frameworks", () => {
    expect(
      executionContextSchema.safeParse({
        ...executionContextSchema.parse(loadRunnerClaimResponseFixture()),
        ...piRunnerContext,
      }).success,
    ).toBe(false);
  });
});

describe("connector runtime synchronization contract", () => {
  const customConnectorId = "00000000-0000-4000-8000-000000000001";

  it("limits sync batches without limiting run targets", () => {
    const fixture = executionContextSchema.parse(
      loadRunnerClaimResponseFixture(),
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
      loadRunnerClaimResponseFixture(),
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
      loadRunnerClaimResponseFixture(),
    );
    const target = {
      kind: "builtin" as const,
      connectorSlug: "zendesk",
      baseUrlVars: { ZENDESK_SUBDOMAIN: "xn--mnich-kva" },
      sourceId: "10000000-0000-4000-8000-000000000001",
    };

    const execution = executionContextSchema.parse({
      ...fixture,
      connectorRuntimeTargets: [target],
    });

    expect(execution.connectorRuntimeTargets).toEqual([target]);
  });

  it("keeps builtin runtime synchronization policy-only", () => {
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

describe("runner poll response contract", () => {
  const job = {
    runId: "22222222-2222-4222-8222-222222222222",
    prompt: "continue",
    appendSystemPrompt: null,
    vars: null,
    runnerPreference: {
      kind: "noPreference" as const,
      reason: "noReuseKey" as const,
    },
  };

  it.each(["vm0/default", "vm0/large"])(
    "requires and preserves profile %s",
    (experimentalProfile) => {
      expect(jobSchema.parse({ ...job, experimentalProfile })).toMatchObject({
        experimentalProfile,
      });
    },
  );

  it("rejects a missing profile", () => {
    expect(jobSchema.safeParse(job).success).toBe(false);
  });

  it("accepts current and pre-reuse-key jobs", () => {
    expect(
      jobSchema.parse({
        ...job,
        experimentalProfile: "vm0/default",
        reuseKey: "thread:22222222-2222-4222-8222-222222222223",
      }).reuseKey,
    ).toBe("thread:22222222-2222-4222-8222-222222222223");
    expect(
      jobSchema.parse({
        ...job,
        experimentalProfile: "vm0/default",
        reuseKey: null,
      }).reuseKey,
    ).toBeNull();
    expect(
      jobSchema.parse({
        ...job,
        experimentalProfile: "vm0/default",
      }).reuseKey,
    ).toBeUndefined();
  });
});

describe("runner storage manifest contract", () => {
  const storedContext = {
    storageMounts: [],
    connectorRuntimeTargets: [],
    environment: null,
    platformEnvironment: {},
    secretValueEnvironmentKeys: null,
    resumeSession: null,
    encryptedSecrets: null,
    cliAgentType: "codex",
  };

  it("keeps prepared readers compatible with omitted stored fields", () => {
    const preparedStoredExecutionContextSchema =
      storedExecutionContextSchema.extend({
        storageManifest: z.unknown().nullable().optional(),
      });

    expect(preparedStoredExecutionContextSchema.parse(storedContext)).toEqual(
      storedContext,
    );
    expect(storedExecutionContextSchema.parse(storedContext)).toEqual(
      storedContext,
    );
  });

  it("requires canonical mounts while ignoring previous stored fields", () => {
    expect(
      compatibleStoredExecutionContextSchema.parse({
        ...storedContext,
        storageManifest: null,
      }),
    ).toEqual(storedContext);
    expect(
      compatibleStoredExecutionContextSchema.parse({
        ...storedContext,
        storageManifest: {
          storages: [{ futureLegacyField: true }],
          artifacts: [],
        },
      }),
    ).toEqual(storedContext);
    expect(
      compatibleStoredExecutionContextSchema.safeParse({
        ...storedContext,
        storageMounts: undefined,
      }).success,
    ).toBe(false);
  });

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
    expect(
      storageMountEntrySchema.safeParse({
        ...base,
        archiveUrl: "https://storage.example/workspace.tar.gz",
        instructionsTargetFilename: "AGENTS.md",
        writeback: true,
      }).success,
    ).toBe(false);
  });

  it("accepts only the canonical wire representation", () => {
    const canonical = {
      storageMounts: [
        {
          name: "workspace",
          storageId: "storage-id-1",
          versionId: "version-1",
          mountPath: "/workspace",
          archiveUrl: "https://storage.example/workspace.tar.gz",
        },
      ],
    };
    const legacy = { storages: [], artifacts: [] };

    expect(storageManifestSchema.parse(canonical)).toEqual(canonical);
    expect(storageManifestSchema.safeParse(legacy).success).toBe(false);
    expect(storageManifestSchema.safeParse({}).success).toBe(false);
    expect(
      storageManifestSchema.parse({
        ...canonical,
        futureRunnerField: true,
      }),
    ).toEqual(canonical);
  });

  it("rejects duplicate canonical mount paths", () => {
    const mount = {
      name: "workspace",
      storageId: "storage-id-1",
      versionId: "version-1",
      mountPath: "/workspace",
      archiveUrl: "https://storage.example/workspace.tar.gz",
    };

    expect(
      storageManifestSchema.safeParse({
        storageMounts: [mount, { ...mount, name: "replacement" }],
      }).success,
    ).toBe(false);
  });
});

describe("runner resume session contract", () => {
  const historyHash =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const historyGenerationRunId = "11111111-1111-4111-8111-111111111111";

  it("accepts inline stored and claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      sessionHistory: '{"type":"init"}\n',
    };

    expect(storedResumeSessionSchema.safeParse(resumeSession).success).toBe(
      true,
    );
    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(true);
  });

  it("accepts hash-backed stored resume sessions without URLs", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: historyHash },
    };

    expect(storedResumeSessionSchema.parse(resumeSession)).toEqual(
      resumeSession,
    );
    expect(
      storedExecutionContextSchema.shape.resumeSession.safeParse(resumeSession)
        .success,
    ).toBe(true);
  });

  it("keeps generation metadata in stable discovery and reusable shapes", () => {
    const storedResumeSession = {
      sessionId: "sess-123",
      historyGenerationRunId,
      historyRef: { kind: "blob" as const, hash: historyHash },
    };
    expect(storedResumeSessionSchema.parse(storedResumeSession)).toEqual(
      storedResumeSession,
    );

    const claimResumeSession = resumeSessionSchema.parse({
      ...storedResumeSession,
      historyRef: {
        ...storedResumeSession.historyRef,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        encoding: "identity",
        rawSize: 1024,
        encodedSize: 1024,
      },
    });
    expect(claimResumeSession).not.toHaveProperty("historyGenerationRunId");

    const job = jobSchema.parse({
      runId: "22222222-2222-4222-8222-222222222222",
      prompt: "continue",
      appendSystemPrompt: null,
      vars: null,
      experimentalProfile: "vm0/default",
      historyGenerationRunId,
      runnerPreference: {
        kind: "noPreference",
        reason: "noReuseKey",
      },
    });
    expect(job.historyGenerationRunId).toBe(historyGenerationRunId);

    const heldSandboxState = heldSandboxStateSchema.parse({
      reuseKey: "thread:22222222-2222-4222-8222-222222222223",
      lastCompletedAt: "2026-07-15T00:00:00.000Z",
      reusableSandbox: {
        profile: "vm0/default",
        historyGenerationRunId,
      },
    });
    expect(heldSandboxState).not.toHaveProperty("sessionId");
    expect(heldSandboxState.reusableSandbox.historyGenerationRunId).toBe(
      historyGenerationRunId,
    );

    const heldWorkspaceState = heldWorkspaceStateSchema.parse({
      reuseKey: "thread:22222222-2222-4222-8222-222222222223",
      lastCompletedAt: "2026-07-15T00:00:00.000Z",
      workspaceCaches: [
        { profile: "vm0/default", workspaceAffinityVersion: 1 },
        { profile: "vm0/large", workspaceAffinityVersion: 1 },
      ],
    });
    expect(heldWorkspaceState.workspaceCaches).toEqual([
      { profile: "vm0/default", workspaceAffinityVersion: 1 },
      { profile: "vm0/large", workspaceAffinityVersion: 1 },
    ]);
  });

  it("requires a canonical runner preference", () => {
    const jobInput = {
      runId: "22222222-2222-4222-8222-222222222222",
      prompt: "continue",
      appendSystemPrompt: null,
      vars: null,
      experimentalProfile: "vm0/default",
    };

    expect(jobSchema.safeParse(jobInput).success).toBe(false);
    const runnerPreference = {
      kind: "noPreference" as const,
      reason: "noReuseKey" as const,
    };
    expect(
      jobSchema.parse({
        ...jobInput,
        runnerPreference,
      }),
    ).toMatchObject({
      runnerPreference,
    });
  });

  it("accepts every strict positive runner preference tier", () => {
    const runnerPreference = {
      kind: "preference" as const,
      runnerIdentity: {
        runnerId: "22222222-2222-4222-8222-222222222222",
        heartbeatGeneration: 7,
      },
      expiresAt: "2026-08-03T00:00:01.000Z",
    };
    const jobInput = {
      runId: "33333333-3333-4333-8333-333333333333",
      prompt: "continue",
      appendSystemPrompt: null,
      vars: null,
      experimentalProfile: "vm0/default",
    };

    for (const tier of [
      "exactSandbox",
      "finalizingPredecessor",
      "reusableSandbox",
      "workspaceCache",
    ] as const) {
      expect(
        jobSchema.parse({
          ...jobInput,
          runnerPreference: { ...runnerPreference, tier },
        }).runnerPreference,
      ).toStrictEqual({ ...runnerPreference, tier });
    }
    expect(
      jobSchema.safeParse({
        ...jobInput,
        runnerPreference: {
          ...runnerPreference,
          tier: "reusableSandbox",
          reason: "noReuseKey",
        },
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        ...jobInput,
        runnerPreference: {
          ...runnerPreference,
          tier: "reusableSandbox",
          expiresAt: undefined,
        },
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        ...jobInput,
        runnerPreference: {
          ...runnerPreference,
          runnerIdentity: {
            ...runnerPreference.runnerIdentity,
            runnerId: "not-a-uuid",
          },
          tier: "reusableSandbox",
        },
      }).success,
    ).toBe(false);
    expect(
      jobSchema.safeParse({
        ...jobInput,
        runnerPreference: {
          ...runnerPreference,
          tier: "reusableSandbox",
          expiresAt: "not-a-date",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts every strict no-preference reason", () => {
    const jobInput = {
      runId: "33333333-3333-4333-8333-333333333333",
      prompt: "continue",
      appendSystemPrompt: null,
      vars: null,
      experimentalProfile: "vm0/default",
    };

    for (const reason of [
      "noReuseKey",
      "expired",
      "noViableHolder",
      "lookupError",
    ] as const) {
      expect(
        jobSchema.parse({
          ...jobInput,
          runnerPreference: { kind: "noPreference", reason },
        }).runnerPreference,
      ).toStrictEqual({ kind: "noPreference", reason });
    }
    expect(
      jobSchema.safeParse({
        ...jobInput,
        runnerPreference: {
          kind: "noPreference",
          reason: "noReuseKey",
          tier: "workspaceCache",
        },
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
      heldWorkspaceStates: [],
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
            reusableSandbox: { profile: "vm0/default" },
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
      heldWorkspaceStates: [],
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
          reusableSandbox: { profile: "vm0/default" },
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

  it("bounds profile-qualified workspace cache heartbeat state", () => {
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
      heldWorkspaceStates: [],
      activeReuseProducers: [],
      mode: "running",
    } as const;
    const workspaceCaches = Array.from({ length: 8 }, (_, index) => {
      return {
        profile: `vm0/profile-${index}`,
        workspaceAffinityVersion: 1 as const,
      };
    });
    const heldWorkspaceStates = Array.from({ length: 128 }, (_, index) => {
      return {
        reuseKey: `thread:${index}`,
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        workspaceCaches,
      };
    });

    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        heldWorkspaceStates,
      }).success,
    ).toBe(true);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        heldWorkspaceStates: [
          ...heldWorkspaceStates,
          {
            reuseKey: "thread:over-global-cap",
            lastCompletedAt: "2026-07-15T00:00:00.000Z",
            workspaceCaches: [
              { profile: "vm0/default", workspaceAffinityVersion: 1 },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      heldWorkspaceStateSchema.safeParse({
        reuseKey: "thread:over-parent-cap",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        workspaceCaches: [
          ...workspaceCaches,
          {
            profile: "vm0/profile-over-cap",
            workspaceAffinityVersion: 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      heldWorkspaceStateSchema.safeParse({
        reuseKey: "thread:without-workspace",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        workspaceCaches: [],
      }).success,
    ).toBe(false);
    expect(
      heldWorkspaceStateSchema.safeParse({
        reuseKey: "thread:invalid-capability",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        workspaceCaches: [
          { profile: "vm0/default", workspaceAffinityVersion: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps stored identity refs tolerant and requires explicit claim metadata", () => {
    const storedResumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: historyHash },
    };
    const claimResumeSessionWithoutEncoding = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        rawSize: 1024,
        encodedSize: 1024,
      },
    };
    const claimResumeSession = {
      ...claimResumeSessionWithoutEncoding,
      historyRef: {
        ...claimResumeSessionWithoutEncoding.historyRef,
        encoding: "identity",
      },
    };

    expect(
      storedResumeSessionSchema.safeParse(storedResumeSession).success,
    ).toBe(true);
    expect(resumeSessionSchema.safeParse(storedResumeSession).success).toBe(
      false,
    );
    expect(
      resumeSessionSchema.safeParse(claimResumeSessionWithoutEncoding).success,
    ).toBe(false);
    expect(resumeSessionSchema.parse(claimResumeSession)).toEqual(
      claimResumeSession,
    );
    expect(
      executionContextSchema.shape.resumeSession.safeParse(claimResumeSession)
        .success,
    ).toBe(true);
  });

  it("rejects non-lowercase session history hashes", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: "A".repeat(64) },
    };

    expect(storedResumeSessionSchema.safeParse(resumeSession).success).toBe(
      false,
    );
    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("rejects oversized hash-backed claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        encoding: "identity",
        rawSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
        encodedSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("accepts gzip hash-backed claim resume sessions with explicit sizes", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.gz?sig=secret",
        encoding: "gzip",
        rawSize: 1024,
        encodedSize: 128,
        downloadSource:
          SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
      },
    };

    expect(resumeSessionSchema.parse(resumeSession)).toEqual(resumeSession);
  });

  it("rejects unknown hash-backed claim resume session download sources", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        encoding: "identity",
        rawSize: 1024,
        encodedSize: 1024,
        downloadSource: "regional_edge_cache",
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("accepts zstd hash-backed stored and claim resume sessions", () => {
    const storedResumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        encoding: "zstd",
      },
    };
    const claimResumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.zst?sig=secret",
        encoding: "zstd",
        rawSize: 1024,
        encodedSize: 96,
      },
    };

    expect(storedResumeSessionSchema.parse(storedResumeSession)).toEqual(
      storedResumeSession,
    );
    expect(resumeSessionSchema.parse(claimResumeSession)).toEqual(
      claimResumeSession,
    );
  });

  it("rejects malformed gzip claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.gz?sig=secret",
        encoding: "gzip",
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("rejects malformed zstd claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.zst?sig=secret",
        encoding: "zstd",
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });
});

describe("runner claim request contract", () => {
  it("accepts omitted or complete runner identity", () => {
    expect(
      runnersJobClaimContract.claim.body.parse({
        capabilities: claimCapabilities,
      }),
    ).toEqual({ capabilities: claimCapabilities });
    expect(
      runnersJobClaimContract.claim.body.parse({
        capabilities: claimCapabilities,
        runnerIdentity: {
          runnerId: "11111111-1111-4111-8111-111111111111",
          heartbeatGeneration: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).toStrictEqual({
      capabilities: claimCapabilities,
      runnerIdentity: {
        runnerId: "11111111-1111-4111-8111-111111111111",
        heartbeatGeneration: Number.MAX_SAFE_INTEGER,
      },
    });
  });

  it("accepts a bounded forward-compatible Pi model-config capability", () => {
    expect(
      runnersJobClaimContract.claim.body.parse({
        capabilities: { piModelConfigGenerations: [1, 2, 7] },
      }),
    ).toStrictEqual({
      capabilities: { piModelConfigGenerations: [1, 2, 7] },
    });

    for (const piModelConfigGenerations of [
      [],
      [1, 1],
      [0],
      [256],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    ]) {
      expect(
        runnersJobClaimContract.claim.body.safeParse({
          capabilities: { piModelConfigGenerations },
        }).success,
      ).toBe(false);
    }
  });

  it("requires a strict all-or-nothing runner identity", () => {
    const runnerId = "11111111-1111-4111-8111-111111111111";
    for (const runnerIdentity of [
      { runnerId },
      { heartbeatGeneration: 1 },
      { runnerId: "not-a-uuid", heartbeatGeneration: 1 },
      { runnerId, heartbeatGeneration: 0 },
      { runnerId, heartbeatGeneration: -1 },
      { runnerId, heartbeatGeneration: 1.5 },
      { runnerId, heartbeatGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { runnerId, heartbeatGeneration: 1, unexpected: true },
    ]) {
      expect(
        runnersJobClaimContract.claim.body.safeParse({
          capabilities: claimCapabilities,
          runnerIdentity,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts optional direct candidate timing telemetry", () => {
    const result = runnersJobClaimContract.claim.body.safeParse({
      capabilities: claimCapabilities,
      telemetry: {
        discoverySource: "ably",
        jobDiscoveredToClaimRequestMs: 123,
        localAdmissionToClaimRequestMs: 4,
        directCandidateNotificationToEnqueueMs: 1,
        directCandidateInboxWaitMs: 2,
        providerDiscoveryToMainLoopMs: 3,
        mainLoopToLocalAdmissionMs: 4,
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts every positive runner preference claim state", () => {
    const runnerPreference = {
      kind: "preference" as const,
      runnerIdentity: {
        runnerId: "22222222-2222-4222-8222-222222222222",
        heartbeatGeneration: 7,
      },
      tier: "workspaceCache" as const,
      expiresAt: "2026-08-03T00:00:01.000Z",
    };

    for (const runnerPreferenceClaimState of [
      "active",
      "expired",
      "cleared",
    ] as const) {
      expect(
        runnersJobClaimContract.claim.body.parse({
          capabilities: claimCapabilities,
          telemetry: {
            runnerPreference,
            runnerPreferenceClaimState,
          },
        }).telemetry,
      ).toStrictEqual({
        runnerPreference,
        runnerPreferenceClaimState,
      });
    }
  });

  it("accepts canonical no-preference claim telemetry", () => {
    const runnerPreference = {
      kind: "noPreference" as const,
      reason: "noViableHolder" as const,
    };

    expect(
      runnersJobClaimContract.claim.body.parse({
        capabilities: claimCapabilities,
        telemetry: {
          runnerPreference,
        },
      }).telemetry,
    ).toStrictEqual({
      runnerPreference,
    });
  });

  it("keeps other claim telemetry when canonical preference is malformed", () => {
    expect(
      runnersJobClaimContract.claim.body.parse({
        capabilities: claimCapabilities,
        telemetry: {
          discoverySource: "poll",
          runnerPreference: { kind: "futurePreference" },
          runnerPreferenceClaimState: "active",
        },
      }).telemetry,
    ).toStrictEqual({
      discoverySource: "poll",
      runnerPreference: undefined,
      runnerPreferenceClaimState: "active",
    });
  });

  it("discards malformed diagnostic telemetry", () => {
    const body = runnersJobClaimContract.claim.body.parse({
      capabilities: claimCapabilities,
      telemetry: {
        pollReason: "future-reason",
        jobDiscoveredToClaimRequestMs: -1,
      },
    });

    expect(body.telemetry).toEqual({});
  });
});

describe("runner poll request contract", () => {
  const group = "vm0/test";
  const supportedProfiles = ["vm0/default"];
  const runId = "550e8400-e29b-41d4-a716-446655440000";

  it("accepts bounded optional run exclusions", () => {
    expect(
      runnersPollContract.poll.body.parse({
        group,
        supportedProfiles,
        excludedRunIds: [runId],
      }),
    ).toEqual({
      group,
      supportedProfiles,
      excludedRunIds: [runId],
    });

    expect(
      runnersPollContract.poll.body.safeParse({
        group,
        supportedProfiles,
        excludedRunIds: Array.from(
          { length: RUNNER_POLL_EXCLUDED_RUN_IDS_MAX + 1 },
          () => {
            return runId;
          },
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects malformed exclusions and behavior-bearing routing fields", () => {
    expect(
      runnersPollContract.poll.body.safeParse({
        group,
        supportedProfiles,
        excludedRunIds: ["not-a-run-id"],
      }).success,
    ).toBe(false);
    expect(
      runnersPollContract.poll.body.safeParse({
        group,
        supportedProfiles: [],
      }).success,
    ).toBe(false);
  });

  it("discards malformed diagnostic telemetry", () => {
    const body = runnersPollContract.poll.body.parse({
      group,
      supportedProfiles,
      telemetry: { pollReason: "future-reason" },
    });

    expect(body.telemetry).toEqual({});
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
        name: "zendesk",
        baseUrlVars: { ZENDESK_SUBDOMAIN: "acme" },
        sourceId: "10000000-0000-4000-8000-000000000001",
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
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
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
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
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
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
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
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
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(true);
  });

  it("rejects fractional timestamps", () => {
    const timestamp = 1_700_000_000_000.5;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(false);
  });

  it("rejects negative timestamps", () => {
    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
  });

  it("rejects seconds-shaped timestamps", () => {
    const timestamp = 1_700_000_000;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
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

describe("runner Claude tool list contracts", () => {
  it("keeps runner context schemas tolerant of legacy tool list values", () => {
    expect(
      storedExecutionContextSchema.shape.tools.safeParse(["Bash,Read"]).success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.tools.safeParse(["Bash,Read"]).success,
    ).toBe(true);
  });
});

describe("Pi memory recall selection contract", () => {
  const summary = "# Working memory\n\nKeep repository-native checks.";
  const readySelection = {
    status: "ready" as const,
    memoryStorageId: "memory-storage",
    storageVersionId: "storage-version-a",
    content: summary,
    sourceHash: "a".repeat(64),
    sourceSize: Buffer.byteLength(summary, "utf8"),
    tokenCount: 12,
  };

  it("bounds the full-source token count by the 64 KiB source limit", () => {
    // A source within the byte ceiling can never exceed one token per byte.
    expect(PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS).toBe(
      PI_MEMORY_SUMMARY_MAX_BYTES,
    );
    expect(PI_MEMORY_SUMMARY_MAX_TOKENS).toBe(2500);

    for (const tokenCount of [
      1,
      PI_MEMORY_SUMMARY_MAX_TOKENS,
      2943,
      PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS,
    ]) {
      expect(
        piMemoryRecallSelectionSchema.safeParse({
          ...readySelection,
          tokenCount,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects impossible and non-source token counts", () => {
    for (const tokenCount of [
      0,
      -1,
      1.5,
      PI_MEMORY_SUMMARY_SOURCE_MAX_TOKENS + 1,
    ]) {
      expect(
        piMemoryRecallSelectionSchema.safeParse({
          ...readySelection,
          tokenCount,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps the remaining full-source fields required", () => {
    expect(
      piMemoryRecallSelectionSchema.safeParse({
        ...readySelection,
        content: "x".repeat(PI_MEMORY_SUMMARY_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      piMemoryRecallSelectionSchema.safeParse({
        ...readySelection,
        sourceSize: PI_MEMORY_SUMMARY_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      piMemoryRecallSelectionSchema.safeParse({
        ...readySelection,
        sourceHash: "zz",
      }).success,
    ).toBe(false);
    expect(
      piMemoryRecallSelectionSchema.safeParse({
        status: "no-content",
        memoryStorageId: "memory-storage",
        storageVersionId: "storage-version-a",
      }).success,
    ).toBe(true);
  });
});
