import { computed, type Computed } from "ccstate";

import { createClerkClient } from "@clerk/backend";
import {
  ClerkAPIResponseError,
  isClerkAPIResponseError,
} from "@clerk/backend/errors";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { delay } from "signal-timers";
import { z } from "zod";
import { singleton } from "../../lib/singleton";
import { env } from "../../lib/env";
import { settle } from "../utils";

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
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export interface ClerkUserListParams {
  readonly userId?: string[];
  readonly emailAddress?: string[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface ClerkUsersApi {
  getUser(
    userId: string,
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<ClerkUser>;
  getUserList(
    params?: ClerkUserListParams,
    context?: ClerkReadContext,
    signal?: AbortSignal,
  ): Promise<{ readonly data: readonly ClerkUser[] }>;
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

export interface ClerkSignInTokensApi {
  createSignInToken(params: {
    userId: string;
    expiresInSeconds: number;
  }): Promise<{ readonly token: string }>;
}

export interface ClerkMachineToMachineApi {
  createToken(params: {
    machineSecretKey: string;
    secondsUntilExpiration?: number;
    minRemainingTtlSeconds?: number;
  }): Promise<{ readonly token?: string }>;
}

export interface ClerkClient {
  readonly users: ClerkUsersApi;
  readonly organizations: ClerkOrganizationsApi;
  readonly signInTokens: ClerkSignInTokensApi;
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
    | "transient_read_exhausted"
    | "transport_read_exhausted";
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

interface ClerkReadRetry {
  readonly delayMs: number;
  readonly providerStatus: number | null;
}

class ClerkUserListTransportError extends Error {}

function clerkReadRetry(error: unknown): ClerkReadRetry | null {
  if (error instanceof ClerkUserListTransportError) {
    return {
      delayMs: CLERK_READ_PROVIDER_UNAVAILABLE_DELAY_MS,
      providerStatus: null,
    };
  }
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
  readonly orgId: string | null;
  readonly orgRole: string | null;
}

/** The only two fields the Clerk webhook route reads off an event. */
export interface ClerkWebhookEvent {
  readonly type: string;
  readonly data: unknown;
}

export interface ClerkDeletionEnvelope {
  readonly audience: string;
  readonly eventId: string;
  readonly subjectKind: "user" | "organization";
  readonly subjectId: string;
  readonly requestedAt: Date;
}

const deletionBody = z.object({
  object: z.literal("event"),
  type: z.enum(["user.deleted", "organization.deleted"]),
  instance_id: z.string().min(1).max(192),
  // Clerk's event timestamp is milliseconds since the Unix epoch. Keep it
  // inside the supported 1970-9999 date range; never infer seconds or use Svix
  // delivery time, which changes when an event is redelivered.
  timestamp: z.number().int().min(0).max(253_402_300_799_999),
  data: z.object({
    id: z
      .string()
      .min(1)
      .refine((id) => {
        return Buffer.byteLength(id) <= 192 && !id.includes("\0");
      }),
    deleted: z.literal(true),
  }),
});

/** Dormant bridge gateway. The configured instance and secret are trusted
 * configuration, never request parameters. No production resolver is installed.
 */
export async function verifyClerkDeletion(
  request: Request,
  config: { readonly audience: string; readonly signingSecret: string },
): Promise<ClerkDeletionEnvelope> {
  if (!config.audience || !config.signingSecret) {
    throw new Error("clerk_deletion:configuration_required");
  }
  const verifiedRequest = request.clone();
  const original = verifiedRequest.clone();
  const audience = config.audience;
  const eventId = verifiedRequest.headers.get("svix-id")?.trim();
  // @clerk/backend 3.13.1 verifies all bytes but drops timestamp/instance_id
  // from its returned object. Decode the same bytes only AFTER SDK verification.
  await verifyWebhook(verifiedRequest, { signingSecret: config.signingSecret });
  const body: unknown = await original.json();
  const event = deletionBody.parse(body);
  if (
    !eventId ||
    Buffer.byteLength(eventId) > 192 ||
    event.instance_id !== audience
  ) {
    throw new Error("clerk_deletion:identity_mismatch");
  }
  return {
    audience,
    eventId,
    subjectKind: event.type === "user.deleted" ? "user" : "organization",
    subjectId: event.data.id,
    requestedAt: new Date(event.timestamp),
  };
}

const clerkSdk = singleton(() => {
  return createClerkClient({
    secretKey: env("CLERK_SECRET_KEY"),
    publishableKey: env("CLERK_PUBLISHABLE_KEY"),
  });
});

const clerkUserResponse = z
  .object({
    id: z.string(),
    email_addresses: z.array(
      z.object({ id: z.string(), email_address: z.string() }),
    ),
    primary_email_address_id: z.string().nullable(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    username: z.string().nullable(),
    image_url: z.string(),
    private_metadata: z.record(z.string(), z.unknown()),
  })
  .transform((user): ClerkUser => {
    return {
      id: user.id,
      emailAddresses: user.email_addresses.map((email) => {
        return { id: email.id, emailAddress: email.email_address };
      }),
      primaryEmailAddressId: user.primary_email_address_id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      imageUrl: user.image_url,
      privateMetadata: user.private_metadata,
    };
  });
const clerkUserListResponse = z.array(clerkUserResponse);

/** The SDK's list method also fetches /users/count, unused by every caller. */
async function readClerkUserList(
  params: ClerkUserListParams | undefined,
  signal: AbortSignal,
): Promise<{ readonly data: readonly ClerkUser[] }> {
  const url = new URL("https://api.clerk.com/v1/users");
  for (const userId of params?.userId ?? []) {
    url.searchParams.append("user_id", userId);
  }
  for (const email of params?.emailAddress ?? []) {
    url.searchParams.append("email_address", email);
  }
  if (params?.limit !== undefined) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params?.offset !== undefined) {
    url.searchParams.set("offset", String(params.offset));
  }

  const result = await settle(
    fetch(url, {
      headers: {
        Authorization: `Bearer ${env("CLERK_SECRET_KEY")}`,
        // Match the locked @clerk/backend 3.13.1 wire contract.
        "Clerk-API-Version": "2026-05-12",
      },
      signal,
    }),
    signal,
  );
  if (!result.ok) {
    const error = result.error;
    if (
      error instanceof TypeError &&
      (error.message === "fetch failed" || error.message === "Failed to fetch")
    ) {
      throw new ClerkUserListTransportError("Clerk user lookup failed", {
        cause: error,
      });
    }
    throw error;
  }
  const response = result.value;
  if (!response.ok) {
    await response.text();
    const retryAfter = Number.parseInt(
      response.headers.get("Retry-After") ?? "",
      10,
    );
    throw new ClerkAPIResponseError("Clerk user lookup failed", {
      status: response.status,
      data: [],
      clerkTraceId: response.headers.get("cf-ray") ?? undefined,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    });
  }
  // Parsing failures are not transport failures and must not be retried.
  const body: unknown = await response.json();
  return { data: clerkUserListResponse.parse(body) };
}

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
      getUserList: (params, context, signal = new AbortController().signal) => {
        return clerkRead(
          () => {
            return readClerkUserList(params, signal);
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
    signInTokens: {
      createSignInToken: (params) => {
        return sdk.signInTokens.createSignInToken(params);
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
 * only need the signed-in identity, or nothing.
 */
export async function authenticateClerkSession(
  request: Request,
): Promise<ClerkSessionIdentity | null> {
  const requestState = await clerkSdk().authenticateRequest(request, {
    acceptsToken: "session_token",
  });

  if (!requestState.isAuthenticated) {
    return null;
  }

  const auth = requestState.toAuth();
  const userId: unknown = auth.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    return null;
  }

  return {
    userId,
    orgId: auth.orgId ?? null,
    orgRole: auth.orgRole ?? null,
  };
}

export async function verifyClerkWebhook(
  request: Request,
  options: { readonly signingSecret?: string },
): Promise<ClerkWebhookEvent> {
  return await verifyWebhook(request, options);
}
