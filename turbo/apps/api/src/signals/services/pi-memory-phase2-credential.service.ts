import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
modelProviderAccounts,
modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { storages } from "@okouai/db/schema/storage";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { and,asc,desc,eq,inArray,isNotNull,isNull } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import type { AgentRunModelPin } from "./agent-run-contracts";
import { resolveCurrentPersonalSubscriptionBundleForApi } from "./agent-webhook-firewall-auth.service";
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import {
featureSwitchContextFromRows,
userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import type {
ModelCatalog,
} from "./model-catalog.service";
import type { PiMemoryQuotaSource } from "./pi-memory-quota.service";

import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";
import {
PI_MEMORY_PHASE2_BUILT_IN_MODEL,
piMemoryPhase2Model,
} from "./pi-memory-phase2-usage.service";
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
  _catalogSnapshot: ModelCatalog,
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
        eq(modelProviders.userId, claim.userId),
        eq(modelProviders.type, "codex-oauth-token"),
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
  }
  return {
    orgId: claim.orgId,
    userId: claim.userId,
    type: "built-in",
    id: null,
    scope: "org",
  };
}

/** Capture ownership and route references only. Canonical launch preparation
 * owns decryption, firewall credentials and atomic subscription refresh. */
async function credentialSnapshot(
  _catalogSnapshot: ModelCatalog,
  db: ReadDb,
  source: CurrentCredential,
) {
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
      );
    const externalAccountId = account?.externalAccountId;
    if (!account || !externalAccountId) {
      reject("credential_unavailable");
    }
    // Never pass sourceRunId to retained-account lookup. A new attempt requires
    // a connected account; committed runs keep their own canonical lifecycle.
    return { ...account, externalAccountId };
  }
  reject("provider_model_unsupported");
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
  const featureSwitchContextRows0 = await db
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(userFeatureSwitchRowCondition(source.orgId, source.userId));
  const featureSwitchContext = featureSwitchContextFromRows(
    source.orgId,
    source.userId,
    featureSwitchContextRows0,
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
  catalogSnapshot: ModelCatalog,
  db: Db,
  claim: ClaimedPiMemoryPhase2Job,
  signal: AbortSignal,
) {
  if (claim.selected.length === 0) {
    reject("source_credentials_missing");
  }
  const selected = await selectCurrentCredential(catalogSnapshot, db, claim);
  signal.throwIfAborted();
  const pin = credentialPin(selected);
  const captured = await credentialSnapshot(catalogSnapshot, db, selected);
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
    providerClass: "builtin",
  };
  const route =
    pin.modelProvider === "built-in"
      ? await resolveBuiltInModelRuntimeRoute(
          catalogSnapshot,
          db,
          PI_MEMORY_PHASE2_BUILT_IN_MODEL,
        )
      : undefined;
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
      if (
        JSON.stringify(
          await credentialSnapshot(catalogSnapshot, tx, selected),
        ) !== JSON.stringify(captured)
      ) {
        reject("credential_unavailable");
      }
      await subscription?.validate(tx);
      const featureSwitchContextRows2 = await tx
        .select({
          userId: userFeatureSwitches.userId,
          switches: userFeatureSwitches.switches,
        })
        .from(userFeatureSwitches)
        .where(userFeatureSwitchRowCondition(claim.orgId, claim.userId));
      const context = featureSwitchContextFromRows(
        claim.orgId,
        claim.userId,
        featureSwitchContextRows2,
      );
      signal.throwIfAborted();
      if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
        reject("pi_memory_disabled");
      }
    },
  };
}
