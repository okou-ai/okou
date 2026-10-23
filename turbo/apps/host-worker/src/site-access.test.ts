import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { authorizeSiteRequest, withHostedSiteAccess } from "./site-access";

const siteId = "00000000-0000-4000-8000-000000000001";
const endpoint = new URL(
  `https://authority.test/api/host/sites/${siteId}/access`,
);
const origin = "https://demo.okou.app";
const token = `okou_site_${"a".repeat(64)}`;
const env = {
  HOST_DOMAIN: "sites.vm0.io",
  OKOU_HOST_DOMAIN: "okou.app",
  HOSTED_SITE_API_ORIGIN: "https://authority.test",
  HOSTED_SITE_AUTH_URL: "https://app.okou.ai/hosted-site-authorize",
};
const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  return server.resetHandlers();
});
afterAll(() => {
  return server.close();
});

function requireSession() {
  server.use(
    http.get(endpoint.href, ({ request }) => {
      return HttpResponse.json(
        request.headers.get("Authorization") === `Bearer ${token}`
          ? { allowed: true, decision: "allow" }
          : { allowed: false, decision: "authenticate" },
      );
    }),
  );
}

async function login(path = "/report?view=summary") {
  requireSession();
  const response = (
    await authorizeSiteRequest(
      new Request(
        `${origin}/.okou/auth/start?${new URLSearchParams({ returnTo: path })}`,
        { headers: { Accept: "text/html" } },
      ),
      env,
      endpoint,
    )
  ).response;
  if (!response) throw new Error("Expected sign-in navigation");
  const bridge = new URL(response.headers.get("Location")!);
  return {
    response,
    bridge,
    pendingCookie: response.headers.getSetCookie()[0]!.split(";")[0]!,
  };
}

it("serves Public without consulting Clerk or forwarding visitor credentials", async () => {
  server.use(
    http.get(endpoint.href, ({ request }) => {
      expect(request.headers.get("Authorization")).toBeNull();
      return HttpResponse.json({ allowed: true, decision: "allow" });
    }),
  );
  const access = await authorizeSiteRequest(
    new Request(origin, {
      headers: {
        Cookie: "__Host-okou-__session=expired; __session=foreign",
        Authorization: "Bearer caller-supplied",
      },
    }),
    env,
    endpoint,
  );
  expect(access.response).toBeUndefined();
  expect(access.headers?.getSetCookie()).toEqual([]);
});

it("uses only the site-specific HttpOnly cookie, ignoring Clerk and visitor Authorization", async () => {
  requireSession();
  const accepted = await authorizeSiteRequest(
    new Request(`${origin}/asset.js`, {
      headers: { Cookie: `__Host-okou-site-session=${token}` },
    }),
    env,
    endpoint,
  );
  expect(accepted.response).toBeUndefined();
  const rejected = await authorizeSiteRequest(
    new Request(`${origin}/asset.js`, {
      headers: {
        Cookie: "__session=clerk-jwt; __Host-okou-__session=clerk-jwt",
        Authorization: `Bearer ${token}`,
      },
    }),
    env,
    endpoint,
  );
  expect(rejected.response?.status).toBe(401);
  expect(rejected.response?.headers.has("Location")).toBe(false);
  expect(await rejected.response?.text()).toBe("Authentication required");
});

it("exchanges a browser-bound code, sets only a site cookie and returns to the clean URL", async () => {
  const { response, bridge, pendingCookie } = await login();
  expect(response.status).toBe(302);
  expect(bridge.origin).toBe("https://app.okou.ai");
  expect(bridge.pathname).toBe("/hosted-site-authorize");
  expect(bridge.searchParams.get("siteId")).toBe(siteId);
  expect(bridge.searchParams.get("origin")).toBe(origin);
  expect([...bridge.searchParams.keys()].sort()).toEqual([
    "codeChallenge",
    "origin",
    "returnTo",
    "siteId",
    "state",
  ]);
  expect(bridge.searchParams.get("returnTo")).toBe("/report?view=summary");
  expect(response.headers.getSetCookie()[0]).toMatch(
    /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/u,
  );
  const code = "b".repeat(64);
  server.use(
    http.post(
      `https://authority.test/api/host/sites/${siteId}/sessions`,
      async ({ request }) => {
        const body = (await request.json()) as {
          code: string;
          codeVerifier: string;
          origin: string;
        };
        const digest = new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(body.codeVerifier),
          ),
        );
        const challenge = btoa(String.fromCharCode(...digest))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
        expect(challenge).toBe(bridge.searchParams.get("codeChallenge"));
        expect(body.code).toBe(code);
        expect(body.origin).toBe(origin);
        return HttpResponse.json({
          sessionToken: token,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      },
    ),
  );
  const callback = `${origin}/.okou/auth/callback?code=${code}&state=${bridge.searchParams.get("state")}`;
  const result = await authorizeSiteRequest(
    new Request(callback, { headers: { Cookie: pendingCookie } }),
    env,
    endpoint,
  );
  expect(result.response?.status).toBe(303);
  expect(result.response?.headers.get("Location")).toBe(
    `${origin}/report?view=summary`,
  );
  expect(await result.response?.text()).toBe("");
  const cookies = result.response!.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  expect(cookies[0]).toContain("Max-Age=0");
  expect(cookies[1]).toContain(
    `__Host-okou-site-session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=`,
  );
  expect(cookies.join(";")).not.toContain("Domain=");
  expect(cookies.join(";")).not.toContain("__session");
});

it("does not let callbacks fall through to Public or SPA documents without the browser proof", async () => {
  server.use(
    http.get(endpoint.href, () => {
      return HttpResponse.json({ allowed: true, decision: "allow" });
    }),
  );
  const access = await authorizeSiteRequest(
    new Request(
      `${origin}/.okou/auth/callback?code=${"b".repeat(64)}&state=${"a".repeat(43)}`,
    ),
    env,
    endpoint,
  );
  expect(access.response?.status).toBe(400);
  expect(access.response?.headers.get("Cache-Control")).toBe(
    "private, no-store",
  );
  expect(await access.response?.text()).not.toContain("<html");
});

it("consumes callbacks before Public authorization after a visibility change", async () => {
  const { bridge, pendingCookie } = await login();
  server.resetHandlers();
  server.use(
    http.post(
      `https://authority.test/api/host/sites/${siteId}/sessions`,
      () => {
        return HttpResponse.json({
          sessionToken: token,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      },
    ),
  );
  const access = await authorizeSiteRequest(
    new Request(
      `${origin}/.okou/auth/callback?code=${"b".repeat(64)}&state=${bridge.searchParams.get("state")}`,
      { headers: { Cookie: pendingCookie } },
    ),
    env,
    endpoint,
  );
  expect(access.response?.status).toBe(303);
});

it("keeps parallel tab login proofs separate", async () => {
  const first = await login("/one");
  const second = await login("/two");
  expect(first.bridge.searchParams.get("state")).not.toBe(
    second.bridge.searchParams.get("state"),
  );
  expect(first.pendingCookie.split("=")[0]).not.toBe(
    second.pendingCookie.split("=")[0],
  );
});

it("starts authorization for document requests without a site session", async () => {
  requireSession();
  const access = await authorizeSiteRequest(
    new Request(`${origin}/report?view=summary`, {
      headers: { "Sec-Fetch-Dest": "document" },
    }),
    env,
    endpoint,
  );
  expect(access.response?.status).toBe(302);
  const location = new URL(access.response!.headers.get("Location")!);
  expect(location.origin).toBe("https://app.okou.ai");
  expect(location.pathname).toBe("/hosted-site-authorize");
  expect(location.searchParams.get("siteId")).toBe(siteId);
  expect(location.searchParams.get("origin")).toBe(origin);
  expect(location.searchParams.get("returnTo")).toBe("/report?view=summary");
  expect(access.response!.headers.getSetCookie()[0]).toMatch(
    /^__Host-okou-site-login-.*; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/u,
  );
});

it("reauthorizes an expired site credential while resource requests remain 401", async () => {
  requireSession();
  const headers = {
    Cookie: `__Host-okou-site-session=okou_site_${"b".repeat(64)}`,
  };
  const document = await authorizeSiteRequest(
    new Request(`${origin}/report`, {
      headers: { ...headers, "Sec-Fetch-Dest": "document" },
    }),
    env,
    endpoint,
  );
  const bridge = new URL(document.response!.headers.get("Location")!);
  expect(bridge.pathname).toBe("/hosted-site-authorize");
  expect(bridge.searchParams.get("returnTo")).toBe("/report");
  const resource = await authorizeSiteRequest(
    new Request(`${origin}/app.js`, {
      headers: { ...headers, "Sec-Fetch-Dest": "script" },
    }),
    env,
    endpoint,
  );
  expect(resource.response?.status).toBe(401);
  expect(resource.response?.headers.has("Location")).toBe(false);
});

it("shows denied access after the authority rejects an authenticated viewer", async () => {
  server.use(
    http.get(endpoint.href, ({ request }) => {
      return HttpResponse.json(
        request.headers.get("Authorization") === `Bearer ${token}`
          ? { allowed: false, decision: "deny" }
          : { allowed: false, decision: "authenticate" },
      );
    }),
  );
  const access = await authorizeSiteRequest(
    new Request(`${origin}/report`, {
      headers: {
        Cookie: `__Host-okou-site-session=${token}`,
        "Sec-Fetch-Dest": "document",
      },
    }),
    env,
    endpoint,
  );
  const location = new URL(access.response!.headers.get("Location")!);
  expect(location.pathname).toBe("/hosted-site-access");
  expect(Object.fromEntries(location.searchParams)).toStrictEqual({
    url: `${origin}/report`,
    reason: "denied",
  });
  expect(access.response?.headers.getSetCookie()).toStrictEqual([]);
});

it("expired callbacks recover on App without forwarding their code or state", async () => {
  const access = await authorizeSiteRequest(
    new Request(
      `${origin}/.okou/auth/callback?code=${"b".repeat(64)}&state=${"a".repeat(43)}`,
      { headers: { "Sec-Fetch-Dest": "document" } },
    ),
    env,
    endpoint,
  );
  const location = new URL(access.response!.headers.get("Location")!);
  expect(location.pathname).toBe("/hosted-site-access");
  expect(Object.fromEntries(location.searchParams)).toStrictEqual({
    url: `${origin}/`,
    reason: "expired",
  });
  expect(access.response?.headers.get("Cache-Control")).toBe(
    "private, no-store",
  );
});

it("an expired code exchange stops at recovery instead of restarting authorization", async () => {
  const { bridge, pendingCookie } = await login();
  server.use(
    http.post(
      `https://authority.test/api/host/sites/${siteId}/sessions`,
      () => {
        return new HttpResponse(null, { status: 401 });
      },
    ),
  );
  const access = await authorizeSiteRequest(
    new Request(
      `${origin}/.okou/auth/callback?code=${"b".repeat(64)}&state=${bridge.searchParams.get("state")}`,
      {
        headers: {
          Cookie: pendingCookie,
          "Sec-Fetch-Dest": "document",
        },
      },
    ),
    env,
    endpoint,
  );
  const location = new URL(access.response!.headers.get("Location")!);
  expect(location.pathname).toBe("/hosted-site-access");
  expect(Object.fromEntries(location.searchParams)).toStrictEqual({
    url: `${origin}/report?view=summary`,
    reason: "expired",
  });
  expect(access.response?.headers.getSetCookie()).toStrictEqual([
    `${pendingCookie.split("=")[0]}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  ]);
});

it.each([
  "//attacker.example/",
  String.raw`/\attacker.example/`,
  "/\n/attacker.example/",
  "/\t/attacker.example/",
  "/.okou/auth/start",
])("a sign-in restart rejects the unsafe return path %s", async (returnTo) => {
  requireSession();
  const access = await authorizeSiteRequest(
    new Request(
      `${origin}/.okou/auth/start?${new URLSearchParams({ returnTo })}`,
      {
        headers: { "Sec-Fetch-Dest": "document" },
      },
    ),
    env,
    endpoint,
  );
  expect(new URL(access.response!.headers.get("Location")!).origin).toBe(
    "https://app.okou.ai",
  );
  expect(access.response!.headers.getSetCookie()).toStrictEqual([]);
});

it("rejects an invalid session without overwriting a newer tab's cookie", async () => {
  requireSession();
  const result = await authorizeSiteRequest(
    new Request(`${origin}/`, {
      headers: {
        Cookie: `__Host-okou-site-session=okou_site_${"c".repeat(64)}`,
        "Sec-Fetch-Dest": "iframe",
      },
    }),
    env,
    endpoint,
  );
  expect(result.response?.status).toBe(401);
  expect(result.response?.headers.has("Location")).toBe(false);
  expect(result.response?.headers.getSetCookie()).toEqual([]);
});

it("rejects callback delivery without browser proof", async () => {
  const response = await withHostedSiteAccess(
    new Request(`${origin}/.okou/auth/callback?code=secret`),
    env,
    siteId,
    () => {
      return Promise.resolve(new Response("<html>public</html>"));
    },
  );
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("<html");
});
