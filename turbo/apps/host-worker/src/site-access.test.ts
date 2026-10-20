import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { authorizeSiteRequest } from "./site-access";

const endpoint = new URL("https://authority.test/api/host/sites/site/access");
const publishableKey = `pk_live_${btoa("clerk.primary.test$")}`;
const env = {
  HOSTED_SITE_ACCESS_ENABLED: "true",
  HOST_DOMAIN: "sites.vm0.io",
  OKOU_HOST_DOMAIN: "okou.app",
  CLERK_PUBLISHABLE_KEY: publishableKey,
  CLERK_SECRET_KEY: "sk_live_test",
  CLERK_SIGN_IN_URL: "https://app.okou.ai/sign-in",
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

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function credentials() {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const kid = crypto.randomUUID();
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  server.use(
    http.get("https://api.clerk.com/v1/jwks", () => {
      return HttpResponse.json({
        keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }],
      });
    }),
  );
  const suffix = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-1",
        new TextEncoder().encode(publishableKey),
      ),
    ),
  ).slice(0, 8);
  async function token(expiration: number, party = "https://demo.okou.app") {
    const now = Math.floor(Date.now() / 1000);
    const data = [
      { alg: "RS256", typ: "JWT", kid },
      {
        sub: "user_owner",
        sid: "sess_owner",
        iss: "https://clerk.primary.test",
        azp: party,
        iat: now - 120,
        nbf: now - 120,
        exp: now + expiration,
        v: 2,
      },
    ]
      .map((part) => {
        return base64url(new TextEncoder().encode(JSON.stringify(part)));
      })
      .join(".");
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(data),
    );
    return `${data}.${base64url(new Uint8Array(signature))}`;
  }
  function cookie(jwt: string) {
    return `__Host-okou-__session_${suffix}=${jwt}; __Host-okou-__client_uat_${suffix}=1; __Host-okou-__refresh_${suffix}=refresh-token`;
  }
  return { token, cookie, suffix };
}

it("does not invoke Clerk for public requests, including stale cookies", async () => {
  server.use(
    http.get(endpoint.href, () => {
      return HttpResponse.json({ allowed: true, decision: "allow" });
    }),
  );
  const result = await authorizeSiteRequest(
    new Request("https://demo.okou.app/", {
      headers: { Cookie: "__Host-okou-__session=expired" },
    }),
    {
      HOST_DOMAIN: "sites.vm0.io",
      OKOU_HOST_DOMAIN: "okou.app",
      HOSTED_SITE_ACCESS_ENABLED: "true",
    },
    endpoint,
  );
  expect(result.response).toBeUndefined();
  expect(result.headers?.getSetCookie()).toEqual([]);
});

it("uses verified host-scoped cookies and ignores a script-writable session cookie", async () => {
  const identity = await credentials();
  const token = await identity.token(60);
  let authenticated = 0;
  server.use(
    http.get(endpoint.href, ({ request }) => {
      if (request.headers.get("Authorization") === `Bearer ${token}`) {
        authenticated++;
        return HttpResponse.json({ allowed: true, decision: "allow" });
      }
      return HttpResponse.json({ allowed: false, decision: "authenticate" });
    }),
  );
  const signedIn = await authorizeSiteRequest(
    new Request("https://demo.okou.app/style.css", {
      headers: { Cookie: identity.cookie(token) },
    }),
    env,
    endpoint,
  );
  expect(signedIn.response).toBeUndefined();
  expect(authenticated).toBe(1);
  const scriptCookie = await authorizeSiteRequest(
    new Request("https://demo.okou.app/style.css", {
      headers: { Cookie: `__session=${token}; __client_uat=1` },
    }),
    env,
    endpoint,
  );
  expect(scriptCookie.response?.status).toBe(401);
  expect(authenticated).toBe(1);
});

it("refreshes an expired JWT on the server and makes every rotated cookie HttpOnly", async () => {
  const identity = await credentials();
  const expired = await identity.token(-60);
  const fresh = await identity.token(60);
  let refreshes = 0;
  server.use(
    http.get(endpoint.href, ({ request }) => {
      return HttpResponse.json(
        request.headers.get("Authorization") === `Bearer ${fresh}`
          ? { allowed: true, decision: "allow" }
          : { allowed: false, decision: "authenticate" },
      );
    }),
    http.post(
      "https://api.clerk.com/v1/sessions/sess_owner/refresh",
      async ({ request }) => {
        expect(await request.json()).toMatchObject({
          expired_token: expired,
          refresh_token: "refresh-token",
          request_origin: "https://demo.okou.app",
        });
        refreshes++;
        return HttpResponse.json({
          cookies: [
            `__session_${identity.suffix}=${fresh}; Domain=.okou.app; Path=/; SameSite=None; Secure`,
            `__refresh_${identity.suffix}=rotated; Domain=.okou.app; Path=/; Max-Age=86400; Secure`,
          ],
        });
      },
    ),
  );
  const result = await authorizeSiteRequest(
    new Request("https://demo.okou.app/style.css", {
      headers: { Cookie: identity.cookie(expired) },
    }),
    env,
    endpoint,
  );
  expect(result.response).toBeUndefined();
  expect(refreshes).toBe(1);
  const cookies = result.headers?.getSetCookie().filter((cookie) => {
    return cookie.startsWith("__Host-okou-");
  });
  expect(cookies).toHaveLength(2);
  for (const cookie of cookies ?? []) {
    expect(cookie).toContain("; Path=/; Secure; HttpOnly; SameSite=Lax");
    expect(cookie).not.toMatch(/domain=/iu);
  }
});

it("consumes a Clerk handshake and removes its parameters before serving user HTML", async () => {
  const identity = await credentials();
  const fresh = await identity.token(60);
  server.use(
    http.get(endpoint.href, () => {
      return HttpResponse.json({ allowed: false, decision: "authenticate" });
    }),
    http.get(
      "https://api.clerk.com/v1/clients/handshake_payload",
      ({ request }) => {
        expect(new URL(request.url).searchParams.get("nonce")).toBe(
          "one-use-nonce",
        );
        return HttpResponse.json({
          directives: [
            `__session_${identity.suffix}=${fresh}; Domain=.okou.app; Path=/; Secure`,
            `__client_uat_${identity.suffix}=1; Path=/; Secure`,
          ],
        });
      },
    ),
  );
  const result = await authorizeSiteRequest(
    new Request(
      "https://demo.okou.app/report?keep=yes&__clerk_handshake_nonce=one-use-nonce",
      { headers: { "Sec-Fetch-Dest": "document" } },
    ),
    env,
    endpoint,
  );
  expect(result.response?.status).toBe(307);
  expect(result.response?.headers.get("Location")).toBe(
    "https://demo.okou.app/report?keep=yes",
  );
  expect(
    result.response?.headers.getSetCookie().some((cookie) => {
      return (
        cookie.startsWith("__Host-okou-__session_") &&
        cookie.includes("HttpOnly")
      );
    }),
  ).toBe(true);
});

it("rejects a signed token minted for a different origin", async () => {
  const identity = await credentials();
  const token = await identity.token(60, "https://attacker.example");
  let reads = 0;
  server.use(
    http.get(endpoint.href, ({ request }) => {
      expect(request.headers.get("Authorization")).toBeNull();
      reads++;
      return HttpResponse.json({ allowed: false, decision: "authenticate" });
    }),
  );
  const result = await authorizeSiteRequest(
    new Request("https://demo.okou.app/style.css", {
      headers: { Cookie: identity.cookie(token) },
    }),
    env,
    endpoint,
  );
  expect(result.response?.status).toBe(401);
  expect(reads).toBe(1);
});
