import { createClerkClient } from "@clerk/backend";
import { z } from "zod";
import { hostedSiteAccessDecisionSchema } from "@okouai/api-contracts/contracts/hosted-site-access";

export interface SiteAuthEnv {
  /** Provision together with a matching authority before enabling visibility writes. */
  readonly CLERK_PUBLISHABLE_KEY?: string;
  readonly CLERK_SECRET_KEY?: string;
  readonly CLERK_SIGN_IN_URL?: string;
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

const COOKIE_PREFIX = "__Host-okou-";
const TRANSIENT_COOKIES = new Set([
  "__clerk_handshake",
  "__clerk_handshake_nonce",
]);

function authenticationRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  // Host and forwarded headers supplied by a visitor cannot select an auth origin.
  for (const name of [
    "Host",
    "X-Forwarded-Host",
    "X-Forwarded-Proto",
    "CloudFront-Forwarded-Proto",
    "Authorization",
  ])
    headers.delete(name);
  const cookies: string[] = [];
  for (const cookie of (headers.get("Cookie") ?? "").split(";")) {
    const trimmed = cookie.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const name = trimmed.slice(0, separator);
    if (name.startsWith(COOKIE_PREFIX))
      cookies.push(trimmed.slice(COOKIE_PREFIX.length));
    else if (TRANSIENT_COOKIES.has(name)) cookies.push(trimmed);
  }
  headers.set("Cookie", cookies.join("; "));
  return new Request(request, { headers });
}

/** All SDK cookie writes, including rotations and deletions, use the same host scope. */
function authenticationHeaders(source: Headers): Headers {
  const result = new Headers({
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "worker-src 'none'",
  });
  for (const cookie of source.getSetCookie()) {
    const [pair, ...attributes] = cookie.split(";");
    if (!pair || !pair.includes("="))
      throw new Error("Invalid Clerk cookie directive");
    const kept = attributes.filter((attribute) => {
      return !/^(domain|path|secure|httponly|samesite|partitioned)(?:=|$)/iu.test(
        attribute.trim(),
      );
    });
    result.append(
      "Set-Cookie",
      `${COOKIE_PREFIX}${pair.trim()};${kept.join(";")}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
  }
  const location = source.get("Location");
  if (location) result.set("Location", location);
  return result;
}

function navigation(request: Request): boolean {
  const destination = request.headers.get("Sec-Fetch-Dest");
  return (
    request.method === "GET" &&
    (destination === "document" ||
      destination === "iframe" ||
      (!destination &&
        request.headers.get("Accept")?.startsWith("text/html") === true))
  );
}

async function identity(request: Request, env: SiteAuthEnv) {
  if (
    !env.CLERK_PUBLISHABLE_KEY ||
    !env.CLERK_SECRET_KEY ||
    !env.CLERK_SIGN_IN_URL
  ) {
    throw new Error("Hosted site authentication is not configured");
  }
  const url = new URL(request.url);
  if (url.protocol !== "https:")
    throw new Error("Hosted site credentials require HTTPS");
  const domain = [env.OKOU_HOST_DOMAIN, env.HOST_DOMAIN].find((value) => {
    return url.hostname.endsWith(`.${value}`);
  });
  if (!domain) throw new Error("Unsupported satellite host");
  const clerk = createClerkClient({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
    telemetry: { disabled: true },
  });
  const state = await clerk.authenticateRequest(
    authenticationRequest(request),
    {
      acceptsToken: "session_token",
      authorizedParties: [url.origin],
      isSatellite: true,
      domain,
      signInUrl: env.CLERK_SIGN_IN_URL,
      satelliteAutoSync: true,
    },
  );
  request.signal.throwIfAborted();
  const headers = authenticationHeaders(state.headers);
  if (headers.has("Location")) {
    return { response: new Response(null, { status: 307, headers }) };
  }
  if (state.isAuthenticated && state.toAuth().userId) {
    // Never expose handshake credentials to scripts in a hosted document.
    const clean = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (key.startsWith("__clerk_") || key === "__session")
        clean.searchParams.delete(key);
    }
    for (const name of TRANSIENT_COOKIES) {
      if (
        (request.headers.get("Cookie") ?? "").split(";").some((cookie) => {
          return cookie.trim().startsWith(`${name}=`);
        })
      ) {
        const deletion = `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
        headers.append("Set-Cookie", deletion);
        // Clerk may transport its one-use handshake cookie on the satellite root.
        headers.append("Set-Cookie", `${deletion}; Domain=${domain}`);
      }
    }
    if (clean.href !== request.url) {
      headers.set("Location", clean.href);
      return { response: new Response(null, { status: 307, headers }) };
    }
    return { token: state.token, headers };
  }
  if (navigation(request)) {
    const returnTo = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (key.startsWith("__clerk_") || key === "__session")
        returnTo.searchParams.delete(key);
    }
    returnTo.searchParams.set("__clerk_synced", "false");
    const signIn = new URL(env.CLERK_SIGN_IN_URL);
    signIn.searchParams.set("redirect_url", returnTo.href);
    headers.set("Location", signIn.href);
    return { response: new Response(null, { status: 302, headers }) };
  }
  return {
    response: new Response("Authentication required", { status: 401, headers }),
  };
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
  return new Response(response.body, {
    status: response.status,
    headers: output,
  });
}

/** Public access is resolved before any Clerk operation, even with stale cookies. */
export async function authorizeSiteRequest(
  request: Request,
  env: SiteAuthEnv,
  endpoint: URL,
): Promise<
  | { readonly headers: Headers; readonly response?: never }
  | { readonly response: Response; readonly headers?: never }
> {
  const anonymous = await decision(request, env, endpoint);
  // A later visibility change must reach the Worker even for preview assets.
  if (anonymous.allowed)
    return { headers: new Headers({ "Cache-Control": "private, no-store" }) };
  if (anonymous.decision === "deny")
    return {
      response: new Response("Not found", {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  const auth = await identity(request, env);
  if (auth.response) return auth;
  const authenticated = await decision(request, env, endpoint, auth.token);
  if (authenticated.allowed) return { headers: auth.headers };
  return {
    response: new Response(
      authenticated.decision === "authenticate"
        ? "Authentication required"
        : "Access denied",
      {
        status: authenticated.decision === "authenticate" ? 401 : 403,
        headers: auth.headers,
      },
    ),
  };
}

export async function withHostedSiteAccess(
  request: Request,
  env: SiteAuthEnv,
  siteId: string,
  serve: () => Promise<Response>,
): Promise<Response> {
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
