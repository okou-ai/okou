import {
  PI_LANGFUSE_RELAY_MAX_BYTES,
  piLangfuseTracesContract,
} from "@okouai/api-contracts/contracts/pi-langfuse";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { readPiLangfuseServerConfig } from "../../lib/pi-langfuse-debug";
import { verifyOkouToken } from "../auth/tokens";
import { authorization$, request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";
import { unauthorizedRunMismatch } from "./agent-webhook-auth";

const L = logger("webhooks:agent:langfuse");
const EXPORT_TIMEOUT_MS = 5000;
const exportParams$ = pathParamsOf(piLangfuseTracesContract.export);

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function readExportBody(
  request: Request,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (
    Number(request.headers.get("content-length")) > PI_LANGFUSE_RELAY_MAX_BYTES
  ) {
    return undefined;
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const read = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, length);
      }
      length += value.byteLength;
      if (length > PI_LANGFUSE_RELAY_MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  };
  return await read().finally(() => {
    reader.releaseLock();
  });
}

const exportTraces$ = command(async ({ get }, signal: AbortSignal) => {
  const { runId } = get(exportParams$);
  const authorization = get(authorization$);
  const auth = authorization?.startsWith("Bearer ")
    ? verifyOkouToken(authorization.slice("Bearer ".length))
    : null;
  if (!auth || auth.runId !== runId) {
    return unauthorizedRunMismatch;
  }
  const db = get(db$);
  const [run] = await db
    .select({ enabled: agentRuns.langfuseTraceEnabled })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.userId, auth.userId),
        eq(agentRuns.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!run) {
    return errorResponse(404, "NOT_FOUND", "Run not found");
  }
  if (!run.enabled) {
    return errorResponse(
      403,
      "FORBIDDEN",
      "Tracing is not enabled for this run",
    );
  }
  const config = readPiLangfuseServerConfig();
  if (!config) {
    return errorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Trace export is unavailable",
    );
  }
  const request = get(request$).raw;
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim();
  const contentEncoding = request.headers.get("content-encoding");
  if (
    (contentType !== "application/json" &&
      contentType !== "application/x-protobuf") ||
    (contentEncoding &&
      contentEncoding !== "identity" &&
      contentEncoding !== "gzip")
  ) {
    return errorResponse(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Unsupported OTLP encoding",
    );
  }
  const body = await readExportBody(request);
  signal.throwIfAborted();
  if (!body) {
    return errorResponse(
      413,
      "PAYLOAD_TOO_LARGE",
      "Trace export payload too large",
    );
  }
  const exported = await settle(
    (async () => {
      const upstream = await fetch(
        `${config.baseUrl}/api/public/otel/v1/traces`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
            "Content-Type": contentType,
            // Native ingestion stores real spans without a synthetic trace root.
            "x-langfuse-ingestion-version": "4",
            ...(contentEncoding ? { "Content-Encoding": contentEncoding } : {}),
          },
          body,
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            request.signal,
            AbortSignal.timeout(EXPORT_TIMEOUT_MS),
          ]),
        },
      );
      signal.throwIfAborted();
      if (!upstream.ok) {
        await upstream.arrayBuffer();
        signal.throwIfAborted();
        L.warn("Langfuse trace export rejected", {
          runId,
          status: upstream.status,
        });
        return errorResponse(503, "SERVICE_UNAVAILABLE", "Trace export failed");
      }
      const responseBody = await upstream.arrayBuffer();
      signal.throwIfAborted();
      return new Response(responseBody, {
        status: 200,
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? contentType,
        },
      });
    })(),
    signal,
  );
  request.signal.throwIfAborted();
  if (!exported.ok) {
    // Do not expose upstream responses or credentials to the sandbox.
    L.warn("Langfuse trace export failed", { runId });
    return errorResponse(502, "BAD_GATEWAY", "Trace export failed");
  }
  return exported.value;
});

export const webhooksAgentLangfuseRoutes: readonly RouteEntry[] = [
  { route: piLangfuseTracesContract.export, handler: exportTraces$ },
];
