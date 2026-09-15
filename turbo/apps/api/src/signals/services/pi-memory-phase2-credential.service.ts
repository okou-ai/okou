import { isModelSupportedByProvider } from "@okouai/api-contracts/contracts/model-providers";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { secrets } from "@okouai/db/schema/secret";
import { storages } from "@okouai/db/schema/storage";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import type { AgentRunModelPin } from "./agent-run-create.service";
import { resolveCurrentPersonalSubscriptionBundleForApi } from "./agent-webhook-firewall-auth.service";
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";
import { PI_MEMORY_PHASE2_MODEL } from "./pi-memory-phase2-usage.service";
import { gptApiKeyPiRoute } from "./pi-sandbox-config";

type ReadDb = Pick<Db, "select">;

type CredentialFailure =
  | "source_credentials_missing"
  | "mixed_source_credentials"
  | "source_missing"
  | "source_owner_mismatch"
  | "source_binding_invalid"
  | "source_scope_mismatch"
  | "credential_unavailable"
  | "provider_model_unsupported"
  | "model_route_unavailable"
  | "pi_memory_disabled"
  | "storage_binding_changed";

export class PiMemoryPhase2CredentialError extends Error {
  constructor(readonly errorClass: CredentialFailure) {
    super("Pi memory Phase 2 source credential admission failed");
    this.name = "PiMemoryPhase2CredentialError";
  }
}

function reject(reason: CredentialFailure): never {
  throw new PiMemoryPhase2CredentialError(reason);
}

function readSources(db: ReadDb, ids: readonly string[]) {
  return db
    .select({
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      type: agentRuns.modelProvider,
      id: agentRuns.modelProviderId,
      scope: agentRuns.modelProviderCredentialScope,
    })
    .from(agentRuns)
    .where(inArray(agentRuns.id, [...ids]))
    .orderBy(asc(agentRuns.id))
    .for("share");
}

type Source = Awaited<ReturnType<typeof readSources>>[number];

function sourcePin(source: Source, claim: ClaimedPiMemoryPhase2Job) {
  if (source.orgId !== claim.orgId || source.userId !== claim.userId) {
    reject("source_owner_mismatch");
  }
  if (!source.type) {
    reject("source_binding_invalid");
  }
  if (source.type === "built-in") {
    if (
      source.id !== null ||
      (source.scope !== null && source.scope !== "org")
    ) {
      reject("source_binding_invalid");
    }
  } else {
    if (!source.id) {
      reject("source_binding_invalid");
    }
    if (source.scope !== "org" && source.scope !== "member") {
      reject("source_scope_mismatch");
    }
    if (
      (source.type === "codex-oauth-token" && source.scope !== "member") ||
      (source.type === "custom-openai-responses" && source.scope !== "org")
    ) {
      reject("source_scope_mismatch");
    }
  }
  return {
    modelProvider: source.type,
    modelProviderId: source.id,
    modelProviderCredentialScope: source.scope ?? "org",
    selectedModel: PI_MEMORY_PHASE2_MODEL,
  } satisfies AgentRunModelPin;
}

/** Capture ownership and route references only. Canonical launch preparation
 * owns decryption, firewall credentials and atomic subscription refresh. */
async function credentialSnapshot(db: ReadDb, source: Source) {
  if (!source.type) {
    reject("source_binding_invalid");
  }
  if (source.type === "built-in") {
    return "built-in";
  }
  if (!source.id) {
    reject("source_binding_invalid");
  }
  if (source.type === "codex-oauth-token") {
    const [account] = await db
      .select({
        id: modelProviderAccounts.id,
        providerId: modelProviderAccounts.modelProviderId,
        externalAccountId: modelProviderAccounts.externalAccountId,
        authMethod: modelProviderAccounts.authMethod,
      })
      .from(modelProviderAccounts)
      .where(
        and(
          eq(modelProviderAccounts.id, source.id),
          eq(modelProviderAccounts.orgId, source.orgId),
          eq(modelProviderAccounts.userId, source.userId),
          eq(modelProviderAccounts.type, source.type),
          eq(modelProviderAccounts.needsReconnect, false),
          isNull(modelProviderAccounts.disconnectedAt),
        ),
      )
      .for("share");
    const externalAccountId = account?.externalAccountId;
    if (!account || !externalAccountId) {
      reject("credential_unavailable");
    }
    // Never pass sourceRunId to retained-account lookup. A new attempt requires
    // a connected account; committed runs keep their own canonical lifecycle.
    return { ...account, externalAccountId };
  }
  if (source.type === "custom-openai-responses") {
    const [surface] = await db
      .select({
        id: modelProviderSurfaces.id,
        connectionId: modelProviderConnections.id,
        secretId: secrets.id,
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
          eq(modelProviderSurfaces.id, source.id),
          eq(modelProviderConnections.orgId, source.orgId),
          eq(secrets.orgId, source.orgId),
          eq(secrets.userId, "__org__"),
        ),
      )
      .for("share");
    if (!surface) {
      reject("credential_unavailable");
    }
    if (
      surface.protocol !== "openai-responses" ||
      !surface.mappings[PI_MEMORY_PHASE2_MODEL]?.trim()
    ) {
      reject("provider_model_unsupported");
    }
    return surface;
  }
  const route = gptApiKeyPiRoute(source.type);
  if (
    !route?.endpoint ||
    !isModelSupportedByProvider(
      PI_MEMORY_PHASE2_MODEL,
      route.productProviderType,
    )
  ) {
    reject("provider_model_unsupported");
  }
  const owner = source.scope === "org" ? "__org__" : source.userId;
  const [key] = await db
    .select({
      id: modelProviders.id,
      secretId: secrets.id,
      encryptedValue: secrets.encryptedValue,
    })
    .from(modelProviders)
    .innerJoin(secrets, eq(secrets.id, modelProviders.secretId))
    .where(
      and(
        eq(modelProviders.id, source.id),
        eq(modelProviders.orgId, source.orgId),
        eq(modelProviders.userId, owner),
        eq(modelProviders.type, source.type),
        eq(secrets.orgId, source.orgId),
        eq(secrets.userId, owner),
        eq(secrets.name, route.credentialSecretName),
        eq(secrets.type, "model-provider"),
      ),
    )
    .for("share");
  if (!key?.encryptedValue) {
    reject("credential_unavailable");
  }
  return key;
}

async function prepareSubscription(
  db: Db,
  source: Source,
  externalAccountId: string,
  signal: AbortSignal,
) {
  if (!source.id) {
    reject("source_binding_invalid");
  }
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    source.orgId,
    source.userId,
  );
  signal.throwIfAborted();
  // Refresh/read the canonical token/account bundle without any retained run
  // authority. New attempts must prove this exact account is still connected.
  const bundle = await resolveCurrentPersonalSubscriptionBundleForApi(
    {
      db,
      orgId: source.orgId,
      userId: source.userId,
      providerKey: "codex-oauth-token",
      key: "CHATGPT_ACCESS_TOKEN",
      metadata: {
        sourceType: "model-provider",
        sourceId: source.id,
        sourceUserId: source.userId,
        metadataKey: "codex-oauth-token",
      },
      featureSwitchContext,
    },
    signal,
  );
  signal.throwIfAborted();
  if (
    bundle.status !== "available" ||
    !bundle.values.get("CHATGPT_ACCESS_TOKEN")?.trim() ||
    bundle.values.get("CHATGPT_ACCOUNT_ID") !== externalAccountId
  ) {
    reject("credential_unavailable");
  }
}

/** Whole selections rebuild one evidence subtree: splitting or filtering them
 * would delete other contributors. Empty/mixed selections must not dispatch. */
export async function resolvePiMemoryPhase2Credential(
  db: Db,
  claim: ClaimedPiMemoryPhase2Job,
  signal: AbortSignal,
) {
  if (claim.selected.length === 0) {
    reject("source_credentials_missing");
  }
  const ids = [
    ...new Set(
      claim.selected.map((entry) => {
        return entry.sourceRunId;
      }),
    ),
  ];
  const sources = await readSources(db, ids);
  signal.throwIfAborted();
  if (sources.length !== ids.length) {
    reject("source_missing");
  }
  const first = sources[0];
  if (!first) {
    reject("source_credentials_missing");
  }
  const pin = sourcePin(first, claim);
  for (const source of sources) {
    if (JSON.stringify(sourcePin(source, claim)) !== JSON.stringify(pin)) {
      reject("mixed_source_credentials");
    }
  }
  const captured = await credentialSnapshot(db, first);
  signal.throwIfAborted();
  if (typeof captured === "object" && "externalAccountId" in captured) {
    await prepareSubscription(db, first, captured.externalAccountId, signal);
  }
  const route =
    pin.modelProvider === "built-in"
      ? await resolveBuiltInModelRuntimeRoute(db, PI_MEMORY_PHASE2_MODEL)
      : undefined;
  signal.throwIfAborted();
  if (route === null) {
    reject("model_route_unavailable");
  }
  return {
    pin,
    route,
    validate: async (tx: Tx) => {
      signal.throwIfAborted();
      const [storage] = await tx
        .select({ id: storages.id })
        .from(storages)
        .where(
          and(
            eq(storages.id, claim.memoryStorageId),
            eq(storages.orgId, claim.orgId),
            eq(storages.userId, claim.userId),
            eq(storages.headVersionId, claim.baseVersion.versionId),
          ),
        )
        .for("share");
      if (!storage) {
        reject("storage_binding_changed");
      }
      const current = await readSources(tx, ids);
      if (JSON.stringify(current) !== JSON.stringify(sources)) {
        reject("source_binding_invalid");
      }
      if (
        JSON.stringify(await credentialSnapshot(tx, first)) !==
        JSON.stringify(captured)
      ) {
        reject("credential_unavailable");
      }
      const context = await loadUserFeatureSwitchContext(
        tx,
        claim.orgId,
        claim.userId,
      );
      signal.throwIfAborted();
      if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
        reject("pi_memory_disabled");
      }
    },
  };
}
