import type { CDPSession, Page } from "@playwright/test";

const MAX_REQUESTS = 64;
const SESSION_DEADLINE_MS = 1_000;

type BuildIdentity =
  | { readonly kind: "valid"; readonly sha: string }
  | { readonly kind: "missing" | "invalid" };

interface DocumentBuildObservation {
  observed: BuildIdentity | { readonly kind: "unavailable" };
  comparison: "match" | "mismatch" | "not-comparable";
  reason?:
    | "response-unavailable"
    | "ineligible-response"
    | "expected-missing"
    | "expected-invalid"
    | "observed-missing"
    | "observed-invalid";
}

interface BuildContext {
  readonly appOrigin: string;
  readonly expected: BuildIdentity;
}

export function expectedAppBuild(value: string | undefined): BuildIdentity {
  if (value === undefined) return { kind: "missing" };
  return /^[0-9a-f]{40}$/u.test(value)
    ? { kind: "valid", sha: value }
    : { kind: "invalid" };
}

function eligibleDocument(
  url: string,
  method: string,
  type: string | undefined,
  appOrigin: string,
) {
  const parsed = new URL(url);
  return (
    type === "Document" &&
    method === "GET" &&
    parsed.origin === appOrigin &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === "/sign-in"
  );
}

function documentBuild(
  response: ResponseMetadata,
  build: BuildContext,
): DocumentBuildObservation {
  if (
    response.status !== 200 ||
    response.mimeType !== "text/html" ||
    new URL(response.url).origin !== build.appOrigin
  ) {
    return {
      observed: { kind: "unavailable" },
      comparison: "not-comparable",
      reason: "ineligible-response",
    };
  }
  const values = Object.entries(response.headers).filter(
    ([name]) => name.toLowerCase() === "x-okou-preview-build-sha",
  );
  const value = values[0]?.[1];
  const observed: BuildIdentity =
    values.length === 0
      ? { kind: "missing" }
      : values.length === 1 &&
          typeof value === "string" &&
          /^[0-9a-f]{40}$/u.test(value)
        ? { kind: "valid", sha: value }
        : { kind: "invalid" };
  if (build.expected.kind !== "valid") {
    return {
      observed,
      comparison: "not-comparable",
      reason:
        build.expected.kind === "missing"
          ? "expected-missing"
          : "expected-invalid",
    };
  }
  if (observed.kind !== "valid") {
    return {
      observed,
      comparison: "not-comparable",
      reason:
        observed.kind === "missing" ? "observed-missing" : "observed-invalid",
    };
  }
  return {
    observed,
    comparison: observed.sha === build.expected.sha ? "match" : "mismatch",
  };
}

interface TransferObservation {
  readonly requestId: string;
  readonly redirectHop: number;
  documentBuild?: DocumentBuildObservation;
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
  url: string;
  mimeType: string;
  status: number;
  protocol?: string;
  headers: Record<string, string>;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  timing?: TransferObservation["timing"];
}

interface NetworkDiagnostics {
  responseHeaders(): ReadonlyMap<string, number> | undefined;
  freeze():
    | {
        kind: "observed";
        interrupted: boolean;
        requests: readonly TransferObservation[];
        omittedRequests: number;
        responseHeaders: readonly ResponseHeadersObservation[];
        omittedResponseHeaders: number;
      }
    | { kind: "unavailable"; reason: "setup-failed" | "setup-deadline" };
  dispose(): Promise<void>;
}

interface ResponseHeadersObservation {
  readonly requestId: string;
  readonly status: number;
  readonly elapsedMs: number;
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
  build: BuildContext,
) {
  if (observation.documentBuild) {
    observation.documentBuild = documentBuild(response, build);
  }
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
  build: BuildContext,
): NetworkDiagnostics {
  const requests: TransferObservation[] = [];
  const active = new Map<string, TransferObservation>();
  const responseHeaders: ResponseHeadersObservation[] = [];
  let omittedResponseHeaders = 0;
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
      recordResponse(redirected, event.redirectResponse, elapsed(), build);
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
      redirectHop: requests.filter((item) => item.requestId === event.requestId)
        .length,
      documentBuild: eligibleDocument(
        event.request.url,
        event.request.method,
        event.type,
        build.appOrigin,
      )
        ? {
            observed: { kind: "unavailable" },
            comparison: "not-comparable",
            reason: "response-unavailable",
          }
        : undefined,
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
  session.on("Network.responseReceivedExtraInfo", (event) => {
    if (!recording) return;
    // Chromium can expose wire headers here before responseReceived, notably
    // for an unfinished script. Keep only status/timing, never raw headers.
    if (responseHeaders.length >= MAX_REQUESTS) {
      omittedResponseHeaders++;
      return;
    }
    responseHeaders.push({
      requestId: event.requestId,
      status: event.statusCode,
      elapsedMs: elapsed(),
    });
  });
  session.on("Network.responseReceived", (event) => {
    const observation = observationFor(event.requestId);
    if (observation)
      recordResponse(observation, event.response, elapsed(), build);
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
    responseHeaders() {
      if (
        !recording ||
        interrupted ||
        omittedRequests ||
        omittedResponseHeaders
      ) {
        return undefined;
      }
      const statuses = new Map<string, number>();
      for (const headers of responseHeaders) {
        // Redirect hops reuse request IDs, and queries are intentionally
        // redacted. Conservatively treat every matching URL as responded;
        // never guess a hop or retry a possibly responding request.
        for (const request of requests) {
          if (
            request.requestId === headers.requestId &&
            (!statuses.has(request.url) || headers.status >= 400)
          ) {
            statuses.set(request.url, headers.status);
          }
        }
      }
      return statuses;
    },
    freeze() {
      recording = false;
      return {
        kind: "observed",
        interrupted,
        requests,
        omittedRequests,
        responseHeaders,
        omittedResponseHeaders,
      };
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
    responseHeaders: () => undefined,
    freeze: () => ({ kind: "unavailable", reason }),
    dispose: async () => {},
  };
}

/** Observe metadata only; never enable body streaming, cache overrides or interception. */
export async function startRunnerNetworkDiagnostics(
  page: Page,
  elapsed: () => number,
  build: BuildContext,
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
    collector = observeNetwork(session, elapsed, build);
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
