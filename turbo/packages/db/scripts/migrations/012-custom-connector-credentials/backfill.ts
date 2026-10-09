#!/usr/bin/env tsx

/**
 * Backfill executable Custom connector credentials into shared connector
 * storage. Dry-run is the default; pass --migrate to repair shared targets.
 * Legacy source rows are never changed or deleted.
 */

import { createDecipheriv } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import {
  customConnectorFieldSchema,
  type CustomConnectorField,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectorSecrets } from "@okouai/db/schema/org-custom-connector-secret";
import { orgCustomConnectorValues } from "@okouai/db/schema/org-custom-connector-value";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const STORED_SECRET_ENVELOPE_PREFIX = "vm0secret:v1:";
const LEGACY_SECRET_KEY = "secret";
const DATA_KEY_BYTE_LENGTH = 32;
const KMS_ENCRYPTION_CONTEXT = {
  purpose: "vm0-stored-secret",
} as const;
const MAX_BATCH_SIZE = 1_000;
const MAX_REPORT_DETAILS = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const normalizedLegacyValues = alias(
  orgCustomConnectorValues,
  "normalized_legacy_values",
);

type BackfillDatabase = PostgresJsDatabase<Record<string, never>>;
type BackfillMode = "dry-run" | "migrate";
type SourceTable = "values" | "legacy-secrets";

type BackfillOutcome =
  | "already_current"
  | "target_missing"
  | "target_mismatch"
  | "inserted"
  | "updated"
  | "invalid_kind"
  | "invalid_definition"
  | "oauth_transition"
  | "oauth_variable_unsupported"
  | "missing_connection"
  | "incompatible_connection"
  | "removed_field"
  | "wrong_kind"
  | "invalid_envelope"
  | "fallback_duplicate_equal"
  | "fallback_duplicate_different"
  | "source_changed";

type BackfillFailureCode =
  "credential_decrypt_failed" | "database_or_internal_failure";

type BackfillFailureStage =
  "decrypt_source" | "inspect_target" | "migrate_target";

interface StoredSecretKmsDecryptRequest {
  readonly keyId: string;
  readonly ciphertext: Uint8Array;
  readonly encryptionContext: Readonly<Record<string, string>>;
}

interface StoredSecretKmsClient {
  decrypt(request: StoredSecretKmsDecryptRequest): Promise<Uint8Array>;
}

interface CustomCredentialBackfillOptions {
  readonly mode: BackfillMode;
  readonly batchSize: number;
  readonly cursor?: string;
  readonly reportPath: string;
}

interface DirectKmsCiphertext {
  readonly keyId: string;
  readonly ciphertext: string;
}

interface EnvelopeKmsCiphertext {
  readonly keyId: string;
  readonly encryptedDataKey: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

type KmsCiphertext = DirectKmsCiphertext | EnvelopeKmsCiphertext;

interface StoredSecretEnvelope {
  readonly v: 1;
  readonly kind: "stored-secret";
  readonly kms: KmsCiphertext;
}

interface SourceCursor {
  readonly table: SourceTable;
  readonly id: string;
}

interface SourceIdentity {
  readonly table: SourceTable;
  readonly id: string;
  readonly customConnectorId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly kind: string;
  readonly key: string;
  readonly encryptedValue: string;
}

interface DefinitionSnapshot {
  readonly authMode: string;
  readonly storageVersion: number;
  readonly fields: unknown;
}

interface ConnectionSnapshot {
  readonly id: string;
  readonly authMethod: string;
  readonly storageVersion: number;
}

interface SourceSnapshot {
  readonly source: SourceIdentity;
  readonly definition: DefinitionSnapshot;
  readonly connection: ConnectionSnapshot | null;
  readonly normalizedOverride: string | null;
}

interface Candidate {
  readonly source: SourceIdentity;
  readonly connectionId: string;
  readonly kind: "secret" | "variable";
  readonly key: string;
  readonly envelope: StoredSecretEnvelope;
}

interface ClassifiedCandidate {
  readonly candidate: Candidate;
}

interface ClassifiedResidue {
  readonly outcome: Exclude<
    BackfillOutcome,
    | "already_current"
    | "target_missing"
    | "target_mismatch"
    | "inserted"
    | "updated"
    | "source_changed"
  >;
}

type Classification = ClassifiedCandidate | ClassifiedResidue;

interface BackfillDetail {
  readonly source: SourceTable;
  readonly sourceRowId: string;
  readonly outcome: Exclude<BackfillOutcome, "already_current">;
}

interface BackfillFailureContext {
  readonly source: SourceTable;
  readonly sourceRowId: string;
  readonly stage: BackfillFailureStage;
}

interface CustomCredentialBackfillReport {
  readonly generatedAt: string;
  readonly mode: BackfillMode;
  readonly batchSize: number;
  readonly startedFromBeginning: boolean;
  readonly complete: boolean;
  readonly ready: boolean;
  readonly resumeCursor: string | null;
  readonly scannedRows: number;
  readonly blockingDifferences: number;
  readonly counts: Readonly<Partial<Record<BackfillOutcome, number>>>;
  readonly details: readonly BackfillDetail[];
  readonly omittedDetails: number;
  readonly failureCode: BackfillFailureCode | null;
  readonly failure: BackfillFailureContext | null;
}

interface MutableReportState {
  readonly mode: BackfillMode;
  readonly batchSize: number;
  readonly startedFromBeginning: boolean;
  scannedRows: number;
  cursor: SourceCursor | null;
  readonly counts: Partial<Record<BackfillOutcome, number>>;
  readonly details: BackfillDetail[];
  omittedDetails: number;
  failureCode: BackfillFailureCode | null;
  failure: BackfillFailureContext | null;
}

class CredentialDecryptFailure extends Error {
  constructor() {
    super("Stored credential decryption failed");
    this.name = "CredentialDecryptFailure";
  }
}

class BackfillRowFailure extends Error {
  readonly code: BackfillFailureCode;
  readonly context: BackfillFailureContext;

  constructor(args: {
    readonly code: BackfillFailureCode;
    readonly context: BackfillFailureContext;
    readonly cause: unknown;
  }) {
    super("Custom credential row processing failed", { cause: args.cause });
    this.name = "BackfillRowFailure";
    this.code = args.code;
    this.context = args.context;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const property = value[key];
  return typeof property === "string" && property.length > 0
    ? property
    : undefined;
}

function decodeStoredSecretEnvelope(
  encryptedValue: string,
): StoredSecretEnvelope | undefined {
  if (!encryptedValue.startsWith(STORED_SECRET_ENVELOPE_PREFIX)) {
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(
        encryptedValue.slice(STORED_SECRET_ENVELOPE_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(decoded) ||
    decoded.v !== 1 ||
    decoded.kind !== "stored-secret" ||
    !isRecord(decoded.kms)
  ) {
    return undefined;
  }

  const keyId = stringProperty(decoded.kms, "keyId");
  const rawCiphertext = decoded.kms.ciphertext;
  if (!keyId || typeof rawCiphertext !== "string") {
    return undefined;
  }
  const encryptedDataKey = stringProperty(decoded.kms, "encryptedDataKey");
  if (!encryptedDataKey) {
    if (!rawCiphertext) {
      return undefined;
    }
    return {
      v: 1,
      kind: "stored-secret",
      kms: { keyId, ciphertext: rawCiphertext },
    };
  }
  const iv = stringProperty(decoded.kms, "iv");
  const authTag = stringProperty(decoded.kms, "authTag");
  if (!iv || !authTag) {
    return undefined;
  }
  return {
    v: 1,
    kind: "stored-secret",
    kms: { keyId, encryptedDataKey, iv, authTag, ciphertext: rawCiphertext },
  };
}

async function decryptStoredSecretEnvelope(
  envelope: StoredSecretEnvelope,
  kms: StoredSecretKmsClient,
): Promise<string> {
  try {
    if (!("encryptedDataKey" in envelope.kms)) {
      const plaintext = await kms.decrypt({
        keyId: envelope.kms.keyId,
        ciphertext: Buffer.from(envelope.kms.ciphertext, "base64"),
        encryptionContext: KMS_ENCRYPTION_CONTEXT,
      });
      try {
        return Buffer.from(
          plaintext.buffer,
          plaintext.byteOffset,
          plaintext.byteLength,
        ).toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    }

    const decryptedDataKey = await kms.decrypt({
      keyId: envelope.kms.keyId,
      ciphertext: Buffer.from(envelope.kms.encryptedDataKey, "base64"),
      encryptionContext: KMS_ENCRYPTION_CONTEXT,
    });
    try {
      if (decryptedDataKey.byteLength !== DATA_KEY_BYTE_LENGTH) {
        throw new Error("Invalid stored-secret data key length");
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        decryptedDataKey,
        Buffer.from(envelope.kms.iv, "base64"),
        { authTagLength: 16 },
      );
      decipher.setAuthTag(Buffer.from(envelope.kms.authTag, "base64"));
      const plaintextChunks: Buffer[] = [];
      try {
        plaintextChunks.push(
          decipher.update(Buffer.from(envelope.kms.ciphertext, "base64")),
        );
        plaintextChunks.push(decipher.final());
        const plaintext = Buffer.concat(plaintextChunks);
        try {
          return plaintext.toString("utf8");
        } finally {
          plaintext.fill(0);
        }
      } finally {
        for (const chunk of plaintextChunks) {
          chunk.fill(0);
        }
      }
    } finally {
      decryptedDataKey.fill(0);
    }
  } catch {
    throw new CredentialDecryptFailure();
  }
}

function parseFields(
  raw: unknown,
):
  | { readonly valid: true; readonly fields: readonly CustomConnectorField[] }
  | { readonly valid: false } {
  if (!Array.isArray(raw)) {
    return { valid: false };
  }
  const fields: CustomConnectorField[] = [];
  const keys = new Set<string>();
  for (const item of raw) {
    const parsed = customConnectorFieldSchema.safeParse(item);
    if (!parsed.success || keys.has(parsed.data.key)) {
      return { valid: false };
    }
    keys.add(parsed.data.key);
    fields.push(parsed.data);
  }
  return { valid: true, fields };
}

function classifySnapshot(snapshot: SourceSnapshot): Classification {
  if (
    snapshot.source.kind !== "secret" &&
    snapshot.source.kind !== "variable"
  ) {
    return { outcome: "invalid_kind" };
  }
  if (
    snapshot.definition.authMode !== "manual" &&
    snapshot.definition.authMode !== "oauth"
  ) {
    return { outcome: "invalid_definition" };
  }
  if (
    snapshot.definition.authMode === "oauth" &&
    (snapshot.source.table === "legacy-secrets" ||
      snapshot.source.kind === "secret")
  ) {
    return { outcome: "oauth_transition" };
  }
  if (!snapshot.connection) {
    return { outcome: "missing_connection" };
  }
  if (
    snapshot.connection.authMethod !== snapshot.definition.authMode ||
    snapshot.connection.storageVersion !== snapshot.definition.storageVersion
  ) {
    return { outcome: "incompatible_connection" };
  }
  const parsedFields = parseFields(snapshot.definition.fields);
  if (!parsedFields.valid) {
    return { outcome: "invalid_definition" };
  }
  if (
    snapshot.source.table === "legacy-secrets" &&
    snapshot.normalizedOverride !== null
  ) {
    return {
      outcome:
        snapshot.normalizedOverride === snapshot.source.encryptedValue
          ? "fallback_duplicate_equal"
          : "fallback_duplicate_different",
    };
  }

  const field = parsedFields.fields.find((candidate) => {
    return candidate.key === snapshot.source.key;
  });
  if (!field) {
    return { outcome: "removed_field" };
  }
  if (field.kind !== snapshot.source.kind) {
    return { outcome: "wrong_kind" };
  }
  const envelope = decodeStoredSecretEnvelope(snapshot.source.encryptedValue);
  if (!envelope) {
    return { outcome: "invalid_envelope" };
  }
  if (snapshot.definition.authMode === "oauth") {
    return { outcome: "oauth_variable_unsupported" };
  }
  return {
    candidate: {
      source: snapshot.source,
      connectionId: snapshot.connection.id,
      kind: snapshot.source.kind,
      key: snapshot.source.key,
      envelope,
    },
  };
}

function cursorString(cursor: SourceCursor | null): string | null {
  return cursor ? `${cursor.table}:${cursor.id}` : null;
}

function parseCursor(raw: string | undefined): SourceCursor | undefined {
  if (!raw) {
    return undefined;
  }
  const separator = raw.indexOf(":");
  const table = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (
    separator < 1 ||
    (table !== "values" && table !== "legacy-secrets") ||
    !UUID_PATTERN.test(id)
  ) {
    throw new Error("--cursor must be values:<uuid> or legacy-secrets:<uuid>");
  }
  return { table, id };
}

function countOutcome(
  report: MutableReportState,
  source: SourceIdentity,
  outcome: BackfillOutcome,
): void {
  report.scannedRows += 1;
  report.counts[outcome] = (report.counts[outcome] ?? 0) + 1;
  if (outcome !== "already_current") {
    if (report.details.length < MAX_REPORT_DETAILS) {
      report.details.push({
        source: source.table,
        sourceRowId: source.id,
        outcome,
      });
    } else {
      report.omittedDetails += 1;
    }
  }
  report.cursor = { table: source.table, id: source.id };
}

function blockingDifferenceCount(
  counts: Readonly<Partial<Record<BackfillOutcome, number>>>,
): number {
  return (
    (counts.target_missing ?? 0) +
    (counts.target_mismatch ?? 0) +
    (counts.source_changed ?? 0) +
    (counts.invalid_definition ?? 0) +
    (counts.oauth_variable_unsupported ?? 0)
  );
}

function createReport(
  state: MutableReportState,
  complete: boolean,
): CustomCredentialBackfillReport {
  const blockingDifferences = blockingDifferenceCount(state.counts);
  return {
    generatedAt: new Date().toISOString(),
    mode: state.mode,
    batchSize: state.batchSize,
    startedFromBeginning: state.startedFromBeginning,
    complete,
    ready:
      state.mode === "dry-run" &&
      state.startedFromBeginning &&
      complete &&
      state.failureCode === null &&
      blockingDifferences === 0,
    resumeCursor: complete ? null : cursorString(state.cursor),
    scannedRows: state.scannedRows,
    blockingDifferences,
    counts: { ...state.counts },
    details: [...state.details],
    omittedDetails: state.omittedDetails,
    failureCode: state.failureCode,
    failure: state.failure,
  };
}

async function writeReport(
  state: MutableReportState,
  reportPath: string,
  complete: boolean,
): Promise<CustomCredentialBackfillReport> {
  const report = createReport(state, complete);
  const temporaryPath = `${reportPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, reportPath);
  return report;
}

async function normalizedOverride(
  db: BackfillDatabase,
  source: SourceIdentity,
): Promise<string | null> {
  const [row] = await db
    .select({ encryptedValue: orgCustomConnectorValues.encryptedValue })
    .from(orgCustomConnectorValues)
    .where(
      and(
        eq(orgCustomConnectorValues.connectorId, source.customConnectorId),
        eq(orgCustomConnectorValues.orgId, source.orgId),
        eq(orgCustomConnectorValues.userId, source.userId),
        eq(orgCustomConnectorValues.kind, "secret"),
        eq(orgCustomConnectorValues.key, LEGACY_SECRET_KEY),
      ),
    )
    .limit(1);
  return row?.encryptedValue ?? null;
}

async function valuePage(
  db: BackfillDatabase,
  afterId: string | undefined,
  limit: number,
): Promise<readonly SourceSnapshot[]> {
  const rows = await db
    .select({
      id: orgCustomConnectorValues.id,
      customConnectorId: orgCustomConnectorValues.connectorId,
      orgId: orgCustomConnectorValues.orgId,
      userId: orgCustomConnectorValues.userId,
      kind: orgCustomConnectorValues.kind,
      key: orgCustomConnectorValues.key,
      encryptedValue: orgCustomConnectorValues.encryptedValue,
      definitionAuthMode: orgCustomConnectors.authMode,
      definitionStorageVersion: orgCustomConnectors.storageVersion,
      definitionFields: orgCustomConnectors.fields,
      connectionId: connectors.id,
      connectionAuthMethod: connectors.authMethod,
      connectionStorageVersion: connectors.storageVersion,
    })
    .from(orgCustomConnectorValues)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, orgCustomConnectorValues.connectorId),
        eq(orgCustomConnectors.orgId, orgCustomConnectorValues.orgId),
      ),
    )
    .leftJoin(
      connectors,
      and(
        eq(connectors.customConnectorId, orgCustomConnectorValues.connectorId),
        eq(connectors.orgId, orgCustomConnectorValues.orgId),
        eq(connectors.userId, orgCustomConnectorValues.userId),
      ),
    )
    .where(afterId ? gt(orgCustomConnectorValues.id, afterId) : undefined)
    .orderBy(asc(orgCustomConnectorValues.id))
    .limit(limit);

  return rows.map((row) => {
    return {
      source: {
        table: "values",
        id: row.id,
        customConnectorId: row.customConnectorId,
        orgId: row.orgId,
        userId: row.userId,
        kind: row.kind,
        key: row.key,
        encryptedValue: row.encryptedValue,
      },
      definition: {
        authMode: row.definitionAuthMode,
        storageVersion: row.definitionStorageVersion,
        fields: row.definitionFields,
      },
      connection:
        row.connectionId === null ||
        row.connectionAuthMethod === null ||
        row.connectionStorageVersion === null
          ? null
          : {
              id: row.connectionId,
              authMethod: row.connectionAuthMethod,
              storageVersion: row.connectionStorageVersion,
            },
      normalizedOverride: null,
    };
  });
}

async function legacySecretPage(
  db: BackfillDatabase,
  afterId: string | undefined,
  limit: number,
): Promise<readonly SourceSnapshot[]> {
  const rows = await db
    .select({
      id: orgCustomConnectorSecrets.id,
      customConnectorId: orgCustomConnectorSecrets.connectorId,
      orgId: orgCustomConnectorSecrets.orgId,
      userId: orgCustomConnectorSecrets.userId,
      encryptedValue: orgCustomConnectorSecrets.encryptedValue,
      definitionAuthMode: orgCustomConnectors.authMode,
      definitionStorageVersion: orgCustomConnectors.storageVersion,
      definitionFields: orgCustomConnectors.fields,
      connectionId: connectors.id,
      connectionAuthMethod: connectors.authMethod,
      connectionStorageVersion: connectors.storageVersion,
      normalizedEncryptedValue: normalizedLegacyValues.encryptedValue,
    })
    .from(orgCustomConnectorSecrets)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, orgCustomConnectorSecrets.connectorId),
        eq(orgCustomConnectors.orgId, orgCustomConnectorSecrets.orgId),
      ),
    )
    .leftJoin(
      connectors,
      and(
        eq(connectors.customConnectorId, orgCustomConnectorSecrets.connectorId),
        eq(connectors.orgId, orgCustomConnectorSecrets.orgId),
        eq(connectors.userId, orgCustomConnectorSecrets.userId),
      ),
    )
    .leftJoin(
      normalizedLegacyValues,
      and(
        eq(
          normalizedLegacyValues.connectorId,
          orgCustomConnectorSecrets.connectorId,
        ),
        eq(normalizedLegacyValues.orgId, orgCustomConnectorSecrets.orgId),
        eq(normalizedLegacyValues.userId, orgCustomConnectorSecrets.userId),
        eq(normalizedLegacyValues.kind, "secret"),
        eq(normalizedLegacyValues.key, LEGACY_SECRET_KEY),
      ),
    )
    .where(afterId ? gt(orgCustomConnectorSecrets.id, afterId) : undefined)
    .orderBy(asc(orgCustomConnectorSecrets.id))
    .limit(limit);

  return rows.map((row): SourceSnapshot => {
    const source: SourceIdentity = {
      table: "legacy-secrets",
      id: row.id,
      customConnectorId: row.customConnectorId,
      orgId: row.orgId,
      userId: row.userId,
      kind: "secret",
      key: LEGACY_SECRET_KEY,
      encryptedValue: row.encryptedValue,
    };
    return {
      source,
      definition: {
        authMode: row.definitionAuthMode,
        storageVersion: row.definitionStorageVersion,
        fields: row.definitionFields,
      },
      connection:
        row.connectionId === null ||
        row.connectionAuthMethod === null ||
        row.connectionStorageVersion === null
          ? null
          : {
              id: row.connectionId,
              authMethod: row.connectionAuthMethod,
              storageVersion: row.connectionStorageVersion,
            },
      normalizedOverride: row.normalizedEncryptedValue,
    };
  });
}

async function targetOutcome(
  db: BackfillDatabase,
  candidate: Candidate,
  plaintext: string | undefined,
): Promise<"already_current" | "target_missing" | "target_mismatch"> {
  if (candidate.kind === "secret") {
    const [target] = await db
      .select({
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.connectorId, candidate.connectionId),
          eq(secrets.name, candidate.key),
        ),
      )
      .limit(1);
    if (!target) {
      return "target_missing";
    }
    return target.encryptedValue === candidate.source.encryptedValue &&
      target.description === null
      ? "already_current"
      : "target_mismatch";
  }

  if (plaintext === undefined) {
    throw new Error("Decrypted variable value is required");
  }
  const [target] = await db
    .select({ value: variables.value, description: variables.description })
    .from(variables)
    .where(
      and(
        eq(variables.connectorId, candidate.connectionId),
        eq(variables.name, candidate.key),
      ),
    )
    .limit(1);
  if (!target) {
    return "target_missing";
  }
  return target.value === plaintext && target.description === null
    ? "already_current"
    : "target_mismatch";
}

function sameCandidate(left: Candidate, right: Candidate): boolean {
  return (
    left.source.id === right.source.id &&
    left.source.encryptedValue === right.source.encryptedValue &&
    left.connectionId === right.connectionId &&
    left.kind === right.kind &&
    left.key === right.key
  );
}

async function migrateCandidate(
  db: BackfillDatabase,
  discovered: Candidate,
  plaintext: string | undefined,
): Promise<"already_current" | "inserted" | "updated" | "source_changed"> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0362; new non-billing transactions are prohibited.
  return await db.transaction(async (tx) => {
    const [definition] = await tx
      .select({
        authMode: orgCustomConnectors.authMode,
        storageVersion: orgCustomConnectors.storageVersion,
        fields: orgCustomConnectors.fields,
      })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, discovered.source.customConnectorId),
          eq(orgCustomConnectors.orgId, discovered.source.orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (!definition) {
      return "source_changed";
    }

    const [connection] = await tx
      .select({
        id: connectors.id,
        authMethod: connectors.authMethod,
        storageVersion: connectors.storageVersion,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.customConnectorId, discovered.source.customConnectorId),
          eq(connectors.orgId, discovered.source.orgId),
          eq(connectors.userId, discovered.source.userId),
        ),
      )
      .for("update")
      .limit(1);

    let sourceIdentity: SourceIdentity;
    if (discovered.source.table === "values") {
      const [lockedSource] = await tx
        .select({
          id: orgCustomConnectorValues.id,
          connectorId: orgCustomConnectorValues.connectorId,
          orgId: orgCustomConnectorValues.orgId,
          userId: orgCustomConnectorValues.userId,
          kind: orgCustomConnectorValues.kind,
          key: orgCustomConnectorValues.key,
          encryptedValue: orgCustomConnectorValues.encryptedValue,
        })
        .from(orgCustomConnectorValues)
        .where(eq(orgCustomConnectorValues.id, discovered.source.id))
        .for("update")
        .limit(1);
      if (!lockedSource) {
        return "source_changed";
      }
      sourceIdentity = {
        table: "values",
        id: lockedSource.id,
        customConnectorId: lockedSource.connectorId,
        orgId: lockedSource.orgId,
        userId: lockedSource.userId,
        kind: lockedSource.kind,
        key: lockedSource.key,
        encryptedValue: lockedSource.encryptedValue,
      };
    } else {
      const [lockedSource] = await tx
        .select({
          id: orgCustomConnectorSecrets.id,
          connectorId: orgCustomConnectorSecrets.connectorId,
          orgId: orgCustomConnectorSecrets.orgId,
          userId: orgCustomConnectorSecrets.userId,
          encryptedValue: orgCustomConnectorSecrets.encryptedValue,
        })
        .from(orgCustomConnectorSecrets)
        .where(eq(orgCustomConnectorSecrets.id, discovered.source.id))
        .for("update")
        .limit(1);
      if (!lockedSource) {
        return "source_changed";
      }
      sourceIdentity = {
        table: "legacy-secrets",
        id: lockedSource.id,
        customConnectorId: lockedSource.connectorId,
        orgId: lockedSource.orgId,
        userId: lockedSource.userId,
        kind: "secret",
        key: LEGACY_SECRET_KEY,
        encryptedValue: lockedSource.encryptedValue,
      };
    }
    const override =
      discovered.source.table === "legacy-secrets"
        ? await normalizedOverride(tx, sourceIdentity)
        : null;
    const lockedClassification = classifySnapshot({
      source: sourceIdentity,
      definition,
      connection: connection ?? null,
      normalizedOverride: override,
    });
    if (
      !("candidate" in lockedClassification) ||
      !sameCandidate(discovered, lockedClassification.candidate)
    ) {
      return "source_changed";
    }

    const before = await targetOutcome(
      tx,
      lockedClassification.candidate,
      plaintext,
    );
    if (before === "already_current") {
      return before;
    }
    if (lockedClassification.candidate.kind === "secret") {
      await tx
        .insert(secrets)
        .values({
          connectorId: lockedClassification.candidate.connectionId,
          orgId: lockedClassification.candidate.source.orgId,
          userId: lockedClassification.candidate.source.userId,
          name: lockedClassification.candidate.key,
          encryptedValue: lockedClassification.candidate.source.encryptedValue,
          description: null,
          type: "connector",
        })
        .onConflictDoUpdate({
          target: [secrets.connectorId, secrets.name],
          targetWhere: isNotNull(secrets.connectorId),
          set: {
            encryptedValue:
              lockedClassification.candidate.source.encryptedValue,
            description: null,
            updatedAt: new Date(),
          },
        });
    } else {
      if (plaintext === undefined) {
        throw new Error("Decrypted variable value is required");
      }
      await tx
        .insert(variables)
        .values({
          connectorId: lockedClassification.candidate.connectionId,
          orgId: lockedClassification.candidate.source.orgId,
          userId: lockedClassification.candidate.source.userId,
          name: lockedClassification.candidate.key,
          value: plaintext,
          description: null,
          type: "connector",
        })
        .onConflictDoUpdate({
          target: [variables.connectorId, variables.name],
          targetWhere: isNotNull(variables.connectorId),
          set: { value: plaintext, description: null, updatedAt: new Date() },
        });
    }
    return before === "target_missing" ? "inserted" : "updated";
  });
}

async function processSnapshot(
  db: BackfillDatabase,
  kms: StoredSecretKmsClient,
  mode: BackfillMode,
  snapshot: SourceSnapshot,
): Promise<BackfillOutcome> {
  let stage: BackfillFailureStage =
    mode === "dry-run" ? "inspect_target" : "migrate_target";
  try {
    const classification = classifySnapshot(snapshot);
    if (!("candidate" in classification)) {
      return classification.outcome;
    }
    let plaintext: string | undefined;
    if (classification.candidate.kind === "variable") {
      stage = "decrypt_source";
      plaintext = await decryptStoredSecretEnvelope(
        classification.candidate.envelope,
        kms,
      );
    }
    stage = mode === "dry-run" ? "inspect_target" : "migrate_target";
    return mode === "dry-run"
      ? await targetOutcome(db, classification.candidate, plaintext)
      : await migrateCandidate(db, classification.candidate, plaintext);
  } catch (error) {
    throw new BackfillRowFailure({
      code:
        error instanceof CredentialDecryptFailure
          ? "credential_decrypt_failed"
          : "database_or_internal_failure",
      context: {
        source: snapshot.source.table,
        sourceRowId: snapshot.source.id,
        stage,
      },
      cause: error,
    });
  }
}

async function processTable(args: {
  readonly db: BackfillDatabase;
  readonly kms: StoredSecretKmsClient;
  readonly options: CustomCredentialBackfillOptions;
  readonly report: MutableReportState;
  readonly table: SourceTable;
  readonly afterId?: string;
}): Promise<void> {
  let afterId = args.afterId;
  for (;;) {
    const page =
      args.table === "values"
        ? await valuePage(args.db, afterId, args.options.batchSize)
        : await legacySecretPage(args.db, afterId, args.options.batchSize);
    if (page.length === 0) {
      return;
    }
    for (const snapshot of page) {
      const outcome = await processSnapshot(
        args.db,
        args.kms,
        args.options.mode,
        snapshot,
      );
      countOutcome(args.report, snapshot.source, outcome);
      afterId = snapshot.source.id;
    }
    await writeReport(args.report, args.options.reportPath, false);
  }
}

async function runCustomCredentialBackfill(args: {
  readonly db: BackfillDatabase;
  readonly kms: StoredSecretKmsClient;
  readonly options: CustomCredentialBackfillOptions;
}): Promise<CustomCredentialBackfillReport> {
  if (
    !Number.isSafeInteger(args.options.batchSize) ||
    args.options.batchSize < 1 ||
    args.options.batchSize > MAX_BATCH_SIZE
  ) {
    throw new Error(`batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  const initialCursor = parseCursor(args.options.cursor);
  const report: MutableReportState = {
    mode: args.options.mode,
    batchSize: args.options.batchSize,
    startedFromBeginning: initialCursor === undefined,
    scannedRows: 0,
    cursor: initialCursor ?? null,
    counts: {},
    details: [],
    omittedDetails: 0,
    failureCode: null,
    failure: null,
  };

  try {
    if (initialCursor?.table !== "legacy-secrets") {
      await processTable({
        ...args,
        report,
        table: "values",
        afterId: initialCursor?.id,
      });
    }
    await processTable({
      ...args,
      report,
      table: "legacy-secrets",
      afterId:
        initialCursor?.table === "legacy-secrets"
          ? initialCursor.id
          : undefined,
    });
    return await writeReport(report, args.options.reportPath, true);
  } catch (error) {
    report.failureCode =
      error instanceof BackfillRowFailure
        ? error.code
        : "database_or_internal_failure";
    report.failure = error instanceof BackfillRowFailure ? error.context : null;
    await writeReport(report, args.options.reportPath, false);
    throw new Error(
      `Custom credential backfill stopped (${report.failureCode}); inspect the sanitized report`,
    );
  }
}

class AwsStoredSecretKmsClient implements StoredSecretKmsClient {
  readonly #client = new KMSClient({});

  async decrypt(request: StoredSecretKmsDecryptRequest): Promise<Uint8Array> {
    const response = await this.#client.send(
      new DecryptCommand({
        KeyId: request.keyId,
        CiphertextBlob: request.ciphertext,
        EncryptionContext: { ...request.encryptionContext },
      }),
    );
    if (!response.Plaintext) {
      throw new Error("AWS KMS decrypt response did not include plaintext");
    }
    return response.Plaintext;
  }

  destroy(): void {
    this.#client.destroy();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseBatchSize(raw: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error("--batch-size must be a positive integer");
  }
  return Number(raw);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      "batch-size": { type: "string", default: "100" },
      cursor: { type: "string" },
      "report-path": { type: "string" },
    },
    strict: true,
  });
  const reportPath = values["report-path"]?.trim();
  if (!reportPath) {
    throw new Error("--report-path is required");
  }
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const sqlClient = postgres(databaseUrl, { max: 2 });
  const db = drizzle(sqlClient);
  const kms = new AwsStoredSecretKmsClient();
  try {
    const report = await runCustomCredentialBackfill({
      db,
      kms,
      options: {
        mode: values.migrate ? "migrate" : "dry-run",
        batchSize: parseBatchSize(values["batch-size"]),
        cursor: values.cursor?.trim() || undefined,
        reportPath,
      },
    });
    console.log(
      JSON.stringify({
        mode: report.mode,
        complete: report.complete,
        ready: report.ready,
        scannedRows: report.scannedRows,
      }),
    );
  } finally {
    kms.destroy();
    await sqlClient.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
