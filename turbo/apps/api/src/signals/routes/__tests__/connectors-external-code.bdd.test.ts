import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { mockNintendoStoreExternalCodeProvider } from "./helpers/connector-auth-provider-fixtures";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

interface Session {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly authorizationUrl: string;
}

function completeAws(actor: ApiTestUser, session: Session, code = "AWS-CODE") {
  return connectors.requestExternalCodeComplete(
    actor,
    "aws",
    {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: awsVerificationCode(session.authorizationUrl, code),
    },
    [200, 400, 404, 409],
  );
}

async function defaultAwsAccount(actor: ApiTestUser) {
  const response = await connectors.requestBuiltinConnectorAccounts(
    actor,
    "aws",
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected AWS accounts");
  }
  return response.body.defaultConnection;
}

function unsignedJwt(payload: Readonly<Record<string, string>>): string {
  const encode = (value: unknown) => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

const PARENTAL_ACTIONS = "https://app.lp1.znma.srv.nintendo.net";

/** Nintendo account and parental-controls action endpoints for two parents. */
function mockParentalControlsProvider() {
  const parents: Readonly<
    Record<string, { readonly sub: string; readonly username: string }>
  > = {
    "code-initial": {
      sub: "bdd-switch-parental-controls-account-id",
      username: "bdd-nintendo-parent",
    },
    "code-replacement": {
      sub: "bdd-switch-parental-controls-replacement-id",
      username: "bdd-nintendo-replacement-parent",
    },
  };
  const recorded = {
    sessionTokenCodes: [] as string[],
    exchangedSessionTokens: [] as string[],
    federations: [] as { smartDeviceId: string; bundleId: unknown }[],
    logouts: [] as { smartDeviceId: string; authorization: string }[],
    logoutStatus: 200,
  };
  const idTokenFor = (sessionToken: string) => {
    const code = sessionToken.replace("session-", "");
    const parent = parents[code];
    if (!parent) {
      throw new Error(`Unknown Nintendo session token ${sessionToken}`);
    }
    return unsignedJwt({
      sub: parent.sub,
      preferred_username: parent.username,
      email: `${parent.username}@example.test`,
    });
  };
  server.use(
    http.post(
      "https://accounts.nintendo.com/connect/1.0.0/api/session_token",
      async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        const code = body.get("session_token_code") ?? "";
        recorded.sessionTokenCodes.push(code);
        return HttpResponse.json({ session_token: `session-${code}` });
      },
    ),
    http.post(
      "https://accounts.nintendo.com/connect/1.0.0/api/token",
      async ({ request }) => {
        const body: unknown = await request.json();
        const sessionToken =
          typeof body === "object" &&
          body !== null &&
          "session_token" in body &&
          typeof body.session_token === "string"
            ? body.session_token
            : "";
        recorded.exchangedSessionTokens.push(sessionToken);
        return HttpResponse.json({
          access_token: `access-${sessionToken}`,
          expires_in: 900,
          id_token: idTokenFor(sessionToken),
          token_type: "Bearer",
          scope: "openid user",
        });
      },
    ),
    http.get("https://api.accounts.nintendo.com/2.0.0/users/me", () => {
      return HttpResponse.json({ country: "US", language: "en-US" });
    }),
    http.post(
      `${PARENTAL_ACTIONS}/v3/actions/federation`,
      async ({ request }) => {
        const body: unknown = await request.json();
        const bundleId =
          typeof body === "object" &&
          body !== null &&
          "smartDeviceInfo" in body &&
          typeof body.smartDeviceInfo === "object" &&
          body.smartDeviceInfo !== null &&
          "bundleId" in body.smartDeviceInfo
            ? body.smartDeviceInfo.bundleId
            : undefined;
        recorded.federations.push({
          smartDeviceId: request.headers.get("x-moon-smart-device-id") ?? "",
          bundleId,
        });
        return HttpResponse.json({
          loginInfo: {
            ownedDevices: [
              {
                deviceId: `switch-${recorded.federations.length}`,
                label: "Living room Switch",
                serialNumber: "XAW10012345678",
                unlockCode: "246810",
              },
            ],
          },
        });
      },
    ),
    http.post(`${PARENTAL_ACTIONS}/v2/actions/logout`, ({ request }) => {
      recorded.logouts.push({
        smartDeviceId: request.headers.get("x-moon-smart-device-id") ?? "",
        authorization: request.headers.get("authorization") ?? "",
      });
      return recorded.logoutStatus === 200
        ? HttpResponse.json({})
        : HttpResponse.json(
            { error: "unavailable" },
            { status: recorded.logoutStatus },
          );
    }),
  );
  return { recorded, idTokenFor };
}

describe("external-code session lifecycle", () => {
  it("connectors-external-code.bdd-004 returns generic copy when PlayStation rejects the NPSSO token", async () => {
    const cookies: (string | null)[] = [];
    server.use(
      http.get(
        "https://ca.account.sony.com/api/authz/v3/oauth/authorize",
        ({ request }) => {
          cookies.push(request.headers.get("cookie"));
          return new HttpResponse(null, { status: 401 });
        },
      ),
    );
    const actor = bdd.user();
    const session = await connectors.startExternalCode(
      actor,
      "playstation",
      "api",
    );
    expect(session.authorizationUrl).toBe(
      "https://ca.account.sony.com/api/v1/ssocookie",
    );
    const rejected = await connectors.requestExternalCodeComplete(
      actor,
      "playstation",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: "  bad-npsso  ",
      },
      [400],
    );
    expect(rejected.body).toMatchObject({
      error: {
        message:
          "External-code authorization code was rejected. Check it and try again.",
      },
    });
    expect(cookies).toStrictEqual(["npsso=bad-npsso"]);
  });

  it("connectors-external-code.bdd-003 supersedes pending sessions and keeps rejected sessions retryable", async () => {
    const provider = mockAwsExternalCodeProvider();
    const owner = bdd.user();
    const first = await connectors.startExternalCode(owner, "aws", "cli");
    const second = await connectors.startExternalCode(owner, "aws", "cli");

    const superseded = await completeAws(owner, first);
    expect(superseded.status).toBe(400);
    expect(superseded.body).toMatchObject({
      error: {
        message: "External-code authorization session was superseded",
      },
    });
    expect(provider.tokenRequests).toHaveLength(0);
    const rejected = await completeAws(owner, second, "AWS-BAD");
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({
      error: {
        message:
          "External-code authorization code was rejected. Check it and try again.",
      },
    });
    const retried = await completeAws(owner, second);
    if (retried.status !== 200) {
      throw new Error("Expected the retry to complete");
    }
    expect(provider.tokenRequests).toHaveLength(2);
    await expect(defaultAwsAccount(owner)).resolves.toMatchObject({
      id: retried.body.connectionId,
      authMethod: "cli",
      externalId: "123456789012",
      isDefault: true,
    });
  });

  it("connectors-external-code.bdd-005 starts and completes a Nintendo Store session", async () => {
    const provider = mockNintendoStoreExternalCodeProvider();
    const actor = bdd.user();
    const session = await connectors.startExternalCode(
      actor,
      "nintendo-store",
      "api",
    );
    expect(session).toMatchObject({ status: "pending", expiresIn: 600 });
    const url = new URL(session.authorizationUrl);
    const state = url.searchParams.get("state");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.nintendo.com/connect/1.0.0/authorize",
    );
    expect({
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
      responseType: url.searchParams.get("response_type"),
      scope: url.searchParams.get("scope"),
    }).toStrictEqual({
      clientId: "5c38e31cd085304b",
      redirectUri: "npf5c38e31cd085304b://auth",
      responseType: "session_token_code",
      scope: "openid user user.mii user.email user.links[].id",
    });
    expect(state).toBeTruthy();

    const completed = await connectors.completeExternalCode(
      actor,
      "nintendo-store",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: `npf5c38e31cd085304b://auth#session_token_code=bdd-nintendo-session-token-code&state=${state ?? ""}`,
      },
    );
    expect(
      provider.sessionTokenBodies.map((body) => {
        return {
          clientId: body.get("client_id"),
          code: body.get("session_token_code"),
          hasVerifier: Boolean(body.get("session_token_code_verifier")),
        };
      }),
    ).toStrictEqual([
      {
        clientId: "5c38e31cd085304b",
        code: "bdd-nintendo-session-token-code",
        hasVerifier: true,
      },
    ]);
    expect(provider.tokenBodies).toHaveLength(1);
    expect(completed.account).toMatchObject({
      authMethod: "api",
      externalId: "bdd-nintendo-account-id",
      externalUsername: "bdd-nintendo-player",
    });
    expect(completed.account.oauthScopes).toHaveLength(5);
    expect(completed.account.tokenExpiresAt).toBeTruthy();
    const exposed = JSON.stringify(completed);
    expect(exposed).not.toContain("bdd-nintendo-session-token");
    expect(exposed).not.toContain("bdd-nintendo-access-token");
  });
  it("connectors-external-code.bdd-006 replaces the remote Nintendo registration and keeps local deletion resilient", async () => {
    const { recorded, idTokenFor } = mockParentalControlsProvider();
    const slug = "nintendo-switch-parental-controls";
    const actor = bdd.user();
    const connect = async (code: string) => {
      const session = await connectors.startExternalCode(actor, slug, "api");
      const url = new URL(session.authorizationUrl);
      const state = url.searchParams.get("state") ?? "";
      const completed = await connectors.completeExternalCode(actor, slug, {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: `npf54789befb391a838://auth#session_token_code=${code}&state=${state}`,
      });
      return { session, url, completed };
    };

    const first = await connect("code-initial");
    expect(first.session).toMatchObject({ status: "pending", expiresIn: 600 });
    expect({
      clientId: first.url.searchParams.get("client_id"),
      redirectUri: first.url.searchParams.get("redirect_uri"),
      scopes: (first.url.searchParams.get("scope") ?? "").split(" ").length,
    }).toStrictEqual({
      clientId: "54789befb391a838",
      redirectUri: "npf54789befb391a838://auth",
      scopes: 13,
    });
    expect(recorded.sessionTokenCodes).toStrictEqual(["code-initial"]);
    expect(recorded.exchangedSessionTokens).toStrictEqual([
      "session-code-initial",
    ]);
    expect(recorded.federations).toHaveLength(1);
    expect(recorded.federations[0]?.bundleId).toBe("com.nintendo.znma");
    expect(first.completed.account).toMatchObject({
      externalId: "bdd-switch-parental-controls-account-id",
      externalUsername: "bdd-nintendo-parent",
    });
    const exposed = JSON.stringify(first.completed);
    for (const hidden of [
      "session-code-initial",
      idTokenFor("session-code-initial"),
      "XAW10012345678",
      "246810",
    ]) {
      expect(exposed).not.toContain(hidden);
    }

    const replacement = await connect("code-replacement");
    expect(replacement.completed.connectionId).not.toBe(
      first.completed.connectionId,
    );
    expect(recorded.federations).toHaveLength(2);
    const [firstDevice, replacementDevice] = recorded.federations.map(
      (federation) => {
        return federation.smartDeviceId;
      },
    );
    expect(replacementDevice).not.toBe(firstDevice);
    expect(recorded.logouts).toStrictEqual([]);

    recorded.exchangedSessionTokens.length = 0;
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      slug,
      first.completed.connectionId,
    );
    recorded.logoutStatus = 503;
    await connectors.deleteBuiltinConnectorAccount(
      actor,
      slug,
      replacement.completed.connectionId,
    );
    expect(recorded.exchangedSessionTokens).toStrictEqual([
      "session-code-initial",
      "session-code-replacement",
    ]);
    expect(recorded.logouts).toStrictEqual([
      {
        smartDeviceId: firstDevice,
        authorization: `Bearer ${idTokenFor("session-code-initial")}`,
      },
      {
        smartDeviceId: replacementDevice,
        authorization: `Bearer ${idTokenFor("session-code-replacement")}`,
      },
    ]);
    const remaining = await connectors.requestBuiltinConnectorAccounts(
      actor,
      slug,
      [200],
    );
    expect(
      remaining.status === 200 ? remaining.body.defaultConnection : undefined,
    ).toBeNull();
  });

  it("connectors-external-code.bdd-001 (1/2) starts a protected AWS session and completes it into the default cli account", async () => {
    const provider = mockAwsExternalCodeProvider();
    const owner = bdd.user();
    const other = bdd.user();

    const session = await connectors.startExternalCode(owner, "aws", "cli");
    expect(session).toMatchObject({ status: "pending", expiresIn: 600 });
    const url = new URL(session.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(
      "arn:aws:signin:::devtools/cross-device",
    );
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation",
    );

    const wrongToken = await completeAws(owner, {
      ...session,
      sessionToken: `${session.sessionToken}-wrong`,
    });
    expect(wrongToken.status).toBe(404);
    expect(wrongToken.body).toMatchObject({
      error: { message: "External-code authorization session not found" },
    });
    const foreign = await completeAws(other, session);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(provider.tokenRequests).toHaveLength(0);

    const completed = await connectors.requestExternalCodeComplete(
      owner,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: `  ${awsVerificationCode(session.authorizationUrl)}  `,
      },
      [200],
    );
    if (completed.status !== 200) {
      throw new Error("Expected AWS completion");
    }
    const connectionId = completed.body.connectionId;
    expect(
      provider.tokenRequests.map((request) => {
        return { grantType: request.grantType, code: request.code };
      }),
    ).toStrictEqual([{ grantType: "authorization_code", code: "AWS-CODE" }]);
    const account = await connectors.readBuiltinConnectorAccount(
      owner,
      "aws",
      connectionId,
    );
    expect({
      authMethod: account.authMethod,
      externalId: account.externalId,
      externalUsername: account.externalUsername,
      oauthScopes: account.oauthScopes,
      isDefault: account.isDefault,
    }).toStrictEqual({
      authMethod: "cli",
      externalId: "123456789012",
      externalUsername: expect.stringContaining(
        "arn:aws:iam::123456789012:user/external-code",
      ),
      oauthScopes: ["openid"],
      isDefault: true,
    });
    const expiresInMs = Date.parse(account.tokenExpiresAt ?? "") - now();
    expect(expiresInMs).toBeGreaterThan(14 * 60_000);
    expect(expiresInMs).toBeLessThanOrEqual(15 * 60_000 + 5000);
    const exposed = JSON.stringify([completed.body, account]);
    for (const secret of [
      "aws-secret-access-key",
      "aws-login-refresh-token",
      "aws-session-token",
    ]) {
      expect(exposed).not.toContain(secret);
    }
    const listed = await connectors.listBuiltinConnectors(owner);
    expect(
      listed.connectors.find((connector) => {
        return connector.slug === "aws";
      }),
    ).toMatchObject({ id: connectionId, externalId: "123456789012" });
  });

  it("connectors-external-code.bdd-001 (2/2) replays the completion and rejects a reconnect after deletion", async () => {
    const provider = mockAwsExternalCodeProvider();
    const owner = bdd.user();
    const session = await startRejectedAwsSession(owner);
    const first = await completeAws(owner, session);
    if (first.status !== 200) {
      throw new Error("Expected AWS completion");
    }
    const connectionId = first.body.connectionId;

    const replay = await completeAws(owner, session);
    expect(replay.body).toStrictEqual({ status: "complete", connectionId });
    expect(provider.tokenRequests).toHaveLength(1);

    const reconnect = await connectors.startExternalCode(owner, "aws", "cli", {
      intent: "reconnect",
      connectionId,
    });
    await connectors.deleteBuiltinConnectorAccount(owner, "aws", connectionId);
    const orphaned = await completeAws(owner, reconnect);
    expect(orphaned.status).toBe(409);
    expect(orphaned.body).toMatchObject({
      error: { message: "Connector account not found" },
    });
    await expect(defaultAwsAccount(owner)).resolves.toBeNull();
  });
});

/** An AWS add session after the wrong-token and other-user completions were refused. */
async function startRejectedAwsSession(owner: ApiTestUser) {
  const other = bdd.user();
  const session = await connectors.startExternalCode(owner, "aws", "cli");
  await completeAws(owner, {
    ...session,
    sessionToken: `${session.sessionToken}-wrong`,
  });
  await completeAws(other, session);
  return session;
}
