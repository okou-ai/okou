import { z } from "zod";
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { storages } from "@okouai/db/schema/storage";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { secrets } from "@okouai/db/schema/secret";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { nowDate } from "../../lib/time";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { gptApiKeyPiRoute } from "./pi-sandbox-config";
import { PI_MEMORY_PHASE2_BYOK_MODEL } from "./pi-memory-phase2-usage.service";
import { pendingLaunchUpdateSql } from "./pending-launch-sql";
import {
  PiMemoryPhase2CredentialError,
  type PiMemoryCredentialProof,
  type PiMemoryCredentialSource,
  type PiMemoryCredentialSnapshot,
  type PiMemoryQuotaPairRow,
  type PiMemoryPhase2ProducerBinding,
  type RunProducerBinding,
} from "./pi-memory-producer-contract";

/** Capture data, never a validator closing over a transaction or AbortSignal. */
export function piMemoryCredentialProof(
  source: PiMemoryCredentialSource,
  snapshot: PiMemoryCredentialSnapshot,
  quotaPair: readonly PiMemoryQuotaPairRow[] | undefined,
): PiMemoryCredentialProof {
  if (snapshot === "built-in") {
    return { kind: "built-in", source };
  }
  if (!source.id) {
    throw new PiMemoryPhase2CredentialError("credential_unavailable");
  }
  const owned = { ...source, id: source.id };
  if ("externalAccountId" in snapshot) {
    if (!quotaPair) {
      throw new PiMemoryPhase2CredentialError("credential_unavailable");
    }
    return { kind: "subscription", source: owned, snapshot, quotaPair };
  }
  if ("connectionId" in snapshot) {
    return { kind: "custom", source: owned, snapshot };
  }
  const route = gptApiKeyPiRoute(source.type);
  if (!route?.endpoint) {
    throw new PiMemoryPhase2CredentialError("provider_model_unsupported");
  }
  return {
    kind: "api-key",
    source: owned,
    snapshot,
    credentialSecretName: route.credentialSecretName,
  };
}

const taggedRow = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("storage"), id: z.string() }),
  z.object({
    phase: z.literal("account"),
    id: z.string(),
    providerId: z.string(),
    externalAccountId: z.string().nullable(),
    authMethod: z.string().nullable(),
  }),
  z.object({
    phase: z.literal("key"),
    id: z.string(),
    secretId: z.string(),
    encryptedValue: z.string(),
  }),
  z.object({ phase: z.literal("reference"), connectionId: z.string() }),
  z.object({
    phase: z.literal("connection"),
    id: z.string(),
    secretId: z.string(),
  }),
  z.object({
    phase: z.literal("secret"),
    id: z.string(),
    encryptedValue: z.string(),
  }),
  z.object({
    phase: z.literal("surface"),
    id: z.string(),
    protocol: z.string(),
    baseUrl: z.string(),
    header: z.string(),
    template: z.string(),
    mappings: z.record(z.string(), z.string()),
  }),
  z.object({
    phase: z.literal("quota"),
    id: z.string(),
    name: z.string(),
    encryptedValue: z.string(),
  }),
  z.object({
    phase: z.literal("flags"),
    userId: z.string(),
    switches: z.record(z.string(), z.boolean()),
  }),
]);
export const producerBindingRowSchema = z.union([
  taggedRow,
  z.object({ memory_storage_id: z.string() }),
]);
type Record = z.output<typeof producerBindingRowSchema>;
type Phase =
  | "storage"
  | "account"
  | "key"
  | "reference"
  | "connection"
  | "secret"
  | "surface"
  | "quota"
  | "flags"
  | "bind";
interface Statement {
  readonly connectionId?: string;
  readonly secretId?: string;
  readonly encryptedValue?: string;
  readonly kind: "statement";
  readonly phase: Phase;
  readonly sql: SQL;
}
type Progress = Statement | { readonly kind: "done" };
export interface ProducerRun {
  readonly runId: string;
  readonly status: "pending" | "failed";
}
function unavailable(): never {
  throw new PiMemoryPhase2CredentialError("credential_unavailable");
}

/** Finite preparation/validation/binding, SQL executed only by the launch owner. */
export function producerBindingStart(
  binding: RunProducerBinding | undefined,
): Progress {
  const phase2 = binding?.phase2;
  if (!phase2) {
    return { kind: "done" };
  }
  if (
    phase2.credential.source.orgId !== phase2.orgId ||
    phase2.credential.source.userId !== phase2.userId
  ) {
    unavailable();
  }
  return {
    kind: "statement",
    phase: "storage",
    sql: sql`SELECT 'storage' AS phase, ${storages.id} AS id FROM ${storages}
    WHERE ${and(eq(storages.id, phase2.memoryStorageId), eq(storages.orgId, phase2.orgId), eq(storages.userId, phase2.userId), eq(storages.headVersionId, phase2.claimedBaseVersionId))} FOR SHARE`,
  };
}

function flags(binding: PiMemoryPhase2ProducerBinding): Statement {
  return {
    kind: "statement",
    phase: "flags",
    sql: sql`SELECT 'flags' AS phase, ${userFeatureSwitches.userId} AS "userId", ${userFeatureSwitches.switches} AS switches
    FROM ${userFeatureSwitches} WHERE ${userFeatureSwitchRowCondition(binding.orgId, binding.userId)}`,
  };
}
function credentialStep(binding: PiMemoryPhase2ProducerBinding): Statement {
  const proof = binding.credential;
  if (proof.kind === "built-in") {
    return flags(binding);
  }
  const source = proof.source;
  if (proof.kind === "subscription") {
    return {
      kind: "statement",
      phase: "account",
      sql: sql`SELECT 'account' AS phase,
    ${modelProviderAccounts.id} AS id, ${modelProviderAccounts.modelProviderId} AS "providerId", ${modelProviderAccounts.externalAccountId} AS "externalAccountId", ${modelProviderAccounts.authMethod} AS "authMethod"
    FROM ${modelProviderAccounts} WHERE ${and(
      eq(modelProviderAccounts.id, source.id),
      eq(modelProviderAccounts.orgId, source.orgId),
      eq(modelProviderAccounts.userId, source.userId),
      eq(modelProviderAccounts.type, source.type),
      eq(modelProviderAccounts.isActive, true),
      eq(modelProviderAccounts.needsReconnect, false),
      isNull(modelProviderAccounts.disconnectedAt),
    )}`,
    };
  }
  if (proof.kind === "custom") {
    return {
      kind: "statement",
      phase: "reference",
      sql: sql`SELECT 'reference' AS phase, ${modelProviderSurfaces.connectionId} AS "connectionId"
    FROM ${modelProviderSurfaces} WHERE ${eq(modelProviderSurfaces.id, source.id)}`,
    };
  }
  const owner = source.scope === "org" ? "__org__" : source.userId;
  return {
    kind: "statement",
    phase: "key",
    sql: sql`SELECT 'key' AS phase, ${modelProviders.id} AS id, ${secrets.id} AS "secretId", ${secrets.encryptedValue} AS "encryptedValue"
    FROM ${modelProviders} INNER JOIN ${secrets} ON ${eq(secrets.id, modelProviders.secretId)}
    WHERE ${and(
      eq(modelProviders.id, source.id),
      eq(modelProviders.orgId, source.orgId),
      eq(modelProviders.userId, owner),
      eq(modelProviders.type, source.type),
      eq(secrets.orgId, source.orgId),
      eq(secrets.userId, owner),
      eq(secrets.name, proof.credentialSecretName),
      eq(secrets.type, "model-provider"),
    )} FOR SHARE`,
  };
}

function customStep(
  binding: PiMemoryPhase2ProducerBinding,
  step: Statement,
  row: Record | undefined,
): Statement {
  const proof = binding.credential;
  if (proof.kind !== "custom" || !row || !("phase" in row)) {
    unavailable();
  }
  const expected = proof.snapshot;
  if (step.phase === "reference") {
    if (row.phase !== "reference") {
      unavailable();
    }
    return {
      kind: "statement",
      phase: "connection",
      connectionId: row.connectionId,
      sql: sql`SELECT 'connection' AS phase, ${modelProviderConnections.id} AS id, ${modelProviderConnections.secretId} AS "secretId"
      FROM ${modelProviderConnections} WHERE ${and(eq(modelProviderConnections.id, row.connectionId), eq(modelProviderConnections.orgId, proof.source.orgId))} FOR SHARE`,
    };
  }
  if (step.phase === "connection") {
    if (row.phase !== "connection") {
      unavailable();
    }
    return {
      kind: "statement",
      phase: "secret",
      connectionId: row.id,
      secretId: row.secretId,
      sql: sql`SELECT 'secret' AS phase, ${secrets.id} AS id, ${secrets.encryptedValue} AS "encryptedValue"
      FROM ${secrets} WHERE ${and(eq(secrets.id, row.secretId), eq(secrets.orgId, proof.source.orgId), eq(secrets.userId, "__org__"))} FOR SHARE`,
    };
  }
  if (step.phase === "secret") {
    if (row.phase !== "secret" || !row.encryptedValue) {
      unavailable();
    }
    const connectionId = step.connectionId;
    if (!connectionId) {
      unavailable();
    }
    return {
      kind: "statement",
      phase: "surface",
      connectionId,
      secretId: row.id,
      encryptedValue: row.encryptedValue,
      sql: sql`SELECT 'surface' AS phase, ${modelProviderSurfaces.id} AS id, ${modelProviderSurfaces.protocol} AS protocol,
      ${modelProviderSurfaces.apiBaseUrl} AS "baseUrl", ${modelProviderSurfaces.authHeaderName} AS header, ${modelProviderSurfaces.authHeaderTemplate} AS template, ${modelProviderSurfaces.modelMappings} AS mappings
      FROM ${modelProviderSurfaces} WHERE ${and(eq(modelProviderSurfaces.id, proof.source.id), eq(modelProviderSurfaces.connectionId, connectionId))} FOR SHARE`,
    };
  }
  if (row.phase !== "surface") {
    unavailable();
  }
  if (
    row.protocol !== "openai-responses" ||
    !row.mappings[PI_MEMORY_PHASE2_BYOK_MODEL]?.trim()
  ) {
    throw new PiMemoryPhase2CredentialError("provider_model_unsupported");
  }
  const current = {
    id: row.id,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    header: row.header,
    template: row.template,
    mappings: row.mappings,
    connectionId: step.connectionId,
    secretId: step.secretId,
    encryptedValue: step.encryptedValue,
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    unavailable();
  }
  return flags(binding);
}

function quotaRead(binding: PiMemoryPhase2ProducerBinding): Statement {
  const proof = binding.credential;
  if (proof.kind !== "subscription") {
    unavailable();
  }
  return {
    kind: "statement",
    phase: "quota",
    sql: sql`SELECT 'quota' AS phase, ${modelProviderAccountSecrets.id} AS id,
    ${modelProviderAccountSecrets.name} AS name, ${modelProviderAccountSecrets.encryptedValue} AS "encryptedValue" FROM ${modelProviderAccountSecrets}
    WHERE ${and(eq(modelProviderAccountSecrets.modelProviderAccountId, proof.source.id), inArray(modelProviderAccountSecrets.name, ["CHATGPT_ACCESS_TOKEN", "CHATGPT_ACCOUNT_ID"]))}
    ORDER BY ${asc(modelProviderAccountSecrets.id)} FOR SHARE`,
  };
}

function bindJob(
  binding: PiMemoryPhase2ProducerBinding,
  run: ProducerRun,
): Progress {
  if (run.status === "failed") {
    return { kind: "done" };
  }
  return {
    kind: "statement",
    phase: "bind",
    sql: pendingLaunchUpdateSql(
      piMemoryPhase2Jobs,
      { maintenanceRunId: run.runId, updatedAt: nowDate() },
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, binding.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, binding.orgId),
        eq(piMemoryPhase2Jobs.userId, binding.userId),
        eq(piMemoryPhase2Jobs.status, "leased"),
        eq(piMemoryPhase2Jobs.leaseToken, binding.leaseToken),
        eq(piMemoryPhase2Jobs.sandboxLeaseToken, binding.leaseToken),
        eq(piMemoryPhase2Jobs.claimedRevision, binding.claimedRevision),
        eq(
          piMemoryPhase2Jobs.claimedBaseVersionId,
          binding.claimedBaseVersionId,
        ),
        eq(piMemoryPhase2Jobs.claimedSelectionDigest, binding.selectionDigest),
        isNull(piMemoryPhase2Jobs.maintenanceRunId),
        gt(piMemoryPhase2Jobs.leaseExpiresAt, nowDate()),
      ),
      ["memoryStorageId"],
    ),
  };
}

function advanceCredentialRow(
  binding: PiMemoryPhase2ProducerBinding,
  step: Statement,
  row: Record | undefined,
): Statement {
  const proof = binding.credential;
  if (step.phase === "account") {
    if (
      proof.kind !== "subscription" ||
      !row ||
      !("phase" in row) ||
      row.phase !== "account"
    ) {
      unavailable();
    }
    const current = {
      id: row.id,
      providerId: row.providerId,
      externalAccountId: row.externalAccountId,
      authMethod: row.authMethod,
    };
    if (
      !row.externalAccountId ||
      JSON.stringify(current) !== JSON.stringify(proof.snapshot)
    ) {
      unavailable();
    }
    return quotaRead(binding);
  }
  if (
    proof.kind !== "api-key" ||
    !row ||
    !("phase" in row) ||
    row.phase !== "key"
  ) {
    unavailable();
  }
  if (
    JSON.stringify({
      id: row.id,
      secretId: row.secretId,
      encryptedValue: row.encryptedValue,
    }) !== JSON.stringify(proof.snapshot)
  ) {
    unavailable();
  }
  return flags(binding);
}

export function advanceProducerBinding(
  binding: RunProducerBinding | undefined,
  run: ProducerRun,
  step: Statement,
  rows: readonly Record[],
): Progress {
  const phase2 = binding?.phase2;
  if (!phase2) {
    throw new Error("Producer admission requires captured Phase 2 facts");
  }
  const proof = phase2.credential;
  const row = rows[0];
  switch (step.phase) {
    case "storage": {
      if (!row) {
        throw new PiMemoryPhase2CredentialError("storage_binding_changed");
      }
      return credentialStep(phase2);
    }
    case "account":
    case "key": {
      return advanceCredentialRow(phase2, step, row);
    }
    case "reference":
    case "connection":
    case "secret":
    case "surface": {
      return customStep(phase2, step, row);
    }
    case "quota": {
      if (proof.kind !== "subscription") {
        unavailable();
      }
      const pair = rows.map((item) => {
        if (!("phase" in item) || item.phase !== "quota") {
          unavailable();
        }
        return {
          id: item.id,
          name: item.name,
          encryptedValue: item.encryptedValue,
        };
      });
      if (JSON.stringify(pair) !== JSON.stringify(proof.quotaPair)) {
        unavailable();
      }
      return flags(phase2);
    }
    case "flags": {
      const flags = rows.map((item) => {
        if (!("phase" in item) || item.phase !== "flags") {
          unavailable();
        }
        return { userId: item.userId, switches: item.switches };
      });
      if (
        !isFeatureEnabled(
          FeatureSwitchKey.PiMemory,
          featureSwitchContextFromRows(phase2.orgId, phase2.userId, flags),
        )
      ) {
        throw new PiMemoryPhase2CredentialError("pi_memory_disabled");
      }
      return bindJob(phase2, run);
    }
    case "bind": {
      if (!row || !("memory_storage_id" in row)) {
        throw new Error(
          "Pi memory Phase 2 maintenance run lost its claim fence",
        );
      }
      return { kind: "done" };
    }
  }
}
