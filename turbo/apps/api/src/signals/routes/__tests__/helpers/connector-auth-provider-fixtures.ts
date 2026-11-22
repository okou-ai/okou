import { Buffer } from "node:buffer";
import { HttpResponse, http } from "msw";
import { server } from "../../../../mocks/server";
import type { ApiTestUser } from "./api-bdd";
import type { createConnectorBddApi } from "./api-bdd-connectors";

const NINTENDO_STORE_SESSION_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/session_token";
const NINTENDO_STORE_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/token";
const NINTENDO_STORE_PROFILE_URL =
  "https://api.accounts.nintendo.com/2.0.0/users/me";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jwtPayload(payload: Readonly<Record<string, string>>): string {
  const encode = (value: unknown) => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

export function mockNintendoStoreExternalCodeProvider(): {
  readonly sessionTokenBodies: URLSearchParams[];
  readonly tokenBodies: Readonly<Record<string, unknown>>[];
} {
  const sessionTokenBodies: URLSearchParams[] = [];
  const tokenBodies: Readonly<Record<string, unknown>>[] = [];

  server.use(
    http.post(NINTENDO_STORE_SESSION_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      sessionTokenBodies.push(body);
      return HttpResponse.json({
        session_token: "bdd-nintendo-session-token",
      });
    }),
    http.post(NINTENDO_STORE_TOKEN_URL, async ({ request }) => {
      const body: unknown = await request.json();
      if (!isRecord(body)) {
        throw new Error("Expected Nintendo Store token body object");
      }
      tokenBodies.push(body);
      return HttpResponse.json({
        access_token: "bdd-nintendo-access-token",
        expires_in: 3600,
        id_token: jwtPayload({
          sub: "bdd-nintendo-account-id",
          preferred_username: "bdd-nintendo-player",
          email: "bdd-nintendo@example.test",
        }),
        token_type: "Bearer",
        scope: "openid user user.mii user.email user.links[].id",
      });
    }),
    http.get(NINTENDO_STORE_PROFILE_URL, () => {
      return HttpResponse.json({
        country: "HK",
        language: "zh-TW",
      });
    }),
  );

  return { sessionTokenBodies, tokenBodies };
}

export async function connectNintendoStore(
  api: ReturnType<typeof createConnectorBddApi>,
  actor: ApiTestUser,
) {
  mockNintendoStoreExternalCodeProvider();
  const session = await api.startExternalCode(actor, "nintendo-store", "api");
  const url = new URL(session.authorizationUrl);
  const state = url.searchParams.get("state");
  const redirect = url.searchParams.get("redirect_uri");
  if (!state || !redirect) {
    throw new Error(
      "Expected a Nintendo Store authorization state and redirect",
    );
  }
  return await api.completeExternalCode(actor, "nintendo-store", {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    code: `${redirect}#session_token_code=bdd-nintendo-session-token-code&state=${state}`,
  });
}

export async function connectX(
  api: ReturnType<typeof createConnectorBddApi>,
  actor: ApiTestUser,
) {
  server.use(
    http.post("https://api.x.com/2/oauth2/token", () => {
      return HttpResponse.json({
        access_token: "x-selection-access",
        refresh_token: "x-selection-refresh",
        token_type: "Bearer",
        scope: "",
      });
    }),
    http.get("https://api.x.com/2/users/me", () => {
      return HttpResponse.json({
        data: {
          id: "selection-x",
          username: "selection-x",
          name: "Selection X",
        },
      });
    }),
  );
  const started = await api.startOauth(actor, "x", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected X OAuth state");
  }
  await api.completeOauthCallback("x", {
    state,
    code: "x-selection-code",
  });
}
