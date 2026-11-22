import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { runnerDispatchResponseSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  runnerVersionSchema,
} from "@okouai/api-contracts/contracts/runner-primitives";
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
  runnerDispatchPath,
  type RunnerDispatchTiming,
  type TakenRunnerDispatch,
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

interface DispatchTransportObservation extends RunnerDispatchTiming {
  readonly origin: string;
  readonly path: string;
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
    if (active && ++active.sendCount === 1) {
      active.connection = connection;
      active.sendHeadersMs = monotonicNow() - active.startedAt;
    }
  });

  return scope;
});

function readRunnerDispatchTiming(response: Response | undefined) {
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

function dispatchRequestOptions(serviceToken: string) {
  return {
    method: "POST",
    redirect: "error" as const,
    cache: "no-store" as const,
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "content-type": "application/json",
    },
  };
}

export function reserveRunnerDispatch(
  target: DirectRunTarget,
  runId: string,
  signal: AbortSignal,
): void {
  const transport = currentRunnerDispatchTransport();
  if (!transport) {
    return;
  }
  const origin = `https://${target.hostname}`;
  const path = runnerDispatchPath(target.runnerId, runId);
  const serviceToken = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`;
  transport.reserve(
    runId,
    origin + path,
    (body, connectionSignal) => {
      const timing = { origin, path, sendCount: 0, startedAt: monotonicNow() };
      const options: RequestInit = {
        ...dispatchRequestOptions(serviceToken),
        body,
        duplex: "half",
        signal: connectionSignal,
      };
      return {
        response: dispatchTransport().run(timing, () => {
          return fetch(origin + path, options);
        }),
        timing,
      };
    },
    signal,
  );
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
  let response: Response | undefined;
  let responseHeadersMs: number | undefined;
  let observation: DispatchObservation | undefined;
  const startedAt = monotonicNow();
  const origin = `https://${target.hostname}`;
  const path = runnerDispatchPath(target.runnerId, runId);
  let reserved: TakenRunnerDispatch | undefined;
  const transport: DispatchTransportObservation = {
    origin,
    path,
    startedAt,
    sendCount: 0,
  };
  return await (async () => {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
    ]);
    const url = origin + path;
    reserved = currentRunnerDispatchTransport()?.take(
      url,
      body,
      startedAt,
      deadline,
    );
    const dispatch = () => {
      return fetch(url, {
        ...dispatchRequestOptions(serviceToken),
        body,
        signal: deadline,
      });
    };
    const fetched = await settleIncludingAbort(() => {
      return (
        reserved?.response ??
        (currentRequestRuntime()
          ? dispatch()
          : dispatchTransport().run(transport, dispatch))
      );
    });
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
    reserved?.clearDeadline();
    const timing = reserved?.timing ?? transport;
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
            timing.sendCount === 1
              ? (timing.connection ?? "unknown")
              : "unknown",
          api_send_headers_ms:
            timing.sendCount === 1 ? timing.sendHeadersMs : undefined,
          api_preconnect_used:
            reserved === undefined ? undefined : timing.sendCount === 1,
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
  response: Response,
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
