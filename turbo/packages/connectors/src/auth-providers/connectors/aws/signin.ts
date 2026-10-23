import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

import * as z from "zod";

import { OAuthProviderHttpError } from "../../oauth/error";
import { ProviderResponseError } from "../../provider-error";

const AWS_DEFAULT_SIGNIN_REGION = "us-east-1";
const AWS_DEFAULT_RUNTIME_REGION = "us-east-1";

const AWS_CODE_CHALLENGE_METHOD = "SHA-256";
const AWS_OPENID_SCOPE = "openid";
const AWS_AUTHORIZATION_RESPONSE_TYPE = "code";
const AWS_ERROR_BODY_MAX_LENGTH = 500;
const AWS_REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const AWS_DPOP_KEY_CURVE = "P-256";
const AWS_DPOP_JWT_TYPE = "dpop+jwt";
const AWS_DPOP_JWT_ALGORITHM = "ES256";
const AWS_RESPONSE_SHAPE_MAX_KEYS = 12;
const AWS_RESPONSE_SHAPE_MAX_DEPTH = 3;
const AWS_RESPONSE_SCHEMA_ISSUE_MAX_COUNT = 8;
const AWS_SIGNIN_SENSITIVE_REQUEST_KEYS = [
  "code",
  "codeVerifier",
  "refreshToken",
] as const;

const awsSigninTokenResponseBodySchema = z.object({
  accessToken: z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1),
  }),
  expiresIn: z.number().int().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.string().min(1),
  idToken: z.string().optional(),
});
const awsSigninTokenResponseSchema = z.union([
  awsSigninTokenResponseBodySchema,
  z
    .object({ tokenOutput: awsSigninTokenResponseBodySchema })
    .transform(({ tokenOutput }) => {
      return tokenOutput;
    }),
]);

const awsSigninErrorResponseSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
  Message: z.string().optional(),
  code: z.string().optional(),
  Code: z.string().optional(),
  __type: z.string().optional(),
});

export interface AwsSigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

interface AwsSigninTokenResult {
  readonly credentials: AwsSigV4Credentials;
  readonly expiresIn: number;
  readonly refreshToken: string;
}

interface AwsExternalCodeProviderState {
  readonly version: 1;
  readonly state: string;
  readonly codeVerifier: string;
  readonly dpopKey: string;
  readonly redirectUri: string;
  readonly signinRegion: string;
  readonly runtimeRegion: string;
}

interface AwsSigninVerificationCode {
  readonly code: string;
  readonly state: string;
}

interface AwsSigninErrorDetails {
  readonly message: string;
  readonly oauthError: string | undefined;
  readonly providerErrorCode: string | undefined;
}

interface AwsDpopPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

interface AwsDpopJwtHeader {
  readonly typ: "dpop+jwt";
  readonly alg: "ES256";
  readonly jwk: AwsDpopPublicJwk;
}

interface AwsDpopJwtPayload {
  readonly htm: "POST";
  readonly htu: string;
  readonly iat: number;
  readonly jti: string;
}

function awsSigninRedirectUri(signinRegion: string): string {
  return `https://${validatedAwsRegion(signinRegion)}.signin.aws.amazon.com/v1/sessions/confirmation`;
}

function awsSigninAuthorizeUrl(signinRegion: string): string {
  return `https://${validatedAwsRegion(signinRegion)}.signin.aws.amazon.com/v1/authorize`;
}

function awsSigninTokenUrl(signinRegion: string): string {
  return `https://${validatedAwsRegion(signinRegion)}.signin.aws.amazon.com/v1/token`;
}

export function createAwsExternalCodeProviderState(): AwsExternalCodeProviderState {
  const signinRegion = AWS_DEFAULT_SIGNIN_REGION;
  return {
    version: 1,
    state: randomBase64UrlBytes(32),
    codeVerifier: randomBase64UrlBytes(64),
    dpopKey: createAwsDpopPrivateKey(),
    redirectUri: awsSigninRedirectUri(signinRegion),
    signinRegion,
    runtimeRegion: AWS_DEFAULT_RUNTIME_REGION,
  };
}

export function buildAwsSigninAuthorizationUrl(args: {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly providerState: AwsExternalCodeProviderState;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: AWS_AUTHORIZATION_RESPONSE_TYPE,
    scope: awsSigninScope(args.scopes),
    code_challenge_method: AWS_CODE_CHALLENGE_METHOD,
    code_challenge: codeChallenge(args.providerState.codeVerifier),
    redirect_uri: args.providerState.redirectUri,
    state: args.providerState.state,
  });

  return `${awsSigninAuthorizeUrl(args.providerState.signinRegion)}?${params.toString()}`;
}

export async function exchangeAwsSigninAuthorizationCode(
  args: {
    readonly clientId: string;
    readonly signinRegion: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly dpopKey: string;
    readonly redirectUri: string;
  },
  signal: AbortSignal,
): Promise<AwsSigninTokenResult> {
  return await fetchAwsSigninToken(
    {
      signinRegion: args.signinRegion,
      operation: "exchange",
      reconnectOnClientError: true,
      dpopKey: args.dpopKey,
      body: {
        clientId: args.clientId,
        grantType: "authorization_code",
        code: args.code,
        codeVerifier: args.codeVerifier,
        redirectUri: args.redirectUri,
      },
    },
    signal,
  );
}

export async function refreshAwsSigninToken(
  args: {
    readonly clientId: string;
    readonly signinRegion: string;
    readonly refreshToken: string;
    readonly dpopKey: string;
  },
  signal: AbortSignal,
): Promise<AwsSigninTokenResult> {
  return await fetchAwsSigninToken(
    {
      signinRegion: args.signinRegion,
      operation: "refresh",
      reconnectOnClientError: true,
      dpopKey: args.dpopKey,
      body: {
        clientId: args.clientId,
        grantType: "refresh_token",
        refreshToken: args.refreshToken,
      },
    },
    signal,
  );
}

async function fetchAwsSigninToken(
  args: {
    readonly signinRegion: string;
    readonly operation: "exchange" | "refresh";
    readonly reconnectOnClientError: boolean;
    readonly dpopKey: string;
    readonly body: Readonly<Record<string, string>>;
  },
  signal?: AbortSignal,
): Promise<AwsSigninTokenResult> {
  const tokenUrl = awsSigninTokenUrl(args.signinRegion);
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      DPoP: buildAwsDpopHeader({
        privateKeyPem: args.dpopKey,
        uri: tokenUrl,
      }),
    },
    body: JSON.stringify(args.body),
    signal,
  });

  if (!response.ok) {
    await throwAwsSigninHttpError({
      response,
      operation: args.operation,
      reconnectOnClientError: args.reconnectOnClientError,
      body: args.body,
    });
  }

  const data = await readAwsSigninTokenResponse(response);
  return {
    credentials: {
      accessKeyId: data.accessToken.accessKeyId,
      secretAccessKey: data.accessToken.secretAccessKey,
      sessionToken: data.accessToken.sessionToken,
    },
    expiresIn: data.expiresIn,
    refreshToken: data.refreshToken,
  };
}

async function readAwsSigninTokenResponse(
  response: Response,
): Promise<z.infer<typeof awsSigninTokenResponseBodySchema>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ProviderResponseError(
      invalidAwsSigninTokenResponseMessage({ response }),
    );
  }

  const parsed = awsSigninTokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderResponseError(
      invalidAwsSigninTokenResponseMessage({
        response,
        body,
        issues: parsed.error.issues,
      }),
    );
  }
  return parsed.data;
}

function invalidAwsSigninTokenResponseMessage(args: {
  readonly response: Response;
  readonly body?: unknown;
  readonly issues?: readonly z.ZodIssue[];
}): string {
  const details = [
    `status=${args.response.status}`,
    `contentType=${args.response.headers.get("content-type") ?? "none"}`,
  ];
  if ("body" in args) {
    details.push(`bodyShape=${awsSigninTokenResponseShape(args.body)}`);
  }
  if (args.issues && args.issues.length > 0) {
    details.push(
      `schemaIssues=${awsSigninTokenResponseSchemaIssues(args.issues)}`,
    );
  }
  return `Invalid AWS Sign-In token response (${details.join("; ")})`;
}

function awsSigninTokenResponseSchemaIssues(
  issues: readonly z.ZodIssue[],
): string {
  const summaries = issues
    .slice(0, AWS_RESPONSE_SCHEMA_ISSUE_MAX_COUNT)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}:${issue.code}`;
    });
  if (issues.length > AWS_RESPONSE_SCHEMA_ISSUE_MAX_COUNT) {
    summaries.push(
      `...+${issues.length - AWS_RESPONSE_SCHEMA_ISSUE_MAX_COUNT}`,
    );
  }
  return summaries.join(",");
}

function awsSigninTokenResponseShape(value: unknown, depth = 0): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    if (depth >= AWS_RESPONSE_SHAPE_MAX_DEPTH || value.length === 0) {
      return "array";
    }
    return `array[${awsSigninTokenResponseShape(value[0], depth + 1)}]`;
  }
  if (typeof value !== "object") {
    return typeof value;
  }
  if (depth >= AWS_RESPONSE_SHAPE_MAX_DEPTH) {
    return "object";
  }

  const entries = Object.entries(value);
  const fields = entries
    .slice(0, AWS_RESPONSE_SHAPE_MAX_KEYS)
    .map(([key, fieldValue]) => {
      return `${key}:${awsSigninTokenResponseShape(fieldValue, depth + 1)}`;
    });
  if (entries.length > AWS_RESPONSE_SHAPE_MAX_KEYS) {
    fields.push(`...+${entries.length - AWS_RESPONSE_SHAPE_MAX_KEYS}`);
  }
  return `object{${fields.join(",")}}`;
}

export function parseAwsSigninVerificationCode(args: {
  readonly verificationCode: string;
  readonly expectedState: string;
}): AwsSigninVerificationCode {
  const decoded = decodeAwsSigninVerificationCode(args.verificationCode);
  const params = new URLSearchParams(decoded);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    throw invalidAwsSigninVerificationCode(
      "missing state or authorization code",
    );
  }
  if (state !== args.expectedState) {
    throw invalidAwsSigninVerificationCode("state mismatch");
  }
  return { code, state };
}

function decodeAwsSigninVerificationCode(verificationCode: string): string {
  const value = verificationCode.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw invalidAwsSigninVerificationCode("invalid base64");
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function invalidAwsSigninVerificationCode(
  reason: string,
): OAuthProviderHttpError {
  return new OAuthProviderHttpError(
    `Invalid AWS Sign-In authorization code: ${reason}`,
    400,
    "invalid_grant",
  );
}

function createAwsDpopPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: AWS_DPOP_KEY_CURVE,
  });
  return privateKey.export({ type: "sec1", format: "pem" }).toString();
}

function buildAwsDpopHeader(args: {
  readonly privateKeyPem: string;
  readonly uri: string;
}): string {
  const privateKey = parseAwsDpopPrivateKey(args.privateKeyPem);
  const header = awsDpopHeader(privateKey);
  const payload: AwsDpopJwtPayload = {
    htm: "POST",
    htu: args.uri,
    iat: Math.floor(Date.now() / 1000),
    jti: randomUUID(),
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function parseAwsDpopPrivateKey(privateKeyPem: string): KeyObject {
  try {
    return createPrivateKey(privateKeyPem);
  } catch {
    throw new ProviderResponseError("Invalid AWS DPoP key");
  }
}

function awsDpopHeader(privateKey: KeyObject): AwsDpopJwtHeader {
  return {
    typ: AWS_DPOP_JWT_TYPE,
    alg: AWS_DPOP_JWT_ALGORITHM,
    jwk: awsDpopPublicJwk(privateKey),
  };
}

function awsDpopPublicJwk(privateKey: KeyObject): AwsDpopPublicJwk {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== AWS_DPOP_KEY_CURVE ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string"
  ) {
    throw new ProviderResponseError("Invalid AWS DPoP key");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
  };
}

function base64UrlJson(value: AwsDpopJwtHeader | AwsDpopJwtPayload): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function throwAwsSigninHttpError(args: {
  readonly response: Response;
  readonly operation: "exchange" | "refresh";
  readonly reconnectOnClientError: boolean;
  readonly body: Readonly<Record<string, string>>;
}): Promise<never> {
  const details = await readAwsSigninErrorDetails(
    args.response,
    awsSigninSensitiveRequestValues(args.body),
  );
  const oauthError =
    args.reconnectOnClientError &&
    args.response.status >= 400 &&
    args.response.status < 500 &&
    args.response.status !== 429
      ? "invalid_grant"
      : details.oauthError;
  const suffix = details.message ? ` ${details.message}` : "";
  throw new OAuthProviderHttpError(
    `AWS Sign-In token ${args.operation} failed: ${args.response.status}${suffix}`,
    args.response.status,
    oauthError,
    undefined,
    details.providerErrorCode,
  );
}

async function readAwsSigninErrorDetails(
  response: Response,
  sensitiveValues: readonly string[],
): Promise<AwsSigninErrorDetails> {
  const raw = await response.text();
  if (!raw) {
    return { message: "", oauthError: undefined, providerErrorCode: undefined };
  }

  const truncated = truncateAwsSigninErrorText(
    redactAwsSigninErrorText(raw, sensitiveValues),
  );

  try {
    const parsed = awsSigninErrorResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        message: redactAwsSigninErrorText(truncated, sensitiveValues),
        oauthError: undefined,
        providerErrorCode: undefined,
      };
    }
    const errorCode =
      parsed.data.error ??
      parsed.data.code ??
      parsed.data.Code ??
      parsed.data.__type;
    const description =
      parsed.data.error_description ??
      parsed.data.message ??
      parsed.data.Message;
    const message = errorCode
      ? description
        ? `${errorCode} (${description})`
        : errorCode
      : (description ?? redactAwsSigninErrorText(truncated, sensitiveValues));
    return {
      message: truncateAwsSigninErrorText(
        redactAwsSigninErrorText(message, sensitiveValues),
      ),
      oauthError: parsed.data.error,
      providerErrorCode:
        errorCode === undefined
          ? undefined
          : truncateAwsSigninErrorText(
              redactAwsSigninErrorText(errorCode, sensitiveValues),
            ),
    };
  } catch {
    return {
      message: redactAwsSigninErrorText(truncated, sensitiveValues),
      oauthError: undefined,
      providerErrorCode: undefined,
    };
  }
}

function awsSigninScope(scopes: readonly string[]): string {
  return scopes.length === 0 ? AWS_OPENID_SCOPE : scopes.join(" ");
}

function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function randomBase64UrlBytes(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function validatedAwsRegion(region: string): string {
  if (!AWS_REGION_RE.test(region)) {
    throw new Error(`Invalid AWS Sign-In region ${region}`);
  }
  return region;
}

function awsSigninSensitiveRequestValues(
  body: Readonly<Record<string, string>>,
): readonly string[] {
  return AWS_SIGNIN_SENSITIVE_REQUEST_KEYS.flatMap((key) => {
    const value = body[key];
    return value ? [value] : [];
  });
}

function redactAwsSigninErrorText(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  let redacted = value
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY_ID]")
    .replace(/ASIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY_ID]")
    .replace(
      /("(?:accessKeyId|secretAccessKey|sessionToken|refreshToken|code|codeVerifier)"\s*:\s*")[^"]+/g,
      "$1[REDACTED]",
    )
    .replace(
      /((?:accessKeyId|secretAccessKey|sessionToken|refreshToken|code|codeVerifier)=)[^&\s]+/g,
      "$1[REDACTED]",
    );
  for (const sensitiveValue of [...sensitiveValues].sort((left, right) => {
    return right.length - left.length;
  })) {
    redacted = redacted.split(sensitiveValue).join("[REDACTED]");
  }
  return redacted;
}

function truncateAwsSigninErrorText(value: string): string {
  return value.length > AWS_ERROR_BODY_MAX_LENGTH
    ? `${value.slice(0, AWS_ERROR_BODY_MAX_LENGTH)}...`
    : value;
}
