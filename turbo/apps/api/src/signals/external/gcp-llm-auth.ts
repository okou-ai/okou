import { getVercelOidcTokenSync } from "@vercel/oidc";
import { delay } from "signal-timers";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { currentRequestRuntime } from "../../lib/request-runtime";
import { now } from "../../lib/time";
import { singleton } from "../../lib/singleton";
import {
  gcpLlmTransportReason,
  type GcpLlmTransportReason,
} from "./gcp-llm-transport";
import {
  awaitWithSignal,
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  safeSync,
  settle,
  startUntrackedBestEffortCleanup,
} from "../utils";

const L = logger("GcpLlmAuth");
const STS_URL = "https://sts.us-west1.rep.googleapis.com/v1/token";
const MTLS_STS_URL = "https://sts.mtls.googleapis.com/v1/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REFRESH_SKEW_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_TOKEN_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const configurationSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  provider: z
    .string()
    .regex(
      /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/u,
    ),
  serviceAccount: z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u,
    ),
});
const certificateChainSchema = z
  .array(z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u))
  .min(1)
  .max(5);
type Configuration = z.infer<typeof configurationSchema> &
  (
    | { readonly identity: "oidc" }
    | {
        readonly identity: "mtls";
        readonly certificateChain: readonly string[];
      }
  );

/** Validate only when a Google LLM operation needs this optional configuration. */
export function gcpLlmConfiguration(): Configuration | undefined {
  const result = configurationSchema.safeParse({
    project: optionalEnv("GCP_LLM_PROJECT_ID"),
    provider: optionalEnv("GCP_LLM_WORKLOAD_IDENTITY_PROVIDER"),
    serviceAccount: optionalEnv("GCP_LLM_SERVICE_ACCOUNT_EMAIL"),
  });
  if (!result.success) {
    return undefined;
  }
  const runtime = currentRequestRuntime();
  if (!runtime) {
    return { ...result.data, identity: "oidc" };
  }
  const chain = optionalEnv("GCP_MTLS_CERTIFICATE_CHAIN");
  const certificates = certificateChainSchema.safeParse(
    chain ? safeJsonParse(chain) : undefined,
  );
  if (!runtime.gcpMtls || !certificates.success) {
    return undefined;
  }
  return {
    ...result.data,
    identity: "mtls",
    certificateChain: certificates.data,
  };
}

export class GcpLlmAuthError extends Error {
  constructor(
    readonly stage: "oidc" | "mtls" | "sts" | "impersonation" | "deadline",
    readonly status: number,
    readonly temporary = false,
    readonly reason:
      | GcpLlmTransportReason
      | "http"
      | "invalid_response"
      | "missing_identity"
      | "deadline" = "invalid_response",
    readonly retryAfterMs?: number,
  ) {
    super("Google Cloud LLM authentication failed");
    this.name = "GcpLlmAuthError";
  }
}

interface Credential {
  readonly accessToken: string;
  readonly expiresAt: number;
}

// Cache completed credentials only; each request owns its token exchange.
const credentials = singleton(() => {
  return new Map<string, Credential>();
});

const stsResponseSchema = z.object({
  access_token: z.string().trim().min(1),
  token_type: z.literal("Bearer"),
  issued_token_type: z.literal(ACCESS_TOKEN_TYPE),
  expires_in: z.number().finite().positive().max(3600),
});
const impersonationResponseSchema = z.object({
  accessToken: z.string().trim().min(1),
  expireTime: z.iso.datetime({ offset: true }),
});

function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const text = value.trim();
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

async function readTokenResponse(
  pending: Promise<Response>,
  stage: "sts" | "impersonation",
  signal: AbortSignal,
): Promise<unknown> {
  const rejectTransport = (error: unknown) => {
    signal.throwIfAborted();
    const reason = gcpLlmTransportReason(error);
    if (reason) {
      throw new GcpLlmAuthError(stage, 503, true, reason);
    }
  };
  const response = await onRejection(pending, rejectTransport);
  signal.throwIfAborted();
  if (!response.ok) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    throw new GcpLlmAuthError(
      stage,
      response.status,
      response.status === 429 || response.status >= 500,
      "http",
      retryAfterMs(response.headers.get("Retry-After")),
    );
  }
  const body = await onRejection(
    readBoundedResponseText(response, MAX_RESPONSE_BYTES),
    rejectTransport,
  );
  signal.throwIfAborted();
  if (body.kind !== "text") {
    throw new GcpLlmAuthError(stage, 502);
  }
  return safeJsonParse(body.text);
}

/** Recover only the failed token endpoint, within the request's auth budget. */
async function tokenResponse(
  request: () => Promise<Response>,
  stage: "sts" | "impersonation",
  deadlineAt: number,
  signal: AbortSignal,
): Promise<unknown> {
  let attempts = 0;
  while (true) {
    signal.throwIfAborted();
    if (now() >= deadlineAt) {
      throw new GcpLlmAuthError("deadline", 503, true, "deadline");
    }
    attempts += 1;
    const result = await settle(
      readTokenResponse(request(), stage, signal),
      signal,
    );
    if (result.ok) {
      return result.value;
    }
    const error = result.error;
    // A locally rejected response can also have status 502. Retry only actual
    // transient HTTP/transport failures, never validation or identity errors.
    const retryable =
      error instanceof GcpLlmAuthError &&
      (error.reason === "network" ||
        error.reason === "upstream_timeout" ||
        (error.reason === "http" &&
          [429, 500, 502, 503, 504].includes(error.status)));
    if (!retryable || attempts >= MAX_TOKEN_ATTEMPTS) {
      throw error;
    }
    const wait = Math.max(
      INITIAL_BACKOFF_MS * 2 ** (attempts - 1) +
        Math.floor(Math.random() * INITIAL_BACKOFF_MS),
      error.retryAfterMs ?? 0,
    );
    // A provider's minimum delay cannot extend the deadline or permit an
    // earlier retry. The original signal also bounds I/O and the wait itself.
    if (wait >= deadlineAt - now()) {
      throw error;
    }
    await delay(wait, { signal });
  }
}

function stsRequest(
  configuration: Configuration,
  signal: AbortSignal,
): () => Promise<Response> {
  if (configuration.identity === "mtls") {
    const binding = currentRequestRuntime()?.gcpMtls;
    if (!binding) {
      throw new GcpLlmAuthError("mtls", 503, false, "missing_identity");
    }
    return () => {
      return binding.fetch(MTLS_STS_URL, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          audience: `//iam.googleapis.com/${configuration.provider}`,
          scope: SCOPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
          subject_token: JSON.stringify(configuration.certificateChain),
        }),
        signal,
      });
    };
  }
  // Read the current request context without the SDK's local CLI refresh path.
  const subjectToken = safeSync(getVercelOidcTokenSync);
  if (!("ok" in subjectToken) || !subjectToken.ok) {
    throw new GcpLlmAuthError("oidc", 401, false, "missing_identity");
  }
  return () => {
    return fetch(STS_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: `//iam.googleapis.com/${configuration.provider}`,
        scope: SCOPE,
        requested_token_type: ACCESS_TOKEN_TYPE,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        subject_token: subjectToken.ok,
      }),
      signal,
    });
  };
}

async function exchange(
  configuration: Configuration,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<Credential> {
  signal.throwIfAborted();
  const sts = stsResponseSchema.safeParse(
    await tokenResponse(
      stsRequest(configuration, signal),
      "sts",
      deadlineAt,
      signal,
    ),
  );
  if (!sts.success) {
    throw new GcpLlmAuthError("sts", 502);
  }
  const response = () => {
    return fetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${configuration.serviceAccount}:generateAccessToken`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${sts.data.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scope: [SCOPE], lifetime: "3600s" }),
        signal,
      },
    );
  };
  const token = impersonationResponseSchema.safeParse(
    await tokenResponse(response, "impersonation", deadlineAt, signal),
  );
  if (!token.success) {
    throw new GcpLlmAuthError("impersonation", 502);
  }
  const expiresAt = Date.parse(token.data.expireTime);
  const receivedAt = now();
  const maxLocalExpiry = receivedAt + 3_600_000;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= receivedAt ||
    expiresAt > maxLocalExpiry + CLOCK_SKEW_MS
  ) {
    throw new GcpLlmAuthError("impersonation", 502);
  }
  // Google's absolute timestamp uses its clock. Accept bounded clock skew,
  // but do not let it extend local reuse beyond the requested token lifetime.
  return {
    accessToken: token.data.accessToken,
    expiresAt: Math.min(expiresAt, maxLocalExpiry),
  };
}

async function refreshCredential(
  configuration: Configuration,
  ownerSignal: AbortSignal,
): Promise<Credential> {
  const deadlineAt = now() + AUTH_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  const signal = AbortSignal.any([ownerSignal, deadline]);
  const credential = await onRejection(
    awaitWithSignal(exchange(configuration, deadlineAt, signal), signal),
    (error) => {
      ownerSignal.throwIfAborted();
      if (deadline.aborted) {
        L.warn("Google Cloud LLM authentication rejected", {
          stage: "deadline",
          status: 503,
          reason: "deadline",
        });
        throw new GcpLlmAuthError("deadline", 503, true, "deadline");
      }
      if (error instanceof GcpLlmAuthError) {
        L.warn("Google Cloud LLM authentication rejected", {
          stage: error.stage,
          status: error.status,
          reason: error.reason,
        });
      }
    },
  );
  signal.throwIfAborted();
  return credential;
}

/** Reuse completed tokens without sharing request-owned authentication I/O. */
export async function gcpLlmAccessToken(
  configuration: Configuration,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const key = JSON.stringify([configuration, env("ENV"), SCOPE]);
  const cached = credentials().get(key);
  if (cached && cached.expiresAt > now() + REFRESH_SKEW_MS) {
    return cached.accessToken;
  }
  const credential = await refreshCredential(configuration, signal);
  signal.throwIfAborted();
  credentials().set(key, credential);
  return credential.accessToken;
}
