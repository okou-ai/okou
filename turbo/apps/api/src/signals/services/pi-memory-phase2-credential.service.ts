import type { PiMemoryQuotaSource } from "./pi-memory-quota.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import { isModelSupportedByProvider } from "@okouai/api-contracts/contracts/model-providers";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { secrets } from "@okouai/db/schema/secret";
import { storages } from "@okouai/db/schema/storage";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import type { AgentRunModelPin } from "./agent-run-create.service";
import { resolveCurrentPersonalSubscriptionBundleForApi } from "./agent-webhook-firewall-auth.service";
import { lockModelProviderState } from "./auth-state-lock.service";
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";
import {
  piMemoryPhase2Model,
  PI_MEMORY_PHASE2_BUILT_IN_MODEL,
  PI_MEMORY_PHASE2_BYOK_MODEL,
} from "./pi-memory-phase2-usage.service";
import { gptApiKeyPiRoute } from "./pi-sandbox-config";

type ReadDb = Pick<Db, "select">;

type CredentialFailure =
  | "source_credentials_missing"
  | "credential_unavailable"
  | "provider_model_unsupported"
  | "model_route_unavailable"
  | "pi_memory_disabled"
  | "storage_binding_changed";

export class PiMemoryPhase2CredentialError extends Error {
  constructor(readonly errorClass: CredentialFailure) {
    super("Pi memory Phase 2 credential admission failed");
    this.name = "PiMemoryPhase2CredentialError";
  }
}

function reject(reason: CredentialFailure): never {
  throw new PiMemoryPhase2CredentialError(reason);
}

interface CurrentCredential {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
  readonly id: string | null;
  readonly scope: "org" | "member";
}

function credentialPin(source: CurrentCredential) {
  return {
    modelProvider: source.type,
    modelProviderId: source.id,
    modelProviderCredentialScope: source.scope,
    selectedModel: piMemoryPhase2Model(source.type),
  } satisfies AgentRunModelPin;
}

/** Historical run credentials are provenance only. Choose one current route
 * for the owner of the whole, already locked candidate selection. */
async function selectCurrentCredential(
  db: ReadDb,
  claim: ClaimedPiMemoryPhase2Job,
): Promise<CurrentCredential> {
  // Honor the current default first; use a stable type/ID order for other
  // compatible BYOK routes. No historical source decides this ranking.
  const providers = await db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      userId: modelProviders.userId,
      isDefault: modelProviders.isDefault,
      secretId: modelProviders.secretId,
      needsReconnect: modelProviders.needsReconnect,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, claim.orgId),
        inArray(modelProviders.userId, [claim.userId, "__org__"]),
      ),
    )
    .orderBy(
      desc(modelProviders.isDefault),
      asc(modelProviders.type),
      asc(modelProviders.id),
    );
  for (const provider of providers) {
    if (provider.type === "codex-oauth-token") {
      if (provider.userId !== claim.userId || provider.needsReconnect) {
        continue;
      }
      const [account] = await db
        .select({ id: modelProviderAccounts.id })
        .from(modelProviderAccounts)
        .where(
          and(
            eq(modelProviderAccounts.modelProviderId, provider.id),
            eq(modelProviderAccounts.orgId, claim.orgId),
            eq(modelProviderAccounts.userId, claim.userId),
            eq(modelProviderAccounts.type, provider.type),
            eq(modelProviderAccounts.isActive, true),
            eq(modelProviderAccounts.needsReconnect, false),
            isNotNull(modelProviderAccounts.externalAccountId),
            isNull(modelProviderAccounts.disconnectedAt),
          ),
        )
        .limit(1);
      if (account) {
        return {
          orgId: claim.orgId,
          userId: claim.userId,
          type: provider.type,
          id: account.id,
          scope: "member",
        };
      }
      continue;
    }
    const route = gptApiKeyPiRoute(provider.type);
    if (
      !provider.secretId ||
      !route?.endpoint ||
      !isModelSupportedByProvider(
        PI_MEMORY_PHASE2_BYOK_MODEL,
        route.productProviderType,
      )
    ) {
      continue;
    }
    return {
      orgId: claim.orgId,
      userId: claim.userId,
      type: provider.type,
      id: provider.id,
      scope: provider.userId === "__org__" ? "org" : "member",
    };
  }
  const surfaces = await db
    .select({
      id: modelProviderSurfaces.id,
      protocol: modelProviderSurfaces.protocol,
      mappings: modelProviderSurfaces.modelMappings,
    })
    .from(modelProviderSurfaces)
    .innerJoin(
      modelProviderConnections,
      eq(modelProviderConnections.id, modelProviderSurfaces.connectionId),
    )
    .where(eq(modelProviderConnections.orgId, claim.orgId))
    .orderBy(asc(modelProviderSurfaces.id));
  const surface = surfaces.find((item) => {
    return (
      item.protocol === "openai-responses" &&
      item.mappings[PI_MEMORY_PHASE2_BYOK_MODEL]?.trim()
    );
  });
  if (surface) {
    return {
      orgId: claim.orgId,
      userId: claim.userId,
      type: "custom-openai-responses",
      id: surface.id,
      scope: "org",
    };
  }
  return {
    orgId: claim.orgId,
    userId: claim.userId,
    type: "built-in",
    id: null,
    scope: "org",
  };
}

async function customCredentialSnapshot(
  db: ReadDb,
  source: CurrentCredential & { readonly id: string },
) {
  // Settings mutate connection -> secret -> surface. Resolve the reference
  // without a lock first, then lock and verify every edge in that same order.
  const [reference] = await db
    .select({ connectionId: modelProviderSurfaces.connectionId })
    .from(modelProviderSurfaces)
    .where(eq(modelProviderSurfaces.id, source.id));
  if (!reference) {
    reject("credential_unavailable");
  }
  const [connection] = await db
    .select({
      id: modelProviderConnections.id,
      secretId: modelProviderConnections.secretId,
    })
    .from(modelProviderConnections)
    .where(
      and(
        eq(modelProviderConnections.id, reference.connectionId),
        eq(modelProviderConnections.orgId, source.orgId),
      ),
    )
    .for("share");
  if (!connection) {
    reject("credential_unavailable");
  }
  const [secret] = await db
    .select({ id: secrets.id, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.id, connection.secretId),
        eq(secrets.orgId, source.orgId),
        eq(secrets.userId, "__org__"),
      ),
    )
    .for("share");
  const [surface] = await db
    .select({
      id: modelProviderSurfaces.id,
      protocol: modelProviderSurfaces.protocol,
      baseUrl: modelProviderSurfaces.apiBaseUrl,
      header: modelProviderSurfaces.authHeaderName,
      template: modelProviderSurfaces.authHeaderTemplate,
      mappings: modelProviderSurfaces.modelMappings,
    })
    .from(modelProviderSurfaces)
    .where(
      and(
        eq(modelProviderSurfaces.id, source.id),
        eq(modelProviderSurfaces.connectionId, connection.id),
      ),
    )
    .for("share");
  if (!secret?.encryptedValue || !surface) {
    reject("credential_unavailable");
  }
  if (
    surface.protocol !== "openai-responses" ||
    !surface.mappings[PI_MEMORY_PHASE2_BYOK_MODEL]?.trim()
  ) {
    reject("provider_model_unsupported");
  }
  return {
    ...surface,
    connectionId: connection.id,
    secretId: secret.id,
    encryptedValue: secret.encryptedValue,
  };
}

/** Capture ownership and route references only. Canonical launch preparation
 * owns decryption, firewall credentials and atomic subscription refresh. */
async function credentialSnapshot(db: ReadDb, source: CurrentCredential) {
  if (source.type === "built-in") {
    return "built-in";
  }
  if (!source.id) {
    reject("credential_unavailable");
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
          eq(modelProviderAccounts.isActive, true),
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
    return await customCredentialSnapshot(db, { ...source, id: source.id });
  }
  const route = gptApiKeyPiRoute(source.type);
  if (
    !route?.endpoint ||
    !isModelSupportedByProvider(
      PI_MEMORY_PHASE2_BYOK_MODEL,
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

async function readQuotaPairSnapshot(db: ReadDb, sourceId: string) {
  return await db
    .select({
      id: modelProviderAccountSecrets.id,
      name: modelProviderAccountSecrets.name,
      encryptedValue: modelProviderAccountSecrets.encryptedValue,
    })
    .from(modelProviderAccountSecrets)
    .where(
      and(
        eq(modelProviderAccountSecrets.modelProviderAccountId, sourceId),
        inArray(modelProviderAccountSecrets.name, [
          "CHATGPT_ACCESS_TOKEN",
          "CHATGPT_ACCOUNT_ID",
        ]),
      ),
    )
    .orderBy(asc(modelProviderAccountSecrets.id))
    .for("share");
}

async function prepareSubscription(
  db: Db,
  source: CurrentCredential,
  externalAccountId: string,
  signal: AbortSignal,
) {
  if (!source.id) {
    reject("credential_unavailable");
  }
  const sourceId = source.id;
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
  if (bundle.status !== "available") {
    reject("credential_unavailable");
  }
  const accessToken = bundle.values.get("CHATGPT_ACCESS_TOKEN");
  if (
    !accessToken?.trim() ||
    bundle.values.get("CHATGPT_ACCOUNT_ID") !== externalAccountId
  ) {
    reject("credential_unavailable");
  }

  // Prove the bounded encrypted pair outside final admission: decryption calls
  // KMS. Canonical preparation above remains the only refresh/resolution owner.
  const snapshot = await readQuotaPairSnapshot(db, sourceId);
  signal.throwIfAborted();
  for (const [name, expected] of [
    ["CHATGPT_ACCESS_TOKEN", accessToken],
    ["CHATGPT_ACCOUNT_ID", externalAccountId],
  ] as const) {
    const row = snapshot.find((item) => {
      return item.name === name;
    });
    if (
      !row ||
      (await decryptStoredSecretValue(
        row.encryptedValue,
        featureSwitchContext,
      )) !== expected
    ) {
      reject("credential_unavailable");
    }
    signal.throwIfAborted();
  }
  const proof = JSON.stringify(snapshot);

  return {
    quota: {
      providerClass: "codex",
      accessToken,
      accountId: externalAccountId,
    } satisfies PiMemoryQuotaSource,
    validate: async (tx: Tx) => {
      // Final admission is database-only. Any later row/ciphertext change,
      // including equivalent re-encryption, requires a fresh admission proof.
      const current = await readQuotaPairSnapshot(tx, sourceId);
      signal.throwIfAborted();
      if (JSON.stringify(current) !== proof) {
        reject("credential_unavailable");
      }
    },
  };
}

/** Whole selections rebuild one evidence subtree. Historical source run IDs
 * stay in the digest/evidence, but never choose the current payer or route. */
export async function resolvePiMemoryPhase2Credential(
  db: Db,
  claim: ClaimedPiMemoryPhase2Job,
  signal: AbortSignal,
) {
  if (claim.selected.length === 0) {
    reject("source_credentials_missing");
  }
  const selected = await selectCurrentCredential(db, claim);
  signal.throwIfAborted();
  const pin = credentialPin(selected);
  const captured = await credentialSnapshot(db, selected);
  signal.throwIfAborted();
  const subscription =
    typeof captured === "object" && "externalAccountId" in captured
      ? await prepareSubscription(
          db,
          selected,
          captured.externalAccountId,
          signal,
        )
      : undefined;
  const quota: PiMemoryQuotaSource = subscription?.quota ?? {
    providerClass: pin.modelProvider === "built-in" ? "builtin" : "api_key",
  };
  let route:
    | Awaited<ReturnType<typeof resolveBuiltInModelRuntimeRoute>>
    | undefined;
  if (pin.modelProvider === "built-in") {
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      claim.orgId,
      claim.userId,
    );
    signal.throwIfAborted();
    route = await resolveBuiltInModelRuntimeRoute(
      db,
      PI_MEMORY_PHASE2_BUILT_IN_MODEL,
      featureSwitchContext,
    );
  }
  signal.throwIfAborted();
  if (route === null) {
    reject("model_route_unavailable");
  }
  return {
    pin,
    route,
    quota,
    validate: async (tx: Tx) => {
      signal.throwIfAborted();
      // Candidate ownership and the entire selection are locked by the claim;
      // old source runs may have expired before this maintenance attempt.
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
      if (selected.type === "codex-oauth-token") {
        await lockModelProviderState(tx, {
          orgId: selected.orgId,
          userId: selected.userId,
          type: selected.type,
        });
      }
      if (
        JSON.stringify(await credentialSnapshot(tx, selected)) !==
        JSON.stringify(captured)
      ) {
        reject("credential_unavailable");
      }
      await subscription?.validate(tx);
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
