import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { storages } from "@okouai/db/schema/storage";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db$ } from "../external/db";
import { command } from "ccstate";
import type { AgentRunModelPin } from "./agent-run-contracts";
import { resolveCurrentPersonalSubscriptionBundleForApi$ } from "./agent-webhook-firewall-auth.service";
import { resolvePiMemoryBuiltinRoute$ } from "./pi-memory-builtin-config";
import {
  selectPiMemoryCurrentCredential$,
  type PiMemoryCurrentCredential,
} from "./pi-memory-current-credential.service";
import { decryptStoredSecretValue } from "./crypto.utils";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import type { ModelCatalog } from "./model-catalog.service";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { PiMemoryQuotaSource } from "./pi-memory-quota.service";

import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";
import { piMemoryPhase2Model } from "./pi-memory-phase2-usage.service";

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

function credentialPin(source: PiMemoryCurrentCredential) {
  return {
    modelProvider: source.type,
    modelProviderId: source.id,
    modelProviderCredentialScope: source.scope,
    selectedModel: piMemoryPhase2Model(source.type),
  } satisfies AgentRunModelPin;
}

type CredentialAccountSnapshot = Pick<
  typeof modelProviderAccounts.$inferSelect,
  "id" | "externalAccountId" | "authMethod"
> & {
  readonly providerId: string;
};

/** Validate ordinary account rows without retaining a database capability. */
export function requirePiMemoryPhase2CredentialAccountSnapshot(
  source: PiMemoryCurrentCredential,
  account: CredentialAccountSnapshot | undefined,
) {
  if (source.type === "built-in") {
    return "built-in";
  }
  if (!source.id) {
    reject("credential_unavailable");
  }
  if (source.type !== "codex-oauth-token") {
    reject("provider_model_unsupported");
  }
  const externalAccountId = account?.externalAccountId;
  if (!account || !externalAccountId) {
    reject("credential_unavailable");
  }
  return { ...account, externalAccountId };
}

export interface PiMemoryPhase2CredentialProof {
  readonly source: PiMemoryCurrentCredential;
  readonly storage: {
    readonly memoryStorageId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly baseVersionId: string;
  };
  readonly captured: ReturnType<
    typeof requirePiMemoryPhase2CredentialAccountSnapshot
  >;
  readonly quotaPair:
    | {
        readonly sourceId: string;
        readonly snapshot: readonly Pick<
          typeof modelProviderAccountSecrets.$inferSelect,
          "id" | "name" | "encryptedValue"
        >[];
      }
    | undefined;
}

function piMemoryPhase2CredentialStorageRead(
  proof: PiMemoryPhase2CredentialProof,
) {
  return {
    fields: { id: storages.id },
    where: and(
      eq(storages.id, proof.storage.memoryStorageId),
      eq(storages.orgId, proof.storage.orgId),
      eq(storages.userId, proof.storage.userId),
      eq(storages.headVersionId, proof.storage.baseVersionId),
    ),
  };
}

export function requirePiMemoryPhase2CredentialStorage(
  storage: { readonly id: string } | undefined,
) {
  if (!storage) {
    reject("storage_binding_changed");
  }
}

function piMemoryPhase2CredentialAccountRead(
  source: PiMemoryCurrentCredential,
) {
  if (source.type === "built-in") {
    return null;
  }
  if (!source.id || source.type !== "codex-oauth-token") {
    return null;
  }
  return {
    fields: {
      id: modelProviderAccounts.id,
      providerId: modelProviderAccounts.modelProviderId,
      externalAccountId: modelProviderAccounts.externalAccountId,
      authMethod: modelProviderAccounts.authMethod,
    },
    where: and(
      eq(modelProviderAccounts.id, source.id),
      eq(modelProviderAccounts.orgId, source.orgId),
      eq(modelProviderAccounts.userId, source.userId),
      eq(modelProviderAccounts.type, source.type),
      eq(modelProviderAccounts.isActive, true),
      eq(modelProviderAccounts.needsReconnect, false),
      isNull(modelProviderAccounts.disconnectedAt),
    ),
  };
}

export function requirePiMemoryPhase2CredentialAccount(
  proof: PiMemoryPhase2CredentialProof,
  account: CredentialAccountSnapshot | undefined,
) {
  const current = requirePiMemoryPhase2CredentialAccountSnapshot(
    proof.source,
    account,
  );
  if (JSON.stringify(current) !== JSON.stringify(proof.captured)) {
    reject("credential_unavailable");
  }
}

function piMemoryPhase2CredentialQuotaPairRead(sourceId: string) {
  return {
    fields: {
      id: modelProviderAccountSecrets.id,
      name: modelProviderAccountSecrets.name,
      encryptedValue: modelProviderAccountSecrets.encryptedValue,
    },
    where: and(
      eq(modelProviderAccountSecrets.modelProviderAccountId, sourceId),
      inArray(modelProviderAccountSecrets.name, [
        "CHATGPT_ACCESS_TOKEN",
        "CHATGPT_ACCOUNT_ID",
      ]),
    ),
    orderBy: asc(modelProviderAccountSecrets.id),
  };
}

export function requirePiMemoryPhase2CredentialQuotaPair(
  captured: NonNullable<PiMemoryPhase2CredentialProof["quotaPair"]>["snapshot"],
  current: NonNullable<PiMemoryPhase2CredentialProof["quotaPair"]>["snapshot"],
) {
  // Equivalent re-encryption still requires a fresh admission proof.
  if (JSON.stringify(current) !== JSON.stringify(captured)) {
    reject("credential_unavailable");
  }
}

/** Ordinary SQL plans for the exact final admission read sequence. */
export function piMemoryPhase2CredentialValidationPlan(
  proof: PiMemoryPhase2CredentialProof,
) {
  return {
    storage: piMemoryPhase2CredentialStorageRead(proof),
    account: piMemoryPhase2CredentialAccountRead(proof.source),
    pair: proof.quotaPair
      ? piMemoryPhase2CredentialQuotaPairRead(proof.quotaPair.sourceId)
      : null,
    features: {
      fields: {
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      },
      where: userFeatureSwitchRowCondition(
        proof.storage.orgId,
        proof.storage.userId,
      ),
    },
  };
}

export function piMemoryPhase2FeatureContext(
  proof: PiMemoryPhase2CredentialProof,
  rows: readonly Pick<
    typeof userFeatureSwitches.$inferSelect,
    "userId" | "switches"
  >[],
) {
  return featureSwitchContextFromRows(
    proof.storage.orgId,
    proof.storage.userId,
    rows,
  );
}

export function requirePiMemoryPhase2FeatureEnabled(
  context: FeatureSwitchContext,
) {
  if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
    reject("pi_memory_disabled");
  }
}

/** Finite account read before the caller's original cancellation checkpoint. */
const credentialSnapshot$ = command(
  async ({ get }, source: PiMemoryCurrentCredential) => {
    const read = piMemoryPhase2CredentialAccountRead(source);
    const [account] = read
      ? await get(db$)
          .select(read.fields)
          .from(modelProviderAccounts)
          .where(read.where)
      : [];
    return requirePiMemoryPhase2CredentialAccountSnapshot(source, account);
  },
);

const readQuotaPairSnapshot$ = command(async ({ get }, sourceId: string) => {
  const read = piMemoryPhase2CredentialQuotaPairRead(sourceId);
  return await get(db$)
    .select(read.fields)
    .from(modelProviderAccountSecrets)
    .where(read.where)
    .orderBy(read.orderBy)
    .for("share");
});

/** Finish row decoding before the existing caller cancellation gate. */
const readSubscriptionFeatureContext$ = command(
  async ({ get }, source: PiMemoryCurrentCredential) => {
    const rows = await get(db$)
      .select({
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      })
      .from(userFeatureSwitches)
      .where(userFeatureSwitchRowCondition(source.orgId, source.userId));
    return featureSwitchContextFromRows(source.orgId, source.userId, rows);
  },
);

const prepareSubscription$ = command(
  async (
    { set },
    source: PiMemoryCurrentCredential,
    externalAccountId: string,
    signal: AbortSignal,
  ) => {
    if (!source.id) {
      reject("credential_unavailable");
    }
    const sourceId = source.id;
    const featureSwitchContext = await set(
      readSubscriptionFeatureContext$,
      source,
    );
    signal.throwIfAborted();
    // Refresh/read the canonical token/account bundle without any retained run
    // authority. New attempts must prove this exact account is still connected.
    const bundle = await set(
      resolveCurrentPersonalSubscriptionBundleForApi$,
      {
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
    const snapshot = await set(readQuotaPairSnapshot$, sourceId);
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
    return {
      quota: {
        providerClass: "codex",
        accessToken,
        accountId: externalAccountId,
      } satisfies PiMemoryQuotaSource,
      quotaPair: { sourceId, snapshot },
    };
  },
);

/** Whole selections rebuild one evidence subtree. Historical source run IDs
 * stay in the digest/evidence, but never choose the current payer or route. */
export const resolvePiMemoryPhase2Credential$ = command(
  async (
    { set },
    _catalogSnapshot: ModelCatalog,
    claim: ClaimedPiMemoryPhase2Job,
    signal: AbortSignal,
  ) => {
    if (claim.selected.length === 0) {
      reject("source_credentials_missing");
    }
    const selected = await set(selectPiMemoryCurrentCredential$, claim);
    signal.throwIfAborted();
    const pin = credentialPin(selected);
    const captured = await set(credentialSnapshot$, selected);
    signal.throwIfAborted();
    const subscription =
      typeof captured === "object" && "externalAccountId" in captured
        ? await set(
            prepareSubscription$,
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
        ? await set(resolvePiMemoryBuiltinRoute$, signal)
        : undefined;
    signal.throwIfAborted();
    if (route === null) {
      reject("model_route_unavailable");
    }
    return {
      pin,
      route,
      quota,
      proof: {
        source: selected,
        storage: {
          memoryStorageId: claim.memoryStorageId,
          orgId: claim.orgId,
          userId: claim.userId,
          baseVersionId: claim.baseVersion.versionId,
        },
        captured,
        quotaPair: subscription?.quotaPair,
      } satisfies PiMemoryPhase2CredentialProof,
    };
  },
);
