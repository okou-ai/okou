import { command, computed, state } from "ccstate";
import type { AuthTokenProvider } from "../lib/auth-token-provider.ts";

interface ApiClientRuntime {
  readonly apiBaseUrl: string;
  readonly getToken: AuthTokenProvider;
  readonly oauthApiBaseUrl: string;
  readonly vercelProtectionBypass?: string;
  readonly onForceUpgrade?: () => void;
}

const internalApiClientRuntime$ = state<ApiClientRuntime | undefined>(
  undefined,
);

export const setApiClientRuntime$ = command(
  ({ set }, runtime: ApiClientRuntime): void => {
    set(internalApiClientRuntime$, runtime);
  },
);

export const apiClientRuntime$ = computed((get): ApiClientRuntime => {
  const runtime = get(internalApiClientRuntime$);
  if (!runtime) {
    throw new Error("API client runtime was not initialized");
  }
  return runtime;
});
