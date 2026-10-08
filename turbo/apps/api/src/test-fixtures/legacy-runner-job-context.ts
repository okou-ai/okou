import { randomUUID } from "node:crypto";
import { storedExecutionContextSchema } from "@okouai/api-contracts/contracts/runners";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { connectorCatalogExecutableCapabilityDigest } from "../signals/services/connector-catalog-compatibility.service";
import { connectorCatalogSource } from "../signals/services/connector-catalog-source";
import { currentConnectorCatalogValidatorIdentity } from "../signals/services/connector-catalog-validator-authority";

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
  const validator = currentConnectorCatalogValidatorIdentity();
  const executionContext = storedExecutionContextSchema.parse({
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
    connectorPermissionBaseline: {
      version: 1,
      catalogIdentity: {
        sourceId: connectorCatalogSource().sourceId,
        schemaVersion: 4,
        // Older contexts stored the publication version rather than its hash alias.
        catalogVersion,
        catalogDigest,
        capabilityDigest: connectorCatalogExecutableCapabilityDigest(),
      },
      validationAuthority: {
        backendVersion: validator.validatorVersion,
        buildCommitSha: validator.buildCommitSha,
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
  });
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
