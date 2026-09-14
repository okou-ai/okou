import { getModelProviderPiEndpoint } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import {
  getProviderRuntimeModel,
  getSecretNameForType,
  isModelSupportedByProvider,
} from "@okouai/api-contracts/contracts/model-providers";
import { getOpenRouterBaseUrl } from "@okouai/api-contracts/contracts/openrouter-routing";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { secrets } from "@okouai/db/schema/secret";
import {
  isPiAgentModelSupported,
  resolvePiAgentCredential,
  type PiAgentModelConfig,
} from "@okouai/pi-agent-runtime";
import { PI_MEMORY_STAGE1_MODEL } from "@okouai/pi-agent-runtime/api";
import { and, eq } from "drizzle-orm";
import type { Db } from "../external/db";
import { resolveCurrentPersonalSubscriptionBundleForApi } from "./agent-webhook-firewall-auth.service";
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { gptApiKeyPiRoute } from "./pi-sandbox-config";
import {
  personalModelProviderAccountById,
  readPersonalSubscriptionCredentialBundle,
} from "./model-provider-account.service";

export type PiMemoryStage1CredentialSkip =
  | "source_missing"
  | "source_owner_mismatch"
  | "source_binding_invalid"
  | "source_scope_mismatch"
  | "credential_unavailable"
  | "provider_model_unsupported";

export class PiMemoryStage1CredentialError extends Error {
  constructor(readonly errorClass: PiMemoryStage1CredentialSkip) {
    super("Pi memory Stage 1 source credential unavailable");
    this.name = "PiMemoryStage1CredentialError";
  }
}

export class PiMemoryStage1CredentialRefreshError extends Error {
  readonly errorClass = "credential_refresh_failed";
  constructor() {
    super("Pi memory Stage 1 source credential refresh failed");
    this.name = "PiMemoryStage1CredentialRefreshError";
  }
}

export interface PiMemoryStage1Billing {
  readonly mode: "builtin" | "byok";
  readonly orgId: string;
  readonly userId: string;
}

interface SourceIdentity {
  readonly sourceRunId: string;
  readonly orgId: string;
  readonly userId: string;
}

export type PiMemoryStage1CredentialResult =
  | { readonly status: "skip"; readonly reason: PiMemoryStage1CredentialSkip }
  | {
      readonly status: "available";
      readonly model: PiAgentModelConfig;
      readonly billing: PiMemoryStage1Billing;
      /** Re-read the exact binding without refreshing or selecting defaults. */
      readonly validate: (signal: AbortSignal) => Promise<void>;
    };

async function sourceBinding(db: Db, source: SourceIdentity) {
  const [run] = await db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      type: agentRuns.modelProvider,
      id: agentRuns.modelProviderId,
      scope: agentRuns.modelProviderCredentialScope,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, source.sourceRunId))
    .limit(1);
  return run;
}

interface ResolutionContext {
  readonly db: Db;
  readonly source: SourceIdentity;
  readonly binding: NonNullable<Awaited<ReturnType<typeof sourceBinding>>>;
  readonly context: Awaited<ReturnType<typeof loadUserFeatureSwitchContext>>;
}

function skip(
  reason: PiMemoryStage1CredentialSkip,
): PiMemoryStage1CredentialResult {
  return { status: "skip", reason };
}

function availableCredential(
  args: ResolutionContext,
  model: PiAgentModelConfig,
  mode: PiMemoryStage1Billing["mode"],
  validateCredential: (signal: AbortSignal) => Promise<boolean>,
): PiMemoryStage1CredentialResult {
  const { db, source, binding } = args;
  if (!isPiAgentModelSupported(model)) {
    return skip("provider_model_unsupported");
  }
  return {
    status: "available",
    model,
    billing: { mode, orgId: source.orgId, userId: source.userId },
    validate: async (validationSignal) => {
      const current = await sourceBinding(db, source);
      validationSignal.throwIfAborted();
      if (!current) {
        throw new PiMemoryStage1CredentialError("source_missing");
      }
      if (JSON.stringify(current) !== JSON.stringify(binding)) {
        throw new PiMemoryStage1CredentialError("source_binding_invalid");
      }
      if (!(await validateCredential(validationSignal))) {
        throw new PiMemoryStage1CredentialError("credential_unavailable");
      }
    },
  };
}
async function builtinCredential(
  args: ResolutionContext,
  signal: AbortSignal,
): Promise<PiMemoryStage1CredentialResult> {
  const { db, binding, context } = args;
  // Model-first Chat pins use org scope; direct built-in launches leave it null.
  if (
    binding.id !== null ||
    (binding.scope !== null && binding.scope !== "org")
  ) {
    return skip("source_binding_invalid");
  }
  const route = await resolveBuiltInModelRuntimeRoute(
    db,
    PI_MEMORY_STAGE1_MODEL,
  );
  signal.throwIfAborted();
  if (
    !route ||
    (route.providerType !== "openai-api-key" &&
      route.providerType !== "openrouter-codex")
  ) {
    return skip("provider_model_unsupported");
  }
  const endpoint = getModelProviderPiEndpoint(
    route.providerType,
    "openai-responses",
  );
  if (!endpoint) {
    return skip("provider_model_unsupported");
  }
  const readKey = async () => {
    const [key] = await db
      .select({ apiKey: builtInModelKeys.apiKey })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.id, route.modelKeyId))
      .limit(1);
    return key?.apiKey;
  };
  const apiKey = await readKey();
  signal.throwIfAborted();
  if (!apiKey?.trim()) {
    return skip("credential_unavailable");
  }
  const provider =
    route.providerType === "openai-api-key" ? "openai" : "openrouter";
  return availableCredential(
    args,
    {
      provider,
      apiKey,
      model: route.upstreamModel,
      baseUrl:
        provider === "openrouter"
          ? getOpenRouterBaseUrl("responses", {
              credentialOwner: "builtin",
              model: route.upstreamModel,
              usRoutingEnabled: isFeatureEnabled(
                FeatureSwitchKey.OpenRouterUsRouting,
                context,
              ),
            })
          : endpoint.baseUrl,
      dialect: "openai-responses",
      transport: "sse",
    },
    "builtin",
    async (validationSignal) => {
      const current = await readKey();
      validationSignal.throwIfAborted();
      return current === apiKey;
    },
  );
}

async function codexCredential(
  args: ResolutionContext,
  id: string,
  signal: AbortSignal,
): Promise<PiMemoryStage1CredentialResult> {
  const { db, source, binding, context } = args;
  if (binding.scope !== "member") {
    return skip("source_scope_mismatch");
  }
  const accountArgs = { db, id, orgId: source.orgId, userId: source.userId };
  const account = await personalModelProviderAccountById(accountArgs);
  signal.throwIfAborted();
  if (!account || account.type !== binding.type) {
    return skip("credential_unavailable");
  }
  const lookup = {
    db,
    orgId: source.orgId,
    userId: source.userId,
    providerKey: "codex-oauth-token",
    metadata: {
      sourceType: "model-provider" as const,
      sourceId: id,
      sourceUserId: source.userId,
      metadataKey: "codex-oauth-token",
    },
    featureSwitchContext: context,
  };
  // No foreground runId: disconnected accounts retained for live runs are unavailable here.
  const refreshed = await resolveCurrentPersonalSubscriptionBundleForApi(
    { ...lookup, key: "CHATGPT_ACCESS_TOKEN" },
    signal,
  );
  if (refreshed.status !== "available") {
    if (refreshed.reconnectState && !refreshed.reconnectState.needsReconnect) {
      throw new PiMemoryStage1CredentialRefreshError();
    }
    return skip("credential_unavailable");
  }
  // The canonical bundle reads the access token and account ID together after refresh.
  const token = refreshed.values.get("CHATGPT_ACCESS_TOKEN");
  const accountId = refreshed.values.get("CHATGPT_ACCOUNT_ID");
  signal.throwIfAborted();
  if (
    !token?.trim() ||
    !accountId?.trim() ||
    account.externalAccountId !== accountId
  ) {
    return skip("credential_unavailable");
  }
  const endpoint = getModelProviderPiEndpoint(
    "codex-oauth-token",
    "openai-codex-responses",
  );
  if (!endpoint) {
    return skip("provider_model_unsupported");
  }
  return availableCredential(
    args,
    {
      provider: "openai-codex",
      baseUrl: endpoint.baseUrl,
      model: PI_MEMORY_STAGE1_MODEL,
      apiKey: token,
      accountId,
      dialect: "openai-codex-responses",
      transport: "sse",
    },
    "byok",
    async (validationSignal) => {
      const current = await personalModelProviderAccountById(accountArgs);
      validationSignal.throwIfAborted();
      if (
        !current ||
        current.type !== binding.type ||
        current.needsReconnect ||
        current.externalAccountId !== accountId
      ) {
        return false;
      }
      const bundle = await readPersonalSubscriptionCredentialBundle(
        {
          db,
          orgId: source.orgId,
          userId: source.userId,
          type: "codex-oauth-token",
          sourceId: id,
          featureSwitchContext: context,
        },
        validationSignal,
      );
      validationSignal.throwIfAborted();
      return (
        bundle?.account.id === id &&
        !bundle.account.needsReconnect &&
        bundle.values.get("CHATGPT_ACCESS_TOKEN") === token &&
        bundle.values.get("CHATGPT_ACCOUNT_ID") === accountId
      );
    },
  );
}

async function gatewayCredential(
  args: ResolutionContext,
  id: string,
  signal: AbortSignal,
): Promise<PiMemoryStage1CredentialResult> {
  const { db, source, binding, context } = args;
  if (binding.scope !== "org") {
    return skip("source_scope_mismatch");
  }
  const readSurface = async () => {
    const [row] = await db
      .select({
        protocol: modelProviderSurfaces.protocol,
        baseUrl: modelProviderSurfaces.apiBaseUrl,
        header: modelProviderSurfaces.authHeaderName,
        template: modelProviderSurfaces.authHeaderTemplate,
        mappings: modelProviderSurfaces.modelMappings,
        encryptedValue: secrets.encryptedValue,
      })
      .from(modelProviderSurfaces)
      .innerJoin(
        modelProviderConnections,
        eq(modelProviderConnections.id, modelProviderSurfaces.connectionId),
      )
      .innerJoin(secrets, eq(secrets.id, modelProviderConnections.secretId))
      .where(
        and(
          eq(modelProviderSurfaces.id, id),
          eq(modelProviderConnections.orgId, source.orgId),
          eq(secrets.orgId, source.orgId),
          eq(secrets.userId, "__org__"),
        ),
      )
      .limit(1);
    return row;
  };
  const row = await readSurface();
  signal.throwIfAborted();
  if (!row) {
    return skip("credential_unavailable");
  }
  const model = row.mappings[PI_MEMORY_STAGE1_MODEL];
  if (row.protocol !== "openai-responses" || !model?.trim()) {
    return skip("provider_model_unsupported");
  }
  // The surface writer validates/canonicalizes the endpoint and header policy.
  const credential = await decryptStoredSecretValue(
    row.encryptedValue,
    context,
  );
  signal.throwIfAborted();
  if (!credential.trim()) {
    return skip("credential_unavailable");
  }
  return availableCredential(
    args,
    {
      provider: "openai",
      baseUrl: row.baseUrl,
      model,
      catalogModel: PI_MEMORY_STAGE1_MODEL,
      ...resolvePiAgentCredential({
        credential,
        header: { name: row.header, valueTemplate: row.template },
        target: "direct",
      }),
      dialect: "openai-responses",
      transport: "sse",
    },
    "byok",
    async (validationSignal) => {
      const current = await readSurface();
      validationSignal.throwIfAborted();
      return JSON.stringify(current) === JSON.stringify(row);
    },
  );
}

async function apiKeyCredential(
  args: ResolutionContext,
  id: string,
  route: NonNullable<ReturnType<typeof gptApiKeyPiRoute>>,
  signal: AbortSignal,
): Promise<PiMemoryStage1CredentialResult> {
  const { db, source, binding, context } = args;
  const type = route.productProviderType;
  if (!isModelSupportedByProvider(PI_MEMORY_STAGE1_MODEL, type)) {
    return skip("provider_model_unsupported");
  }
  const secretOwner = binding.scope === "org" ? "__org__" : source.userId;
  const secretName = getSecretNameForType(type);
  const endpoint = route.endpoint;
  if (!secretName || !endpoint) {
    return skip("provider_model_unsupported");
  }
  const readKey = async () => {
    const [row] = await db
      .select({ encryptedValue: secrets.encryptedValue })
      .from(modelProviders)
      .innerJoin(secrets, eq(secrets.id, modelProviders.secretId))
      .where(
        and(
          eq(modelProviders.id, id),
          eq(modelProviders.orgId, source.orgId),
          eq(modelProviders.userId, secretOwner),
          eq(modelProviders.type, type),
          eq(secrets.orgId, source.orgId),
          eq(secrets.userId, secretOwner),
          eq(secrets.name, secretName),
          eq(secrets.type, "model-provider"),
        ),
      )
      .limit(1);
    return row?.encryptedValue;
  };
  const encrypted = await readKey();
  signal.throwIfAborted();
  if (!encrypted) {
    return skip("credential_unavailable");
  }
  const apiKey = await decryptStoredSecretValue(encrypted, context);
  signal.throwIfAborted();
  if (!apiKey.trim()) {
    return skip("credential_unavailable");
  }
  return availableCredential(
    args,
    {
      provider: route.provider,
      baseUrl: endpoint.baseUrl,
      model: getProviderRuntimeModel(type, PI_MEMORY_STAGE1_MODEL),
      ...(type === "vercel-ai-gateway-codex"
        ? { catalogModel: PI_MEMORY_STAGE1_MODEL }
        : {}),
      apiKey,
      dialect: "openai-responses",
      transport: "sse",
    },
    "byok",
    async (validationSignal) => {
      const current = await readKey();
      validationSignal.throwIfAborted();
      return current === encrypted;
    },
  );
}

/** Source identity is authority; defaults and foreground settings never participate. */
export async function resolvePiMemoryStage1Credential(
  db: Db,
  source: SourceIdentity,
  signal: AbortSignal,
): Promise<PiMemoryStage1CredentialResult> {
  const binding = await sourceBinding(db, source);
  signal.throwIfAborted();
  if (!binding) {
    return skip("source_missing");
  }
  if (binding.orgId !== source.orgId || binding.userId !== source.userId) {
    return skip("source_owner_mismatch");
  }
  if (!binding.type) {
    return skip("source_binding_invalid");
  }
  const context = await loadUserFeatureSwitchContext(
    db,
    source.orgId,
    source.userId,
  );
  signal.throwIfAborted();
  const args = { db, source, binding, context };
  if (binding.type === "built-in") {
    return await builtinCredential(args, signal);
  }
  if (!binding.id) {
    return skip("source_binding_invalid");
  }
  if (binding.scope !== "member" && binding.scope !== "org") {
    return skip("source_scope_mismatch");
  }
  const apiKeyRoute = gptApiKeyPiRoute(binding.type);
  if (apiKeyRoute) {
    return await apiKeyCredential(args, binding.id, apiKeyRoute, signal);
  }
  switch (binding.type) {
    case "codex-oauth-token": {
      return await codexCredential(args, binding.id, signal);
    }
    case "custom-openai-responses": {
      return await gatewayCredential(args, binding.id, signal);
    }
    default: {
      return skip("provider_model_unsupported");
    }
  }
}
