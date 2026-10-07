import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import type { Logger } from "drizzle-orm/logger";
import { singleton } from "../lib/singleton";
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

// node-postgres returns int8/numeric as text. Match that real driver contract
// before Drizzle maps fields, without losing precision or changing SQL results.
const driverParsers = Object.freeze({
  20: (value: string) => {
    return value;
  },
  1700: (value: string) => {
    return value;
  },
});

/** Build the migrated, seeded baseline once in the run's global setup. */
export async function createPgliteSnapshot(
  seed: (database: PgliteDatabase) => Promise<void>,
): Promise<Blob> {
  const engine = new PGlite({
    extensions: { pgcrypto, btree_gin },
    parsers: driverParsers,
  });
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
      await seed(drizzle(engine));
      return await engine.dumpDataDir();
    })(),
    async () => {
      await engine.close();
    },
  );
}

// Cache only immutable bytes. Every case loads a fresh engine from the image.
const snapshotImages = singleton(() => {
  return new Map<string, Promise<Blob>>();
});

async function readSnapshotImage(path: string): Promise<Blob> {
  const bytes = await readFile(path);
  return new Blob([new Uint8Array(bytes)]);
}

function snapshotImage(path: string): Promise<Blob> {
  const images = snapshotImages();
  let image = images.get(path);
  if (!image) {
    image = readSnapshotImage(path);
    images.set(path, image);
  }
  return image;
}

export interface PgliteTestDatabase {
  readonly engine: PGlite;
  readonly database: PgliteDatabase;
  readonly setLogger: (logger: Logger) => void;
  readonly close: () => Promise<void>;
}

/** Fork the run's seeded image; cleanup belongs to the enclosing case owner. */
export async function createPgliteDatabase(
  snapshotPath: string,
): Promise<PgliteTestDatabase> {
  const engine = new PGlite({
    extensions: { pgcrypto, btree_gin },
    loadDataDir: await snapshotImage(snapshotPath),
    parsers: driverParsers,
  });
  let logger: Logger | undefined;
  const database = drizzle(engine, {
    logger: {
      logQuery(query, parameters) {
        logger?.logQuery(query, parameters);
      },
    },
  });
  const ready = await settleIncludingAbort(async () => {
    await engine.waitReady;
    // Session settings are not carried by dumpDataDir/loadDataDir. Keep UTC
    // timestamp-without-time-zone columns consistent with PostgreSQL tests.
    await engine.exec("SET search_path TO public; SET timezone TO 'UTC'");
  });
  if (!ready.ok) {
    return await releaseAfter(Promise.reject(ready.error), async () => {
      await engine.close();
    });
  }
  return {
    engine,
    database,
    setLogger(next) {
      logger = next;
    },
    close: async () => {
      await engine.close();
    },
  };
}
