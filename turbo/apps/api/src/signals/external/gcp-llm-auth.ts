import { getVercelOidcTokenSync } from "@vercel/oidc";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
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
  startUntrackedBestEffortCleanup,
} from "../utils";

const L = logger("GcpLlmAuth");
const STS_URL = "https://sts.us-west1.rep.googleapis.com/v1/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REFRESH_SKEW_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
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
type Configuration = z.infer<typeof configurationSchema>;

/** Validate only when a Google LLM operation needs this optional configuration. */
export function gcpLlmConfiguration(): Configuration | undefined {
  const result = configurationSchema.safeParse({
    project: optionalEnv("GCP_LLM_PROJECT_ID"),
    provider: optionalEnv("GCP_LLM_WORKLOAD_IDENTITY_PROVIDER"),
    serviceAccount: optionalEnv("GCP_LLM_SERVICE_ACCOUNT_EMAIL"),
  });
  return result.success ? result.data : undefined;
}

export class GcpLlmAuthError extends Error {
  constructor(
    readonly stage: "oidc" | "sts" | "impersonation" | "deadline",
    readonly status: number,
    readonly temporary = false,
    readonly reason:
      | GcpLlmTransportReason
      | "http"
      | "invalid_response"
      | "missing_identity"
      | "deadline" = "invalid_response",
  ) {
    super("Google Cloud LLM authentication failed");
    this.name = "GcpLlmAuthError";
  }
}

interface Credential {
  readonly accessToken: string;
  readonly expiresAt: number;
}

interface Refresh {
  readonly id: symbol;
  readonly controller: AbortController;
  readonly promise: Promise<Credential>;
  waiters: number;
}

interface CacheEntry {
  credential?: Credential;
  refresh?: Refresh;
}

// Configuration is immutable within a deployment; separate entries also keep
// simultaneous requests for different service accounts from sharing credentials.
const credentials = singleton(() => {
  return new Map<string, CacheEntry>();
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

async function tokenResponse(
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

async function exchange(
  configuration: Configuration,
  signal: AbortSignal,
): Promise<Credential> {
  signal.throwIfAborted();
  // Read the current request context without the SDK's local CLI refresh path.
  const subjectToken = safeSync(getVercelOidcTokenSync);
  if (!("ok" in subjectToken) || !subjectToken.ok) {
    throw new GcpLlmAuthError("oidc", 401, false, "missing_identity");
  }
  const stsResponse = fetch(STS_URL, {
    method: "POST",
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
  const sts = stsResponseSchema.safeParse(
    await tokenResponse(stsResponse, "sts", signal),
  );
  if (!sts.success) {
    throw new GcpLlmAuthError("sts", 502);
  }
  const response = fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${configuration.serviceAccount}:generateAccessToken`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sts.data.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope: [SCOPE], lifetime: "3600s" }),
      signal,
    },
  );
  const token = impersonationResponseSchema.safeParse(
    await tokenResponse(response, "impersonation", signal),
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

async function completeRefresh(
  configuration: Configuration,
  entry: CacheEntry,
  refreshId: symbol,
  ownerSignal: AbortSignal,
): Promise<Credential> {
  const deadline = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  const signal = AbortSignal.any([ownerSignal, deadline]);
  const credential = await onRejection(
    awaitWithSignal(exchange(configuration, signal), signal),
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
  if (entry.refresh?.id === refreshId) {
    entry.credential = credential;
  }
  return credential;
}

function refreshCredential(
  configuration: Configuration,
  entry: CacheEntry,
): Refresh {
  const controller = new AbortController();
  const refreshId = Symbol("Google LLM credential refresh");
  const refresh: Refresh = {
    id: refreshId,
    controller,
    waiters: 0,
    promise: completeRefresh(
      configuration,
      entry,
      refreshId,
      controller.signal,
    ).finally(() => {
      if (entry.refresh === refresh) {
        delete entry.refresh;
      }
    }),
  };
  entry.refresh = refresh;
  return refresh;
}

/** Each request owns its wait; only the last departing waiter cancels exchange. */
export async function gcpLlmAccessToken(
  configuration: Configuration,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const key = JSON.stringify([configuration, env("ENV"), STS_URL, SCOPE]);
  let entry = credentials().get(key);
  if (!entry) {
    entry = {};
    credentials().set(key, entry);
  }
  if (
    entry.credential &&
    entry.credential.expiresAt > now() + REFRESH_SKEW_MS
  ) {
    return entry.credential.accessToken;
  }
  const refresh = entry.refresh ?? refreshCredential(configuration, entry);
  refresh.waiters += 1;
  const credential = await awaitWithSignal(refresh.promise, signal).finally(
    () => {
      refresh.waiters -= 1;
      if (refresh.waiters === 0 && entry.refresh === refresh) {
        delete entry.refresh;
        refresh.controller.abort();
      }
    },
  );
  signal.throwIfAborted();
  return credential.accessToken;
}
