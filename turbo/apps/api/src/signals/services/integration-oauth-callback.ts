import { command } from "ccstate";
import {
  INTEGRATION_OAUTH_CALLBACK_PATHS,
  type IntegrationOAuthProvider,
} from "@okouai/core/integration-routes";

import { env } from "../../lib/env";
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

export const setIntegrationOAuthCallbackHeaders$ = command(({ set }) => {
  set(setResHeader$, "Cache-Control", "no-store");
  set(setResHeader$, "Referrer-Policy", "no-referrer");
});

export function integrationOAuthCallbackResponse(
  response: Response,
  responseMode: "json" | undefined,
) {
  const redirectUrl = response.headers.get("location");
  return responseMode === "json" && redirectUrl
    ? { status: 200 as const, body: { redirectUrl } }
    : response;
}
