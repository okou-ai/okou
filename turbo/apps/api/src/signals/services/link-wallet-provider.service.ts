import { z } from "zod";

import { env } from "../../lib/env";
import { settle } from "../utils";
import { walletSpendStatusSchema } from "@okouai/api-contracts/contracts/wallet";

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
  token_type: z.literal("Bearer"),
});

export const linkCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int(),
});

export function linkActionUrl(value: string): string {
  const parsed = z.url().safeParse(value);
  if (parsed.success) {
    const url = new URL(parsed.data);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "link.com" ||
        url.hostname.endsWith(".link.com") ||
        url.hostname === "hooks.stripe.com")
    ) {
      return value;
    }
  }
  throw new LinkWalletError(
    502,
    "WALLET_INVALID_RESPONSE",
    "Link returned an invalid action URL",
  );
}

// Projection deliberately drops card details, tokens, billing addresses and unknown fields.
export const linkSpendSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  status: walletSpendStatusSchema.exclude(["creating"]),
  amount: z.number().int(),
  currency: z.string(),
  merchant_name: z.string(),
  merchant_url: z.string(),
  approval_url: z.string().optional(),
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

async function linkFetch(
  url: string,
  options: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const result = await settle(
    fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    }),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    throw new LinkWalletError(
      502,
      "WALLET_PROVIDER_UNAVAILABLE",
      "Link is unavailable; do not assume the operation failed or create a replacement purchase",
    );
  }
  return result.value;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    // Never attach provider bodies or token-bearing request options to errors.
    throw new LinkWalletError(
      response.status === 401 ? 409 : 502,
      response.status === 401
        ? "WALLET_RECONNECT_REQUIRED"
        : "WALLET_PROVIDER_ERROR",
      response.status === 401
        ? "Reconnect your Link wallet"
        : "Link could not complete the operation; check the existing request before retrying",
    );
  }
  const result = await settle(response.json() as Promise<unknown>);
  if (!result.ok) {
    throw new LinkWalletError(
      502,
      "WALLET_INVALID_RESPONSE",
      "Link returned an invalid response",
    );
  }
  return result.value;
}

export async function linkTokenRequest(
  params: Record<string, string>,
  signal: AbortSignal,
) {
  const config = linkWalletConfig();
  const response = await linkFetch(
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
    signal,
  );
  const parsed = linkTokenSchema.safeParse(await responseJson(response));
  if (
    !parsed.success ||
    !parsed.data.scope.split(/[ ,]+/).includes("payment_methods.agentic")
  ) {
    throw new LinkWalletError(
      403,
      "WALLET_SCOPE_REQUIRED",
      "Link payment authorization was not granted",
    );
  }
  return parsed.data;
}

export async function revokeLinkToken(
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const config = linkWalletConfig();
  const response = await linkFetch(
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
    signal,
  );
  if (!response.ok) {
    throw new LinkWalletError(
      502,
      "WALLET_REVOCATION_INCOMPLETE",
      "Wallet access is disabled locally; Link revocation must be retried",
    );
  }
}

export async function linkSpendRequest(
  token: string,
  path: string,
  method: "GET" | "POST",
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
): Promise<LinkSpend> {
  const response = await linkFetch(
    `https://api.link.com/spend_requests${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    signal,
  );
  if (response.status === 409 && method === "POST" && path === "") {
    // Link may report an idempotent replay as a duplicate object rather than 200.
    // Apply the same secret-dropping projection; never create another intent.
    const duplicateBody = await settle(response.json() as Promise<unknown>);
    if (duplicateBody.ok) {
      const duplicate = z
        .object({
          error: z.object({ duplicate_spend_request: linkSpendSchema }),
        })
        .safeParse(duplicateBody.value);
      if (duplicate.success) {
        return duplicate.data.error.duplicate_spend_request;
      }
    }
    throw new LinkWalletError(
      409,
      "WALLET_CREATION_UNCERTAIN",
      "The existing purchase intent could not be recovered; do not create a replacement purchase",
    );
  }
  const parsed = linkSpendSchema.safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new LinkWalletError(
      502,
      "WALLET_INVALID_RESPONSE",
      "Link returned an invalid spend request",
    );
  }
  return parsed.data;
}

export async function requestLinkApproval(
  token: string,
  id: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await linkFetch(
    `https://api.link.com/spend_requests/${encodeURIComponent(id)}/request_approval`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
    signal,
  );
  const parsed = z
    .object({ id: z.literal(id), approval_link: z.string() })
    .safeParse(await responseJson(response));
  if (!parsed.success) {
    throw new LinkWalletError(
      502,
      "WALLET_INVALID_RESPONSE",
      "Link returned an invalid approval response",
    );
  }
  return linkActionUrl(parsed.data.approval_link);
}
