import { createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { deserialize, serialize } from "node:v8";
import { MemoryFS, PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { Parser } from "tar";
import { z } from "zod";
import { API_DATABASE_SEED_FILES } from "./database-seeds";
import { singleton } from "../lib/singleton";
import { settleIncludingAbort } from "../signals/utils";

// The API uses ES-only TypeScript libraries. Describe Node's existing runtime
// value with the SDK's public option type, without adding browser globals.
declare const WebAssembly: {
  compile(
    bytes: Uint8Array,
  ): Promise<NonNullable<PGliteOptions["pgliteWasmModule"]>>;
};

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
export async function createPgliteSnapshot(): Promise<Blob> {
  const engine = new PGlite({
    extensions: { pgcrypto, btree_gin, btree_gist },
    parsers: driverParsers,
  });
  const replayUuidBatch = async (statement: string, name: string) => {
    let cursor: string | null = null;
    while (true) {
      const result = await engine.query(statement, [cursor]);
      const [{ next_cursor: nextCursor }] = z
        .tuple([z.object({ next_cursor: z.guid().nullable() })])
        .parse(result.rows);
      if (nextCursor === null) {
        break;
      }
      if (cursor !== null && nextCursor <= cursor) {
        throw new Error(`Batch cursor did not advance in ${name}`);
      }
      cursor = nextCursor;
    }
  };
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
        // These two unsupported
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
        if (sql.includes("-- okou:non-transactional")) {
          for (const statement of sql.split("--> statement-breakpoint")) {
            if (statement.includes("-- okou:batch-by-uuid")) {
              await replayUuidBatch(statement, name);
            } else {
              await engine.exec(statement);
            }
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
        } else if (sql.includes("-- okou:batch-by-uuid")) {
          for (const statement of sql.split("--> statement-breakpoint")) {
            if (!statement.includes("-- okou:batch-by-uuid")) {
              await engine.exec(statement);
              continue;
            }
            await replayUuidBatch(statement, name);
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
      for (const file of API_DATABASE_SEED_FILES) {
        await engine.exec(await readFile(file, "utf8"));
      }
      // Checkpoint the seeded baseline to reduce WAL recovery when restoring cases.
      await engine.exec("CHECKPOINT");
      const image = await engine.dumpDataDir("none");
      const snapshot = await readSnapshotFiles(
        Buffer.from(await image.arrayBuffer()),
      );
      // Decode the physical archive once for the run. Workers only read the
      // indexed files; every case still receives its own writable copies.
      return new Blob([serialize(snapshot)]);
    })(),
    async () => {
      await engine.close();
    },
  );
}

interface SnapshotFile {
  readonly path: string;
  readonly data: Uint8Array;
  readonly modifiedAt: number;
}

interface SnapshotFiles {
  readonly directories: readonly string[];
  readonly files: readonly SnapshotFile[];
}

const snapshotPathSchema = z
  .string()
  .startsWith("/pglite/data/")
  .refine((path) => {
    return !path.split("/").includes("..");
  }, "Invalid snapshot path");

const snapshotSchema = z.object({
  directories: z.array(snapshotPathSchema),
  files: z.array(
    z.object({
      path: snapshotPathSchema,
      data: z.instanceof(Uint8Array),
      modifiedAt: z.number().int(),
    }),
  ),
});

// Decode immutable files once. Each engine still owns separate writable copies.
const snapshots = singleton(() => {
  return new Map<string, Promise<SnapshotFiles>>();
});

// PGlite exposes a precompiled-module option. Compile its immutable program
// on first isolated use; each case instantiates its own memory and database.
const postgresModule = singleton(async () => {
  const entry = createRequire(import.meta.url).resolve("@electric-sql/pglite");
  const bytes = await readFile(join(dirname(entry), "pglite.wasm"));
  return await WebAssembly.compile(new Uint8Array(bytes));
});

async function readSnapshotFiles(bytes: Buffer): Promise<SnapshotFiles> {
  const directories: string[] = [];
  const files: SnapshotFile[] = [];
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      const relativePath = entry.path.replace(/^\/+/, "");
      if (relativePath.split("/").includes("..")) {
        parser.abort(new Error(`Invalid snapshot path: ${entry.path}`));
        return;
      }
      const target = `/pglite/data/${relativePath}`;
      if (entry.type === "Directory") {
        directories.push(target);
        entry.resume();
        return;
      }
      if (entry.type !== "File") {
        parser.abort(new Error(`Unsupported snapshot entry: ${entry.type}`));
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("error", (error: unknown) => {
        parser.abort(
          new Error(`Cannot read snapshot entry: ${entry.path}`, {
            cause: error,
          }),
        );
      });
      entry.on("end", () => {
        if (!entry.mtime) {
          parser.abort(
            new Error(`Missing snapshot modification time: ${entry.path}`),
          );
          return;
        }
        const [singleChunk] = chunks;
        files.push({
          path: target,
          // These image views stay immutable. Each engine still copies them
          // before taking writable ownership in SnapshotMemoryFS.
          data:
            chunks.length === 1 && singleChunk
              ? singleChunk
              : Buffer.concat(chunks),
          modifiedAt: Math.floor(entry.mtime.getTime() / 1000),
        });
      });
    },
  });
  parser.on("error", (error: Error) => {
    parser.abort(error);
  });
  const completed = once(parser, "end");
  parser.end(bytes);
  await completed;
  return { directories, files };
}

async function readIndexedSnapshot(path: string): Promise<SnapshotFiles> {
  const bytes = await readFile(path);
  const decoded: unknown = deserialize(bytes);
  return snapshotSchema.parse(decoded);
}

function snapshotFiles(path: string): Promise<SnapshotFiles> {
  const images = snapshots();
  let files = images.get(path);
  if (!files) {
    files = readIndexedSnapshot(path);
    images.set(path, files);
  }
  return files;
}

class SnapshotMemoryFS extends MemoryFS {
  constructor(private readonly snapshot: SnapshotFiles) {
    super();
  }

  override async initialSyncFs(): Promise<void> {
    await super.initialSyncFs();
    if (!this.pg) {
      throw new Error("Snapshot filesystem has not been initialized");
    }
    const filesystem = this.pg.Module.FS;
    filesystem.mkdirTree("/pglite/data");
    for (const directory of this.snapshot.directories) {
      filesystem.mkdirTree(directory);
    }
    for (const file of this.snapshot.files) {
      // Transfer a fresh copy so each engine can mutate files independently.
      filesystem.writeFile(file.path, new Uint8Array(file.data), {
        canOwn: true,
      });
      filesystem.utime(file.path, file.modifiedAt, file.modifiedAt);
    }
  }
}

export interface PgliteTestDatabase {
  readonly database: PgliteDatabase;
  readonly close: () => Promise<void>;
}

/** Fork the run's seeded image; cleanup belongs to the enclosing case owner. */
export async function createPgliteDatabase(
  snapshotPath: string,
): Promise<PgliteTestDatabase> {
  const [snapshot, pgliteWasmModule] = await Promise.all([
    snapshotFiles(snapshotPath),
    postgresModule(),
  ]);
  const engine = new PGlite({
    extensions: { pgcrypto, btree_gin, btree_gist },
    fs: new SnapshotMemoryFS(snapshot),
    pgliteWasmModule,
    parsers: driverParsers,
  });
  const database = drizzle(engine);
  const ready = await settleIncludingAbort(async () => {
    await engine.waitReady;
    // Session settings are not carried by filesystem snapshots. Keep UTC
    // timestamp-without-time-zone columns consistent with PostgreSQL tests.
    await engine.exec("SET search_path TO public; SET timezone TO 'UTC'");
  });
  if (!ready.ok) {
    return await releaseAfter(Promise.reject(ready.error), async () => {
      await engine.close();
    });
  }
  return {
    database,
    close: async () => {
      await engine.close();
    },
  };
}
