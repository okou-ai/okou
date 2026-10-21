import { z } from "zod";
import {
  HOSTED_SITE_AUTH_CALLBACK_PATH,
  hostedSiteAccessDecisionSchema,
  hostedSiteAuthCodeSchema,
  hostedSiteAuthProofSchema,
  hostedSiteSessionSchema,
  hostedSiteSessionTokenSchema,
} from "@okouai/api-contracts/contracts/hosted-site-access";

export interface SiteAuthEnv {
  readonly HOSTED_SITE_AUTH_URL?: string;
  readonly HOST_DOMAIN: string;
  readonly OKOU_HOST_DOMAIN: string;
  readonly HOSTED_SITE_API_ORIGIN?: string;
  /** Prepared by default; enable only after #41704 accepts every serving route. */
  readonly HOSTED_SITE_ACCESS_ENABLED?: string;
}

const activationSchema = z.enum(["true", "false"]).default("false");
const preparedDecisionSchema = z.object({ allowed: z.boolean() });

export function hostedSiteAccessEnabled(env: SiteAuthEnv): boolean {
  return activationSchema.parse(env.HOSTED_SITE_ACCESS_ENABLED) === "true";
}

const SESSION_COOKIE = "__Host-okou-site-session";
const LOGIN_COOKIE_PREFIX = "__Host-okou-site-login-";
const LOGIN_LIFETIME_SECONDS = 10 * 60;
const MAX_SESSION_SECONDS = 7 * 24 * 60 * 60;

function authHeaders() {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "worker-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}

function cookie(request: Request, name: string) {
  return (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => {
      return part.trim();
    })
    .find((part) => {
      return part.startsWith(`${name}=`);
    })
    ?.slice(name.length + 1);
}

function setCookie(headers: Headers, name: string, value: string, age: number) {
  headers.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`,
  );
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function randomProof() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function navigation(request: Request) {
  const destination = request.headers.get("Sec-Fetch-Dest");
  return (
    request.method === "GET" &&
    (destination === "document" ||
      (!destination &&
        request.headers.get("Accept")?.startsWith("text/html") === true))
  );
}

function siteIdOf(endpoint: URL) {
  const siteId = /^\/api\/host\/(?:sites|delivery)\/([^/]+)\//u.exec(
    endpoint.pathname,
  )?.[1];
  if (!siteId) throw new Error("Invalid hosted site authority endpoint");
  return siteId;
}

async function beginLogin(
  request: Request,
  env: SiteAuthEnv,
  endpoint: URL,
  headers: Headers,
) {
  const url = new URL(request.url);
  if (!navigation(request)) {
    return new Response("Authentication required", { status: 401, headers });
  }
  if (!env.HOSTED_SITE_AUTH_URL)
    throw new Error("Hosted site sign-in is not configured");
  const bridge = new URL(env.HOSTED_SITE_AUTH_URL);
  if (
    url.protocol !== "https:" ||
    bridge.protocol !== "https:" ||
    bridge.origin === url.origin ||
    !url.hostname.endsWith(`.${env.OKOU_HOST_DOMAIN}`)
  ) {
    throw new Error("Invalid hosted site sign-in origin");
  }
  const verifier = randomProof();
  const state = randomProof();
  const returnTo = `${url.pathname}${url.search}`;
  if (returnTo.length > 2048)
    return new Response("Website URL is too long", { status: 400, headers });
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const pending = base64url(
    new TextEncoder().encode(
      JSON.stringify({ verifier, returnTo, siteId: siteIdOf(endpoint) }),
    ),
  );
  // A cookie per flow lets separate tabs complete without overwriting each other.
  setCookie(
    headers,
    `${LOGIN_COOKIE_PREFIX}${state}`,
    pending,
    LOGIN_LIFETIME_SECONDS,
  );
  bridge.searchParams.set("siteId", siteIdOf(endpoint));
  bridge.searchParams.set("origin", url.origin);
  bridge.searchParams.set("codeChallenge", challenge);
  bridge.searchParams.set("state", state);
  headers.set("Location", bridge.href);
  return new Response(null, { status: 302, headers });
}

const pendingLoginSchema = z.object({
  siteId: z.uuid(),
  verifier: hostedSiteAuthProofSchema,
  returnTo: z
    .string()
    .max(2048)
    .refine((value) => {
      return value.startsWith("/") && !value.startsWith("//");
    }),
});

function pendingLogin(value: string | undefined) {
  if (!value) return null;
  try {
    const bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => {
        return c.charCodeAt(0);
      },
    );
    const parsed = pendingLoginSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof DOMException)
      return null;
    throw error;
  }
}

export async function hostedSiteAuthCallback(
  request: Request,
  env: SiteAuthEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== HOSTED_SITE_AUTH_CALLBACK_PATH) return null;
  const headers = authHeaders();
  const code = hostedSiteAuthCodeSchema.safeParse(url.searchParams.get("code"));
  const state = hostedSiteAuthProofSchema.safeParse(
    url.searchParams.get("state"),
  );
  const name = state.success ? `${LOGIN_COOKIE_PREFIX}${state.data}` : null;
  const pending = name ? pendingLogin(cookie(request, name)) : null;
  if (name) setCookie(headers, name, "", 0);
  if (
    request.method !== "GET" ||
    !hostedSiteAccessEnabled(env) ||
    !env.HOSTED_SITE_API_ORIGIN ||
    url.protocol !== "https:" ||
    !code.success ||
    !pending
  ) {
    return new Response("Sign-in link expired. Open the website again.", {
      status: 400,
      headers,
    });
  }
  const exchange = new URL(
    `/api/host/sites/${pending.siteId}/sessions`,
    env.HOSTED_SITE_API_ORIGIN,
  );
  const response = await fetch(exchange, {
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      origin: url.origin,
      code: code.data,
      codeVerifier: pending.verifier,
    }),
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
  });
  if (response.status === 401) {
    return new Response("Sign-in link expired. Open the website again.", {
      status: 401,
      headers,
    });
  }
  if (response.status !== 200)
    throw new Error("Hosted site sign-in is unavailable");
  const session = hostedSiteSessionSchema.parse(await response.json());
  const age = Math.min(
    MAX_SESSION_SECONDS,
    Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
  );
  if (age <= 0) throw new Error("Hosted site session has expired");
  setCookie(headers, SESSION_COOKIE, session.sessionToken, age);
  const returnTo = new URL(pending.returnTo, url.origin);
  if (
    returnTo.origin !== url.origin ||
    returnTo.pathname === HOSTED_SITE_AUTH_CALLBACK_PATH
  ) {
    throw new Error("Invalid hosted site return URL");
  }
  // Consume every callback before any document, including after a change to Public.
  headers.set("Location", returnTo.href);
  return new Response(null, { status: 303, headers });
}

async function decision(
  request: Request,
  env: SiteAuthEnv,
  endpoint: URL,
  token?: string,
) {
  const response = await fetch(endpoint, {
    cache: "no-store",
    redirect: "manual",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
  });
  if (response.status !== 200)
    throw new Error("Hosted site authority is unavailable");
  const body: unknown = await response.json();
  // Preserve the GA delivery protocol while API rollback targets predate this
  // feature. Remove the prepared reader after #41704 establishes the API floor
  // and activates all routes. Active readers never infer Public on an old API.
  if (!hostedSiteAccessEnabled(env)) {
    const { allowed } = preparedDecisionSchema.parse(body);
    return allowed
      ? { allowed: true as const, decision: "allow" as const }
      : { allowed: false as const, decision: "deny" as const };
  }
  return hostedSiteAccessDecisionSchema.parse(body);
}

export function withSiteAuthHeaders(
  response: Response,
  headers: Headers,
): Response {
  const output = new Headers(response.headers);
  for (const cookie of headers.getSetCookie())
    output.append("Set-Cookie", cookie);
  if (headers.has("Cache-Control"))
    output.set("Cache-Control", "private, no-store");
  if (headers.has("Referrer-Policy"))
    output.set("Referrer-Policy", "no-referrer");
  if (headers.has("Content-Security-Policy"))
    output.append("Content-Security-Policy", "worker-src 'none'");
  if (headers.has("Cross-Origin-Resource-Policy"))
    output.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    headers: output,
  });
}

/** Public access is resolved without session or identity-provider work. */
export async function authorizeSiteRequest(
  request: Request,
  env: SiteAuthEnv,
  endpoint: URL,
): Promise<
  | { readonly headers: Headers; readonly response?: never }
  | { readonly response: Response; readonly headers?: never }
> {
  const completed = await hostedSiteAuthCallback(request, env);
  if (completed) return { response: completed };
  const anonymous = await decision(request, env, endpoint);
  if (anonymous.allowed)
    return { headers: new Headers({ "Cache-Control": "private, no-store" }) };
  if (anonymous.decision === "deny")
    return {
      response: new Response("Not found", {
        status: 404,
        headers: authHeaders(),
      }),
    };
  const headers = authHeaders();
  const token = hostedSiteSessionTokenSchema.safeParse(
    cookie(request, SESSION_COOKIE),
  );
  if (token.success) {
    const authenticated = await decision(request, env, endpoint, token.data);
    if (authenticated.allowed) return { headers };
    if (authenticated.decision === "deny") {
      return {
        response: new Response("Access denied", { status: 403, headers }),
      };
    }
    // An older request must not delete a newer login completed in another tab.
    // Invalid handles stay rejected on the server until the next login replaces them.
  }
  return { response: await beginLogin(request, env, endpoint, headers) };
}

export async function withHostedSiteAccess(
  request: Request,
  env: SiteAuthEnv,
  siteId: string,
  serve: () => Promise<Response>,
): Promise<Response> {
  const completed = await hostedSiteAuthCallback(request, env);
  if (completed) return completed;
  // Preserve existing preview/share grants during preparation. #41704 removes
  // this branch only after every serving Worker and API rollback target is ready.
  if (!hostedSiteAccessEnabled(env)) return serve();
  if (!env.HOSTED_SITE_API_ORIGIN)
    throw new Error("Hosted site authority is unavailable");
  const endpoint = new URL(
    `/api/host/sites/${encodeURIComponent(siteId)}/access`,
    env.HOSTED_SITE_API_ORIGIN,
  );
  endpoint.searchParams.set("origin", new URL(request.url).origin);
  const access = await authorizeSiteRequest(request, env, endpoint);
  if (access.response) return access.response;
  return withSiteAuthHeaders(await serve(), access.headers);
}
