import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { deserialize, serialize } from "node:v8";
import { MemoryFS, PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as nativeDrizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { Parser } from "tar";
import {
  array,
  boolean,
  discriminatedUnion,
  guid,
  literal,
  number,
  object,
  string,
  tuple,
  instanceof as zInstanceof,
  url as zUrl,
} from "zod";
import { API_DATABASE_SEED_FILES } from "./database-seeds";
import type { ApiDb } from "../lib/db-types";
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

interface BaselineDatabase {
  exec: (sql: string) => Promise<unknown>;
  query: (sql: string, values: unknown[]) => Promise<{ rows: unknown }>;
}

// Both engines replay the same canonical isolated baseline, never a shared
// database that a business case may already have mutated.
async function initializeBaseline(engine: BaselineDatabase): Promise<void> {
  const replayUuidBatch = async (statement: string, name: string) => {
    let cursor: string | null = null;
    while (true) {
      const result = await engine.query(statement, [cursor]);
      const [{ next_cursor: nextCursor }] = tuple([
        object({ next_cursor: guid().nullable() }),
      ]).parse(result.rows);
      if (nextCursor === null) {
        break;
      }
      if (cursor !== null && nextCursor <= cursor) {
        throw new Error(`Batch cursor did not advance in ${name}`);
      }
      cursor = nextCursor;
    }
  };
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
    // Keep the existing isolated baseline's extension omissions identical on
    // both engines; they have no dependent table/constraint behavior.
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
    } else if (/\b(?:CREATE|DROP) (?:UNIQUE )?INDEX CONCURRENTLY\b/.test(sql)) {
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
}

/** Build the migrated, seeded baseline once in the run's global setup. */
async function createPgliteSnapshot(): Promise<Blob> {
  const engine = new PGlite({
    extensions: { pgcrypto, btree_gin, btree_gist },
    parsers: driverParsers,
  });
  return await releaseAfter(
    (async () => {
      await initializeBaseline(engine);
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

const snapshotPathSchema = string()
  .startsWith("/pglite/data/")
  .refine((path) => {
    return !path.split("/").includes("..");
  }, "Invalid snapshot path");

const snapshotSchema = object({
  directories: array(snapshotPathSchema),
  files: array(
    object({
      path: snapshotPathSchema,
      data: zInstanceof(Uint8Array),
      modifiedAt: number().int(),
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

interface PgliteTestDatabase {
  readonly database: PgliteDatabase;
  readonly close: () => Promise<void>;
}

export interface IsolatedTestDatabase {
  readonly database: ApiDb | PgliteDatabase;
  readonly close: () => Promise<void>;
}

const namespaceSchema = string().regex(/^oa_[a-f0-9]{32}$/);
const descriptorSchema = discriminatedUnion("backend", [
  object({ backend: literal("pglite"), path: string() }).strict(),
  object({
    backend: literal("postgres"),
    connectionString: zUrl(),
    namespace: namespaceSchema,
  }).strict(),
]);

function databaseUrl(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

// Names are generated and validated here, never derived from case input.
function identifier(name: string): string {
  if (!/^oa_[a-f0-9]{32}_(?:template|case_[a-f0-9]{16})$/.test(name)) {
    throw new Error("Invalid isolated database identifier");
  }
  return `"${name}"`;
}

async function withNativeClient<T>(
  connectionString: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  const errors: Error[] = [];
  client.on("error", (error: Error) => {
    errors.push(error);
  });
  return await releaseAfter(
    (async () => {
      await client.connect();
      return await work(client);
    })(),
    async () => {
      await releaseAfter(client.end(), () => {
        if (errors.length) {
          return Promise.reject(
            new AggregateError(errors, "Isolated database connection failed"),
          );
        }
        return Promise.resolve();
      });
    },
  );
}

async function dropDatabase(connectionString: string, name: string) {
  await withNativeClient(connectionString, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
  });
}

// CREATE is never retried. A conflicting database is not ours to remove;
// otherwise reconcile a possibly completed creation by dropping only our name.
async function createDatabase(
  connectionString: string,
  name: string,
  template: string,
): Promise<boolean> {
  const created = await settleIncludingAbort(async () => {
    await withNativeClient(connectionString, async (client) => {
      const source =
        template === "template0" ? "template0" : identifier(template);
      await client.query(
        `CREATE DATABASE ${identifier(name)} TEMPLATE ${source}`,
      );
    });
  });
  if (!created.ok) {
    const code = object({ code: string() }).safeParse(created.error);
    if (code.success && code.data.code === "42501") {
      return false;
    }
    if (code.success && code.data.code === "42P04") {
      throw created.error;
    }
    return await releaseAfter(Promise.reject(created.error), async () => {
      await dropDatabase(connectionString, name);
    });
  }
  return true;
}

export interface ApiDatabaseSnapshot {
  readonly path: string;
  readonly close: () => Promise<void>;
}

/** Freeze a run's backend once, retaining environments without CREATEDB. */
export async function createApiDatabaseSnapshot(
  directory: string,
  connectionString: string,
): Promise<ApiDatabaseSnapshot> {
  const namespace = namespaceSchema.parse(
    `oa_${randomUUID().replaceAll("-", "")}`,
  );
  const template = `${namespace}_template`;
  const capabilities = await withNativeClient(
    connectionString,
    async (client) => {
      const result = await client.query(
        "SELECT rolcreatedb OR rolsuper AS capable, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
      );
      return tuple([
        object({ capable: boolean(), superuser: boolean() }),
      ]).parse(result.rows)[0];
    },
  );
  const native =
    capabilities.capable &&
    (await createDatabase(connectionString, template, "template0"));
  const close = async () => {
    if (native) {
      // Prefix comparison is literal (LIKE would treat underscores as wildcards).
      const cases = await withNativeClient(connectionString, async (client) => {
        const result = await client.query(
          "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
          [`${namespace}_case_`],
        );
        return array(object({ datname: string() })).parse(result.rows);
      });
      for (const { datname } of cases) {
        await dropDatabase(connectionString, datname);
      }
      await dropDatabase(connectionString, template);
    }
  };
  const initialized = await settleIncludingAbort(async () => {
    const path = join(directory, "database.json");
    if (native) {
      await withNativeClient(
        databaseUrl(connectionString, template),
        async (client) => {
          await initializeBaseline({
            exec: async (sql) => {
              return await client.query(sql);
            },
            query: async (sql, values) => {
              return await client.query(sql, values);
            },
          });
          if (capabilities.superuser) {
            // The run owns the seeded baseline flush, rather than the first
            // isolated case paying for it when dropping its database.
            await client.query("CHECKPOINT");
          }
        },
      );
      await writeFile(
        path,
        JSON.stringify({ backend: "postgres", connectionString, namespace }),
        { mode: 0o600 },
      );
    } else {
      const image = await createPgliteSnapshot();
      const imagePath = join(directory, "seeded.tar");
      await writeFile(imagePath, new Uint8Array(await image.arrayBuffer()), {
        mode: 0o600,
      });
      await writeFile(
        path,
        JSON.stringify({ backend: "pglite", path: imagePath }),
        {
          mode: 0o600,
        },
      );
    }
    return { path, close };
  });
  if (!initialized.ok) {
    return await releaseAfter(Promise.reject(initialized.error), close);
  }
  return initialized.value;
}

export async function createIsolatedDatabase(
  path: string,
): Promise<IsolatedTestDatabase> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  const descriptor = descriptorSchema.parse(decoded);
  if (descriptor.backend === "pglite") {
    return await createPgliteDatabase(descriptor.path);
  }
  const { connectionString, namespace } = descriptor;
  const name = `${namespace}_case_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  if (
    !(await createDatabase(connectionString, name, `${namespace}_template`))
  ) {
    // Capability is frozen by global setup; never switch an individual case.
    throw new Error(
      "Isolated database creation permission changed during the run",
    );
  }
  const pool = new Pool({
    connectionString: databaseUrl(connectionString, name),
  });
  const errors: Error[] = [];
  pool.on("error", (error: Error) => {
    errors.push(error);
  });
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= releaseAfter(
      releaseAfter(pool.end(), async () => {
        await dropDatabase(connectionString, name);
      }),
      () => {
        if (errors.length) {
          return Promise.reject(
            new AggregateError(errors, "Isolated database pool failed"),
          );
        }
        return Promise.resolve();
      },
    );
    return closing;
  };
  const ready = await settleIncludingAbort(async () => {
    const result = await pool.query("SHOW TimeZone");
    object({ TimeZone: literal("UTC") }).parse(result.rows[0]);
    return { database: nativeDrizzle(pool), close };
  });
  if (!ready.ok) {
    return await releaseAfter(Promise.reject(ready.error), close);
  }
  return ready.value;
}

/** Fork the run's seeded image; cleanup belongs to the enclosing case owner. */
async function createPgliteDatabase(
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
