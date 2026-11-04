import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync } from "node:crypto";

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { resolveConnectorAuthClient } from "../../../connector-auth-method";
import { isOAuthProviderHttpError } from "../../oauth/error";
import { isProviderResponseError } from "../../provider-error";
import { AWS_PROVIDER_METHOD } from "./provider-method-fixtures";
import { providerOperationFixture } from "./provider-operation-fixture";

const AWS_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";
const AWS_EXCHANGE_CREDENTIAL_ID = ["aws", "exchange", "credential", "id"].join(
  "-",
);
const AWS_REFRESH_CREDENTIAL_ID = ["aws", "refresh", "credential", "id"].join(
  "-",
);
const {
  completeConnectorExternalCodeAuthorization,
  refreshConnectorAuthProviderAccessToken,
  startConnectorExternalCodeAuthorization,
} = providerOperationFixture({
  connectorSlug: "aws",
  authMethodId: "cli",
  method: AWS_PROVIDER_METHOD,
});

const awsTokenRequestSchema = object({
  clientId: literal("arn:aws:signin:::devtools/cross-device"),
  grantType: zEnum(["authorization_code", "refresh_token"]),
  code: string().optional(),
  codeVerifier: string().optional(),
  redirectUri: string().optional(),
  refreshToken: string().optional(),
});

const awsProviderStateSchema = object({
  version: literal(1),
  state: string(),
  codeVerifier: string(),
  dpopKey: string(),
  redirectUri: string(),
  signinRegion: string(),
  runtimeRegion: string(),
});

const awsDpopHeaderSchema = object({
  typ: literal("dpop+jwt"),
  alg: literal("ES256"),
  jwk: object({
    kty: literal("EC"),
    crv: literal("P-256"),
    x: string().min(1),
    y: string().min(1),
  }),
});

const awsDpopPayloadSchema = object({
  htm: literal("POST"),
  htu: literal(AWS_TOKEN_URL),
  iat: number().int().positive(),
  jti: uuid(),
});

const server = setupServer();
const tokenRequests: zInfer<typeof awsTokenRequestSchema>[] = [];
const dpopHeaders: string[] = [];
let stsCalls = 0;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  tokenRequests.length = 0;
  dpopHeaders.length = 0;
  stsCalls = 0;
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function awsAuthClient() {
  const authClient = resolveConnectorAuthClient(
    AWS_PROVIDER_METHOD.client,
    () => {
      return undefined;
    },
  );
  if (!authClient) {
    throw new Error("Expected AWS auth client");
  }
  return authClient;
}

function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function parseProviderState(providerState: string) {
  return awsProviderStateSchema.parse(JSON.parse(providerState) as unknown);
}

function awsVerificationCode(args: {
  readonly providerState: zInfer<typeof awsProviderStateSchema>;
  readonly code?: string;
  readonly state?: string;
}): string {
  return Buffer.from(
    new URLSearchParams({
      state: args.state ?? args.providerState.state,
      code: args.code ?? "AWS-CODE",
    }).toString(),
  ).toString("base64");
}

function awsDpopKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "sec1", format: "pem" }).toString();
}

function awsRefreshInputs() {
  return {
    refreshToken: "aws-refresh-token",
    dpopKey: awsDpopKey(),
    signinRegion: "us-east-1",
  };
}

function expectAwsDpopHeader(value: string | undefined): void {
  expect(value).toBeTruthy();
  const parts = value?.split(".");
  expect(parts).toHaveLength(3);
  if (!parts || parts.length !== 3) {
    return;
  }
  const header = parts[0];
  const payload = parts[1];
  const signature = parts[2];
  if (!header || !payload || !signature) {
    return;
  }
  expectJsonWebTokenPart(awsDpopHeaderSchema, header);
  expectJsonWebTokenPart(awsDpopPayloadSchema, payload);
  expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
}

function expectJsonWebTokenPart<T>(schema: ZodType<T>, value: string): T {
  return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
}

function awsTokenEndpointResponseBody(
  body: zInfer<typeof awsTokenRequestSchema>,
  options: {
    readonly expiresIn?: number;
    readonly tokenType?: string;
  } = {},
) {
  return {
    accessToken: {
      accessKeyId:
        body.grantType === "refresh_token"
          ? AWS_REFRESH_CREDENTIAL_ID
          : AWS_EXCHANGE_CREDENTIAL_ID,
      secretAccessKey:
        body.grantType === "refresh_token"
          ? "refresh-secret-access-key"
          : "exchange-secret-access-key",
      sessionToken:
        body.grantType === "refresh_token"
          ? "refresh-session-token"
          : "exchange-session-token",
    },
    expiresIn: options.expiresIn ?? 900,
    refreshToken:
      body.grantType === "refresh_token"
        ? "aws-refresh-token-rotated"
        : "aws-refresh-token",
    tokenType: options.tokenType ?? "aws_sigv4",
    ...(body.grantType === "authorization_code"
      ? { idToken: "aws-id-token" }
      : {}),
  };
}

function mockAwsTokenEndpoint(
  options: {
    readonly expiresIn?: number;
    readonly responseShape?: "flat" | "tokenOutput";
    readonly tokenType?: string;
  } = {},
): void {
  server.use(
    http.post(AWS_TOKEN_URL, async ({ request }) => {
      const body = awsTokenRequestSchema.parse(await request.json());
      tokenRequests.push(body);
      dpopHeaders.push(request.headers.get("dpop") ?? "");
      const responseBody = awsTokenEndpointResponseBody(body, options);
      if (options.responseShape === "tokenOutput") {
        return HttpResponse.json({ tokenOutput: responseBody });
      }
      return HttpResponse.json(responseBody);
    }),
    http.get(AWS_STS_URL, ({ request }) => {
      stsCalls += 1;
      expect(request.headers.get("authorization")).toContain(
        "AWS4-HMAC-SHA256",
      );
      expect(request.headers.get("x-amz-security-token")).toBe(
        "exchange-session-token",
      );
      return HttpResponse.xml(
        [
          "<GetCallerIdentityResponse>",
          "<GetCallerIdentityResult>",
          "<UserId>AIDAEXAMPLEUSER</UserId>",
          "<Account>123456789012</Account>",
          "<Arn>arn:aws:iam::123456789012:user/test-user</Arn>",
          "</GetCallerIdentityResult>",
          "</GetCallerIdentityResponse>",
        ].join(""),
      );
    }),
  );
}

describe("AWS external-code provider", () => {
  it("starts AWS remote sign-in with cross-device PKCE parameters", async () => {
    const result = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });

    const providerState = parseProviderState(result.providerState);
    const url = new URL(result.authorizationUrl);

    expect(url.origin + url.pathname).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(
      "arn:aws:signin:::devtools/cross-device",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("code_challenge_method")).toBe("SHA-256");
    expect(url.searchParams.get("code_challenge")).toBe(
      codeChallenge(providerState.codeVerifier),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation",
    );
    expect(url.searchParams.get("state")).toBe(providerState.state);
    expect(providerState.dpopKey).toContain("BEGIN EC PRIVATE KEY");
    expect(result.expiresIn).toBe(600);
  });

  it("exchanges the pasted code, preserves expiresIn, and maps STS identity", async () => {
    mockAwsTokenEndpoint({ responseShape: "tokenOutput" });
    const start = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });

    const providerState = parseProviderState(start.providerState);
    const result = await completeConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
      code: awsVerificationCode({ providerState }),
      providerState: start.providerState,
      signal: new AbortController().signal,
    });

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({
      grantType: "authorization_code",
      code: "AWS-CODE",
      redirectUri:
        "https://us-east-1.signin.aws.amazon.com/v1/sessions/confirmation",
    });
    expect(tokenRequests[0]?.codeVerifier).toBe(providerState.codeVerifier);
    expectAwsDpopHeader(dpopHeaders[0]);
    expect(stsCalls).toBe(1);
    expect(result).toStrictEqual({
      outputs: {
        refreshToken: "aws-refresh-token",
        dpopKey: providerState.dpopKey,
        accessKeyId: AWS_EXCHANGE_CREDENTIAL_ID,
        secretAccessKey: "exchange-secret-access-key",
        sessionToken: "exchange-session-token",
        signinRegion: "us-east-1",
        runtimeRegion: "us-east-1",
      },
      expiresIn: 900,
      scopes: ["openid"],
      userInfo: {
        id: "123456789012",
        username: "arn:aws:iam::123456789012:user/test-user (AIDAEXAMPLEUSER)",
        email: null,
      },
    });
  });

  it("accepts AWS token metadata that the AWS CLI does not validate", async () => {
    mockAwsTokenEndpoint({ expiresIn: 3600, tokenType: "Bearer" });
    const start = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const providerState = parseProviderState(start.providerState);

    const result = await completeConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
      code: awsVerificationCode({ providerState }),
      providerState: start.providerState,
      signal: new AbortController().signal,
    });

    expect(result.expiresIn).toBe(3600);
    expect(stsCalls).toBe(1);
  });

  it("aborts AWS code exchange without sending the token request", async () => {
    mockAwsTokenEndpoint();
    const start = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const providerState = parseProviderState(start.providerState);
    const controller = new AbortController();
    controller.abort();

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        code: awsVerificationCode({ providerState }),
        providerState: start.providerState,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(tokenRequests).toStrictEqual([]);
    expect(stsCalls).toBe(0);
  });

  it("propagates aborts while reading the AWS token response body", async () => {
    let resolveTokenResponseStarted: (() => void) | undefined;
    const tokenResponseStarted = new Promise<void>((resolve) => {
      resolveTokenResponseStarted = resolve;
    });
    let abortTokenResponseBody: ((error: DOMException) => void) | undefined;
    server.use(
      http.post(AWS_TOKEN_URL, async ({ request }) => {
        const body = awsTokenRequestSchema.parse(await request.json());
        tokenRequests.push(body);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            abortTokenResponseBody = (error) => {
              controller.error(error);
            };
            resolveTokenResponseStarted?.();
          },
        });
        return new HttpResponse(stream, {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const start = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const providerState = parseProviderState(start.providerState);
    const controller = new AbortController();

    const complete = completeConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
      code: awsVerificationCode({ providerState }),
      providerState: start.providerState,
      signal: controller.signal,
    });

    await tokenResponseStarted;
    const abortError = new DOMException(
      "The operation was aborted",
      "AbortError",
    );
    controller.abort(abortError);
    if (!abortTokenResponseBody) {
      throw new Error("Expected AWS token response body to start");
    }
    abortTokenResponseBody(abortError);

    await expect(complete).rejects.toMatchObject({ name: "AbortError" });
    expect(tokenRequests).toHaveLength(1);
    expect(stsCalls).toBe(0);
  });

  it("reports invalid AWS token response shape without leaking token values", async () => {
    const start = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const providerState = parseProviderState(start.providerState);
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: {
            accessKeyId: "leaked-access-key-id",
            secretAccessKey: "leaked-secret-access-key",
            sessionToken: "leaked-session-token",
          },
          expires_in: 900,
          refresh_token: "leaked-refresh-token",
          token_type: "aws_sigv4",
        });
      }),
    );

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        code: awsVerificationCode({ providerState }),
        providerState: start.providerState,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isProviderResponseError(error) &&
        error.message.includes("bodyShape=object{access_token:object") &&
        error.message.includes("schemaIssues=") &&
        !error.message.includes("leaked-access-key-id") &&
        !error.message.includes("leaked-secret-access-key") &&
        !error.message.includes("leaked-session-token") &&
        !error.message.includes("leaked-refresh-token")
      );
    });
  });

  it("refreshes AWS credentials and returns a rotated refresh token", async () => {
    mockAwsTokenEndpoint();

    await expect(
      refreshConnectorAuthProviderAccessToken({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: awsRefreshInputs(),
        signal: new AbortController().signal,
      }),
    ).resolves.toStrictEqual({
      outputs: {
        refreshToken: "aws-refresh-token-rotated",
        accessKeyId: AWS_REFRESH_CREDENTIAL_ID,
        secretAccessKey: "refresh-secret-access-key",
        sessionToken: "refresh-session-token",
      },
      expiresIn: 900,
    });
    expect(tokenRequests).toStrictEqual([
      {
        clientId: "arn:aws:signin:::devtools/cross-device",
        grantType: "refresh_token",
        refreshToken: "aws-refresh-token",
      },
    ]);
    expectAwsDpopHeader(dpopHeaders[0]);
  });

  it("rejects AWS verification codes with a mismatched state before token exchange", async () => {
    mockAwsTokenEndpoint();
    const start = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const providerState = parseProviderState(start.providerState);

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        code: awsVerificationCode({
          providerState,
          state: "wrong-state",
        }),
        providerState: start.providerState,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 400 &&
        error.oauthError === "invalid_grant"
      );
    });
    expect(tokenRequests).toStrictEqual([]);
  });

  it("maps terminal AWS refresh failures to invalid_grant", async () => {
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          {
            __type: "AccessDeniedException",
            message: "Refresh token expired",
          },
          { status: 400 },
        );
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: awsRefreshInputs(),
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 400 &&
        error.oauthError === "invalid_grant"
      );
    });
  });

  it.each(["error", "code", "Code", "__type"])(
    "preserves the AWS %s error code independently of OAuth normalization",
    async (field) => {
      server.use(
        http.post(AWS_TOKEN_URL, () => {
          return HttpResponse.json(
            { [field]: "TOKEN_EXPIRED", message: "Refresh token expired" },
            { status: 401 },
          );
        }),
      );

      await expect(
        refreshConnectorAuthProviderAccessToken({
          connectorSlug: "aws",
          authMethod: "cli",
          authClient: awsAuthClient(),
          inputs: awsRefreshInputs(),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        status: 401,
        oauthError: "invalid_grant",
        providerErrorCode: "TOKEN_EXPIRED",
      });
    },
  );

  it("redacts AWS token exchange sensitive values from provider errors", async () => {
    const start = await startConnectorExternalCodeAuthorization({
      connectorSlug: "aws",
      authMethod: "cli",
      authClient: awsAuthClient(),
    });
    const providerState = parseProviderState(start.providerState);
    const errorAccessKeyId = ["aws", "error", "access", "key"].join("-");
    const errorSecretAccessKey = ["aws", "error", "secret"].join("-");
    const errorSessionToken = ["aws", "error", "session"].join("-");
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: [
              "Rejected",
              "AWS-CODE",
              providerState.codeVerifier,
              `accessKeyId=${errorAccessKeyId}`,
              `secretAccessKey=${errorSecretAccessKey}`,
              `sessionToken=${errorSessionToken}`,
            ].join(" "),
          },
          { status: 400 },
        );
      }),
    );

    await expect(
      completeConnectorExternalCodeAuthorization({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        code: awsVerificationCode({ providerState }),
        providerState: start.providerState,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        !error.message.includes("AWS-CODE") &&
        !error.message.includes(providerState.codeVerifier) &&
        !error.message.includes(errorAccessKeyId) &&
        !error.message.includes(errorSecretAccessKey) &&
        !error.message.includes(errorSessionToken)
      );
    });
  });

  it("redacts AWS refresh tokens echoed by provider errors", async () => {
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: "aws-refresh-token",
            error_description: "Refresh token aws-refresh-token expired",
          },
          { status: 400 },
        );
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: awsRefreshInputs(),
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        !error.message.includes("aws-refresh-token") &&
        error.providerErrorCode === "[REDACTED]"
      );
    });
  });

  it("keeps AWS token throttling as an upstream OAuth HTTP error", async () => {
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json(
          { __type: "TooManyRequestsError", message: "Rate limited" },
          { status: 429 },
        );
      }),
    );

    await expect(
      refreshConnectorAuthProviderAccessToken({
        connectorSlug: "aws",
        authMethod: "cli",
        authClient: awsAuthClient(),
        inputs: awsRefreshInputs(),
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        isOAuthProviderHttpError(error) &&
        error.status === 429 &&
        error.oauthError === undefined
      );
    });
  });
});
