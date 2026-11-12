import { runnerDispatchResponseSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
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

async function boundedBody(response: Response): Promise<unknown> {
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return value;
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
  let response: Response;
  try {
    response = await fetch(
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
    );
  } catch (error) {
    signal.throwIfAborted();
    return definitelyNotConnected(error) ? "not-delivered" : "unknown";
  }
  if ([400, 401, 403, 404, 405, 408, 413, 415].includes(response.status)) {
    await response.body?.cancel();
    return "not-delivered";
  }
  if (response.status !== 200 && response.status !== 429) {
    await response.body?.cancel();
    return "unknown";
  }
  try {
    const parsed = runnerDispatchResponseSchema.safeParse(
      await boundedBody(response),
    );
    signal.throwIfAborted();
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
  } catch {
    signal.throwIfAborted();
    return "unknown";
  }
}
