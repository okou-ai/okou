import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { runnerDispatchResponseSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import { runnerVersionSchema } from "@okouai/api-contracts/contracts/runner-primitives";
import { number, object } from "zod";
import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";
import { currentRequestRuntime } from "../../lib/request-runtime";
import { singleton } from "../../lib/singleton";
import { monotonicNow } from "../../lib/time";
import { safeJsonParse, safeSync, settleIncludingAbort } from "../utils";
import type { DirectRunTarget } from "../services/direct-run-ownership.service";
import { recordSandboxOperation } from "./sandbox-op-log";
import {
  currentRunnerDispatchTransport,
  type PreconnectedSocketUse,
  type RunnerDispatchTransport,
  type RunnerDispatchRequest,
  type RunnerDispatchResponse,
} from "./runner-dispatch-transport";

type DispatchObservation =
  "accepted" | "rejected" | "busy" | "unknown" | "not-delivered";

const dispatchTimingHeader = "x-okou-runner-dispatch-timing";
const runnerElapsedMs = number().nonnegative().optional();
const runnerDispatchTimingSchema = object({
  runnerVersion: runnerVersionSchema,
  bodyReadMs: runnerElapsedMs,
  envelopeParseMs: runnerElapsedMs,
  contextDecodeMs: runnerElapsedMs,
  acceptanceMs: runnerElapsedMs,
});

interface DispatchTransportObservation {
  readonly origin: string;
  readonly path: string;
  readonly startedAt: number;
  readonly runnerTransport: RunnerDispatchTransport | undefined;
  sendCount: number;
  connection?: "first_use" | "reused";
  sendHeadersMs?: number;
  preconnectedSocketUse?: PreconnectedSocketUse;
}

function diagnosticRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

const dispatchTransport = singleton(() => {
  const scope = new AsyncLocalStorage<DispatchTransportObservation>();
  const requests = new WeakMap<object, DispatchTransportObservation>();
  const sockets = new WeakMap<object, "first_use" | "reused">();

  channel("undici:request:create").subscribe((event) => {
    const active = scope.getStore();
    if (!active || !diagnosticRecord(event)) {
      return;
    }
    const { request } = event;
    if (
      diagnosticRecord(request) &&
      request.method === "POST" &&
      request.origin === active.origin &&
      request.path === active.path
    ) {
      requests.set(request, active);
    }
  });
  channel("undici:client:connected").subscribe((event) => {
    if (diagnosticRecord(event) && diagnosticRecord(event.socket)) {
      sockets.set(event.socket, "first_use");
    }
  });
  channel("undici:client:sendHeaders").subscribe((event) => {
    if (!diagnosticRecord(event) || !diagnosticRecord(event.socket)) {
      return;
    }
    const connection = sockets.get(event.socket);
    if (connection !== "reused") {
      sockets.set(event.socket, "reused");
    }
    const active = diagnosticRecord(event.request)
      ? requests.get(event.request)
      : undefined;
    const preconnectedSocketUse = active?.runnerTransport?.takeSocketUse(
      event.socket,
    );
    if (active && ++active.sendCount === 1) {
      active.connection = connection;
      active.sendHeadersMs = monotonicNow() - active.startedAt;
      active.preconnectedSocketUse = preconnectedSocketUse;
    }
  });

  return scope;
});

function readRunnerDispatchTiming(
  response: RunnerDispatchResponse | undefined,
) {
  const header = response?.headers.get(dispatchTimingHeader);
  if (!header || header.length > 512) {
    return undefined;
  }
  const parsed = runnerDispatchTimingSchema.safeParse(safeJsonParse(header));
  return parsed.success ? parsed.data : undefined;
}

function definitelyNotConnected(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (
    "code" in error &&
    (error.code === "ECONNREFUSED" ||
      error.code === "ENOTFOUND" ||
      error.code === "EAI_AGAIN" ||
      error.code === "UND_ERR_CONNECT_TIMEOUT")
  ) {
    return true;
  }
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.every(definitelyNotConnected);
  }
  return error.cause instanceof Error && definitelyNotConnected(error.cause);
}

/** A failed response is never made into evidence against an earlier attempt. */
export async function postRunnerDispatch(
  args: {
    readonly target: DirectRunTarget;
    readonly runId: string;
    readonly body: string;
    readonly bodyBytes: number;
    readonly serviceToken: string;
    readonly timeoutMs: number;
    readonly firstRankedTarget: boolean;
    readonly firstCandidateReadyAt: number | undefined;
  },
  signal: AbortSignal,
): Promise<DispatchObservation> {
  signal.throwIfAborted();
  const { target, runId, body, bodyBytes, serviceToken, timeoutMs } = args;
  let response: RunnerDispatchResponse | undefined;
  let responseHeadersMs: number | undefined;
  let observation: DispatchObservation | undefined;
  const startedAt = monotonicNow();
  const origin = `https://${target.hostname}`;
  const path = `/runners/${target.runnerId}/control/runs/${runId}/dispatch`;
  const runnerTransport = currentRunnerDispatchTransport();
  const transport: DispatchTransportObservation = {
    origin,
    path,
    startedAt,
    sendCount: 0,
    runnerTransport,
  };
  return await (async () => {
    const dispatch = () => {
      const options: RunnerDispatchRequest = {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
        ]),
      };
      const url = origin + path;
      return runnerTransport
        ? runnerTransport.fetch(url, options)
        : fetch(url, options);
    };
    // Worker-native fetch does not use Node's Undici diagnostic channels.
    const fetched = await settleIncludingAbort(
      currentRequestRuntime()
        ? dispatch()
        : dispatchTransport().run(transport, dispatch),
    );
    if (fetched.ok) {
      response = fetched.value;
      responseHeadersMs = monotonicNow() - startedAt;
    }
    signal.throwIfAborted();
    if (fetched.ok) {
      observation = await observeRunnerDispatch(
        fetched.value,
        target,
        runId,
        signal,
      );
    } else {
      observation = definitelyNotConnected(fetched.error)
        ? "not-delivered"
        : "unknown";
    }
    return observation;
  })().finally(() => {
    const attemptElapsedMs = monotonicNow() - startedAt;
    // Telemetry is optional even after the Runner has taken custody.
    safeSync(() => {
      const timings = readRunnerDispatchTiming(response);
      recordSandboxOperation({
        sandboxType: "runner",
        actionType: "api_dispatch_runner_post",
        runId,
        durationMs: attemptElapsedMs,
        success: observation === "accepted",
        dimensions: {
          dispatch_attempt_id: randomUUID(),
          runner_id: target.runnerId,
          heartbeat_generation: target.heartbeatGeneration,
          api_version: getBuildVersion(),
          api_commit_sha:
            normalizeBuildCommitSha(env("GIT_COMMIT_SHA")) ?? undefined,
          body_bytes: bodyBytes,
          first_ranked_target: args.firstRankedTarget,
          first_candidate_lead_ms:
            args.firstCandidateReadyAt === undefined
              ? undefined
              : startedAt - args.firstCandidateReadyAt,
          api_socket_use:
            transport.sendCount === 1
              ? (transport.connection ?? "unknown")
              : "unknown",
          api_send_headers_ms:
            transport.sendCount === 1 ? transport.sendHeadersMs : undefined,
          api_preconnect_socket_use:
            transport.sendCount === 1
              ? transport.preconnectedSocketUse
              : undefined,
          response_headers_ms: responseHeadersMs,
          http_status: response?.status,
          dispatch_outcome:
            observation ?? (signal.aborted ? "aborted" : "error"),
          runner_version: timings?.runnerVersion,
          runner_body_read_ms: timings?.bodyReadMs,
          runner_envelope_parse_ms: timings?.envelopeParseMs,
          runner_context_decode_ms: timings?.contextDecodeMs,
          runner_acceptance_ms:
            observation === "accepted" ? timings?.acceptanceMs : undefined,
        },
      });
    });
  });
}

async function observeRunnerDispatch(
  response: RunnerDispatchResponse,
  target: DirectRunTarget,
  runId: string,
  signal: AbortSignal,
): Promise<DispatchObservation> {
  if ([400, 401, 403, 404, 405, 408, 413, 415].includes(response.status)) {
    await response.body?.cancel();
    return "not-delivered";
  }
  if (response.status !== 200 && response.status !== 429) {
    await response.body?.cancel();
    return "unknown";
  }
  const received = await settleIncludingAbort<unknown>(response.json());
  signal.throwIfAborted();
  if (!received.ok) {
    return "unknown";
  }
  const parsed = runnerDispatchResponseSchema.safeParse(received.value);
  if (
    !parsed.success ||
    parsed.data.runnerId !== target.runnerId ||
    parsed.data.heartbeatGeneration !== target.heartbeatGeneration ||
    parsed.data.runId !== runId
  ) {
    return "unknown";
  }
  if (response.status === 429) {
    return parsed.data.disposition === "busy" ? "busy" : "unknown";
  }
  return parsed.data.disposition === "accepted" ||
    parsed.data.disposition === "rejected"
    ? parsed.data.disposition
    : "unknown";
}
