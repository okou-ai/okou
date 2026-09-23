import { describe, expect, it } from "vitest";

import { requirePiApiFirstTurnExecutionContext } from "../pi-api-first-turn-config";

describe("Pi API first-turn execution context", () => {
  it("preserves the session-construction digest across the API-owned projection", () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const context = {
      apiStartTime: 1,
      billableFirewalls: [],
      encryptedSecrets: null,
      modelUsageProvider: undefined,
      piLaunchConfig: {
        schemaVersion: 2,
        apiFirstTurn: {
          schemaVersion: 1,
          resourceSnapshotDigest: "a".repeat(64),
          manifestUrl: "https://storage.example/manifest.json",
          sessionUrl: "https://storage.example/session.jsonl",
          deadlineAt: 55_001,
          baseSession: { sessionId, sha256: null },
          sandboxEventSequenceStart: 1,
          requiredPiAgentRuntimeVersion: "1.39.0",
          minCliVersion: "9.355.3",
          requiredPiSessionConstructionDigest: "d".repeat(64),
        },
      },
      platformEnvironment: {},
      piModelConfig: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6-terra",
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OPENAI_API_KEY",
      },
      piSessionId: sessionId,
      resumeSession: null,
      secretConnectorMap: null,
      secretConnectorMetadataMap: null,
      storageMounts: [],
    } satisfies Parameters<typeof requirePiApiFirstTurnExecutionContext>[0];

    const projected = requirePiApiFirstTurnExecutionContext(context);
    expect(projected.piLaunchConfig.apiFirstTurn).toMatchObject({
      requiredPiSessionConstructionDigest: "d".repeat(64),
      requiredPiAgentRuntimeVersion: "1.39.0",
      minCliVersion: "9.355.3",
    });
    expect(projected.piLaunchConfig.apiFirstTurn).not.toHaveProperty(
      "manifestUrl",
    );

    const legacy = requirePiApiFirstTurnExecutionContext({
      ...context,
      piLaunchConfig: {
        ...context.piLaunchConfig,
        apiFirstTurn: {
          ...context.piLaunchConfig.apiFirstTurn,
          requiredPiSessionConstructionDigest: undefined,
        },
      },
    });
    expect(legacy.piLaunchConfig.apiFirstTurn).not.toHaveProperty(
      "requiredPiSessionConstructionDigest",
    );
  });
});
