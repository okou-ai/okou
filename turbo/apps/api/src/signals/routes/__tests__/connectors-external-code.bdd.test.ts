/**
 * CONN-02: external-code authorization sessions through public APIs.
 *
 * External provider endpoints are mocked with MSW at the HTTP boundary.
 */

import { Buffer } from "node:buffer";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { readUserSecrets } from "./helpers/user-config-state";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsDeferredTokenExchange,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const connectorsApi = createConnectorBddApi(context);

const AWS_REDIRECT_URI =
  "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation";
const PLAYSTATION_AUTHORIZE_URL =
  "https://ca.account.sony.com/api/authz/v3/oauth/authorize";
const PLAYSTATION_NPSSO_URL = "https://ca.account.sony.com/api/v1/ssocookie";
const NINTENDO_STORE_AUTHORIZE_URL =
  "https://accounts.nintendo.com/connect/1.0.0/authorize";
const NINTENDO_STORE_SESSION_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/session_token";
const NINTENDO_STORE_TOKEN_URL =
  "https://accounts.nintendo.com/connect/1.0.0/api/token";
const NINTENDO_STORE_PROFILE_URL =
  "https://api.accounts.nintendo.com/2.0.0/users/me";
const NINTENDO_STORE_REDIRECT_URI = "npf5c38e31cd085304b://auth";
const NINTENDO_STORE_CLIENT_ID = "5c38e31cd085304b";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_REDIRECT_URI =
  "npf54789befb391a838://auth";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_CLIENT_ID = "54789befb391a838";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_FEDERATION_URL =
  "https://app.lp1.znma.srv.nintendo.net/v3/actions/federation";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_LOGOUT_URL =
  "https://app.lp1.znma.srv.nintendo.net/v2/actions/logout";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_SCOPES = [
  "openid",
  "user",
  "user.mii",
  "moonUser:administration",
  "moonDevice:create",
  "moonOwnedDevice:administration",
  "moonParentalControlSetting",
  "moonParentalControlSetting:update",
  "moonParentalControlSettingState",
  "moonPairingState",
  "moonSmartDevice:administration",
  "moonDailySummary",
  "moonMonthlySummary",
] as const;
const NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN_CODE =
  "bdd-switch-parental-controls-code";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN_CODE =
  "bdd-switch-parental-controls-replacement-code";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN =
  "bdd-switch-parental-controls-session-token";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN =
  "bdd-switch-parental-controls-replacement-session-token";
const NINTENDO_SWITCH_PARENTAL_CONTROLS_UNLOCK_CODE =
  "bdd-switch-parental-controls-unlock-code-must-not-leak";

function awsActor(): ApiTestUser {
  const bdd = createBddApi(context);
  context.mocks.ably.publish.mockResolvedValue(undefined);
  return bdd.user();
}

function expectNoVisibleSecret(value: unknown, secret: string): void {
  expect(JSON.stringify(value)).not.toContain(secret);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jwtPayload(payload: Readonly<Record<string, string>>): string {
  const encode = (value: unknown) => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function mockNintendoStoreExternalCodeProvider(): {
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

function mockNintendoSwitchParentalControlsExternalCodeProvider(): {
  readonly federatedSmartDeviceIds: string[];
  readonly federationBodies: unknown[];
  readonly failLogout: () => void;
  readonly initialIdToken: string;
  readonly logoutAuthorizations: (string | null)[];
  readonly logoutBodies: unknown[];
  readonly replacementIdToken: string;
  readonly sessionTokenBodies: URLSearchParams[];
  readonly tokenBodies: Readonly<Record<string, unknown>>[];
} {
  const federatedSmartDeviceIds: string[] = [];
  const federationBodies: unknown[] = [];
  const initialIdToken = jwtPayload({
    sub: "bdd-switch-parental-controls-account-id",
    preferred_username: "bdd-nintendo-parent",
    email: "bdd-nintendo-parent@example.test",
  });
  const logoutAuthorizations: (string | null)[] = [];
  const logoutBodies: unknown[] = [];
  const replacementIdToken = jwtPayload({
    sub: "bdd-switch-parental-controls-replacement-account-id",
    preferred_username: "bdd-nintendo-replacement-parent",
    email: "bdd-nintendo-replacement-parent@example.test",
  });
  const sessionTokenBodies: URLSearchParams[] = [];
  const tokenBodies: Readonly<Record<string, unknown>>[] = [];
  let logoutStatus = 204;

  server.use(
    http.post(NINTENDO_STORE_SESSION_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      sessionTokenBodies.push(body);
      const sessionTokenCode = body.get("session_token_code");
      if (
        sessionTokenCode ===
        NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN_CODE
      ) {
        return HttpResponse.json({
          session_token:
            NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN,
        });
      }
      if (
        sessionTokenCode ===
        NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN_CODE
      ) {
        return HttpResponse.json({
          session_token:
            NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN,
        });
      }
      throw new Error(
        `Unexpected Nintendo Switch Parental Controls session token code: ${sessionTokenCode}`,
      );
    }),
    http.post(NINTENDO_STORE_TOKEN_URL, async ({ request }) => {
      const body: unknown = await request.json();
      if (!isRecord(body)) {
        throw new Error(
          "Expected Nintendo Switch Parental Controls token body object",
        );
      }
      tokenBodies.push(body);
      const sessionToken = body["session_token"];
      if (
        sessionToken !==
          NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN &&
        sessionToken !==
          NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN
      ) {
        throw new Error(
          "Expected a known Nintendo Switch Parental Controls session token",
        );
      }
      const isReplacement =
        sessionToken ===
        NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN;
      return HttpResponse.json({
        access_token: isReplacement
          ? "bdd-switch-parental-controls-replacement-access-token"
          : "bdd-switch-parental-controls-access-token",
        expires_in: 3600,
        id_token: isReplacement ? replacementIdToken : initialIdToken,
        token_type: "Bearer",
        scope: NINTENDO_SWITCH_PARENTAL_CONTROLS_SCOPES.join(" "),
      });
    }),
    http.get(NINTENDO_STORE_PROFILE_URL, () => {
      return HttpResponse.json({ country: "US", language: "en" });
    }),
    http.post(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_FEDERATION_URL,
      async ({ request }) => {
        const body: unknown = await request.json();
        if (
          !isRecord(body) ||
          !isRecord(body["smartDeviceInfo"]) ||
          typeof body["smartDeviceInfo"]["id"] !== "string"
        ) {
          throw new Error("Expected Nintendo smart-device federation body");
        }
        federationBodies.push(body);
        federatedSmartDeviceIds.push(body["smartDeviceInfo"]["id"]);
        return HttpResponse.json({
          loginInfo: {
            ownedDevices: [
              {
                deviceId: "bdd-switch-device-id",
                label: "Family room",
                device: {
                  serialNumber: "bdd-serial-must-not-leak",
                  synchronizedUnlockCode:
                    NINTENDO_SWITCH_PARENTAL_CONTROLS_UNLOCK_CODE,
                },
              },
            ],
          },
          nextStep: "COMPLETED",
        });
      },
    ),
    http.post(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_LOGOUT_URL,
      async ({ request }) => {
        logoutAuthorizations.push(request.headers.get("authorization"));
        logoutBodies.push(await request.json());
        return logoutStatus === 204
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json(
              { error: "temporarily unavailable" },
              { status: logoutStatus },
            );
      },
    ),
  );

  return {
    federatedSmartDeviceIds,
    federationBodies,
    failLogout: () => {
      logoutStatus = 503;
    },
    initialIdToken,
    logoutAuthorizations,
    logoutBodies,
    replacementIdToken,
    sessionTokenBodies,
    tokenBodies,
  };
}

describe("CONN-02: external-code session lifecycle", () => {
  it("starts, completes, replays, and protects an AWS external-code session through public APIs", async () => {
    const provider = mockAwsExternalCodeProvider();
    const actor = await awsActor();
    const bdd = createBddApi(context);

    const session = await connectorsApi.startExternalCode(actor, "aws", "cli", {
      intent: "add",
    });
    expect(session).toMatchObject({
      connectorSlug: "aws",
      status: "pending",
      expiresIn: 600,
    });
    const authorizationUrl = new URL(session.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "arn:aws:signin:::devtools/cross-device",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      AWS_REDIRECT_URI,
    );

    const wrongToken = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: `wrong-${session.sessionToken}`,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [404],
    );
    expectApiError(wrongToken.body);
    expect(wrongToken.body.error.message).toBe(
      "External-code authorization session not found",
    );
    expect(provider.tokenRequests).toStrictEqual([]);

    const stranger = bdd.user();
    const crossUser = await connectorsApi.requestExternalCodeComplete(
      stranger,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [404],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.code).toBe("NOT_FOUND");
    expect(provider.tokenRequests).toStrictEqual([]);

    const beforeComplete = now();
    const complete = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: ` ${awsVerificationCode(session.authorizationUrl)} \n`,
    });
    const afterComplete = now();

    expect(provider.tokenRequests).toHaveLength(1);
    expect(provider.tokenRequests[0]).toMatchObject({
      grantType: "authorization_code",
      code: "AWS-CODE",
      redirectUri: AWS_REDIRECT_URI,
    });
    expect(complete.connector).toMatchObject({
      slug: "aws",
      authMethod: "cli",
      externalId: "123456789012",
      externalUsername:
        "arn:aws:iam::123456789012:user/external-code (AIDAEXTERNALUSER)",
      oauthScopes: ["openid"],
    });
    expect(complete.connector.tokenExpiresAt).not.toBeNull();
    const tokenExpiresAtMs = Date.parse(
      complete.connector.tokenExpiresAt ?? "",
    );
    expect(tokenExpiresAtMs).toBeGreaterThanOrEqual(beforeComplete + 899_000);
    expect(tokenExpiresAtMs).toBeLessThanOrEqual(afterComplete + 901_000);
    expectNoVisibleSecret(complete, "aws-secret-access-key");
    expectNoVisibleSecret(complete, "aws-login-refresh-token");
    expectNoVisibleSecret(complete, "aws-session-token");

    const readBack = await connectorsApi.readConnectorBySlug(actor, "aws");
    expect(readBack.id).toBe(complete.connector.id);
    expect(readBack.connectionStatus).toBe("connected");

    const listed = await connectorsApi.listBuiltinConnectors(actor);
    expect(
      listed.connectors.find((connector) => {
        return connector.slug === "aws";
      })?.id,
    ).toBe(complete.connector.id);
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(listed.connectorProvidedBindings).toContainEqual(
        expect.objectContaining({
          connectorSlug: "aws",
          authMethod: "cli",
          namespace: "secrets",
          name,
        }),
      );
    }
    for (const name of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
      expect(listed.connectorProvidedBindings).toContainEqual(
        expect.objectContaining({
          connectorSlug: "aws",
          authMethod: "cli",
          namespace: "vars",
          name,
        }),
      );
    }

    const storedSecrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    const connectorSecretNames = storedSecrets
      .filter((secret) => {
        return secret.type === "connector";
      })
      .map((secret) => {
        return secret.name;
      });
    expect(connectorSecretNames.sort()).toStrictEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_LOGIN_DPOP_KEY",
      "AWS_LOGIN_REFRESH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]);
    expectNoVisibleSecret(storedSecrets, "aws-secret-access-key");
    expectNoVisibleSecret(storedSecrets, "aws-login-refresh-token");

    const replay = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: awsVerificationCode(session.authorizationUrl),
    });
    expect(replay.connector.id).toBe(complete.connector.id);
    expect(replay.connector).toMatchObject({
      slug: "aws",
      authMethod: "cli",
      externalId: "123456789012",
    });
    expect(provider.tokenRequests).toHaveLength(1);

    const removedReconnect = await connectorsApi.startExternalCode(
      actor,
      "aws",
      "cli",
      { intent: "reconnect", connectionId: complete.connector.id },
    );
    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "aws");
    const rejectedReconnect = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: removedReconnect.sessionId,
        sessionToken: removedReconnect.sessionToken,
        code: awsVerificationCode(removedReconnect.authorizationUrl),
      },
      [409],
    );
    expectApiError(rejectedReconnect.body);
    expect(rejectedReconnect.body.error.message).toBe(
      "Connector account not found",
    );
    const afterDelete = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "aws",
      [404],
    );
    expectApiError(afterDelete.body);
    expect(afterDelete.body.error.code).toBe("NOT_FOUND");

    const secretsAfterDelete = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    expect(
      secretsAfterDelete.filter((secret) => {
        return secret.type === "connector";
      }),
    ).toStrictEqual([]);
  });

  it("replays the exact non-default account added by an external-code session", async () => {
    const provider = mockAwsExternalCodeProvider();
    const actor = awsActor();
    await connectorsApi.updateFeatureSwitches(actor, {});

    const defaultSession = await connectorsApi.startExternalCode(
      actor,
      "aws",
      "cli",
      { intent: "add" },
    );
    const defaultAccount = await connectorsApi.completeExternalCode(
      actor,
      "aws",
      {
        sessionId: defaultSession.sessionId,
        sessionToken: defaultSession.sessionToken,
        code: awsVerificationCode(defaultSession.authorizationUrl),
      },
    );
    const siblingSession = await connectorsApi.startExternalCode(
      actor,
      "aws",
      "cli",
      { intent: "add" },
    );
    const siblingAccount = await connectorsApi.completeExternalCode(
      actor,
      "aws",
      {
        sessionId: siblingSession.sessionId,
        sessionToken: siblingSession.sessionToken,
        code: awsVerificationCode(siblingSession.authorizationUrl),
      },
    );

    expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);
    const accounts = await connectorsApi.listBuiltinConnectorAccounts(
      actor,
      "aws",
    );
    expect(accounts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: defaultAccount.connector.id,
          isDefault: true,
        }),
        expect.objectContaining({
          id: siblingAccount.connector.id,
          isDefault: false,
        }),
      ]),
    );

    const replay = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: siblingSession.sessionId,
      sessionToken: siblingSession.sessionToken,
      code: awsVerificationCode(siblingSession.authorizationUrl),
    });
    expect(replay.connector.id).toBe(siblingAccount.connector.id);
    expect(provider.tokenRequests).toHaveLength(2);

    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "aws",
      siblingAccount.connector.id,
    );
    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "aws",
      defaultAccount.connector.id,
    );
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("supersedes pending sessions and restores provider-rejected sessions to pending", async () => {
    const provider = mockAwsExternalCodeProvider();
    const actor = await awsActor();

    const first = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const second = await connectorsApi.startExternalCode(actor, "aws", "cli");

    const superseded = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: first.sessionId,
        sessionToken: first.sessionToken,
        code: awsVerificationCode(first.authorizationUrl),
      },
      [400],
    );
    expectApiError(superseded.body);
    expect(superseded.body.error.message).toBe(
      "External-code authorization session was superseded",
    );
    expect(provider.tokenRequests).toStrictEqual([]);

    const rejected = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: second.sessionId,
        sessionToken: second.sessionToken,
        code: awsVerificationCode(second.authorizationUrl, "AWS-BAD"),
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "External-code authorization code was rejected. Check it and try again.",
    );

    const retried = await connectorsApi.completeExternalCode(actor, "aws", {
      sessionId: second.sessionId,
      sessionToken: second.sessionToken,
      code: awsVerificationCode(second.authorizationUrl),
    });
    expect(retried.connector).toMatchObject({
      slug: "aws",
      authMethod: "cli",
      externalId: "123456789012",
    });
    expect(provider.tokenRequests).toHaveLength(2);

    const readBack = await connectorsApi.readConnectorBySlug(actor, "aws");
    expect(readBack.id).toBe(retried.connector.id);

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "aws");
  });

  it("returns generic external-code copy when the PlayStation NPSSO token is rejected", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    let authorizeRequestCount = 0;
    context.mocks.ably.publish.mockResolvedValue(undefined);
    server.use(
      http.get(PLAYSTATION_AUTHORIZE_URL, ({ request }) => {
        authorizeRequestCount += 1;
        expect(request.headers.get("cookie")).toBe("npsso=bad-npsso");
        return new HttpResponse(null, { status: 401 });
      }),
    );

    const session = await connectorsApi.startExternalCode(
      actor,
      "playstation",
      "api",
    );
    expect(session.authorizationUrl).toBe(PLAYSTATION_NPSSO_URL);

    const rejected = await connectorsApi.requestExternalCodeComplete(
      actor,
      "playstation",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: " bad-npsso ",
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "External-code authorization code was rejected. Check it and try again.",
    );
    expect(authorizeRequestCount).toBe(1);
  });

  it("starts and completes a Nintendo Store external-code session through public APIs", async () => {
    const provider = mockNintendoStoreExternalCodeProvider();
    const bdd = createBddApi(context);
    const actor = bdd.user();
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const session = await connectorsApi.startExternalCode(
      actor,
      "nintendo-store",
      "api",
    );
    expect(session).toMatchObject({
      connectorSlug: "nintendo-store",
      status: "pending",
      expiresIn: 600,
    });
    const authorizationUrl = new URL(session.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      NINTENDO_STORE_AUTHORIZE_URL,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      NINTENDO_STORE_CLIENT_ID,
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      NINTENDO_STORE_REDIRECT_URI,
    );
    expect(authorizationUrl.searchParams.get("response_type")).toBe(
      "session_token_code",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "openid user user.mii user.email user.links[].id",
    );
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toStrictEqual(expect.any(String));
    if (!state) {
      throw new Error("Expected Nintendo Store authorization state");
    }

    const complete = await connectorsApi.completeExternalCode(
      actor,
      "nintendo-store",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: `${NINTENDO_STORE_REDIRECT_URI}#session_token_code=bdd-nintendo-session-token-code&state=${state}`,
      },
    );

    expect(provider.sessionTokenBodies).toHaveLength(1);
    expect(provider.sessionTokenBodies[0]?.get("client_id")).toBe(
      NINTENDO_STORE_CLIENT_ID,
    );
    expect(provider.sessionTokenBodies[0]?.get("session_token_code")).toBe(
      "bdd-nintendo-session-token-code",
    );
    expect(
      provider.sessionTokenBodies[0]?.get("session_token_code_verifier"),
    ).toStrictEqual(expect.any(String));
    expect(provider.tokenBodies).toStrictEqual([
      {
        client_id: NINTENDO_STORE_CLIENT_ID,
        session_token: "bdd-nintendo-session-token",
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token",
      },
    ]);
    expect(complete.connector).toMatchObject({
      slug: "nintendo-store",
      authMethod: "api",
      externalId: "bdd-nintendo-account-id",
      externalUsername: "bdd-nintendo-player",
      oauthScopes: [
        "openid",
        "user",
        "user.mii",
        "user.email",
        "user.links[].id",
      ],
    });
    expect(complete.connector.tokenExpiresAt).not.toBeNull();
    expectNoVisibleSecret(complete, "bdd-nintendo-session-token");
    expectNoVisibleSecret(complete, "bdd-nintendo-access-token");

    const listed = await connectorsApi.listBuiltinConnectors(actor);
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "nintendo-store",
        authMethod: "api",
        namespace: "secrets",
        name: "NINTENDO_STORE_TOKEN",
      }),
    );
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "nintendo-store",
        authMethod: "api",
        namespace: "vars",
        name: "NINTENDO_STORE_LOCALE",
      }),
    );
    const storedSecrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    const connectorSecretNames = storedSecrets
      .filter((secret) => {
        return secret.type === "connector";
      })
      .map((secret) => {
        return secret.name;
      });
    expect(connectorSecretNames.sort()).toStrictEqual([
      "NINTENDO_STORE_ACCESS_TOKEN",
      "NINTENDO_STORE_ID_TOKEN",
      "NINTENDO_STORE_SESSION_TOKEN",
    ]);
    expectNoVisibleSecret(storedSecrets, "bdd-nintendo-session-token");
    expectNoVisibleSecret(storedSecrets, "bdd-nintendo-access-token");

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(
      actor,
      "nintendo-store",
    );
  });

  it("replaces the remote Nintendo registration and keeps local deletion resilient", async () => {
    const provider = mockNintendoSwitchParentalControlsExternalCodeProvider();
    const bdd = createBddApi(context);
    const actor = bdd.user();
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const session = await connectorsApi.startExternalCode(
      actor,
      "nintendo-switch-parental-controls",
      "api",
    );
    expect(session).toMatchObject({
      connectorSlug: "nintendo-switch-parental-controls",
      status: "pending",
      expiresIn: 600,
    });
    const authorizationUrl = new URL(session.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      NINTENDO_STORE_AUTHORIZE_URL,
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_CLIENT_ID,
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_REDIRECT_URI,
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_SCOPES.join(" "),
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error(
        "Expected Nintendo Switch Parental Controls authorization state",
      );
    }

    const complete = await connectorsApi.completeExternalCode(
      actor,
      "nintendo-switch-parental-controls",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: `${NINTENDO_SWITCH_PARENTAL_CONTROLS_REDIRECT_URI}#session_token_code=${NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN_CODE}&state=${state}`,
      },
    );

    expect(provider.sessionTokenBodies).toHaveLength(1);
    expect(provider.sessionTokenBodies[0]?.get("client_id")).toBe(
      NINTENDO_SWITCH_PARENTAL_CONTROLS_CLIENT_ID,
    );
    expect(provider.tokenBodies).toStrictEqual([
      {
        client_id: NINTENDO_SWITCH_PARENTAL_CONTROLS_CLIENT_ID,
        session_token: NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN,
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token",
      },
    ]);
    expect(provider.federationBodies).toHaveLength(1);
    expect(provider.federationBodies[0]).toMatchObject({
      smartDeviceInfo: {
        id: expect.any(String),
        bundleId: "com.nintendo.znma",
        notificationToken: null,
      },
    });
    expect(complete.connector).toMatchObject({
      slug: "nintendo-switch-parental-controls",
      authMethod: "api",
      externalId: "bdd-switch-parental-controls-account-id",
      externalUsername: "bdd-nintendo-parent",
      oauthScopes: NINTENDO_SWITCH_PARENTAL_CONTROLS_SCOPES,
    });
    expect(complete.connector.tokenExpiresAt).not.toBeNull();
    expectNoVisibleSecret(
      complete,
      NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN,
    );
    expectNoVisibleSecret(
      complete,
      "bdd-switch-parental-controls-access-token",
    );
    expectNoVisibleSecret(complete, "bdd-serial-must-not-leak");
    expectNoVisibleSecret(
      complete,
      NINTENDO_SWITCH_PARENTAL_CONTROLS_UNLOCK_CODE,
    );

    const listed = await connectorsApi.listBuiltinConnectors(actor);
    for (const name of [
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
    ]) {
      expect(listed.connectorProvidedBindings).toContainEqual(
        expect.objectContaining({
          connectorSlug: "nintendo-switch-parental-controls",
          authMethod: "api",
          namespace: "secrets",
          name,
        }),
      );
    }
    for (const name of [
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
    ]) {
      expect(listed.connectorProvidedBindings).toContainEqual(
        expect.objectContaining({
          connectorSlug: "nintendo-switch-parental-controls",
          authMethod: "api",
          namespace: "vars",
          name,
        }),
      );
    }

    const storedSecrets = await readUserSecrets(context, {
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    const connectorSecretNames = storedSecrets
      .filter((secret) => {
        return secret.type === "connector";
      })
      .map((secret) => {
        return secret.name;
      });
    expect(connectorSecretNames.sort()).toStrictEqual([
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
    ]);

    const replacementSession = await connectorsApi.startExternalCode(
      actor,
      "nintendo-switch-parental-controls",
      "api",
    );
    const replacementAuthorizationUrl = new URL(
      replacementSession.authorizationUrl,
    );
    const replacementState =
      replacementAuthorizationUrl.searchParams.get("state");
    if (!replacementState) {
      throw new Error("Expected replacement Nintendo authorization state");
    }
    const replacementComplete = await connectorsApi.completeExternalCode(
      actor,
      "nintendo-switch-parental-controls",
      {
        sessionId: replacementSession.sessionId,
        sessionToken: replacementSession.sessionToken,
        code: `${NINTENDO_SWITCH_PARENTAL_CONTROLS_REDIRECT_URI}#session_token_code=${NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN_CODE}&state=${replacementState}`,
      },
    );
    expect(provider.federatedSmartDeviceIds).toHaveLength(2);
    expect(provider.federatedSmartDeviceIds[1]).not.toBe(
      provider.federatedSmartDeviceIds[0],
    );
    expect(replacementComplete.connector.id).not.toBe(complete.connector.id);
    expect(provider.logoutBodies).toStrictEqual([]);

    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "nintendo-switch-parental-controls",
      complete.connector.id,
    );
    expect(provider.logoutBodies).toStrictEqual([
      { smartDeviceId: provider.federatedSmartDeviceIds[0] },
    ]);

    provider.failLogout();
    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      "nintendo-switch-parental-controls",
      replacementComplete.connector.id,
    );
    expect(
      provider.tokenBodies.map((body) => {
        return body["session_token"];
      }),
    ).toStrictEqual([
      NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN,
      NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN,
      NINTENDO_SWITCH_PARENTAL_CONTROLS_INITIAL_SESSION_TOKEN,
      NINTENDO_SWITCH_PARENTAL_CONTROLS_REPLACEMENT_SESSION_TOKEN,
    ]);
    expect(provider.logoutAuthorizations).toStrictEqual([
      `Bearer ${provider.initialIdToken}`,
      `Bearer ${provider.replacementIdToken}`,
    ]);
    expect(provider.logoutBodies).toStrictEqual([
      { smartDeviceId: provider.federatedSmartDeviceIds[0] },
      { smartDeviceId: provider.federatedSmartDeviceIds[1] },
    ]);
    const afterDelete = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "nintendo-switch-parental-controls",
      [404],
    );
    expectApiError(afterDelete.body);
    expect(afterDelete.body.error.code).toBe("NOT_FOUND");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("keeps an in-flight completion exclusive without superseding it", async () => {
    const provider = mockAwsDeferredTokenExchange();
    const actor = await awsActor();

    const first = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const heldCompletePromise = connectorsApi.completeExternalCode(
      actor,
      "aws",
      {
        sessionId: first.sessionId,
        sessionToken: first.sessionToken,
        code: awsVerificationCode(first.authorizationUrl),
      },
    );
    await provider.tokenRequestStarted;

    const alreadyCompleting = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: first.sessionId,
        sessionToken: first.sessionToken,
        code: awsVerificationCode(first.authorizationUrl),
      },
      [400],
    );
    expectApiError(alreadyCompleting.body);
    expect(alreadyCompleting.body.error.message).toBe(
      "External-code authorization session is already completing",
    );

    const second = await connectorsApi.startExternalCode(actor, "aws", "cli");
    expect(second.status).toBe("pending");

    provider.releaseTokenResponse();
    const heldComplete = await heldCompletePromise;
    expect(heldComplete.connector).toMatchObject({
      slug: "aws",
      authMethod: "cli",
      externalId: "123456789012",
    });
    expect(provider.tokenRequests).toHaveLength(1);

    const secondComplete = await connectorsApi.completeExternalCode(
      actor,
      "aws",
      {
        sessionId: second.sessionId,
        sessionToken: second.sessionToken,
        code: awsVerificationCode(second.authorizationUrl),
      },
    );
    expect(secondComplete.connector.slug).toBe("aws");
    expect(provider.tokenRequests).toHaveLength(2);

    await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "aws");
  });

  it("expires external-code sessions past their deadline, including stale completing claims", async () => {
    const guardProvider = mockAwsExternalCodeProvider();
    const actor = await awsActor();

    const base = now();
    mockNow(base);
    const pending = await connectorsApi.startExternalCode(actor, "aws", "cli");
    mockNow(base + 601_000);

    const expired = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: pending.sessionId,
        sessionToken: pending.sessionToken,
        code: awsVerificationCode(pending.authorizationUrl),
      },
      [400],
    );
    expectApiError(expired.body);
    expect(expired.body.error.message).toBe(
      "External-code authorization session expired",
    );

    const expiredAgain = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: pending.sessionId,
        sessionToken: pending.sessionToken,
        code: awsVerificationCode(pending.authorizationUrl),
      },
      [400],
    );
    expectApiError(expiredAgain.body);
    expect(expiredAgain.body.error.message).toBe(
      "External-code authorization session expired",
    );
    expect(guardProvider.tokenRequests).toStrictEqual([]);

    const deferredProvider = mockAwsDeferredTokenExchange();
    const staleBase = base + 700_000;
    mockNow(staleBase);
    const completing = await connectorsApi.startExternalCode(
      actor,
      "aws",
      "cli",
    );
    const heldCompletePromise = connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: completing.sessionId,
        sessionToken: completing.sessionToken,
        code: awsVerificationCode(completing.authorizationUrl),
      },
      [500],
    );
    await deferredProvider.tokenRequestStarted;
    mockNow(staleBase + 31 * 60_000);

    const staleExpired = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: completing.sessionId,
        sessionToken: completing.sessionToken,
        code: awsVerificationCode(completing.authorizationUrl),
      },
      [400],
    );
    expectApiError(staleExpired.body);
    expect(staleExpired.body.error.message).toBe(
      "External-code authorization session expired",
    );

    deferredProvider.releaseTokenResponse();
    const heldComplete = await heldCompletePromise;
    expect(heldComplete.body).toStrictEqual({
      error: "Internal server error",
    });
    expect(deferredProvider.tokenRequests).toHaveLength(1);
  });

  it("marks a session failed when the provider identity lookup fails after token exchange", async () => {
    const provider = mockAwsExternalCodeProvider({ stsFailure: true });
    const actor = await awsActor();

    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    const failed = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [500],
    );
    expect(failed.body).toStrictEqual({ error: "Internal server error" });
    expect(provider.tokenRequests).toHaveLength(1);

    const terminal = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: awsVerificationCode(session.authorizationUrl),
      },
      [400],
    );
    expectApiError(terminal.body);
    expect(terminal.body.error.message).toContain("STS");
    expect(provider.tokenRequests).toHaveLength(1);

    const nothingPersisted = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "aws",
      [404],
    );
    expectApiError(nothingPersisted.body);
    expect(nothingPersisted.body.error.code).toBe("NOT_FOUND");
  });
});
