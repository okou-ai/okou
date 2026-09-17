import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { compileModelProviderGatewayRuntime } from "../signals/services/model-provider-gateway-runtime";
/** Durable synthetic credentials for consumer admission; no provider I/O. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { db } from "../lib/db";
import { encryptSecretForTests } from "../signals/routes/__tests__/helpers/encrypt-secret";
import { resolvePiSandboxModelConfig } from "../signals/services/pi-sandbox-config";

export async function captureDeferredPersonalProvider(f: {
  runId: string;
  orgId: string;
  userId: string;
}) {
  const logicalId = randomUUID();
  const accountId = randomUUID();
  const type = "codex-oauth-token";
  const selectedModel = "gpt-5.6-terra";
  const environment = {
    OPENAI_MODEL: selectedModel,
    CHATGPT_ACCESS_TOKEN: "synthetic-access-token",
    CHATGPT_REFRESH_TOKEN: "synthetic-refresh-token",
    CHATGPT_ID_TOKEN: "synthetic-id-token",
    CHATGPT_ACCOUNT_ID: `synthetic-${accountId}`,
  };
  await db().insert(modelProviders).values({
    id: logicalId,
    type,
    userId: f.userId,
    orgId: f.orgId,
    authMethod: "auth_json",
    selectedModel,
  });
  await db().insert(modelProviderAccounts).values({
    id: accountId,
    modelProviderId: logicalId,
    type,
    userId: f.userId,
    orgId: f.orgId,
    authMethod: "auth_json",
    isActive: true,
    externalAccountId: environment.CHATGPT_ACCOUNT_ID,
  });
  for (const [name, value] of Object.entries(environment)) {
    if (name === "OPENAI_MODEL") {
      continue;
    }
    const encryptedValue = encryptSecretForTests(value);
    await db()
      .insert(modelProviderAccountSecrets)
      .values({ modelProviderAccountId: accountId, name, encryptedValue });
    await db().insert(secrets).values({
      orgId: f.orgId,
      userId: f.userId,
      type: "model-provider",
      name,
      encryptedValue,
    });
  }
  onTestFinished(async () => {
    await db().delete(modelProviders).where(eq(modelProviders.id, logicalId));
    await db()
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, f.orgId),
          eq(secrets.userId, f.userId),
          eq(secrets.type, "model-provider"),
        ),
      );
  });
  await db()
    .update(agentRuns)
    .set({
      builtInModelKeyId: null,
      modelProvider: type,
      modelProviderId: accountId,
      modelProviderCredentialScope: "member",
      selectedModel,
      modelRuntimeProvider: "openai-codex",
      modelRuntimeModel: selectedModel,
    })
    .where(eq(agentRuns.id, f.runId));
  return {
    modelProviderId: accountId,
    modelProviderCredentialScope: "member" as const,
    modelProviderType: type,
    selectedModel,
    runtimeProvider: "openai-codex",
    runtimeModel: selectedModel,
    modelConfig: resolvePiSandboxModelConfig({
      type,
      environment,
      selectedModel,
    }),
    builtInModelRuntimeRoute: undefined,
  };
}

export async function captureDeferredGateway(f: {
  runId: string;
  orgId: string;
  userId: string;
}) {
  const surfaceId = randomUUID();
  const connectionId = randomUUID();
  const secretId = randomUUID();
  const selectedModel = "gpt-5.6-terra";
  const gateway = {
    connectionId,
    secretId,
    protocol: "openai-responses" as const,
    apiBaseUrl: "https://gateway.example/v1",
    authHeaderName: "Authorization",
    authHeaderTemplate: "Bearer {{secret}}",
    upstreamModel: "captured-upstream-model",
  };
  await db()
    .insert(secrets)
    .values({
      id: secretId,
      orgId: f.orgId,
      userId: f.userId,
      type: "model-provider",
      name: `gateway-${surfaceId}`,
      encryptedValue: encryptSecretForTests("synthetic-gateway-key"),
    });
  await db().insert(modelProviderConnections).values({
    id: connectionId,
    orgId: f.orgId,
    displayName: "Consumer fixture",
    secretId,
  });
  await db()
    .insert(modelProviderSurfaces)
    .values({
      id: surfaceId,
      connectionId,
      protocol: gateway.protocol,
      apiBaseUrl: gateway.apiBaseUrl,
      authHeaderName: gateway.authHeaderName,
      authHeaderTemplate: gateway.authHeaderTemplate,
      modelMappings: { [selectedModel]: gateway.upstreamModel },
    });
  onTestFinished(async () => {
    await db().delete(secrets).where(eq(secrets.id, secretId));
  });
  const runtime = compileModelProviderGatewayRuntime({
    ...gateway,
    surfaceId,
    logicalModel: selectedModel,
    displayName: "Consumer fixture",
  });
  const modelConfig = resolvePiSandboxModelConfig({
    type: runtime.type,
    selectedModel,
    environment: runtime.environment,
    inlineFirewall: true,
    credentialHeader: {
      name: gateway.authHeaderName,
      valueTemplate: gateway.authHeaderTemplate,
    },
  });
  if (!modelConfig) {
    throw new Error("Unsupported synthetic gateway model");
  }
  await db()
    .update(agentRuns)
    .set({
      builtInModelKeyId: null,
      modelProvider: runtime.type,
      modelProviderId: surfaceId,
      modelProviderCredentialScope: "org",
      selectedModel,
      modelRuntimeProvider: modelConfig.provider,
      modelRuntimeModel: gateway.upstreamModel,
    })
    .where(eq(agentRuns.id, f.runId));
  return {
    modelProviderId: surfaceId,
    modelProviderCredentialScope: "org" as const,
    modelProviderType: runtime.type,
    selectedModel,
    runtimeProvider: modelConfig.provider,
    runtimeModel: gateway.upstreamModel,
    modelConfig,
    gateway,
    builtInModelRuntimeRoute: undefined,
  };
}
