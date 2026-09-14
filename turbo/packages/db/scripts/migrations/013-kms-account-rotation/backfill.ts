#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";

import { KMSClient } from "@aws-sdk/client-kms";
import { Client } from "pg";

import { fieldName, fields, type Field } from "./fields";
import {
  decode,
  decrypt,
  encode,
  encrypt,
  keyArnPattern,
  object,
  refersTo,
  resolvedKey,
  rewrap,
  string,
  type Envelope,
} from "./kms";

type Mode = "inventory" | "verify" | "migrate";

interface Counts {
  rows: number;
  envelope: number;
  direct: number;
  source: number;
  target: number;
  nonArn: number;
  invalid: number;
  unknownKey: number;
  nestedUninspected: number;
  nestedSource: number;
  nestedTarget: number;
  verified: number;
  updated: number;
  concurrentChanges: number;
}

interface Report {
  version: number;
  mode: Mode;
  source: string;
  target: string;
  database: string;
  manifest: string;
  startedAt: string;
  finishedAt: string;
  resumed: boolean;
  complete: boolean;
  databaseVerifiedOnTarget: boolean;
  failure: string | null;
  failureDetails?: { stage: string; code: string };
  cursor: string | null;
  totals: Counts;
  fields: Record<string, Counts>;
  missingOptionalFields: string[];
}

function keyRegion(source: string, target: string): string {
  const region = keyArnPattern.exec(source)?.[1];
  if (
    !region ||
    keyArnPattern.exec(target)?.[1] !== region ||
    source === target
  ) {
    throw new Error("invalid_keys");
  }
  return region;
}

function counts(): Counts {
  return {
    rows: 0,
    envelope: 0,
    direct: 0,
    source: 0,
    target: 0,
    nonArn: 0,
    invalid: 0,
    unknownKey: 0,
    nestedUninspected: 0,
    nestedSource: 0,
    nestedTarget: 0,
    verified: 0,
    updated: 0,
    concurrentChanges: 0,
  };
}

function integer(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new Error("invalid_numeric_option");
  }
  return result;
}

function quoted(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new Error("invalid_identifier");
  }
  return `"${value}"`;
}

function expression(field: Field): string {
  return field.jsonKey
    ? `${quoted(field.column)} ->> '${field.jsonKey}'`
    : quoted(field.column);
}

function isVerifiedOnTarget(
  mode: Mode,
  complete: boolean,
  resumed: boolean,
  totals: Counts,
): boolean {
  return (
    mode === "verify" &&
    complete &&
    !resumed &&
    totals.source === 0 &&
    totals.nestedSource === 0 &&
    totals.nonArn === 0 &&
    totals.invalid === 0 &&
    totals.unknownKey === 0
  );
}

function verificationConcurrency(
  mode: Mode,
  value: string | undefined,
): number {
  if (value !== undefined && mode !== "verify") {
    throw new Error("verify_concurrency_requires_verify_mode");
  }
  return integer(value, 1, 16);
}

function failureCode(error: unknown): string {
  // Retain only fixed codes, never provider messages, SQL, or input values.
  const cause =
    error instanceof Error && error.message === "verification_failed_at_cursor"
      ? error.cause
      : error;
  if (!(cause instanceof Error)) {
    return "unclassified_error";
  }
  const codes = new Set([
    "storage_manifest_mismatch",
    "primary_key_manifest_mismatch",
    "untracked_encrypted_columns",
    "unknown_queue_payload_version",
    "unexpected_key_reference",
    "unexpected_decrypt_response",
    "invalid_data_key_size",
    "invalid_object",
    "invalid_string",
    "invalid_base64",
    "invalid_envelope_prefix",
    "invalid_envelope_encoding",
    "invalid_envelope_shape",
    "invalid_data_key",
    "invalid_direct_ciphertext",
    "invalid_ciphertext_blocks_migration",
    "AccessDeniedException",
    "InvalidCiphertextException",
    "IncorrectKeyException",
    "DisabledException",
    "NotFoundException",
    "KMSInvalidStateException",
    "ThrottlingException",
    "DependencyTimeoutException",
    "ExpiredTokenException",
    "CredentialsProviderError",
    "TimeoutError",
    "SyntaxError",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "08006",
    "28P01",
    "3D000",
    "42501",
    "42703",
    "42P01",
    "57014",
    "53300",
    "55P03",
    "40001",
    "40P01",
  ]);
  for (const candidate of [
    "code" in cause ? cause.code : undefined,
    cause.name,
    cause.message,
  ]) {
    if (typeof candidate === "string" && codes.has(candidate)) {
      return candidate;
    }
  }
  return "unclassified_error";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "source-key": { type: "string" },
      "target-key": { type: "string" },
      "batch-size": { type: "string" },
      "max-rows": { type: "string" },
      "verify-concurrency": { type: "string" },
      "report-path": { type: "string" },
      cursor: { type: "string" },
      verify: { type: "boolean", default: false },
      migrate: { type: "boolean", default: false },
      preflight: { type: "string" },
    },
  });
  const source = string(values["source-key"]);
  const target = string(values["target-key"]);
  const region = keyRegion(source, target);
  if (values.verify && values.migrate) {
    throw new Error("invalid_mode");
  }
  const connectionString = string(process.env.DATABASE_URL);
  const url = new URL(connectionString);
  if (url.hostname.includes("-pooler.")) {
    throw new Error("direct_database_endpoint_required");
  }
  const database = createHash("sha256")
    .update(`${url.host}${url.pathname}:${url.username}`)
    .digest("hex");
  const manifest = createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");
  const mode: Mode = values.migrate
    ? "migrate"
    : values.verify
      ? "verify"
      : "inventory";
  const batchSize = integer(values["batch-size"], 100, 500);
  const maxRows = integer(
    values["max-rows"],
    5_000,
    mode === "verify" ? 1_000_000 : 100_000,
  );
  const verifyConcurrency = verificationConcurrency(
    mode,
    values["verify-concurrency"],
  );
  const reportPath = string(values["report-path"]);
  function initialCursor(): { fieldIndex: number; afterId: string | null } {
    let fieldIndex = 0;
    let afterId: string | null = null;
    if (values.cursor) {
      const cursor = object(
        JSON.parse(Buffer.from(values.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.database !== database ||
        cursor.manifest !== manifest ||
        cursor.source !== source ||
        cursor.target !== target ||
        cursor.mode !== mode ||
        !Number.isSafeInteger(cursor.field) ||
        typeof cursor.field !== "number" ||
        cursor.field < 0 ||
        cursor.field >= fields.length
      ) {
        throw new Error("cursor_scope_mismatch");
      }
      fieldIndex = cursor.field;
      afterId = cursor.id === null ? null : string(cursor.id);
    }
    return { fieldIndex, afterId };
  }
  let { fieldIndex, afterId } = initialCursor();
  async function checkPreflight(): Promise<void> {
    const preflight = object(
      JSON.parse(await readFile(string(values.preflight), "utf8")),
    );
    const totals = object(preflight.totals);
    const age = Date.now() - Date.parse(string(preflight.finishedAt));
    if (
      preflight.database !== database ||
      preflight.manifest !== manifest ||
      preflight.source !== source ||
      preflight.target !== target ||
      preflight.mode !== "verify" ||
      preflight.resumed !== false ||
      preflight.complete !== true ||
      preflight.failure !== null ||
      totals.invalid !== 0 ||
      totals.unknownKey !== 0 ||
      totals.nestedUninspected !== 0 ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 24 * 60 * 60 * 1_000
    ) {
      throw new Error("complete_recent_verified_preflight_required");
    }
  }
  if (values.migrate) {
    await checkPreflight();
  }

  const report: Report = {
    version: 1,
    mode,
    source,
    target,
    database,
    manifest,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    resumed: Boolean(values.cursor),
    complete: false,
    databaseVerifiedOnTarget: false,
    failure: null,
    cursor: null,
    totals: counts(),
    fields: {},
    missingOptionalFields: [],
  };
  async function checkpoint(): Promise<void> {
    report.finishedAt = new Date().toISOString();
    report.cursor = report.complete
      ? null
      : Buffer.from(
          JSON.stringify({
            database,
            manifest,
            source,
            target,
            mode,
            field: fieldIndex,
            id: afterId,
          }),
        ).toString("base64url");
    await writeFile(
      `${reportPath}.tmp`,
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(`${reportPath}.tmp`, reportPath);
  }

  const db = new Client({
    connectionString,
    application_name: "kms-account-rotation-32264",
    connectionTimeoutMillis: 15_000,
  });
  const kms = new KMSClient({
    region,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
  });
  let stage = "connect";
  try {
    await checkpoint();
    await db.connect();
    stage = "session";
    await db.query("SET statement_timeout = '15s'");
    await db.query("SET lock_timeout = '1s'");
    // Enforced by PostgreSQL for every query, including verification mode.
    await db.query(
      `SET default_transaction_read_only = ${values.migrate ? "off" : "on"}`,
    );
    async function inspectStorage(): Promise<Set<string>> {
      const catalogRows: unknown[] = (
        await db.query(
          "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'",
        )
      ).rows;
      const catalog = catalogRows.map((row) => {
        const data = object(row);
        return {
          table: string(data.table_name),
          column: string(data.column_name),
          type: string(data.data_type),
        };
      });
      const missing = new Set<string>();
      for (const field of fields) {
        const column = catalog.find((candidate) => {
          return (
            candidate.table === field.table && candidate.column === field.column
          );
        });
        if (
          !column &&
          field.optional &&
          !catalog.some((candidate) => {
            return candidate.table === field.table;
          })
        ) {
          missing.add(fieldName(field));
          report.missingOptionalFields.push(fieldName(field));
          continue;
        }
        if (
          !column ||
          (field.jsonKey ? column.type !== "jsonb" : column.type !== "text")
        ) {
          throw new Error("storage_manifest_mismatch");
        }
        const keys: unknown[] = (
          await db.query(
            "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary",
            [`public.${field.table}`],
          )
        ).rows;
        if (keys.length !== 1 || object(keys[0]).attname !== field.primaryKey) {
          throw new Error("primary_key_manifest_mismatch");
        }
      }
      const untracked = catalog.filter((column) => {
        return (
          column.column.startsWith("encrypted_") &&
          !fields.some((field) => {
            return (
              field.table === column.table && field.column === column.column
            );
          })
        );
      });
      if (untracked.length > 0) {
        throw new Error("untracked_encrypted_columns");
      }
      return missing;
    }
    stage = "storage_manifest";
    const missing = await inspectStorage();

    async function transformQueue(
      envelope: Envelope,
      arn: string,
      original: string,
      outcome: Counts,
    ): Promise<string> {
      let replacement = original;
      const plaintext = await decrypt(kms, envelope, arn);
      try {
        const map = object(JSON.parse(plaintext.toString("utf8")));
        const payload = object(
          JSON.parse(string(map.__api_runner_job_payload__)),
        );
        if (payload.version !== 1) {
          throw new Error("unknown_queue_payload_version");
        }
        const context = object(payload.executionContext);
        let nestedChanged = false;
        if (context.encryptedSecrets !== null) {
          const nested = decode(string(context.encryptedSecrets));
          const innerArn = resolvedKey(nested.kms.keyId, source, target);
          outcome[innerArn === source ? "nestedSource" : "nestedTarget"]++;
          if (!keyArnPattern.test(nested.kms.keyId)) {
            outcome.nonArn++;
          }
          const innerPlaintext = await decrypt(kms, nested, innerArn);
          innerPlaintext.fill(0);
          if (mode === "migrate" && nested.kms.keyId !== target) {
            context.encryptedSecrets = encode(
              await rewrap(kms, nested, source, target),
            );
            nestedChanged = true;
          }
        }
        if (mode === "migrate") {
          if (nestedChanged) {
            map.__api_runner_job_payload__ = JSON.stringify({
              ...payload,
              executionContext: context,
            });
            const updatedPlaintext = Buffer.from(JSON.stringify(map));
            try {
              // Changing an inner envelope requires a fresh outer data key and IV.
              replacement = encode(
                await encrypt(kms, updatedPlaintext, target),
              );
            } finally {
              updatedPlaintext.fill(0);
            }
          } else if (envelope.kms.keyId !== target) {
            replacement = encode(await rewrap(kms, envelope, source, target));
          }
        }
      } finally {
        plaintext.fill(0);
      }
      return replacement;
    }

    async function processRow(
      raw: unknown,
      field: Field,
    ): Promise<{ id: string; outcome: Counts }> {
      const row = object(raw);
      const id = string(row.id);
      const original = string(row.value);
      const outcome = counts();
      outcome.rows = 1;
      let envelope: Envelope | undefined;
      try {
        envelope = decode(original);
      } catch {
        // Malformed ciphertext is counted without logging its payload or parser error.
        outcome.invalid = 1;
      }
      if (envelope) {
        outcome[envelope.kms.encryptedDataKey ? "envelope" : "direct"] = 1;
        outcome.nonArn = keyArnPattern.test(envelope.kms.keyId) ? 0 : 1;
        if (refersTo(envelope.kms.keyId, source)) {
          outcome.source = 1;
        } else if (refersTo(envelope.kms.keyId, target)) {
          outcome.target = 1;
        } else {
          outcome.unknownKey = 1;
        }
        let replacement = original;
        if (mode !== "inventory") {
          const arn = resolvedKey(envelope.kms.keyId, source, target);
          if (field.nestedQueue) {
            replacement = await transformQueue(
              envelope,
              arn,
              original,
              outcome,
            );
          } else if (mode === "verify") {
            const plaintext = await decrypt(kms, envelope, arn);
            plaintext.fill(0);
          } else if (envelope.kms.keyId !== target) {
            replacement = encode(await rewrap(kms, envelope, source, target));
          }
          if (mode === "verify") {
            outcome.verified = 1;
          }
        } else if (field.nestedQueue) {
          outcome.nestedUninspected = 1;
        }
        if (replacement !== original) {
          const set = field.jsonKey
            ? `jsonb_set(${quoted(field.column)}, '{${field.jsonKey}}', to_jsonb($1::text), false)`
            : "$1";
          const result = await db.query(
            `UPDATE public.${quoted(field.table)} SET ${quoted(field.column)} = ${set} WHERE ${quoted(field.primaryKey)} = $2 AND ${expression(field)} = $3`,
            [replacement, id, original],
          );
          outcome[result.rowCount === 1 ? "updated" : "concurrentChanges"] = 1;
        }
      }
      if (mode === "migrate" && outcome.invalid) {
        throw new Error("invalid_ciphertext_blocks_migration");
      }
      return { id, outcome };
    }

    async function processRows(
      rows: unknown[],
      field: Field,
      fieldCounts: Counts,
    ): Promise<void> {
      function record(result: { id: string; outcome: Counts }): void {
        for (const name of Object.keys(result.outcome) as (keyof Counts)[]) {
          fieldCounts[name] += result.outcome[name];
          report.totals[name] += result.outcome[name];
        }
        afterId = result.id;
      }
      if (mode === "verify" && verifyConcurrency > 1) {
        for (let start = 0; start < rows.length; start += verifyConcurrency) {
          // Drain every request before advancing the cursor or handling failure.
          // Commit only the successful prefix in primary-key order, so a later
          // response can never move a checkpoint past an unverified row.
          const results = await Promise.allSettled(
            rows.slice(start, start + verifyConcurrency).map((raw) => {
              return processRow(raw, field);
            }),
          );
          for (const result of results) {
            if (result.status === "rejected") {
              throw new Error("verification_failed_at_cursor", {
                cause: result.reason,
              });
            }
            record(result.value);
          }
        }
      } else {
        for (const raw of rows) {
          record(await processRow(raw, field));
        }
      }
    }

    while (fieldIndex < fields.length && report.totals.rows < maxRows) {
      const field = fields[fieldIndex];
      if (!field) {
        throw new Error("invalid_field_cursor");
      }
      if (missing.has(fieldName(field))) {
        fieldIndex++;
        afterId = null;
        continue;
      }
      const fieldCounts = report.fields[fieldName(field)] ?? counts();
      report.fields[fieldName(field)] = fieldCounts;
      const size = Math.min(batchSize, maxRows - report.totals.rows);
      stage = "read_batch";
      const rows: unknown[] = (
        await db.query(
          `SELECT ${quoted(field.primaryKey)}::text AS id, ${expression(field)} AS value FROM public.${quoted(field.table)} WHERE ${expression(field)} IS NOT NULL ${afterId === null ? "" : `AND ${quoted(field.primaryKey)} > $2`} ORDER BY ${quoted(field.primaryKey)} LIMIT $1`,
          afterId === null ? [size] : [size, afterId],
        )
      ).rows;
      stage = "process_rows";
      await processRows(rows, field, fieldCounts);
      if (rows.length < size) {
        fieldIndex++;
        afterId = null;
      }
      report.complete = fieldIndex === fields.length;
      await checkpoint();
    }
    report.complete = fieldIndex === fields.length;
    report.databaseVerifiedOnTarget = isVerifiedOnTarget(
      mode,
      report.complete,
      report.resumed,
      report.totals,
    );
    await checkpoint();
    process.stdout.write(
      JSON.stringify({
        mode,
        complete: report.complete,
        resumed: report.resumed,
        databaseVerifiedOnTarget: report.databaseVerifiedOnTarget,
        totals: report.totals,
      }) + "\n",
    );
    if (report.totals.invalid || report.totals.unknownKey) {
      process.exitCode = 2;
    }
  } catch (error) {
    // Provider/SQL errors can include input data. Retain fixed codes only.
    report.failureDetails = { stage, code: failureCode(error) };
    report.failure = "migration_failed_at_cursor";
    await checkpoint();
    throw new Error("migration_failed_at_cursor");
  } finally {
    kms.destroy();
    await db.end();
  }
}

main().catch(() => {
  process.stderr.write(
    "KMS rotation failed; inspect the sanitized report and its checkpoint.\n",
  );
  process.exitCode = 1;
});
