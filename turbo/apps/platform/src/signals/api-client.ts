/**
 * Type-safe API client for Platform → Okou API calls.
 *
 * Replaces raw fetch$ usage with typed tRPC-backed clients that provide
 * compile-time type checking for request/response shapes.
 */
import { computed } from "ccstate";
import type {
  ClientRouter,
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/client/types";
import { getCapturedPreviewBypassForTarget } from "../lib/preview-bypass-cookie.ts";
import { resolveApiBaseForTarget, resolveOAuthApiBase } from "./api-base.ts";
import {
  createAuthedContractClient,
  type AuthTokenProvider,
} from "./api-client-base.ts";
import { clerk$ } from "./auth.ts";
import { readClerkToken } from "./clerk-token.ts";

/**
 * Type alias for the factory function returned by `get(apiClient$)`.
 * Useful for shared helper functions that accept the client factory
 * as a parameter (e.g. `createThread`).
 */
export type ApiClientFactory = <T extends ClientRouter>(
  contract: T,
  options?: ApiClientOptions,
) => InitClientReturn<T, InitClientArgs>;

declare const oauthApiBaseBrand: unique symbol;

type OAuthApiBase = "oauth" & {
  readonly [oauthApiBaseBrand]: true;
};

/**
 * Environment-aware API base reserved for OAuth and origin handoff flows.
 * Normal platform API calls should use the default API backend or `apiBase: "api"`.
 */
export const OAUTH_API_BASE = "oauth" as OAuthApiBase;

export interface ApiClientOptions {
  readonly apiBase?: "auto" | "api" | OAuthApiBase;
  /** Pin an exchange to its freshly activated session, or make it unauthenticated. */
  readonly getToken?: AuthTokenProvider;
  /** Capture request auth state before a token read and validate it afterwards. */
  readonly getTokenGuard?: () => () => void;
}

function rebaseApiPath(
  path: string,
  apiBase: string,
  defaultApiBase: string,
): string {
  const url = new URL(path, defaultApiBase);
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  return `${base}${url.pathname}${url.search}${url.hash}`;
}

function createClerkTokenProvider(
  clerk: Promise<Parameters<typeof readClerkToken>[0]>,
): AuthTokenProvider {
  return async (requestSignal) => {
    const resolvedClerk = await clerk;
    requestSignal?.throwIfAborted();
    return await readClerkToken(resolvedClerk, requestSignal);
  };
}

/**
 * Factory signal for creating typed tRPC-backed clients.
 *
 * Returns a function that accepts any tRPC-backed contract and returns
 * a fully configured client with auth token injection and base URL
 * resolution.
 *
 * @example
 * ```ts
 * const createClient = get(apiClient$);
 * const client = createClient(chatThreadByIdContract);
 * const result = await client.get({ params: { id: threadId } });
 * if (result.status === 200) {
 *   console.log(result.body.title);
 * }
 * ```
 */
export const apiClient$ = computed((get) => {
  const apiBaseUrl = resolveApiBaseForTarget("api");
  const oauthApiBaseUrl = resolveOAuthApiBase();
  const getToken = createClerkTokenProvider(get(clerk$));
  return <T extends ClientRouter>(contract: T, options?: ApiClientOptions) => {
    return createAuthedContractClient(contract, {
      getToken: options?.getToken ?? getToken,
      getTokenGuard: options?.getTokenGuard,
      baseUrl: apiBaseUrl,
      clientVersion: __OKOU_APP_VERSION__,
      resolvePath: (path) => {
        if (options?.apiBase === OAUTH_API_BASE) {
          return rebaseApiPath(path, oauthApiBaseUrl, apiBaseUrl);
        }
        return rebaseApiPath(path, apiBaseUrl, apiBaseUrl);
      },
      getVercelProtectionBypass: () => {
        return getCapturedPreviewBypassForTarget(apiBaseUrl) ?? undefined;
      },
    });
  };
});
