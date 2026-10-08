import { randomUUID } from "node:crypto";
import { storedExecutionContextSchema } from "@okouai/api-contracts/contracts/runners";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";

/**
 * Current APIs cannot produce the old queued context. Keep that supported
 * reader boundary covered by replacing only a Run already created through API.
 */
export async function replaceRunnerJobWithLegacyConnectorBaselineFixture({
  runId,
  cliAgentType,
  catalogVersion,
  catalogDigest,
}: {
  readonly runId: string;
  readonly cliAgentType: "claude-code" | "pi";
  readonly catalogVersion: string;
  readonly catalogDigest: string;
}) {
  const executionContext = {
    ...storedExecutionContextSchema.parse({
      storageMounts: [],
      environment: null,
      platformEnvironment: {},
      secretValueEnvironmentKeys: null,
      resumeSession: null,
      encryptedSecrets: null,
      cliAgentType,
      connectorRuntimeTargets: [{ kind: "builtin", connectorSlug: "github" }],
      networkPolicies: {
        github: {
          allow: [],
          deny: ["user:read"],
          ask: [],
          unknownPolicy: "deny",
        },
      },
      ...(cliAgentType === "pi"
        ? {
            piSessionId: randomUUID(),
            piLaunchConfig: { schemaVersion: 2 },
            piModelConfig: {
              provider: "openrouter",
              baseUrl: "https://openrouter.ai/api/v1",
              model: "@preset/okou-1-0",
              apiKeyEnv: "OPENAI_API_KEY",
              credentialSecretName: "OPENROUTER_API_KEY",
            },
          }
        : {}),
    }),
    // Add the retired field after current-schema parsing, which strips it.
    connectorPermissionBaseline: {
      version: 1,
      catalogIdentity: {
        sourceId: "retired-catalog-source",
        schemaVersion: 4,
        catalogVersion,
        catalogDigest,
        capabilityDigest: `sha256:${"0".repeat(64)}`,
      },
      validationAuthority: {
        backendVersion: "1.0.0",
        buildCommitSha: null,
      },
      connectors: {
        github: {
          permissionNames: ["user:read"],
          defaultPolicy: {
            permissionDefault: "deny",
            unknownPolicy: "deny",
          },
        },
      },
    },
  };
  const updated = await db()
    .update(runnerJobQueue)
    .set({ executionContext })
    .where(eq(runnerJobQueue.runId, runId))
    .returning({ runId: runnerJobQueue.runId });
  if (updated.length !== 1) {
    throw new Error(
      "Expected the case's queued Run before replacing its context",
    );
  }
  return executionContext;
}
