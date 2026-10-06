import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { drizzle } from "drizzle-orm/pglite";
import { singleton } from "../lib/singleton";
import { abortTestCaseOwner, withTestCaseOwner } from "./case-owner";
import { settleIncludingAbort } from "../signals/utils";

/** Cleanup always finishes; preserve both failures rather than masking work. */
async function releaseAfter<T>(
  work: Promise<T>,
  release: () => Promise<void>,
): Promise<T> {
  const result = await settleIncludingAbort(work);
  const released = await settleIncludingAbort(release);
  if (!result.ok) {
    if (!released.ok) {
      throw new AggregateError(
        [result.error, released.error],
        "Database work and cleanup failed",
      );
    }
    throw result.error;
  }
  if (!released.ok) {
    throw released.error;
  }
  return result.value;
}

const databaseScope = singleton(() => {
  return new AsyncLocalStorage<ReturnType<typeof drizzle>>();
});

/** No shared-PG fallback: all route, fixture and detached reads own this case. */
export function pgliteDatabase() {
  const database = databaseScope().getStore();
  if (!database) {
    throw new Error("PGlite database accessed outside its test owner");
  }
  return database;
}

async function migratedImage(): Promise<Blob> {
  const engine = new PGlite({ extensions: { pgcrypto, btree_gin } });
  return await releaseAfter(
    (async () => {
      const directory = new URL(
        "../../../../packages/db/src/migrations/",
        import.meta.url,
      );
      const files = (await readdir(directory))
        .filter((name) => {
          return /^\d+.*\.sql$/.test(name);
        })
        .sort();
      const journal = JSON.parse(
        await readFile(new URL("meta/_journal.json", directory), "utf8"),
      ) as {
        entries: { tag: string; when: number }[];
      };
      await engine.exec(
        "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
      );
      for (const name of files) {
        const original = await readFile(new URL(name, directory), "utf8");
        // Match the existing immutable-catalog harness: these two unsupported
        // extension declarations have no dependent table/constraint behavior.
        let sql = original;
        if (name === "1078_baseline.sql") {
          sql = sql
            .replace(
              "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
              "",
            )
            .replace(
              "COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';",
              "",
            );
        }
        sql = sql.replace(
          "CREATE EXTENSION IF NOT EXISTS pgstattuple WITH SCHEMA public;",
          "",
        );
        if (sql.includes("-- vm0:non-transactional")) {
          for (const statement of sql.split("--> statement-breakpoint")) {
            await engine.exec(statement);
          }
        } else if (
          /\b(?:CREATE|DROP) (?:UNIQUE )?INDEX CONCURRENTLY\b/.test(sql)
        ) {
          if (sql.includes("$$")) {
            throw new Error(
              "Concurrent migration requires SQL-aware statement boundaries",
            );
          }
          for (const statement of sql.split(";")) {
            if (statement.trim()) {
              await engine.exec(statement);
            }
          }
        } else {
          await engine.exec(sql);
        }
        const metadata = journal.entries.find((entry) => {
          return `${entry.tag}.sql` === name;
        });
        if (!metadata) {
          throw new Error(`Missing migration journal entry: ${name}`);
        }
        await engine.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [createHash("sha256").update(original).digest("hex"), metadata.when],
        );
      }
      await engine.exec("SET search_path TO public; SET timezone TO 'UTC'");
      return await engine.dumpDataDir();
    })(),
    async () => {
      await engine.close();
    },
  );
}

// Only immutable migrated baseline bytes are reused. Each case loads a private
// copy; no connections, transactions or mutable case data are shared.
const migrationImage = singleton(migratedImage);

/** Build immutable schema bytes during worker setup, not a case's hook. */
export async function preparePgliteDatabase(): Promise<void> {
  await migrationImage();
}

export interface PgliteTestOwner {
  readonly engine: PGlite;
  readonly signal: AbortSignal;
}

export async function withPgliteDatabase<T>(
  work: (owner: PgliteTestOwner) => Promise<T>,
  drain: () => Promise<void> = async () => {},
): Promise<T> {
  const engine = new PGlite({
    extensions: { pgcrypto, btree_gin },
    loadDataDir: await migrationImage(),
  });
  const controller = new AbortController();
  return await withTestCaseOwner(controller, async () => {
    return await databaseScope().run(drizzle(engine), async () => {
      return await releaseAfter(
        (async () => {
          await engine.waitReady;
          return await work({ engine, signal: controller.signal });
        })(),
        async () => {
          const finished = new DOMException(
            "PGlite test owner finished",
            "AbortError",
          );
          controller.abort(finished);
          abortTestCaseOwner(finished);
          await releaseAfter(
            (async () => {
              await drain();
            })(),
            async () => {
              await engine.close();
            },
          );
        },
      );
    });
  });
}
