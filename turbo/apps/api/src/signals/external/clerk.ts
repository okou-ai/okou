import { computed, type Computed } from "ccstate";

import { createClerkClient, verifyToken } from "@clerk/backend";
import {
  isClerkAPIResponseError,
  TokenVerificationError,
  TokenVerificationErrorReason,
} from "@clerk/backend/errors";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { delay } from "signal-timers";
import { array, number, object, string, union, url } from "zod";
import { singleton } from "../../lib/singleton";
import { env } from "../../lib/env";
import { safeJsonParse, settle } from "../utils";

export interface ClerkOAuthIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

const oauthClaimsSchema = object({
  iss: string(),
  aud: union([string().min(1), array(string().min(1)).min(1)]),
  sub: string().startsWith("user_").min(6),
  org_id: string().startsWith("org_").min(5),
  // Must fit the persisted MCP source contract before any input is accepted.
  client_id: string()
    .min(1)
    .max(2048)
    .refine((value) => {
      return value.trim().length > 0;
    }),
  exp: number().int().positive(),
  scope: string().optional(),
  scp: array(string().min(1)).optional(),
});

const invalidOAuthTokenReasons: readonly string[] = Object.freeze([
  TokenVerificationErrorReason.TokenExpired,
  TokenVerificationErrorReason.TokenInvalid,
  TokenVerificationErrorReason.TokenInvalidAlgorithm,
  TokenVerificationErrorReason.TokenInvalidAuthorizedParties,
  TokenVerificationErrorReason.TokenInvalidSignature,
  TokenVerificationErrorReason.TokenNotActiveYet,
  TokenVerificationErrorReason.TokenIatInTheFuture,
  TokenVerificationErrorReason.TokenVerificationFailed,
  TokenVerificationErrorReason.JWKKidMismatch,
]);

export class ClerkOAuthVerificationUnavailableError extends Error {
  constructor() {
    super("OAuth verification is temporarily unavailable");
    this.name = "ClerkOAuthVerificationUnavailableError";
  }
}

/** Choose a verifier only; an untrusted JWT header never authorizes a request. */
export function isClerkOAuthAccessToken(token: string): boolean {
  const header = token.split(".", 1)[0];
  if (!header) {
    return false;
  }
  const parsed = object({ typ: string() }).safeParse(
    safeJsonParse(Buffer.from(header, "base64url").toString("utf8")),
  );
  return (
    parsed.success &&
    ["at+jwt", "application/at+jwt"].includes(parsed.data.typ.toLowerCase())
  );
}

/** Full, signed OAuth claims; the provider's reduced token wrapper omits org/aud. */
export async function verifyClerkOAuthAccessToken(
  token: string,
  config: { readonly issuer: string; readonly resource: string },
): Promise<ClerkOAuthIdentity | undefined> {
  const verified = await settle(
    verifyToken(token, {
      secretKey: env("CLERK_SECRET_KEY"),
      audience: config.resource,
      headerType: ["at+jwt", "application/at+jwt"],
      clockSkewInMs: 0,
    }),
  );
  if (!verified.ok) {
    if (
      verified.error instanceof TokenVerificationError &&
      invalidOAuthTokenReasons.includes(verified.error.reason)
    ) {
      return undefined;
    }
    // Key-service and configuration failures do not mean invalid credentials.
    throw new ClerkOAuthVerificationUnavailableError();
  }
  const parsed = oauthClaimsSchema.safeParse(verified.value);
  if (
    !parsed.success ||
    parsed.data.iss !== config.issuer ||
    !(typeof parsed.data.aud === "string"
      ? parsed.data.aud === config.resource
      : parsed.data.aud.includes(config.resource))
  ) {
    return undefined;
  }
  const {
    sub,
    org_id: orgId,
    client_id: clientId,
    scope,
    scp,
    exp,
  } = parsed.data;
  const scopes =
    scope === undefined ? scp : scope.split(/\s+/u).filter(Boolean);
  if (
    !scopes ||
    (scopes &&
      scp &&
      (scopes.some((item) => {
        return !scp.includes(item);
      }) ||
        scp.some((item) => {
          return !scopes.includes(item);
        })))
  ) {
    return undefined;
  }
  return {
    userId: sub,
    orgId,
    clientId,
    scopes,
    expiresAt: exp,
  };
}

/**
 * Clerk gateway. This module is the only place `@clerk/backend` is resolved:
 * it belongs to `tsconfig.gateways.json`, so the SDK declaration surface is
 * parsed once in that small program instead of inside the core one, which is
 * what sets the CI peak RSS for apps/api (same move as `@aws-sdk/*` in
 * PR #25714).
 *
 * Everything exported below is an application-owned type; that is what keeps the
 * emitted `.d.ts` free of Clerk types. The mirrored client covers exactly the
 * surface callers use today - widening it is fine, naming a Clerk type in an
 * exported signature is not.
 */

export interface ClerkPaginated<T> {
  readonly data: readonly T[];
  readonly totalCount: number;
}

export interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

export interface ClerkUser {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly imageUrl: string;
  readonly privateMetadata: Record<string, unknown>;
}

export interface ClerkOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string | null;
  readonly imageUrl: string;
  readonly hasImage: boolean;
  readonly createdAt: number;
  readonly createdBy?: string;
}

export interface ClerkOrganizationMembershipPublicUserData {
  readonly userId: string;
}

export interface ClerkOrganizationMembership {
  readonly id: string;
  readonly role: string;
  readonly createdAt: number;
  readonly organization: ClerkOrganization;
  readonly publicUserData?: ClerkOrganizationMembershipPublicUserData | null;
}

export interface ClerkOrganizationInvitation {
  readonly id: string;
  readonly emailAddress: string;
  readonly role: string;
  readonly createdAt: number;
}

export type ClerkOrganizationInvitationStatus =
  "pending" | "accepted" | "revoked" | "expired";

export interface ClerkUsersApi {
  getUser(
    userId: string,
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<ClerkUser>;
  getUserList(
    params?: {
      userId?: string[];
      emailAddress?: string[];
      limit?: number;
      offset?: number;
    },
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<ClerkPaginated<ClerkUser>>;
  getOrganizationMembershipList(
    params: {
      userId: string;
      limit?: number;
      offset?: number;
    },
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<ClerkPaginated<ClerkOrganizationMembership>>;
  updateUserMetadata(
    userId: string,
    params: {
      publicMetadata?: Record<string, unknown>;
      privateMetadata?: Record<string, unknown>;
    },
  ): Promise<ClerkUser>;
}

export interface ClerkOrganizationsApi {
  getOrganization(
    params: {
      organizationId: string;
    },
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<ClerkOrganization>;
  getOrganizationMembershipList(
    params: {
      organizationId: string;
      userId?: string[];
      limit?: number;
      offset?: number;
    },
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<ClerkPaginated<ClerkOrganizationMembership>>;
  getOrganizationInvitationList(
    params: {
      organizationId: string;
      status?: ClerkOrganizationInvitationStatus[];
      limit?: number;
      offset?: number;
    },
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<ClerkPaginated<ClerkOrganizationInvitation>>;
  createOrganizationInvitation(params: {
    organizationId: string;
    emailAddress: string;
    inviterUserId?: string;
    role: string;
    redirectUrl?: string;
    expiresInDays?: number;
    privateMetadata?: Record<string, unknown>;
  }): Promise<ClerkOrganizationInvitation>;
  revokeOrganizationInvitation(params: {
    organizationId: string;
    invitationId: string;
    requestingUserId?: string;
  }): Promise<ClerkOrganizationInvitation>;
  updateOrganizationMembership(params: {
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<ClerkOrganizationMembership>;
  deleteOrganizationMembership(params: {
    organizationId: string;
    userId: string;
  }): Promise<ClerkOrganizationMembership>;
  updateOrganization(
    organizationId: string,
    params: { name?: string },
  ): Promise<ClerkOrganization>;
  updateOrganizationLogo(
    organizationId: string,
    params: { file: Blob | File; uploaderUserId?: string },
  ): Promise<ClerkOrganization>;
  deleteOrganization(organizationId: string): Promise<ClerkOrganization>;
}

export interface ClerkMachineToMachineApi {
  createToken(params: {
    machineSecretKey: string;
    secondsUntilExpiration?: number;
    minRemainingTtlSeconds?: number;
  }): Promise<{ readonly token?: string }>;
}

export interface ClerkSessionsApi {
  getSession(
    sessionId: string,
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<{
    readonly id: string;
    readonly userId: string;
    readonly status: string;
    readonly expireAt: number;
  }>;
}

export interface ClerkClient {
  readonly sessions: ClerkSessionsApi;
  readonly users: ClerkUsersApi;
  readonly organizations: ClerkOrganizationsApi;
  readonly m2m: ClerkMachineToMachineApi;
}

export interface ClerkRateLimit {
  readonly retryAfterSeconds: number;
}

export class ClerkRateLimitError extends Error implements ClerkRateLimit {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ClerkRateLimitError";
    this.retryAfterSeconds = normalizeRetryAfterSeconds(retryAfterSeconds);
  }
}

const CLERK_READ_MAX_ATTEMPTS = 3;
const CLERK_READ_MAX_TOTAL_DELAY_MS = 15_000;
const CLERK_READ_MAX_JITTER_MS = 250;
const CLERK_READ_PROVIDER_UNAVAILABLE_DELAY_MS = 1000;

export interface ClerkReadUnavailable {
  readonly providerStatus: number | null;
  readonly failureClass:
    "transient_read_exhausted" | "transport_read_exhausted";
}

class ClerkReadUnavailableError extends Error implements ClerkReadUnavailable {
  readonly failureClass: ClerkReadUnavailable["failureClass"];

  constructor(
    readonly providerStatus: number | null,
    cause: unknown,
  ) {
    super("Clerk read is temporarily unavailable", { cause });
    this.name = "ClerkReadUnavailableError";
    this.failureClass =
      providerStatus === null
        ? "transport_read_exhausted"
        : "transient_read_exhausted";
  }
}

export interface ClerkReadContext {
  readonly remainingDelayMs: () => number;
}

export function createClerkReadContext(
  currentTimeMs: () => number = Date.now,
): ClerkReadContext {
  const deadlineAtMs = currentTimeMs() + CLERK_READ_MAX_TOTAL_DELAY_MS;
  return {
    remainingDelayMs: () => {
      return Math.max(0, deadlineAtMs - currentTimeMs());
    },
  };
}

function normalizeRetryAfterSeconds(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.ceil(value))
    : 1;
}

export function clerkRateLimit(error: unknown): ClerkRateLimit | null {
  if (error instanceof ClerkRateLimitError) {
    return error;
  }
  if (!isClerkAPIResponseError(error) || error.status !== 429) {
    return null;
  }
  return {
    retryAfterSeconds: normalizeRetryAfterSeconds(error.retryAfter),
  };
}

export function clerkReadUnavailable(
  error: unknown,
): ClerkReadUnavailable | null {
  return error instanceof ClerkReadUnavailableError ? error : null;
}

export function isClerkResourceNotFound(error: unknown): boolean {
  return isClerkAPIResponseError(error) && error.status === 404;
}

export function isClerkInvitationEmailFormatError(error: unknown): boolean {
  return (
    isClerkAPIResponseError(error) &&
    error.status === 422 &&
    error.errors.length > 0 &&
    // The format code is shared by other parameters; handle only the email refusal.
    error.errors.every(({ code, longMessage }) => {
      return (
        code === "form_param_format_invalid" &&
        longMessage === "Email address must be a valid email address."
      );
    })
  );
}

export type ClerkOrganizationInvitationConflict =
  "already_member" | "already_invited";

/**
 * Clerk rejects an invitation when the address is already a member or still
 * has an active invitation. Keep this narrower than a general Clerk 4xx so
 * configuration, authorization, and unrecognized validation failures remain server errors.
 */
export function clerkOrganizationInvitationConflict(
  error: unknown,
): ClerkOrganizationInvitationConflict | null {
  if (
    !isClerkAPIResponseError(error) ||
    (error.status !== 400 && error.status !== 409 && error.status !== 422)
  ) {
    return null;
  }
  if (
    error.errors.some(({ code }) => {
      return code === "already_a_member_in_organization";
    })
  ) {
    return "already_member";
  }
  if (
    error.errors.some(({ code }) => {
      return (
        code === "duplicate_record" ||
        code === "organization_invitation_not_unique"
      );
    })
  ) {
    return "already_invited";
  }
  return null;
}

interface ClerkReadRetry {
  readonly delayMs: number;
  readonly providerStatus: number | null;
}

function clerkReadRetry(error: unknown): ClerkReadRetry | null {
  if (!isClerkAPIResponseError(error)) {
    return null;
  }

  // Clerk 3.13.1 wraps fetch failures without a status. Its catch also wraps
  // parsing errors, so only the observed singleton transport signature retries.
  if (
    error.status === undefined &&
    Array.isArray(error.errors) &&
    error.errors.length === 1 &&
    error.errors[0]?.code === "unexpected_error" &&
    error.errors[0]?.message === "fetch failed"
  ) {
    return {
      delayMs: CLERK_READ_PROVIDER_UNAVAILABLE_DELAY_MS,
      providerStatus: null,
    };
  }

  if (
    !Number.isInteger(error.status) ||
    error.status < 500 ||
    error.status > 599
  ) {
    return null;
  }

  return {
    delayMs: CLERK_READ_PROVIDER_UNAVAILABLE_DELAY_MS,
    providerStatus: error.status,
  };
}

/** Retry Clerk 5xx/transport reads; rate limits surface without another request. */
export async function retryClerkRead<T>(
  read: () => Promise<T>,
  context: ClerkReadContext = createClerkReadContext(),
  signal: AbortSignal = new AbortController().signal,
): Promise<T> {
  let totalDelayMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    const result = await settle(read(), signal);
    if (result.ok) {
      return result.value;
    }

    const retry = clerkReadRetry(result.error);
    if (!retry) {
      throw result.error;
    }
    if (attempt >= CLERK_READ_MAX_ATTEMPTS) {
      throw new ClerkReadUnavailableError(retry.providerStatus, result.error);
    }

    const remainingDelayMs = Math.min(
      CLERK_READ_MAX_TOTAL_DELAY_MS - totalDelayMs,
      context.remainingDelayMs(),
    );
    if (retry.delayMs > remainingDelayMs) {
      throw new ClerkReadUnavailableError(retry.providerStatus, result.error);
    }
    const jitterBudgetMs = Math.min(
      CLERK_READ_MAX_JITTER_MS,
      remainingDelayMs - retry.delayMs,
    );
    const jitterMs = Math.floor(Math.random() * (jitterBudgetMs + 1));
    const waitMs = retry.delayMs + jitterMs;
    await delay(waitMs, { signal });
    totalDelayMs += waitMs;
  }
}

/** Session identity as the API models it, independent of Clerk's auth object. */
export interface ClerkSessionIdentity {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly orgId: string | null;
  readonly orgRole: string | null;
}

export interface ClerkSessionAuthentication {
  readonly identity: ClerkSessionIdentity | null;
}

/** The only two fields the Clerk webhook route reads off an event. */
export interface ClerkWebhookEvent {
  readonly type: string;
  readonly data: unknown;
}

const clerkSdk = singleton(() => {
  return createClerkClient({
    secretKey: env("CLERK_SECRET_KEY"),
    publishableKey: env("CLERK_PUBLISHABLE_KEY"),
  });
});

function clerkRead<T>(
  read: () => Promise<T>,
  context: ClerkReadContext | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  return retryClerkRead(
    read,
    context ?? createClerkReadContext(),
    signal ?? new AbortController().signal,
  );
}

const clerkClient = singleton((): ClerkClient => {
  const sdk = clerkSdk();
  return {
    sessions: {
      getSession: (sessionId, context, signal) => {
        return clerkRead(
          () => {
            return sdk.sessions.getSession(sessionId);
          },
          context,
          signal,
        );
      },
    },
    users: {
      getUser: (userId, context, signal) => {
        return clerkRead(
          () => {
            return sdk.users.getUser(userId);
          },
          context,
          signal,
        );
      },
      getUserList: (params, context, signal) => {
        return clerkRead(
          () => {
            return sdk.users.getUserList(params);
          },
          context,
          signal,
        );
      },
      getOrganizationMembershipList: (params, context, signal) => {
        return clerkRead(
          () => {
            return sdk.users.getOrganizationMembershipList(params);
          },
          context,
          signal,
        );
      },
      updateUserMetadata: (userId, params) => {
        return sdk.users.updateUserMetadata(userId, params);
      },
    },
    organizations: {
      getOrganization: (params, context, signal) => {
        return clerkRead(
          () => {
            return sdk.organizations.getOrganization(params);
          },
          context,
          signal,
        );
      },
      getOrganizationMembershipList: (params, context, signal) => {
        return clerkRead(
          () => {
            return sdk.organizations.getOrganizationMembershipList(params);
          },
          context,
          signal,
        );
      },
      getOrganizationInvitationList: (params, context, signal) => {
        return clerkRead(
          () => {
            return sdk.organizations.getOrganizationInvitationList(params);
          },
          context,
          signal,
        );
      },
      createOrganizationInvitation: (params) => {
        return sdk.organizations.createOrganizationInvitation(params);
      },
      revokeOrganizationInvitation: (params) => {
        return sdk.organizations.revokeOrganizationInvitation(params);
      },
      updateOrganizationMembership: (params) => {
        return sdk.organizations.updateOrganizationMembership(params);
      },
      deleteOrganizationMembership: (params) => {
        return sdk.organizations.deleteOrganizationMembership(params);
      },
      updateOrganization: (organizationId, params) => {
        return sdk.organizations.updateOrganization(organizationId, params);
      },
      updateOrganizationLogo: (organizationId, params) => {
        return sdk.organizations.updateOrganizationLogo(organizationId, params);
      },
      deleteOrganization: (organizationId) => {
        return sdk.organizations.deleteOrganization(organizationId);
      },
    },
    m2m: {
      createToken: (params) => {
        return sdk.m2m.createToken(params);
      },
    },
  };
});

export const clerk$: Computed<ClerkClient> = computed((): ClerkClient => {
  return clerkClient();
});

/**
 * Clerk's `RequestState` is a wide union whose members disagree about what
 * `toAuth()` returns, so it is collapsed here rather than mirrored: callers
 * keep only the signed-in identity.
 */
export async function authenticateClerkSession(
  request: Request,
  options?: { readonly authorizedParties: readonly string[] },
): Promise<ClerkSessionAuthentication> {
  const requestState = await clerkSdk().authenticateRequest(request, {
    acceptsToken: "session_token",
    ...(options ? { authorizedParties: [...options.authorizedParties] } : {}),
  });

  if (!requestState.isAuthenticated) {
    return { identity: null };
  }

  const auth = requestState.toAuth();
  const party = auth.sessionClaims?.azp;
  if (typeof party === "string") {
    const origin = url().safeParse(party);
    if (!origin.success) {
      return { identity: null };
    }
    const hostname = new URL(origin.data).hostname.replace(/\.$/u, "");
    // User-hosted origins are never general App clients, including credentials
    // issued before the satellite was removed. Site delivery uses its own handles.
    if (
      [env("OKOU_PUBLIC_HOST_DOMAIN"), env("ZERO_HOST_DOMAIN")].some(
        (domain) => {
          const normalized = domain.toLowerCase().replace(/\.$/u, "");
          return hostname === normalized || hostname.endsWith(`.${normalized}`);
        },
      )
    ) {
      return { identity: null };
    }
  }
  const userId: unknown = auth.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    return { identity: null };
  }

  return {
    identity: {
      userId,
      sessionId:
        typeof auth.sessionId === "string" && auth.sessionId.length > 0
          ? auth.sessionId
          : null,
      orgId: auth.orgId ?? null,
      orgRole: auth.orgRole ?? null,
    },
  };
}

/** Verify the caller and machine-to-machine scope with the receiver's key. */
export async function authenticateClerkMachine(
  request: Request,
  machineSecretKey: string,
): Promise<{ readonly machineId: string } | null> {
  const requestState = await clerkSdk().authenticateRequest(request, {
    acceptsToken: "m2m_token",
    machineSecretKey,
  });
  if (!requestState.isAuthenticated) {
    return null;
  }
  const auth = requestState.toAuth();
  if (auth.tokenType !== "m2m_token" || !auth.machineId || !auth.id) {
    return null;
  }
  return { machineId: auth.machineId };
}

export async function verifyClerkWebhook(
  request: Request,
  options: { readonly signingSecret?: string },
): Promise<ClerkWebhookEvent> {
  return await verifyWebhook(request, options);
}
