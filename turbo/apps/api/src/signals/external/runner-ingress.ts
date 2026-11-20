import { randomUUID } from "node:crypto";
import { runnerDispatchResponseSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import { runnerVersionSchema } from "@okouai/api-contracts/contracts/runner-primitives";
import { number, object } from "zod";
import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";
import { monotonicNow } from "../../lib/time";
import { safeJsonParse, safeSync, settleIncludingAbort } from "../utils";
import type { DirectRunTarget } from "../services/direct-run-ownership.service";
import { recordSandboxOperation } from "./sandbox-op-log";

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

/** A failed response is never made into evidence against an earlier attempt. */
export async function postRunnerDispatch(
  args: {
    readonly target: DirectRunTarget;
    readonly runId: string;
    readonly body: string;
    readonly bodyBytes: number;
    readonly serviceToken: string;
    readonly timeoutMs: number;
  },
  signal: AbortSignal,
): Promise<DispatchObservation> {
  signal.throwIfAborted();
  const { target, runId, body, bodyBytes, serviceToken, timeoutMs } = args;
  let response: Response | undefined;
  let responseHeadersMs: number | undefined;
  let observation: DispatchObservation | undefined;
  const startedAt = monotonicNow();
  return await (async () => {
    const fetched = await settleIncludingAbort(
      fetch(
        `https://${target.hostname}/runners/${target.runnerId}/control/runs/${runId}/dispatch`,
        {
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
        },
      ),
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
