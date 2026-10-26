import { accept, HttpStatusError } from "@okouai/connectors/accept";
import * as z from "zod";

import { env } from "../../lib/env";
import {
  callLinkWalletSdk,
  LinkWalletSdkResponseError,
  type LinkWalletSdkRequest,
  type LinkWalletSpendRequest,
  type LinkWalletReadRequest,
} from "../external/link-wallet-client";
import {
  settle,
  readBoundedResponseText,
  safeJsonParse,
  settleIncludingAbort,
} from "../utils";
import {
  linkRequestDiagnostic,
  linkFailureDiagnostic,
  linkSuccessDiagnostic,
  linkDiagnosticMessage,
  type LinkRequestDiagnostic,
} from "./link-wallet-diagnostics";
import {
  walletAuthorizationDetailsSchema,
  walletCardSchema,
  walletSpendStatusSchema,
} from "@okouai/api-contracts/contracts/wallet";

import {
  linkPaymentMethodSchema,
  linkTransactionsSchema,
  linkUserInfoSchema,
} from "./link-wallet-read-schemas";

export class LinkWalletError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function linkWalletConfig() {
  const clientId = env("LINK_OAUTH_CLIENT_ID");
  const clientSecret = env("LINK_OAUTH_CLIENT_SECRET");
  const publishableKey = env("LINK_STRIPE_PUBLISHABLE_KEY");
  if (!clientId || !clientSecret || !publishableKey) {
    throw new LinkWalletError(
      503,
      "WALLET_NOT_CONFIGURED",
      "Link wallet is not configured",
    );
  }
  return { clientId, clientSecret, publishableKey };
}

export function linkWalletRedirectUri(): string {
  return new URL("/connectors/link/callback", env("APP_URL")).toString();
}

export const linkTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().min(1),
  scope: z.string(),
  authorization_details: walletAuthorizationDetailsSchema.optional(),
  token_type: z.literal("Bearer"),
});

export const LINK_WALLET_OAUTH_SCOPES = [
  "payment_methods.agentic",
  "userinfo:read",
] as const;

export const LINK_WALLET_SOURCE_ACTIONS = ["read_link_transactions"] as const;

export const linkCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int(),
  scope: z.string(),
  authorizationDetails: walletAuthorizationDetailsSchema.optional(),
  readOnly: z.boolean(),
});

function isLinkActionUrl(value: string): boolean {
  const parsed = z.url().safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const url = new URL(parsed.data);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.hostname === "link.com" ||
      url.hostname.endsWith(".link.com") ||
      url.hostname === "hooks.stripe.com")
  );
}

export function linkActionUrl(value: string): string {
  if (isLinkActionUrl(value)) {
    return value;
  }
  throw new LinkWalletError(
    502,
    "WALLET_INVALID_RESPONSE",
    "Link returned an invalid action URL",
  );
}

const linkPaymentSchema = z
  .object({
    outcome: z.string(),
    amount: z.number().int().safe(),
    currency: z.string(),
    code: z.string().nullable().optional(),
    decline_code: z.string().nullable().optional(),
    created: z.number().nullable().optional(),
    refund_details: z
      .object({
        amount: z.number().int().safe(),
        currency: z.string(),
        state: z.string(),
        created: z.number(),
      })
      .nullable()
      .optional(),
  })
  .transform((value) => {
    return {
      outcome: value.outcome,
      amount: value.amount,
      currency: value.currency,
      code: value.code,
      declineCode: value.decline_code,
      created: value.created,
      refund: value.refund_details,
    };
  });

// Projection deliberately drops card details, tokens, billing addresses and unknown fields.
export const linkSpendSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  status: walletSpendStatusSchema.exclude(["creating"]),
  amount: z.number().int(),
  currency: z.string(),
  merchant_name: z.string(),
  merchant_url: z.string(),
  approval_url: z.string().optional(),
  payment_status_details: linkPaymentSchema.nullable().optional(),
  payment_history: z.array(linkPaymentSchema).optional(),
  status_details: z
    .object({
      requires_action: z
        .object({
          next_action: z.object({
            type: z.string(),
            resolution: z.enum([
              "auto_resume",
              "create_new_spend_request",
              "create_new_spend_request_after_completion",
            ]),
            action_url: z.string().nullable().optional(),
          }),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
export type LinkSpend = z.infer<typeof linkSpendSchema>;

interface LinkResponse {
  readonly response: Response;
  readonly diagnostic: LinkRequestDiagnostic;
}

async function linkFetch(
  url: Parameters<typeof globalThis.fetch>[0],
  options: RequestInit,
  diagnostic: LinkRequestDiagnostic,
  signal: AbortSignal,
): Promise<LinkResponse> {
  const result = await settleIncludingAbort(
    (async () => {
      const acceptedResponse = await settle(
        accept(
          fetch(url, {
            ...options,
            signal,
          }),
          [200, 201, 202, 204],
        ),
      );
      if (!acceptedResponse.ok) {
        const error = acceptedResponse.error;
        if (error instanceof HttpStatusError && error.status >= 300) {
          return error.response;
        }
        throw error;
      }
      return acceptedResponse.value;
    })(),
  );
  if (!result.ok) {
    const failure = linkFailureDiagnostic(diagnostic, {
      stage: "transport",
      transportError: result.error,
      transportReason: signal.aborted ? "cancelled" : "network",
    });
    signal.throwIfAborted();
    throw new LinkWalletError(
      502,
      "WALLET_PROVIDER_UNAVAILABLE",
      `Link is unavailable; do not assume the operation failed or create a replacement purchase ${linkDiagnosticMessage(failure)}`,
    );
  }
  signal.throwIfAborted();
  return { response: result.value, diagnostic };
}

async function readLinkResponse(link: LinkResponse, signal: AbortSignal) {
  const read = await settleIncludingAbort(
    readBoundedResponseText(
      link.response,
      link.response.ok ? 128 * 1024 : 16 * 1024,
    ),
  );
  signal.throwIfAborted();
  const body =
    read.ok && read.value.kind === "text"
      ? safeJsonParse(read.value.text)
      : undefined;
  return {
    body,
    text: read.ok && read.value.kind === "text" ? read.value.text : undefined,
    providerText:
      !link.response.ok &&
      link.response.headers.get("content-type")?.split(";")[0]?.trim() ===
        "text/plain" &&
      read.ok &&
      read.value.kind === "text"
        ? read.value.text
        : undefined,
    transportError: read.ok ? undefined : read.error,
    responseBodyRead: !read.ok
      ? "unreadable"
      : read.value.kind === "too_large"
        ? "too_large"
        : body === undefined
          ? "invalid_json"
          : "json",
  };
}

function invalidResponse(
  link: LinkResponse,
  message: string,
  details: {
    stage: "response_body" | "response_schema" | "scope" | "action_url";
    responseBodyRead?: string;
    issues?: readonly {
      readonly path: readonly PropertyKey[];
      readonly code: string;
    }[];
    transportError?: unknown;
  },
) {
  const failure = linkFailureDiagnostic(link.diagnostic, {
    responseBodyRead: "json",
    ...details,
    response: link.response,
  });
  return new LinkWalletError(
    502,
    "WALLET_INVALID_RESPONSE",
    `${message} ${linkDiagnosticMessage(failure)}`,
  );
}

async function responseJson(
  link: LinkResponse,
  signal: AbortSignal,
): Promise<unknown> {
  const read = await readLinkResponse(link, signal);
  return validateLinkResponse(link, read);
}

function validateLinkResponse(
  link: LinkResponse,
  read: Awaited<ReturnType<typeof readLinkResponse>>,
): unknown {
  if (!link.response.ok) {
    const diagnostic = linkFailureDiagnostic(link.diagnostic, {
      stage: "http",
      response: link.response,
      ...read,
    });
    const reconnect = ["invalid_token", "invalid_grant"].includes(
      diagnostic.providerErrorCode,
    );
    const authRejected = link.response.status === 401;
    const message = reconnect
      ? "Reconnect your Link wallet"
      : authRejected
        ? "Link rejected wallet authentication; investigate the diagnostic reference before reconnecting"
        : "Link could not complete the operation; check the existing request before retrying";
    throw new LinkWalletError(
      authRejected || reconnect ? 409 : 502,
      reconnect
        ? "WALLET_RECONNECT_REQUIRED"
        : authRejected
          ? "WALLET_PROVIDER_AUTH_REJECTED"
          : "WALLET_PROVIDER_ERROR",
      `${message} ${linkDiagnosticMessage(diagnostic)}`,
    );
  }
  if (read.body === undefined) {
    throw invalidResponse(link, "Link returned an invalid response", {
      stage: "response_body",
      responseBodyRead: read.responseBodyRead,
      transportError: read.transportError,
    });
  }
  return read.body;
}

export async function linkTokenRequest(
  params: Record<string, string>,
  signal: AbortSignal,
) {
  const config = linkWalletConfig();
  const diagnostic = linkRequestDiagnostic(
    params.grant_type === "refresh_token" ? "oauth_refresh" : "oauth_exchange",
    [
      config.clientId,
      config.clientSecret,
      config.publishableKey,
      ...Object.entries(params)
        .filter(([key]) => {
          return key !== "grant_type";
        })
        .map(([, value]) => {
          return value;
        }),
    ],
  );
  const link = await linkFetch(
    "https://login.link.com/auth/token",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.publishableKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      }),
    },
    diagnostic,
    signal,
  );
  const parsed = linkTokenSchema.safeParse(await responseJson(link, signal));
  if (!parsed.success) {
    throw invalidResponse(link, "Link returned an invalid OAuth response", {
      stage: "response_schema",
      issues: parsed.error.issues,
    });
  }
  const scopes = parsed.data.scope.split(/[ ,]+/);
  if (
    !scopes.some((scope) => {
      return [
        "payment_methods.agentic",
        "userinfo:read",
        "financial_insights.transactions.read",
      ].includes(scope);
    })
  ) {
    const failure = linkFailureDiagnostic(diagnostic, {
      stage: "scope",
      response: link.response,
      responseBodyRead: "json",
      scopes: {
        paymentScopeGranted: false,
        userinfoScopeGranted: scopes.includes("userinfo:read"),
      },
    });
    throw new LinkWalletError(
      403,
      "WALLET_SCOPE_REQUIRED",
      `Link wallet authorization was not granted ${linkDiagnosticMessage(failure)}`,
    );
  }
  linkSuccessDiagnostic(diagnostic, link.response, {
    paymentScopeGranted: scopes.includes("payment_methods.agentic"),
    userinfoScopeGranted: scopes.includes("userinfo:read"),
  });
  return parsed.data;
}

export async function revokeLinkToken(
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const config = linkWalletConfig();
  const diagnostic = linkRequestDiagnostic("oauth_revoke", [
    token,
    config.clientId,
    config.clientSecret,
    config.publishableKey,
  ]);
  const link = await linkFetch(
    "https://login.link.com/auth/revoke",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.publishableKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        token,
        token_type_hint: "refresh_token",
      }),
    },
    diagnostic,
    signal,
  );
  if (!link.response.ok) {
    const read = await readLinkResponse(link, signal);
    const failure = linkFailureDiagnostic(diagnostic, {
      stage: "http",
      response: link.response,
      ...read,
    });
    throw new LinkWalletError(
      502,
      "WALLET_REVOCATION_INCOMPLETE",
      `Wallet access is disabled locally; Link revocation must be retried ${linkDiagnosticMessage(failure)}`,
    );
  }
  linkSuccessDiagnostic(diagnostic, link.response);
}

function validateSpend(link: LinkResponse, value: unknown): LinkSpend {
  const parsed = linkSpendSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidResponse(link, "Link returned an invalid spend request", {
      stage: "response_schema",
      issues: parsed.error.issues,
    });
  }
  const nextUrl =
    parsed.data.status_details?.requires_action?.next_action.action_url;
  for (const url of [parsed.data.approval_url, nextUrl]) {
    if (url && !isLinkActionUrl(url)) {
      throw invalidResponse(link, "Link returned an invalid action URL", {
        stage: "action_url",
      });
    }
  }
  linkSuccessDiagnostic(link.diagnostic, link.response);
  return parsed.data;
}

export async function linkSpendRequest(
  token: string,
  request: LinkWalletSpendRequest & { readonly intentId: string },
  signal: AbortSignal,
): Promise<LinkSpend> {
  const { operation, intentId } = request;
  const body = operation === "spend_create" ? request.body : undefined;
  const diagnostic = linkRequestDiagnostic(
    operation,
    [
      token,
      ...Object.entries(body ?? {})
        .filter(([key]) => {
          return [
            "merchant_name",
            "merchant_url",
            "context",
            "idempotency_key",
          ].includes(key);
        })
        .flatMap(([, value]) => {
          return typeof value === "string" ? [value] : [];
        }),
    ],
    intentId,
    operation === "spend_create" && body
      ? {
          amount: z.number().parse(body.amount),
          currency: z.literal("usd").parse(body.currency),
          test: z.boolean().parse(body.test),
          contextLength: z.string().parse(body.context).length,
        }
      : undefined,
  );
  const { link, read, result } = await linkSdkRequest(
    token,
    request,
    diagnostic,
    signal,
  );
  if (link.response.status === 409 && operation === "spend_create") {
    // Recover only the same provider intent; never silently create another.
    const duplicate = z
      .object({ error: z.object({ duplicate_spend_request: linkSpendSchema }) })
      .safeParse(read.body);
    if (duplicate.success) {
      return validateSpend(link, duplicate.data.error.duplicate_spend_request);
    }
    const failure = linkFailureDiagnostic(diagnostic, {
      stage: "http",
      response: link.response,
      ...read,
      issues: duplicate.error.issues,
    });
    throw new LinkWalletError(
      409,
      "WALLET_CREATION_UNCERTAIN",
      `The existing purchase intent could not be recovered; do not create a replacement purchase ${linkDiagnosticMessage(failure)}`,
    );
  }
  return validateSpend(link, sdkResponseValue(link, read, result));
}

const linkCardSchema = z
  .object({
    brand: walletCardSchema.shape.brand,
    number: walletCardSchema.shape.number,
    cvc: walletCardSchema.shape.cvc,
    exp_month: walletCardSchema.shape.expMonth,
    exp_year: walletCardSchema.shape.expYear,
    billing_address: z
      .object({
        name: z.string(),
        line1: z.string(),
        line2: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postal_code: z.string().optional(),
        country: z.string().regex(/^[A-Z]{2}$/),
      })
      .optional(),
    valid_until: walletCardSchema.shape.validUntil,
  })
  .transform((card) => {
    const address = card.billing_address;
    return {
      brand: card.brand,
      number: card.number,
      cvc: card.cvc,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      billingAddress: address
        ? {
            name: address.name,
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            state: address.state,
            postalCode: address.postal_code,
            country: address.country,
          }
        : undefined,
      validUntil: card.valid_until,
    };
  });

export async function retrieveLinkSpendCredentials(
  token: string,
  id: string,
  intentId: string,
  signal: AbortSignal,
) {
  const diagnostic = linkRequestDiagnostic(
    "spend_credentials",
    [token],
    intentId,
  );
  const { link, read, result } = await linkSdkRequest(
    token,
    { operation: "spend_credentials", id },
    diagnostic,
    signal,
  );
  const value = sdkResponseValue(link, read, result);
  const spend = validateSpend(link, value);
  if (spend.status !== "approved") {
    return { spend, card: undefined };
  }
  const parsed = z.object({ card: linkCardSchema.optional() }).safeParse(value);
  if (!parsed.success) {
    throw invalidResponse(link, "Link returned invalid payment credentials", {
      stage: "response_schema",
      issues: parsed.error.issues,
    });
  }
  return { spend, card: parsed.data.card };
}

async function linkSdkRequest(
  token: string,
  request: LinkWalletSdkRequest,
  diagnostic: LinkRequestDiagnostic,
  signal: AbortSignal,
) {
  const captured: {
    response?: {
      link: LinkResponse;
      read: Awaited<ReturnType<typeof readLinkResponse>>;
    };
  } = {};
  const result = await settleIncludingAbort(
    callLinkWalletSdk(token, request, async (input, options) => {
      const link = await linkFetch(input, options ?? {}, diagnostic, signal);
      const read = await readLinkResponse(link, signal);
      captured.response = { link, read };
      // Bound the body before the SDK consumes it, retaining the original
      // headers and parsing outcome for the existing redacted diagnostics.
      return new Response(read.text || null, {
        status: link.response.status,
        statusText: link.response.statusText,
        headers: link.response.headers,
      });
    }),
  );
  signal.throwIfAborted();
  if (!captured.response) {
    if (!result.ok) {
      throw result.error;
    }
    throw new Error("Link SDK completed without a provider response");
  }
  return { ...captured.response, result };
}

function sdkResponseValue(
  link: LinkResponse,
  read: Awaited<ReturnType<typeof readLinkResponse>>,
  result: Awaited<ReturnType<typeof linkSdkRequest>>["result"],
): unknown {
  validateLinkResponse(link, read);
  if (!result.ok) {
    if (result.error instanceof LinkWalletSdkResponseError) {
      throw invalidResponse(link, "Link returned an invalid SDK response", {
        stage: "response_schema",
        issues: result.error.issues,
      });
    }
    throw result.error;
  }
  return result.value;
}

export async function requestLinkApproval(
  token: string,
  id: string,
  intentId: string,
  signal: AbortSignal,
): Promise<string> {
  const diagnostic = linkRequestDiagnostic(
    "spend_approval",
    [token, id],
    intentId,
  );
  const { link, read, result } = await linkSdkRequest(
    token,
    { operation: "spend_approval", id },
    diagnostic,
    signal,
  );
  const parsed = z
    .object({ id: z.literal(id), approval_url: z.string() })
    .safeParse(sdkResponseValue(link, read, result));
  if (!parsed.success) {
    throw invalidResponse(link, "Link returned an invalid approval response", {
      stage: "response_schema",
      issues: parsed.error.issues,
    });
  }
  if (!isLinkActionUrl(parsed.data.approval_url)) {
    throw invalidResponse(link, "Link returned an invalid action URL", {
      stage: "action_url",
    });
  }
  linkSuccessDiagnostic(diagnostic, link.response);
  return parsed.data.approval_url;
}

export async function readLinkWallet(
  token: string,
  request: LinkWalletReadRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const diagnostic = linkRequestDiagnostic(request.operation, [token]);
  const { link, read, result } = await linkSdkRequest(
    token,
    request,
    diagnostic,
    signal,
  );
  if (link.response.status === 202) {
    throw new LinkWalletError(
      409,
      "WALLET_DATA_PENDING",
      "Link is still retrieving the requested data; try this read again later",
    );
  }
  if (link.response.status === 403) {
    throw new LinkWalletError(
      403,
      "WALLET_SCOPE_REQUIRED",
      "Link denied access to this data; check wallet status and ask the user to update their consent",
    );
  }
  if (
    link.response.status === 404 &&
    request.operation === "payment_method_read"
  ) {
    throw new LinkWalletError(
      404,
      "WALLET_PAYMENT_METHOD_NOT_FOUND",
      "Link payment method not found",
    );
  }
  const value = sdkResponseValue(link, read, result);
  const parsed =
    request.operation === "transactions_read"
      ? linkTransactionsSchema.safeParse(value)
      : request.operation === "user_info_read"
        ? linkUserInfoSchema.safeParse(value)
        : request.operation === "payment_methods_read"
          ? z
              .array(linkPaymentMethodSchema)
              .transform((data) => {
                return { data };
              })
              .safeParse(value)
          : linkPaymentMethodSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidResponse(link, "Link returned invalid wallet data", {
      stage: "response_schema",
      issues: parsed.error.issues,
    });
  }
  if ("verification" in parsed.data && parsed.data.verification?.actionUrl) {
    linkActionUrl(parsed.data.verification.actionUrl);
  }
  linkSuccessDiagnostic(diagnostic, link.response);
  return parsed.data;
}
