import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify, parseArgs } from "node:util";
import postgres from "postgres";
import { z } from "zod";
import { identity, pg, recordIntent, reconcileEmpty, writeReceipt } from "./io";
import {
  approvalSchema,
  archiveSchema,
  jobsSchema,
  preparationCommit,
  receiptSchema,
  rowsSchema,
  sha256,
  snapshotSchema,
  tables,
  validatePolicy,
  validateRetirementReceipts,
} from "./format";

const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    "verify-restore": { type: "string" },
    migrate: { type: "boolean", default: false },
    "approval-file": { type: "string" },
    "expect-host": { type: "string" },
    "expect-database": { type: "string" },
    "expect-restore-host": { type: "string" },
    "expect-restore-database": { type: "string" },
  },
});
const environment = z
  .object({
    DATABASE_URL_FILE: z.string().min(1),
    RESTORE_DATABASE_URL_FILE: z.string().optional(),
    PG_BIN: z.string().optional(),
  })
  .parse(process.env);

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  if (values["verify-restore"] && (values.archive || values.migrate))
    throw new Error("ChooseOneMode");
  if (values.migrate && (!values.archive || !values["approval-file"]))
    throw new Error("MigrateRequiresArchiveAndApproval");
  const credential = (
    await readFile(environment.DATABASE_URL_FILE, "utf8")
  ).trim();
  const source = identity(credential);
  if (
    values.migrate &&
    (values["expect-host"] !== source.host ||
      values["expect-database"] !== source.database)
  )
    throw new Error("SourceIdentityNotConfirmed");
  const db = postgres(credential, {
    max: 1,
    onnotice() {},
    connection: values.migrate
      ? { TimeZone: "UTC" }
      : { TimeZone: "UTC", default_transaction_read_only: true },
  });
  try {
    const capture = async () => {
      const schemaRows = z.array(z.object({ document: z.string() })).parse(
        await db`
        SELECT jsonb_build_object(
          'dependencies', (SELECT jsonb_agg(description ORDER BY description) FROM (
            SELECT pg_describe_object('pg_constraint'::regclass, oid, 0) AS description FROM pg_constraint
              WHERE confrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(${tables}::text[]))
            UNION SELECT pg_describe_object('pg_trigger'::regclass, oid, 0) FROM pg_trigger
              WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(${tables}::text[]))
            UNION SELECT pg_describe_object('pg_rewrite'::regclass, oid, 0) FROM pg_rewrite
              WHERE ev_class IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(${tables}::text[]))
            UNION SELECT format('inheritance %s -> %s',inhparent::regclass,inhrelid::regclass) FROM pg_inherits
              WHERE inhparent IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(${tables}::text[]))
                 OR inhrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(${tables}::text[]))
          ) dependencies),
          'columns', (SELECT jsonb_agg(to_jsonb(c) - 'table_catalog' - 'udt_catalog' - 'domain_catalog' ORDER BY table_name, ordinal_position)
            FROM information_schema.columns c WHERE table_schema = 'public' AND table_name = ANY(${tables}::text[])),
          'constraints', (SELECT jsonb_agg(jsonb_build_object('table', conrelid::regclass::text, 'name', conname, 'definition', pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text, conname)
            FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${tables}::text[]))),
          'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY tablename, indexname)
            FROM pg_indexes i WHERE schemaname = 'public' AND tablename = ANY(${tables}::text[]))
        )::text AS document`,
      );
      if (schemaRows.length !== 1) throw new Error("SchemaInventoryMissing");
      const captured = [];
      for (const table of tables) {
        const rows = rowsSchema.parse(
          await db.unsafe(
            `SELECT id::text, to_jsonb(t)::text AS document FROM public.${table} t ORDER BY id LIMIT 5001`,
          ),
        );
        if (rows.length > 5000)
          throw new Error("InventoryExceedsReviewedBound");
        captured.push({ name: table, rows });
      }
      return snapshotSchema.parse({
        schema: schemaRows[0]?.document,
        tables: captured,
      });
    };
    const loadArchive = async (directory: string) => {
      const bytes = await readFile(path.join(directory, "archive.json"));
      const archive = archiveSchema.parse(JSON.parse(bytes.toString("utf8")));
      const dump = await readFile(path.join(directory, "jobs.dump"));
      if (sha256(dump) !== archive.dumpSha256)
        throw new Error("DumpHashMismatch");
      if (
        archive.snapshot.tables.some((table, index) => {
          return table.name !== tables[index];
        })
      )
        throw new Error("ArchiveTableSetMismatch");
      return { archive, archiveSha256: sha256(bytes), dump };
    };
    const verifyRestore = async (directory: string) => {
      const loaded = await loadArchive(directory);
      if (!environment.RESTORE_DATABASE_URL_FILE)
        throw new Error("RestoreCredentialMissing");
      const restoreUri = (
        await readFile(environment.RESTORE_DATABASE_URL_FILE, "utf8")
      ).trim();
      const destination = identity(restoreUri);
      if (
        (destination.host === source.host &&
          destination.database === source.database) ||
        (destination.host === loaded.archive.source.host &&
          destination.database === loaded.archive.source.database) ||
        destination.host !== values["expect-restore-host"] ||
        destination.database !== values["expect-restore-database"]
      )
        throw new Error("DisposableRestoreIdentityNotConfirmed");
      const restore = postgres(restoreUri, { max: 1, onnotice() {} });
      try {
        for (const table of tables) {
          const rows = z
            .array(z.object({ count: z.string() }))
            .parse(
              await restore.unsafe(
                `SELECT count(*)::text AS count FROM public.${table}`,
              ),
            );
          if (rows[0]?.count !== "0") throw new Error("RestoreTargetNotEmpty");
        }
      } finally {
        await restore.end();
      }
      await pg(
        "pg_restore",
        [
          "--dbname",
          destination.database,
          "--data-only",
          "--exit-on-error",
          "--no-owner",
          "--no-privileges",
          path.join(directory, "jobs.dump"),
        ],
        restoreUri,
        environment.PG_BIN,
      );
      // Reuse the read-only inventory entry point on the disposable target.
      const result = await exec(
        process.execPath,
        ["--import", "tsx", import.meta.filename],
        {
          env: {
            ...process.env,
            DATABASE_URL_FILE: environment.RESTORE_DATABASE_URL_FILE,
          },
          maxBuffer: 1024 * 1024,
        },
      );
      const restored = z
        .object({ snapshotSha256: z.string() })
        .parse(JSON.parse(result.stdout));
      if (
        restored.snapshotSha256 !==
        sha256(JSON.stringify(loaded.archive.snapshot))
      )
        throw new Error("RestoredSnapshotMismatch");
      const receipt = {
        archiveSha256: loaded.archiveSha256,
        dumpSha256: loaded.archive.dumpSha256,
        restoredAt: new Date().toISOString(),
        restoredTo: destination,
      };
      await writeFile(
        path.join(directory, "restore-receipt.json"),
        `${JSON.stringify(receipt, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      output({
        result: "restore-verified",
        archiveSha256: loaded.archiveSha256,
      });
      return;
    };
    const migrate = async (directory: string, approvalPath: string) => {
      const loaded = await loadArchive(directory);
      const receipt = receiptSchema.parse(
        JSON.parse(
          await readFile(path.join(directory, "restore-receipt.json"), "utf8"),
        ),
      );
      const approvalBytes = await readFile(approvalPath);
      const approval = approvalSchema.parse(
        JSON.parse(approvalBytes.toString("utf8")),
      );
      validateRetirementReceipts(
        loaded.archive,
        loaded.archiveSha256,
        receipt,
        approval,
        source,
      );
      if (approval.productionCommit !== preparationCommit) {
        try {
          await exec("git", [
            "merge-base",
            "--is-ancestor",
            preparationCommit,
            approval.productionCommit,
          ]);
        } catch {
          throw new Error("ProductionCommitMissingPreparation");
        }
      }
      const jobs = new Map<string, z.infer<typeof jobsSchema>>();
      for (const table of loaded.archive.snapshot.tables) {
        // Decode only settlement selectors in PostgreSQL, preserving large integers.
        jobs.set(
          table.name,
          jobsSchema.parse(
            await db`
          SELECT document->>'id' AS id, document->>'status' AS status,
            document->>'credits_charged' AS charge, document->>'reserved_credits' AS reserved,
            document->>'max_credits' AS "maxCredits", document->>'actual_cost_usd_micros' AS "actualCost",
            document->>'completed_at' AS "completedAt", document->>'upstream_run_id' AS upstream
          FROM (SELECT item->>'document' AS text FROM jsonb_array_elements(${JSON.stringify(table.rows)}::text::jsonb) item) records
          CROSS JOIN LATERAL (SELECT text::jsonb AS document) decoded`,
          ),
        );
      }
      validatePolicy(jobs, approval);
      const before = await capture();
      if (before.schema !== loaded.archive.snapshot.schema)
        throw new Error("SourceSchemaChanged");
      const dependencies = z
        .object({ dependencies: z.array(z.string()).nullable() })
        .parse(JSON.parse(before.schema));
      if (dependencies.dependencies?.length)
        throw new Error("UnexpectedDeleteDependencies");
      const empty = before.tables.every((table) => {
        return table.rows.length === 0;
      });
      if (
        !empty &&
        JSON.stringify(before) !== JSON.stringify(loaded.archive.snapshot)
      )
        throw new Error("SourceRowsChanged");
      if (empty) {
        await reconcileEmpty(
          directory,
          loaded.archiveSha256,
          sha256(approvalBytes),
          source,
        );
        output({
          result: "already-retired",
          archiveSha256: loaded.archiveSha256,
        });
        return;
      }
      const legacyUsage = z.array(z.object({ count: z.string() })).parse(
        await db`
        SELECT count(*)::text AS count FROM usage_event
        WHERE (kind IN ('finance','maps','weather','seo','social','commerce','scrape','web-search','people-search')
          OR (kind = 'data-search' AND provider <> 'data-router')
          OR pricing_unit_price IS NOT NULL OR pricing_unit_size IS NOT NULL OR pricing_credits_limit IS NOT NULL)
        AND (status NOT IN ('processed','compacted') OR processed_at IS NULL OR credits_charged IS NULL OR billing_error IS NOT NULL)`,
      );
      if (legacyUsage[0]?.count !== "0")
        throw new Error("UnsettledLegacyUsage");
      const archived = loaded.archive.snapshot.tables;
      const declarations = tables.map((table, index) => {
        return `a${index} AS MATERIALIZED (SELECT id::uuid AS id, document::jsonb AS document FROM jsonb_to_recordset($${index + 1}::text::jsonb) x(id text, document text))`;
      });
      const predicates = tables.map((table, index) => {
        return `(SELECT count(*) FROM public.${table}) = (SELECT count(*) FROM a${index}) AND NOT EXISTS (SELECT FROM public.${table} t LEFT JOIN a${index} a ON a.id = t.id WHERE a.id IS NULL OR to_jsonb(t) <> a.document)`;
      });
      const targetRelations = `SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('commerce_jobs','data_search_jobs','social_data_jobs','socialkit_download_jobs')`;
      const dependenciesAbsent = `NOT EXISTS (
        SELECT FROM pg_constraint WHERE confrelid IN (${targetRelations})
        UNION ALL SELECT FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (${targetRelations})
        UNION ALL SELECT FROM pg_rewrite WHERE ev_class IN (${targetRelations})
        UNION ALL SELECT FROM pg_inherits WHERE inhparent IN (${targetRelations}) OR inhrelid IN (${targetRelations})
      )`;
      const deletions = tables.map((table, index) => {
        return `d${index} AS (DELETE FROM public.${table} t USING a${index} a WHERE t.id = a.id AND to_jsonb(t) = a.document AND (SELECT ok FROM ready) RETURNING t.id)`;
      });
      const intent = await recordIntent(
        directory,
        loaded.archiveSha256,
        sha256(approvalBytes),
        source,
        archived.map((table) => {
          return {
            table: table.name,
            count: table.rows.length,
          };
        }),
      );
      let observedCounts: unknown = null;
      try {
        const results = z
          .array(z.object({ table: z.enum(tables), deleted: z.string() }))
          .length(4)
          .parse(
            await db.unsafe(
              `WITH ${declarations.join(",")}, ready AS MATERIALIZED (SELECT ${predicates.join(" AND ")} AND ${dependenciesAbsent} AS ok), ${deletions.join(",")} ${tables
                .map((table, index) => {
                  return `SELECT '${table}'::text AS table, count(*)::text AS deleted FROM d${index}`;
                })
                .join(" UNION ALL ")}`,
              archived.map((table) => {
                return JSON.stringify(table.rows);
              }),
            ),
          );
        observedCounts = results;
        // No retry: updates can reduce DELETE counts after the statement snapshot.
        if (
          results.some((row) => {
            return (
              BigInt(row.deleted) !==
              BigInt(
                archived.find((table) => {
                  return table.name === row.table;
                })?.rows.length ?? -1,
              )
            );
          })
        )
          throw new Error("RetirementCountMismatchInspectCommittedState");
        const after = await capture();
        if (
          after.tables.some((table) => {
            return table.rows.length !== 0;
          })
        )
          throw new Error("NewLegacyRowsAfterRetirementInspectCommittedState");
        await writeReceipt(path.join(directory, "retirement-receipt.json"), {
          ...intent,
          completedAt: new Date().toISOString(),
          deleted: results,
          disposition:
            "platform-absorbs-unconfirmed-cost-no-additional-charge-no-refund-or-compensation",
        });
        output({
          result: "retired",
          deleted: results,
          archiveSha256: loaded.archiveSha256,
        });
      } catch (error) {
        await writeReceipt(path.join(directory, "retirement-outcome.json"), {
          ...intent,
          observedAt: new Date().toISOString(),
          outcome: "uncertain-or-incomplete",
          observedCounts,
          nextAction:
            "inspect authoritative tables; do not replay automatically",
        });
        throw error;
      }
      return;
    };
    if (values["verify-restore"]) {
      await verifyRestore(await realpath(values["verify-restore"]));
      return;
    }
    if (values.migrate && values.archive && values["approval-file"]) {
      await migrate(await realpath(values.archive), values["approval-file"]);
      return;
    }
    const before = await capture();
    if (!values.archive) {
      output({
        result: "dry-run",
        snapshotSha256: sha256(JSON.stringify(before)),
        tables: before.tables.map((table) => {
          return {
            table: table.name,
            count: table.rows.length,
          };
        }),
      });
      return;
    }
    const directory = path.resolve(values.archive);
    await mkdir(directory, { mode: 0o700 });
    // The containing directory is private before pg_dump creates its output.
    await pg(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        ...tables.flatMap((table) => {
          return ["--table", `public.${table}`];
        }),
        "--file",
        path.join(directory, "jobs.dump"),
      ],
      credential,
      environment.PG_BIN,
    );
    await chmod(path.join(directory, "jobs.dump"), 0o600);
    const after = await capture();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("SourceChangedDuringArchive");
    const dump = await readFile(path.join(directory, "jobs.dump"));
    const archive = {
      version: 1,
      createdAt: new Date().toISOString(),
      source,
      snapshot: before,
      dumpSha256: sha256(dump),
    };
    const bytes = `${JSON.stringify(archive, null, 2)}\n`;
    await writeFile(path.join(directory, "archive.json"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    output({
      result: "archived",
      archiveSha256: sha256(bytes),
      dumpSha256: archive.dumpSha256,
      tables: before.tables.map((table) => {
        return {
          table: table.name,
          count: table.rows.length,
        };
      }),
    });
  } finally {
    await db.end();
  }
}
await main().catch((error: unknown) => {
  // Do not print driver/subprocess error messages that can contain private data.
  const classification =
    error instanceof Error && /^[A-Z][A-Za-z]+$/u.test(error.message)
      ? error.message
      : "OperatorFailed";
  process.stderr.write(
    `${JSON.stringify({ result: "stopped", classification })}\n`,
  );
  process.exitCode = 1;
});
