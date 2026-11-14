import { runnerDispatchResponseSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import { settleIncludingAbort } from "../utils";
import type { DirectRunTarget } from "../services/direct-run-ownership.service";

type DispatchObservation =
  "accepted" | "rejected" | "busy" | "unknown" | "not-delivered";

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
    readonly serviceToken: string;
    readonly timeoutMs: number;
  },
  signal: AbortSignal,
): Promise<DispatchObservation> {
  signal.throwIfAborted();
  const { target, runId, body, serviceToken, timeoutMs } = args;
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
  signal.throwIfAborted();
  if (!fetched.ok) {
    return definitelyNotConnected(fetched.error) ? "not-delivered" : "unknown";
  }
  const response = fetched.value;
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
