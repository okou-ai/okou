import { tracing } from "cloudflare:workers";
import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { trace } from "@opentelemetry/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Hono } from "hono";

import { instrumentPgPool } from "./lib/db-instrumentation";
import type { ApiDb } from "./lib/db-types";
import { env } from "./lib/env";
import {
  withRequestRuntime,
  type RequestQuerySpan,
  type RequestRuntime,
} from "./lib/request-runtime";
import { createDeferredPromise, settleIncludingAbort } from "./signals/utils";

interface WorkerBindings {
  readonly HYPERDRIVE: Hyperdrive;
  readonly API_NATIVE_TELEMETRY?: string;
  readonly GCP_MTLS?: RequestRuntime["gcpMtls"];
}

/** Keep the pool alive until both response streaming and registered work finish. */
function ownResponse(
  response: Response,
  finish: () => void,
  waitUntil: (work: Promise<unknown>) => void,
): Response {
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let cancellation: Promise<void> | undefined;
  const complete = () => {
    if (!finished) {
      finished = true;
      reader.releaseLock();
      finish();
    }
  };
  const cancel = (reason: unknown): void => {
    if (!cancellation) {
      // A second reader.cancel() need not join the original source cleanup.
      // A downstream stream cancellation joins this one cleanup operation.
      cancellation = reader.cancel(reason).finally(complete);
      waitUntil(cancellation);
    }
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const result = await settleIncludingAbort(reader.read());
        if (!result.ok) {
          controller.error(result.error);
          complete();
        } else if (result.value.done) {
          controller.close();
          complete();
        } else {
          controller.enqueue(result.value.value);
        }
      },
      cancel(reason) {
        if (!finished) {
          cancel(reason);
        }
        return cancellation;
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

function traceWorkerQuery(
  name: string,
  sql: string | undefined,
  execute: (span: RequestQuerySpan) => Promise<unknown>,
): Promise<unknown> {
  return tracing.enterSpan(name, async (span) => {
    span.setAttributes({
      "db.system": "postgresql",
      "db.system.name": "postgresql",
      "db.statement": sql,
      "db.query.text": sql,
      "okou.runtime": "cloudflare-workers",
    });
    const result = await settleIncludingAbort(() => {
      return execute(span);
    });
    if (result.ok) {
      span.setAttribute("okou.outcome", "success");
      return result.value;
    }
    // Native custom spans have no setStatus API yet. Keep an explicit
    // outcome; missing OTel status must not be interpreted as success.
    // Never include query parameter values in telemetry attributes.
    span.setAttribute("okou.outcome", "error");
    span.setAttribute(
      "error.type",
      result.error instanceof Error ? result.error.name : "unknown",
    );
    throw result.error;
  });
}

export function createWorkerHandler(createApp: (signal: AbortSignal) => Hono) {
  function workerFetch(
    request: Request,
    bindings: WorkerBindings,
    context: ExecutionContext,
  ): Promise<Response> {
    let pool: Pool | undefined;
    let database: ApiDb | undefined;
    const background = new Set<Promise<unknown>>();
    // The request owner lasts through foreground, response, and background work.
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    const responseFinished = createDeferredPromise<void>(lifetime.signal);
    const foregroundFinished = createDeferredPromise<void>(lifetime.signal);
    let closing = false;
    const finish = () => {
      if (!responseFinished.settled()) {
        responseFinished.resolve();
      }
    };

    return tracing.enterSpan("api.request", (requestSpan) => {
      requestSpan.setAttributes({
        "server.address": new URL(request.url).hostname,
        "okou.api.commit_sha": env("GIT_COMMIT_SHA"),
      });
      const runtime: RequestRuntime = {
        nativeTelemetry: bindings.API_NATIVE_TELEMETRY === "true",
        gcpMtls: bindings.GCP_MTLS,
        database() {
          if (closing) {
            throw new Error("Worker request database is closed");
          }
          if (!database) {
            pool = instrumentPgPool(
              new Pool({
                connectionString: bindings.HYPERDRIVE.connectionString,
                min: 0,
                max: Math.min(4, env("DB_POOL_MAX")),
                connectionTimeoutMillis: env("DB_POOL_CONNECT_TIMEOUT_MS"),
                idleTimeoutMillis: env("DB_POOL_IDLE_TIMEOUT_MS"),
              }),
              trace.getTracer("vm0-api/pg"),
            );
            pool.on("error", activeClientError);
            pool.on("acquire", (client) => {
              client.on("error", activeClientError);
            });
            pool.on("release", (_error, client) => {
              client.removeListener("error", activeClientError);
            });
            database = drizzle(pool);
          }
          return database;
        },
        waitUntil(work) {
          // Rejection remains visible to Cloudflare and the owning caller;
          // this continuation only tracks completion for resource teardown.
          const tracked = work.finally(() => {
            background.delete(tracked);
          });
          background.add(tracked);
          context.waitUntil(tracked);
        },
        traceQuery: traceWorkerQuery,
        observeHttp(method, route, status) {
          requestSpan.setAttributes({
            "http.request.method": method,
            "http.route": route,
            "http.response.status_code": status,
            "okou.runtime": "cloudflare-workers",
            "okou.outcome": status >= 500 ? "error" : "success",
          });
        },
      };
      function activeClientError(error: Error): void {
        requestSpan.setAttribute("okou.db.connection_error", error.name);
      }
      context.waitUntil(
        withRequestRuntime(runtime, async () => {
          // Wait for actual owners, never treat an abort notification as a join.
          await foregroundFinished.promise;
          await responseFinished.promise;
          while (background.size > 0) {
            await Promise.allSettled(background);
          }
          closing = true;
          await pool?.end();
          lifetime.abort();
        }),
      );
      return withRequestRuntime(runtime, async () => {
        const result = await settleIncludingAbort(async () => {
          signal.throwIfAborted();
          const response = await createApp(signal).fetch(
            request,
            bindings,
            context,
          );
          return ownResponse(response, finish, runtime.waitUntil);
        });
        foregroundFinished.resolve();
        if (!result.ok) {
          finish();
          throw result.error;
        }
        return result.value;
      });
    });
  }

  // Workers Logs and traces observe this entry natively; Sentry is not
  // initialized here, so shared captureException calls are no-ops.
  return { fetch: workerFetch };
}
