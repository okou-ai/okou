import { command, type Command } from "ccstate";
import {
  INTEGRATION_OAUTH_CALLBACK_PATHS,
  type IntegrationOAuthProvider,
} from "@okouai/core/integration-routes";

import { env } from "../../lib/env";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";

/** Provider redirects carry no application bearer token. Authenticate in App first. */
export function integrationOAuthAppRedirect(
  integration: IntegrationOAuthProvider,
  query: Readonly<Record<string, string | undefined>>,
): Response {
  const url = new URL(
    INTEGRATION_OAUTH_CALLBACK_PATHS[integration],
    env("APP_URL"),
  );
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && key !== "responseMode") {
      url.searchParams.set(key, value);
    }
  }
  url.searchParams.set("integration", integration);
  return new Response(null, {
    status: 307,
    headers: {
      location: url.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** Construct once at the route boundary; reject missing auth before consuming state. */
export function authenticatedIntegrationOAuthCallback(
  handler$: Command<Promise<Response>, [AbortSignal]>,
  responseMode: "json" | "redirect",
) {
  const authenticated$ = authRoute(
    { requireOrganization: true, missingOrganizationStatus: 401 },
    command(async ({ set }, signal: AbortSignal) => {
      const response = await set(handler$, signal);
      if (responseMode === "redirect") {
        return response;
      }
      const redirectUrl = response.headers.get("location");
      if (!redirectUrl) {
        return response;
      }
      return { status: 200 as const, body: { redirectUrl } };
    }),
  );
  return command(async ({ set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    set(setResHeader$, "Referrer-Policy", "no-referrer");
    return await set(authenticated$, signal);
  });
}
