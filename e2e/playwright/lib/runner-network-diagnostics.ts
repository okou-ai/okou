import type { CDPSession, Page } from "@playwright/test";

const MAX_REQUESTS = 64;
const SESSION_DEADLINE_MS = 1_000;

interface TransferObservation {
  readonly requestId: string;
  readonly url: string;
  readonly resourceType: string;
  readonly startedMs: number;
  dataEvents: number;
  decodedDataBytes: number;
  encodedDataBytes: number;
  firstDataMs?: number;
  lastDataMs?: number;
  responseMs?: number;
  status?: number;
  protocol?: string;
  cfRay?: string;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  timing?: {
    dnsStart: number;
    dnsEnd: number;
    connectStart: number;
    connectEnd: number;
    sslStart: number;
    sslEnd: number;
    sendStart: number;
    sendEnd: number;
    receiveHeadersEnd: number;
  };
  endedMs?: number;
  totalEncodedBytes?: number;
  outcome: "pending" | "finished" | "failed" | "redirected";
  failureCode?: string;
  canceled?: boolean;
}

interface ResponseMetadata {
  status: number;
  protocol?: string;
  headers: Record<string, string>;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  timing?: TransferObservation["timing"];
}

interface NetworkDiagnostics {
  freeze():
    | {
        kind: "observed";
        interrupted: boolean;
        requests: readonly TransferObservation[];
        omittedRequests: number;
      }
    | { kind: "unavailable"; reason: "setup-failed" | "setup-deadline" };
  dispose(): Promise<void>;
}

// Keep the same URL boundary for Playwright and CDP evidence.
export function safeNetworkUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? `${url.origin}${url.pathname}`.slice(0, 512)
      : "non-http-url";
  } catch {
    return "invalid-url";
  }
}

function recordResponse(
  observation: TransferObservation,
  response: ResponseMetadata,
  elapsedMs: number,
) {
  observation.status = response.status;
  observation.responseMs = elapsedMs;
  if (response.protocol !== undefined) {
    observation.protocol = /^(?:http\/1\.[01]|h2|h3)$/u.test(response.protocol)
      ? response.protocol
      : "other";
  }
  observation.fromDiskCache = response.fromDiskCache;
  observation.fromServiceWorker = response.fromServiceWorker;
  const cfRay = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === "cf-ray",
  )?.[1];
  if (cfRay && /^[0-9a-f]{16}(?:-[A-Z]{3})?$/u.test(cfRay)) {
    observation.cfRay = cfRay;
  }
  if (response.timing) {
    const {
      dnsStart,
      dnsEnd,
      connectStart,
      connectEnd,
      sslStart,
      sslEnd,
      sendStart,
      sendEnd,
      receiveHeadersEnd,
    } = response.timing;
    observation.timing = {
      dnsStart,
      dnsEnd,
      connectStart,
      connectEnd,
      sslStart,
      sslEnd,
      sendStart,
      sendEnd,
      receiveHeadersEnd,
    };
  }
}

async function detachSession(session: CDPSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // A closed target already owns session teardown.
      session.detach().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observeNetwork(
  session: CDPSession,
  elapsed: () => number,
): NetworkDiagnostics {
  const requests: TransferObservation[] = [];
  const active = new Map<string, TransferObservation>();
  let recording = true;
  let interrupted = false;
  let omittedRequests = 0;
  let disposed = false;
  const observationFor = (requestId: string) =>
    recording ? active.get(requestId) : undefined;

  session.on("Network.requestWillBeSent", (event) => {
    if (!recording) return;
    const redirected = active.get(event.requestId);
    if (redirected && event.redirectResponse) {
      recordResponse(redirected, event.redirectResponse, elapsed());
      redirected.outcome = "redirected";
      redirected.endedMs = elapsed();
    }
    active.delete(event.requestId);
    if (requests.length >= MAX_REQUESTS) {
      omittedRequests++;
      return;
    }
    const observation: TransferObservation = {
      requestId: event.requestId,
      url: safeNetworkUrl(event.request.url),
      resourceType: event.type?.toLowerCase() ?? "other",
      startedMs: elapsed(),
      dataEvents: 0,
      decodedDataBytes: 0,
      encodedDataBytes: 0,
      outcome: "pending",
    };
    requests.push(observation);
    active.set(event.requestId, observation);
  });
  session.on("Network.responseReceived", (event) => {
    const observation = observationFor(event.requestId);
    if (observation) recordResponse(observation, event.response, elapsed());
  });
  session.on("Network.dataReceived", (event) => {
    const observation = observationFor(event.requestId);
    if (!observation) return;
    observation.dataEvents++;
    observation.decodedDataBytes += event.dataLength;
    observation.encodedDataBytes += event.encodedDataLength;
    observation.firstDataMs ??= elapsed();
    observation.lastDataMs = elapsed();
  });
  session.on("Network.loadingFinished", (event) => {
    const observation = observationFor(event.requestId);
    if (!observation) return;
    observation.outcome = "finished";
    observation.endedMs = elapsed();
    observation.totalEncodedBytes = event.encodedDataLength;
    active.delete(event.requestId);
  });
  session.on("Network.loadingFailed", (event) => {
    const observation = observationFor(event.requestId);
    if (!observation) return;
    observation.outcome = "failed";
    observation.endedMs = elapsed();
    observation.failureCode = /^net::ERR_[A-Z_]+$/u.test(event.errorText)
      ? event.errorText
      : "unclassified";
    observation.canceled = event.canceled;
    active.delete(event.requestId);
  });
  session.on("close", () => {
    if (recording) interrupted = true;
  });

  return {
    freeze() {
      recording = false;
      return { kind: "observed", interrupted, requests, omittedRequests };
    },
    async dispose() {
      recording = false;
      if (disposed) return;
      disposed = true;
      await detachSession(session);
    },
  };
}

function unavailable(
  reason: "setup-failed" | "setup-deadline",
): NetworkDiagnostics {
  return {
    freeze: () => ({ kind: "unavailable", reason }),
    dispose: async () => {},
  };
}

/** Observe metadata only; never enable body streaming, cache overrides or interception. */
export async function startRunnerNetworkDiagnostics(
  page: Page,
  elapsed: () => number,
): Promise<NetworkDiagnostics> {
  let acceptingSession = true;
  let collector: NetworkDiagnostics | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setup = (async () => {
    const session = await page.context().newCDPSession(page);
    if (!acceptingSession) {
      await detachSession(session);
      return unavailable("setup-deadline");
    }
    collector = observeNetwork(session, elapsed);
    await session.send("Network.enable");
    return collector;
  })().catch(async () => {
    await collector?.dispose();
    return unavailable("setup-failed");
  });
  try {
    const result = await Promise.race([
      setup,
      new Promise<NetworkDiagnostics>((resolve) => {
        timer = setTimeout(() => {
          acceptingSession = false;
          collector?.freeze();
          resolve(unavailable("setup-deadline"));
        }, SESSION_DEADLINE_MS);
      }),
    ]);
    if (!acceptingSession) await collector?.dispose();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
