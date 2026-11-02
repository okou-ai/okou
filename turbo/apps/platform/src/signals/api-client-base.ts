import {
  initClient,
  trpcRestFetchApi,
} from "@okouai/api-contracts/client/transport";
import type {
  ClientRouter,
  ApiFetcherArgs,
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/client/types";
import { validateClientResponse } from "@okouai/api-contracts/client/response-validation";

import { IN_VITEST } from "../env.ts";
import type { AuthTokenProvider } from "../lib/auth-token-provider.ts";
import {
  clientTelemetryOutcomeForError,
  type ClientTelemetryOperation,
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../lib/client-telemetry.ts";
import { addClientHeaders } from "./client-headers.ts";
import { reportForceUpgradeResponse } from "./force-upgrade.ts";
import { onRejection } from "./utils.ts";

interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly clientVersion: string;
  readonly getToken: AuthTokenProvider;
  readonly getTokenGuard?: () => () => void;
  readonly getVercelProtectionBypass: () => string | undefined;
  readonly onForceUpgrade?: () => void;
  readonly validateResponse?: boolean;
  readonly resolvePath?: (
    path: string,
    ctx: { method: string },
  ) => Promise<string> | string;
}

const API_BOOTSTRAP_SELECTOR =
  'script[type="application/json"][data-okou-api-bootstrap]';

function findBootstrapResponseScript(
  method: string,
  path: string,
): HTMLScriptElement | null {
  const currentDocument = globalThis.document;
  if (currentDocument === undefined) {
    return null;
  }

  for (const script of currentDocument.querySelectorAll<HTMLScriptElement>(
    API_BOOTSTRAP_SELECTOR,
  )) {
    if (
      script.dataset.method !== method ||
      script.dataset.path !== encodeURIComponent(path) ||
      script.dataset.contentType !== "application/json"
    ) {
      continue;
    }

    return script;
  }

  return null;
}

/** Discard an unread Worker prefetch when its resource is invalidated. */
export function discardApiBootstrapResponse(
  method: string,
  path: string,
): void {
  findBootstrapResponseScript(method, path)?.remove();
}

function takeBootstrapResponse(
  method: string,
  requestUrl: string,
  baseUrl: string,
): {
  readonly status: 200;
  readonly body: unknown;
  readonly headers: Headers;
} | null {
  const url = new URL(requestUrl, baseUrl);
  const script = findBootstrapResponseScript(
    method,
    `${url.pathname}${url.search}`,
  );
  if (!script) {
    return null;
  }

  // The Worker emits this inert script after parsing a successful JSON API
  // response. Parsing here makes it the first response for the same request.
  const body: unknown = JSON.parse(script.textContent ?? "");
  const headers = new Headers({ "Content-Type": "application/json" });
  script.remove();
  return { status: 200, body, headers };
}

export function createAuthedContractClient<T extends ClientRouter>(
  contract: T,
  options: AuthedClientOptions,
): InitClientReturn<T, InitClientArgs> {
  return initClient(contract, {
    baseUrl: options.baseUrl,
    jsonQuery: false,
    // Validation is handled below so errors include the actual response body.
    validateResponse: false,
    api: async (args: ApiFetcherArgs) => {
      const signal = args.fetchOptions?.signal ?? undefined;
      const path = options.resolvePath
        ? await options.resolvePath(args.path, { method: args.route.method })
        : args.path;
      signal?.throwIfAborted();

      const requestWithToken = async (token: string | null) => {
        const headers = new Headers(args.headers);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        addClientHeaders(headers, options.clientVersion);
        const vercelProtectionBypass = options.getVercelProtectionBypass();
        if (vercelProtectionBypass) {
          headers.set("X-Vercel-Protection-Bypass", vercelProtectionBypass);
        }
        return await trpcRestFetchApi({
          ...args,
          fetchOptions: {
            ...args.fetchOptions,
            credentials: "include",
          },
          headers,
          path,
        });
      };

      const bootstrapResponse = takeBootstrapResponse(
        args.method,
        path,
        options.baseUrl,
      );
      const response =
        bootstrapResponse ??
        (await (async () => {
          const validateToken = options.getTokenGuard?.();
          signal?.throwIfAborted();
          validateToken?.();
          const token = await options.getToken(signal);
          signal?.throwIfAborted();
          validateToken?.();
          const measurement = startClientTelemetryMeasurement();
          const requestTelemetry = {
            event_name: "http.request",
            method: args.route.method,
            route: args.route.path,
          } satisfies ClientTelemetryOperation;
          // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: shared network-failure telemetry.
          const networkResponse = await onRejection(
            requestWithToken(token),
            (error) => {
              recordClientTelemetry(
                measurement,
                requestTelemetry,
                clientTelemetryOutcomeForError(error),
              );
            },
          );
          recordClientTelemetry(
            measurement,
            {
              ...requestTelemetry,
              response_status_code: networkResponse.status,
            },
            networkResponse.status >= 500 ? "error" : "success",
          );
          return networkResponse;
        })());

      if (reportForceUpgradeResponse(response, options.onForceUpgrade)) {
        return response;
      }

      if (IN_VITEST || options.validateResponse) {
        return validateClientResponse(args.route, response);
      }

      return response;
    },
  });
}
