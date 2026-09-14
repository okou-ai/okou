import { command, computed, state } from "ccstate";

interface ApiClientRuntime {
  readonly apiBaseUrl: string;
  readonly getToken: (signal?: AbortSignal) => Promise<string | null>;
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
