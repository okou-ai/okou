import { command, computed, state } from "ccstate";
import type {
  AuthDiagnosticContext,
  AuthTokenProvider,
} from "../lib/auth-diagnostics.ts";

interface ApiClientRuntime {
  readonly apiBaseUrl: string;
  readonly getToken: AuthTokenProvider;
  readonly authDiagnosticContext?: AuthDiagnosticContext;
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
