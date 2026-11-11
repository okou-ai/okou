import { Buffer } from "node:buffer";
import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";

import type { FetchLike } from "@modelcontextprotocol/client";
import { validateBaseUrlHostPolicy } from "@okouai/connectors/firewall-types";

import { createDeferredPromise, settle } from "../utils";

const MCP_OAUTH_MAX_HEADER_BYTES = 16 * 1024;
const MCP_OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;
const MCP_OAUTH_MAX_REDIRECTS = 3;

const ALLOWED_METHODS = Object.freeze(["GET", "HEAD", "POST"]);
const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS = Object.freeze([
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REDIRECT_SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
] as const;

interface SerializedRequest {
  readonly method: "GET" | "HEAD" | "POST";
  readonly headers: Headers;
  readonly body: Buffer | undefined;
}

type RequestOutcome =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: unknown };

export class McpOAuthUnsafeUrlError extends Error {
  constructor() {
    super("MCP OAuth URL is not allowed");
    this.name = "McpOAuthUnsafeUrlError";
  }
}

export class McpOAuthNetworkRejectedError extends Error {
  constructor() {
    super(
      "Cloudflare Access rejected the request; check its service token and application policy",
    );
    this.name = "McpOAuthNetworkRejectedError";
  }
}

async function hasApplicationChallenge(response: Response): Promise<boolean> {
  if (
    /^(?:Bearer|Basic)\s/iu.test(
      response.headers.get("www-authenticate")?.trim() ?? "",
    )
  ) {
    return true;
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return false;
  }
  const parsed = await settle(response.clone().json());
  if (
    !parsed.ok ||
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    !("error" in parsed.value)
  ) {
    return false;
  }
  return [
    "invalid_client",
    "invalid_grant",
    "invalid_token",
    "insufficient_scope",
    "unauthorized_client",
  ].includes(String(parsed.value.error));
}

function allowedUrl(input: string | URL): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new McpOAuthUnsafeUrlError();
  }
  return url;
}

export function validateMcpOAuthUrl(input: string | URL): string {
  return allowedUrl(input).href;
}

function requestMethod(
  method: string | undefined,
): SerializedRequest["method"] {
  const normalized = (method ?? "GET").toUpperCase();
  if (
    !ALLOWED_METHODS.some((allowedMethod) => {
      return allowedMethod === normalized;
    })
  ) {
    throw new Error(`MCP OAuth request method is not allowed: ${normalized}`);
  }
  if (normalized === "GET" || normalized === "HEAD") {
    return normalized;
  }
  return "POST";
}

function validateRequestHeaders(headers: Headers): void {
  for (const name of FORBIDDEN_REQUEST_HEADERS) {
    if (headers.has(name)) {
      throw new Error(`MCP OAuth request header is not allowed: ${name}`);
    }
  }
}

function serializeRequestBody(
  body: RequestInit["body"],
  headers: Headers,
): Buffer | undefined {
  if (body === undefined || body === null) {
    headers.delete("content-length");
    return undefined;
  }

  let serialized: Buffer;
  if (typeof body === "string") {
    serialized = Buffer.from(body);
  } else if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) {
      headers.set(
        "content-type",
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
    }
    serialized = Buffer.from(body.toString());
  } else if (body instanceof ArrayBuffer) {
    serialized = Buffer.from(body);
  } else if (ArrayBuffer.isView(body)) {
    serialized = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  } else {
    throw new Error("MCP OAuth request body type is not supported");
  }

  headers.set("content-length", String(serialized.byteLength));
  return serialized;
}

function serializedRequest(init: RequestInit | undefined): SerializedRequest {
  const method = requestMethod(init?.method);
  const headers = new Headers(init?.headers);
  validateRequestHeaders(headers);
  const body = serializeRequestBody(init?.body, headers);
  if ((method === "GET" || method === "HEAD") && body) {
    throw new Error(`MCP OAuth ${method} requests cannot have a body`);
  }
  return { method, headers, body };
}

function responseHeaders(
  rawHeaders: Readonly<Record<string, string | string[] | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function responseCanHaveBody(method: string, status: number): boolean {
  return (
    method !== "HEAD" && status !== 204 && status !== 205 && status !== 304
  );
}

function outgoingRequestHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers);
}

async function validateObservedPublicDestination(
  url: URL,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const validate = (base: string) => {
    return validateBaseUrlHostPolicy({
      base,
      serviceName: "Custom connector network request",
      hostPolicy: { kind: "publicDestination" },
    });
  };
  validate(url.origin);
  if (
    url.hostname.startsWith("[") ||
    /^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname)
  ) {
    return;
  }
  const lookup = await settle(
    Promise.allSettled([resolve4(url.hostname), resolve6(url.hostname)]),
    signal,
  );
  if (!lookup.ok) {
    throw lookup.error;
  }
  const addresses: string[] = [];
  for (const answer of lookup.value) {
    if (answer.status === "fulfilled") {
      addresses.push(...answer.value);
    } else if (
      !(answer.reason instanceof Error) ||
      !("code" in answer.reason) ||
      (answer.reason.code !== "ENODATA" && answer.reason.code !== "ENOTFOUND")
    ) {
      throw new McpOAuthUnsafeUrlError();
    }
  }
  if (addresses.length === 0) {
    throw new McpOAuthUnsafeUrlError();
  }
  for (const address of addresses) {
    validate(`https://${address.includes(":") ? `[${address}]` : address}`);
  }
  signal.throwIfAborted();
  // Workers performs its own DNS resolution for HTTPS. This validates observed
  // answers; it does not pin the eventual connection to one of those answers.
}

async function boundedRequest(
  url: URL,
  requestData: SerializedRequest,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  // The caller owns the original abort reason (including TimeoutError).
  // Resolve that reason as an observed request outcome so the request-local
  // deferred never reports an expected timeout as an unhandled background
  // failure, while upstream classification still receives the original error.
  const deferredOwner = new AbortController();
  const deferred = createDeferredPromise<RequestOutcome>(deferredOwner.signal);
  const settleDeferredFromAbort = () => {
    if (!deferred.settled()) {
      deferred.resolve({ ok: false, error: signal.reason });
    }
  };
  if (signal.aborted) {
    settleDeferredFromAbort();
  } else {
    signal.addEventListener("abort", settleDeferredFromAbort, { once: true });
  }
  return await (async () => {
    const request = httpsRequest(
      url,
      {
        agent: false,
        method: requestData.method,
        headers: outgoingRequestHeaders(requestData.headers),
        maxHeaderSize: MCP_OAUTH_MAX_HEADER_BYTES,
        signal,
      },
      (response) => {
        const headerBytes = Object.entries(response.headers).reduce(
          (total, [name, value]) => {
            return (
              total +
              Buffer.byteLength(name) +
              Buffer.byteLength(
                Array.isArray(value) ? value.join(", ") : (value ?? ""),
              ) +
              4
            );
          },
          0,
        );
        if (headerBytes > MCP_OAUTH_MAX_HEADER_BYTES) {
          const error = new Error("MCP OAuth response headers are too large");
          deferred.resolve({ ok: false, error });
          response.destroy(error);
          return;
        }
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on("data", (chunk: Buffer) => {
          if (deferred.settled()) {
            return;
          }
          responseBytes += chunk.byteLength;
          if (responseBytes > MCP_OAUTH_MAX_RESPONSE_BYTES) {
            const error = new Error("MCP OAuth response is too large");
            deferred.resolve({ ok: false, error });
            response.destroy(error);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("error", (error) => {
          if (!deferred.settled()) {
            deferred.resolve({ ok: false, error });
          }
        });
        response.on("aborted", () => {
          if (!deferred.settled()) {
            deferred.resolve({
              ok: false,
              error: new Error("MCP OAuth response was aborted"),
            });
          }
        });
        response.on("end", () => {
          if (deferred.settled()) {
            return;
          }
          const status = response.statusCode ?? 502;
          if (status < 200 || status > 599) {
            deferred.resolve({
              ok: false,
              error: new Error("MCP OAuth response status is invalid"),
            });
            return;
          }
          const body = Buffer.concat(chunks);
          deferred.resolve({
            ok: true,
            response: new Response(
              responseCanHaveBody(requestData.method, status) ? body : null,
              {
                status,
                statusText: response.statusMessage,
                headers: responseHeaders(response.headers),
              },
            ),
          });
        });
      },
    );
    request.on("error", (error) => {
      if (!deferred.settled()) {
        deferred.resolve({ ok: false, error });
      }
    });
    request.end(requestData.body);
    const outcome = await deferred.promise;
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.response;
  })().finally(() => {
    signal.removeEventListener("abort", settleDeferredFromAbort);
    if (!deferred.settled()) {
      deferredOwner.abort(
        new DOMException("MCP OAuth request aborted", "AbortError"),
      );
    }
  });
}

function redirectLocation(response: Response): string | null {
  return REDIRECT_STATUSES.some((status) => {
    return status === response.status;
  })
    ? response.headers.get("location")
    : null;
}

export type McpOAuthNetworkAdmission = (
  request: { readonly url: URL; readonly method: string },
  signal: AbortSignal,
) => Promise<Readonly<Record<string, string>>>;

export function createMcpOAuthSafeFetch(
  admitNetwork?: McpOAuthNetworkAdmission,
): FetchLike {
  return async (input, init) => {
    const signal = new Request(input, init).signal;
    const requestData = serializedRequest(init);
    let url = allowedUrl(input);
    let redirectCount = 0;

    while (true) {
      if (admitNetwork) {
        requestData.headers.delete("CF-Access-Client-Id");
        requestData.headers.delete("CF-Access-Client-Secret");
        await validateObservedPublicDestination(url, signal);
        const headers = await admitNetwork(
          { url, method: requestData.method },
          signal,
        );
        signal.throwIfAborted();
        for (const [name, value] of Object.entries(headers)) {
          requestData.headers.set(name, value);
        }
      }
      const response = await boundedRequest(url, requestData, signal);
      if (
        admitNetwork &&
        requestData.headers.has("CF-Access-Client-Id") &&
        (response.status === 401 || response.status === 403) &&
        !(await hasApplicationChallenge(response))
      ) {
        throw new McpOAuthNetworkRejectedError();
      }
      const location = redirectLocation(response);
      if (location === null) {
        return response;
      }
      if (requestData.method === "POST") {
        throw new Error("MCP OAuth POST redirects are not allowed");
      }
      if (redirectCount === MCP_OAUTH_MAX_REDIRECTS) {
        throw new Error("MCP OAuth response has too many redirects");
      }
      for (const name of REDIRECT_SENSITIVE_HEADERS) {
        requestData.headers.delete(name);
      }
      url = allowedUrl(new URL(location, url));
      redirectCount += 1;
    }
  };
}

export const mcpOAuthSafeFetch = createMcpOAuthSafeFetch();
