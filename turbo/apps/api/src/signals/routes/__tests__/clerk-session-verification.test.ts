import { generateKeyPairSync, randomUUID } from "node:crypto";

import { authContract } from "@okouai/api-contracts/contracts/auth";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { SignJWT } from "jose";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, test, vi } from "vitest";
import { array, instanceof as instanceOf, literal, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { authMeRoutes } from "../auth-me";
import { hostRoutes } from "../host";
import { createBddApi } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";

const context = testContext();
const currentKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const replacementKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const clerkHost = "clerk.session.test";
const appOrigin = "https://app.session.test";
const jwksUrl = "https://api.clerk.com/v1/jwks";

const sessionOptions = object({
  acceptsToken: literal("session_token"),
  jwtKey: string().optional(),
  authorizedParties: array(string()).optional(),
});

function publicPem(key = currentKey): string {
  return key.publicKey.export({ type: "spki", format: "pem" }).toString();
}

async function useSessionVerification(): Promise<void> {
  mockEnv("CLERK_JWT_KEY", publicPem());
  mockEnv("APP_URL", appOrigin);
  // Retain the shared profile/organization mocks, but exercise the installed
  // SDK's actual session verification with only provider HTTP simulated.
  const sdk =
    await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
  const client = sdk.createClerkClient({
    secretKey: `sk_live_fixture_${randomUUID()}`,
    publishableKey: `pk_live_${Buffer.from(`${clerkHost}$`).toString("base64")}`,
    telemetry: { disabled: true },
  });
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request, options) => {
      return client.authenticateRequest(
        instanceOf(Request).parse(request),
        sessionOptions.parse(options),
      );
    },
  );
  server.use(
    http.get(jwksUrl, () => {
      return new HttpResponse(null, { status: 503 });
    }),
  );
}

beforeEach(useSessionVerification);

function actor() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const sessionId = `sess_${randomUUID()}`;
  const email = `${userId}@example.test`;
  context.mocks.clerk.users.getUser.mockResolvedValue({
    id: userId,
    primaryEmailAddressId: "primary",
    emailAddresses: [{ id: "primary", emailAddress: email }],
  });
  return { userId, orgId, sessionId, email };
}

async function token(
  user: { readonly userId: string; readonly orgId: string | null },
  options: {
    readonly key?: typeof currentKey;
    readonly party?: string;
    readonly expired?: boolean;
    readonly sessionId?: string;
  } = {},
): Promise<string> {
  const issuedAt = Math.floor(now() / 1000) - 5;
  return await new SignJWT({
    sid: options.sessionId ?? `sess_${user.userId}`,
    org_id: user.orgId,
    org_role: "org:admin",
    azp: options.party ?? appOrigin,
  })
    // Clerk can reuse its instance kid across key rotation.
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: clerkHost })
    .setIssuer(`https://${clerkHost}`)
    .setSubject(user.userId)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(options.expired ? issuedAt - 30 : issuedAt + 3600)
    .sign((options.key ?? currentKey).privateKey);
}

function client() {
  return setupApp({ context, routes: authMeRoutes })(authContract);
}

test.each(["bearer", "cookie"] as const)(
  "authenticates a %s session while online signing keys are unavailable",
  async (transport) => {
    const user = actor();
    const jwt = await token(user, { sessionId: user.sessionId });
    const headers =
      transport === "bearer"
        ? { authorization: `Bearer ${jwt}` }
        : {
            cookie: `__session=${jwt}; __client_uat=${Math.floor(now() / 1000) - 10}`,
          };
    const response = await accept(client().me({ headers }), [200]);
    expect(response.body).toStrictEqual(user);
  },
);

test.each(["expired", "wrong-key", "hosted-origin"] as const)(
  "denies a %s session with local verification",
  async (reason) => {
    if (reason === "wrong-key") {
      // A signature denied by the pinned authority must not be retried against
      // a different online authority even if that endpoint would accept it.
      server.use(
        http.get(jwksUrl, () => {
          return HttpResponse.json({
            keys: [
              {
                ...replacementKey.publicKey.export({ format: "jwk" }),
                alg: "RS256",
                use: "sig",
                kid: clerkHost,
              },
            ],
          });
        }),
      );
    }
    const user = actor();
    const jwt = await token(user, {
      expired: reason === "expired",
      key: reason === "wrong-key" ? replacementKey : currentKey,
      party: reason === "hosted-origin" ? "https://demo.okou.app" : appOrigin,
    });
    const response = await accept(
      client().me({ headers: { authorization: `Bearer ${jwt}` } }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  },
);

test("uses the replacement configured key and denies the withdrawn key", async () => {
  const user = actor();
  const oldToken = await token(user);
  const original = await accept(
    client().me({ headers: { authorization: `Bearer ${oldToken}` } }),
    [200],
  );
  expect(original.body.userId).toBe(user.userId);

  // Environment overrides model a replacement deployment's fixed config.
  mockEnv("CLERK_JWT_KEY", publicPem(replacementKey));
  const newToken = await token(user, { key: replacementKey });
  const replacement = await accept(
    client().me({ headers: { authorization: `Bearer ${newToken}` } }),
    [200],
  );
  expect(replacement.body.userId).toBe(user.userId);
  const withdrawn = await accept(
    client().me({ headers: { authorization: `Bearer ${oldToken}` } }),
    [401],
  );
  expect(withdrawn.body.error.code).toBe("UNAUTHORIZED");
});

test("uses online verification when the pinned key is removed", async () => {
  const user = actor();
  const originalJwt = await token(user);
  await accept(
    client().me({ headers: { authorization: `Bearer ${originalJwt}` } }),
    [200],
  );
  mockEnv("CLERK_JWT_KEY", undefined);
  server.use(
    http.get(jwksUrl, () => {
      return HttpResponse.json({
        keys: [
          {
            ...replacementKey.publicKey.export({ format: "jwk" }),
            alg: "RS256",
            use: "sig",
            kid: clerkHost,
          },
        ],
      });
    }),
  );
  const jwt = await token(user, { key: replacementKey });
  const response = await accept(
    client().me({ headers: { authorization: `Bearer ${jwt}` } }),
    [200],
  );
  expect(response.body.userId).toBe(user.userId);
});

test("retains the hosted-site bridge's App-only authorized party", async () => {
  const bdd = createBddApi(context);
  const owner = bdd.user();
  const host = createHostBddApi(context);
  host.captureHostedSitesS3();
  const prepared = await host.prepareHostedSite(owner, {
    site: `session-${randomUUID().slice(0, 8)}`,
    title: "Session verification",
    artifactKind: "hosted-site",
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<p>Session</p>")],
  });
  const api = setupApp({ context, routes: hostRoutes })(hostContract);
  const body = {
    origin: `https://${prepared.publicSlug}.okou.app`,
    state: "a".repeat(43),
    codeChallenge: "b".repeat(43),
  };
  const params = { siteId: prepared.siteId };
  const sessionId = `sess_${owner.userId}`;
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: sessionId,
    userId: owner.userId,
    status: "active",
    expireAt: now() + 86_400_000,
  });
  // Site preparation uses the ordinary shared identity fixture; restore the
  // real verifier after preparation without changing its external contract.
  await useSessionVerification();
  const trusted = await token(owner, { sessionId });
  const allowed = await accept(
    api.authorizeSiteSession({
      params,
      body,
      headers: { authorization: `Bearer ${trusted}` },
    }),
    [200],
  );
  expect(new URL(allowed.body.callbackUrl).origin).toBe(body.origin);
  const untrusted = await token(owner, {
    sessionId,
    party: "https://other.session.test",
  });
  const denied = await accept(
    api.authorizeSiteSession({
      params,
      body,
      headers: { authorization: `Bearer ${untrusted}` },
    }),
    [401],
  );
  expect(denied.body.error.code).toBe("UNAUTHORIZED");
});
