import { trace } from "@opentelemetry/api";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { instrumentPgPool, PgConnectionRuntime } from "./db-instrumentation";
import type { ApiDb } from "./db-types";
import { env } from "./env";
import { logger } from "./log";
import { singleton } from "./singleton";

const log = logger("api:db");

interface SingletonValue<T> {
  (): T;
  readonly peek: () => T | undefined;
  readonly reset: () => void;
}

interface DatabaseRuntime {
  readonly db: () => ApiDb;
  readonly closePool: () => Promise<void>;
}

function createPool(connections: PgConnectionRuntime): Pool {
  // The official pg instrumentation normally hooks Pool through
  // require-in-the-middle. The single-file Vercel bundle prevents that hook,
  // so instrument this lazy singleton directly. The tracer is a no-op when no
  // provider is registered, keeping local development and ordinary tests
  // lightweight.
  const pgPool = instrumentPgPool(
    new Pool({
      allowExitOnIdle: true,
      connectionString: env("DATABASE_URL"),
      min: 1,
      max: env("DB_POOL_MAX"),
      idleTimeoutMillis: env("DB_POOL_IDLE_TIMEOUT_MS"),
      connectionTimeoutMillis: env("DB_POOL_CONNECT_TIMEOUT_MS"),
      stream: () => {
        return connections.createStream();
      },
    }),
    trace.getTracer("vm0-api/pg"),
  );
  pgPool.on("error", (error: Error) => {
    log.warn("idle database client error", { error: error.message });
  });
  const activeClientError = (error: Error) => {
    // PostgreSQL can terminate an in-flight session (for example when
    // transaction_timeout expires) after rejecting its active query. The query
    // promise still owns that failure; this listener prevents the separate
    // connection event from becoming an uncaught process error.
    log.warn("active database client error", { error: error.message });
  };
  pgPool.on("acquire", (client) => {
    client.on("error", activeClientError);
  });
  pgPool.on("release", (_error, client) => {
    client.removeListener("error", activeClientError);
  });

  attachDatabasePool(pgPool);

  return pgPool;
}

const databaseRuntime = singleton((): DatabaseRuntime => {
  // The connection owner outlives replaceable pools: a winning DNS hedge can
  // finish a query while its original lookup is still using process capacity.
  const connections = new PgConnectionRuntime();
  const pool = singleton((): Pool => {
    return createPool(connections);
  });

  const database: SingletonValue<ApiDb> = singleton((): ApiDb => {
    return drizzle(pool());
  });

  return {
    db: database,
    async closePool(): Promise<void> {
      const current = pool.peek();
      if (current) {
        // Relinquish this exact pool before its asynchronous shutdown. A new
        // borrower can create a fresh pool while the old one closes, but both
        // generations retain the same connection owner and DNS hedge budget.
        pool.reset();
        database.reset();
        await current.end();
      }
    },
  };
});

export function db(): ApiDb {
  return databaseRuntime().db();
}

export async function closeDbPool(): Promise<void> {
  await databaseRuntime.peek()?.closePool();
}
