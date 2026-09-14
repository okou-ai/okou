/**
 * Type-safe API client for Platform → Okou API calls.
 *
 * Replaces raw fetch$ usage with typed tRPC-backed clients that provide
 * compile-time type checking for request/response shapes.
 */
import { computed } from "ccstate";
import type {
  AppRouter,
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { appVersion$ } from "./app-version.ts";
import { createAuthedContractClient } from "./api-client-base.ts";
import { apiClientRuntime$ } from "./api-client-runtime.ts";
import { rootSignal$ } from "./root-signal.ts";

/**
 * Type alias for the factory function returned by `get(apiClient$)`.
 * Useful for shared helper functions that accept the client factory
 * as a parameter (e.g. `createAgent`).
 */
export type ApiClientFactory = <T extends AppRouter>(
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
  readonly getToken?: (signal: AbortSignal) => Promise<string | null>;
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
 * const client = createClient(agentsByIdContract);
 * const result = await client.get({ params: { id: "my-agent-id" } });
 * if (result.status === 200) {
 *   console.log(result.body.displayName);
 * }
 * ```
 */
// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
export const apiClient$ = computed((get) => {
  const runtime = get(apiClientRuntime$);
  const clientVersion = get(appVersion$);
  const rootSignal = get(rootSignal$);
  const tokenOptions = {
    getToken: runtime.getToken,
  };
  return <T extends AppRouter>(contract: T, options?: ApiClientOptions) => {
    return createAuthedContractClient(contract, {
      getToken: options?.getToken ?? tokenOptions.getToken,
      getTokenGuard: options?.getTokenGuard,
      baseUrl: runtime.apiBaseUrl,
      clientVersion,
      getRootSignal: () => {
        return rootSignal;
      },
      resolvePath: (path) => {
        if (options?.apiBase === "api") {
          return rebaseApiPath(path, runtime.apiBaseUrl, runtime.apiBaseUrl);
        }
        if (options?.apiBase === OAUTH_API_BASE) {
          return rebaseApiPath(
            path,
            runtime.oauthApiBaseUrl,
            runtime.apiBaseUrl,
          );
        }
        return rebaseApiPath(path, runtime.apiBaseUrl, runtime.apiBaseUrl);
      },
      getVercelProtectionBypass: () => {
        return runtime.vercelProtectionBypass;
      },
      onForceUpgrade: runtime.onForceUpgrade,
    });
  };
});
