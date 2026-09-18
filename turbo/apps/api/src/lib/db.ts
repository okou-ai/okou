import { trace } from "@opentelemetry/api";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  createInstrumentedPgStream,
  instrumentPgPool,
} from "./db-instrumentation";
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

const pool = singleton((): Pool => {
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
        return createInstrumentedPgStream();
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
});

export const db: SingletonValue<ApiDb> = singleton((): ApiDb => {
  return drizzle(pool());
});

export async function closeDbPool(): Promise<void> {
  const current = pool.peek();
  if (current) {
    await current.end();
    pool.reset();
    db.reset();
  }
}
