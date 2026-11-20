import { accept } from "@okouai/connectors/accept";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { Buffer } from "node:buffer";
import {
  createHmac,
  createSign,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { and, eq } from "drizzle-orm";
import { buildConnectorAuthCodeAuthorizationUrlWithMethod } from "@okouai/connectors/auth-providers";
import type { AuthUrlResult } from "@okouai/connectors/auth-providers/provider-flow-types";
import {
  connectorGrantScopes,
  resolveConnectorAuthClient,
  isStaticConfidentialConnectorAuthClient,
  type ConnectorEnvReader,
} from "@okouai/connectors/connector-auth-method";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import type { ConnectorAuthMethodId } from "@okouai/api-contracts/contracts/connector-identity";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { githubUserLinks } from "@okouai/db/schema/github-user-link";
import { array, number, object, string } from "zod";
import { command } from "ccstate";

import { db$, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import {
  connectorOAuthStateExpiresAt,
  generateConnectorOAuthState,
} from "../../lib/connector-oauth-state";
import { now } from "../../lib/time";
import { insertConnectorOAuthState$ } from "./connector-oauth-state.service";
import { githubAppUrl } from "../../lib/github-official-app";

const INSTALLATION_ID_RE = /^\d+$/;
const MAX_GITHUB_CONNECT_AGE_SECONDS = 10 * 60;
const GITHUB_OAUTH_AUTH_METHOD = "oauth";

const appInstallationSchema = object({
  id: number(),
  app_id: number(),
  app_slug: string().min(1),
  account: object({
    id: number(),
    login: string(),
    type: string(),
  }),
});

interface GitHubInstallationInfo {
  readonly appId: string;
  readonly appSlug: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly targetName: string;
}

interface GithubOAuthState {
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly composeId: string | null;
  readonly sig: string | null;
  readonly callbackRedirectUri: string | null;
  readonly callbackRedirectUriSig: string | null;
  readonly oauthRequestedScopes: readonly string[] | null;
  readonly oauthRequestedScopesSig: string | null;
}

type ParsedGithubOauthRequestedScopesState =
  | {
      readonly ok: true;
      readonly scopes: readonly string[] | null;
      readonly signature: string | null;
    }
  | { readonly ok: false };

type ParsedGithubOauthCallbackRedirectUriState =
  | {
      readonly ok: true;
      readonly redirectUri: string;
      readonly signature: string;
    }
  | { readonly ok: false };

export function getGithubOAuthAuthMethod(): ConnectorAuthMethodId {
  return GITHUB_OAUTH_AUTH_METHOD;
}

function validateInstallationId(installationId: string): string {
  if (!INSTALLATION_ID_RE.test(installationId)) {
    throw new Error(
      `Invalid GitHub installation ID: expected numeric string, got "${installationId}"`,
    );
  }
  return installationId;
}

function base64url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parsePemKey(input: string): string {
  if (!input.startsWith("-----BEGIN")) {
    return Buffer.from(input, "base64").toString("utf8");
  }

  const match = input.match(
    /^(-----BEGIN [^-]+-----)[\s]+([\s\S]+?)[\s]+(-----END [^-]+-----)$/,
  );
  if (!match) {
    return input;
  }

  const header = match[1];
  const body = match[2];
  const footer = match[3];
  if (!header || !body || !footer) {
    return input;
  }

  return `${header}\n${body.replace(/\s+/g, "\n")}\n${footer}\n`;
}

function createAppJwt(appId: string, privateKeyPemOrBase64: string): string {
  const nowSeconds = Math.floor(now() / 1000);
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 600,
      iss: appId,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(
    parsePemKey(privateKeyPemOrBase64),
    "base64url",
  );

  return `${signingInput}.${signature}`;
}

function githubHeaders(
  appId: string,
  privateKey: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${createAppJwt(appId, privateKey)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function getGithubInstallationInfo(
  args: {
    readonly appId: string;
    readonly privateKey: string;
    readonly installationId: string;
  },
  _signal: AbortSignal,
): Promise<GitHubInstallationInfo> {
  const installationId = validateInstallationId(args.installationId);
  const response = await accept(
    fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: githubHeaders(args.appId, args.privateKey),
    }),
    [200],
  );

  const data = appInstallationSchema.parse(await response.json());

  return {
    appId: String(data.app_id),
    appSlug: data.app_slug,
    targetType: data.account.type,
    targetId: String(data.account.id),
    targetName: data.account.login,
  };
}

export async function getGithubInstallationAccessToken(
  args: {
    readonly appId: string;
    readonly privateKey: string;
    readonly installationId: string;
  },
  _signal: AbortSignal,
): Promise<{ readonly token: string; readonly expiresAt: string }> {
  const installationId = validateInstallationId(args.installationId);
  const response = await accept(
    fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubHeaders(args.appId, args.privateKey),
      },
    ),
    [201],
  );

  const data = (await response.json()) as {
    readonly token: string;
    readonly expires_at: string;
  };
  return { token: data.token, expiresAt: data.expires_at };
}

async function createGithubOauthStateSignature(args: {
  readonly userId: string;
  readonly orgId: string | null;
  readonly composeId: string | null;
  readonly secretsEncryptionKey: string;
}): Promise<string> {
  return await createGithubOauthStateHmac(
    `github-app-install-v2:${args.userId}:${args.orgId ?? ""}:${args.composeId ?? ""}`,
    args.secretsEncryptionKey,
  );
}

async function createGithubOauthStateHmac(
  payload: string,
  secretsEncryptionKey: string,
): Promise<string> {
  const textEncoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secretsEncryptionKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payload),
  );

  return Buffer.from(signature).toString("hex");
}

async function createGithubOauthCallbackRedirectUriSignature(args: {
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly composeId: string | null;
  readonly callbackRedirectUri: string;
  readonly secretsEncryptionKey: string;
}): Promise<string> {
  const payload = [
    "github-oauth-callback-redirect-uri-v2",
    args.userId ?? "",
    args.orgId ?? "",
    args.composeId ?? "",
    args.callbackRedirectUri,
  ].join(":");
  return await createGithubOauthStateHmac(payload, args.secretsEncryptionKey);
}

async function createGithubOauthRequestedScopesSignature(args: {
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly composeId: string | null;
  readonly oauthRequestedScopes: readonly string[];
  readonly secretsEncryptionKey: string;
}): Promise<string> {
  const payload = [
    "github-oauth-requested-scopes-v2",
    args.userId ?? "",
    args.orgId ?? "",
    args.composeId ?? "",
    JSON.stringify(args.oauthRequestedScopes),
  ].join(":");
  return await createGithubOauthStateHmac(payload, args.secretsEncryptionKey);
}

function signaturesMatch(actual: string | null, expected: string): boolean {
  return (
    actual !== null &&
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

function normalizeGithubUsername(
  githubUsername: string | null | undefined,
): string | null {
  const normalized = githubUsername?.trim().replace(/^@+/, "");
  return normalized || null;
}

function githubConnectSignaturePayload(args: {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly timestamp: number;
  readonly githubUsername?: string | null;
}): string {
  return [
    args.installationId,
    args.githubUserId,
    String(args.timestamp),
    normalizeGithubUsername(args.githubUsername) ?? "",
  ].join(":");
}

function signGithubConnectParams(args: {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly timestamp: number;
  readonly secretsEncryptionKey: string;
  readonly githubUsername?: string | null;
}): string {
  return createHmac("sha256", args.secretsEncryptionKey)
    .update(githubConnectSignaturePayload(args))
    .digest("hex");
}

export function verifyGithubConnectSignature(args: {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly secretsEncryptionKey: string;
  readonly githubUsername?: string | null;
}): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (nowSeconds - args.timestamp > MAX_GITHUB_CONNECT_AGE_SECONDS) {
    return false;
  }

  const expected = signGithubConnectParams(args);
  return signaturesMatch(args.signature, expected);
}

async function buildGithubOauthState(args: {
  readonly userId?: string;
  readonly orgId?: string;
  readonly composeId?: string;
  readonly callbackRedirectUri: string;
  readonly oauthRequestedScopes?: readonly string[];
  readonly secretsEncryptionKey: string;
}): Promise<string> {
  const state: {
    nonce: string;
    userId?: string;
    orgId?: string;
    composeId?: string;
    sig?: string;
    callbackRedirectUri?: string;
    callbackRedirectUriSig?: string;
    oauthRequestedScopes?: readonly string[];
    oauthRequestedScopesSig?: string;
  } = { nonce: randomBytes(32).toString("hex") };
  if (args.userId) {
    state.userId = args.userId;
  }
  if (args.orgId) {
    state.orgId = args.orgId;
  }
  if (args.composeId) {
    state.composeId = args.composeId;
  }
  if (state.userId) {
    state.sig = await createGithubOauthStateSignature({
      userId: state.userId,
      orgId: state.orgId ?? null,
      composeId: state.composeId ?? null,
      secretsEncryptionKey: args.secretsEncryptionKey,
    });
  }
  state.callbackRedirectUri = args.callbackRedirectUri;
  state.callbackRedirectUriSig =
    await createGithubOauthCallbackRedirectUriSignature({
      userId: state.userId ?? null,
      orgId: state.orgId ?? null,
      composeId: state.composeId ?? null,
      callbackRedirectUri: args.callbackRedirectUri,
      secretsEncryptionKey: args.secretsEncryptionKey,
    });
  if (args.oauthRequestedScopes !== undefined) {
    state.oauthRequestedScopes = args.oauthRequestedScopes;
    state.oauthRequestedScopesSig =
      await createGithubOauthRequestedScopesSignature({
        userId: state.userId ?? null,
        orgId: state.orgId ?? null,
        composeId: state.composeId ?? null,
        oauthRequestedScopes: args.oauthRequestedScopes,
        secretsEncryptionKey: args.secretsEncryptionKey,
      });
  }

  return Object.keys(state).length > 0 ? JSON.stringify(state) : "";
}

function githubAppSetupCallbackRedirectUri(origin: string): string {
  return `${origin}/api/github/app/setup/callback`;
}

export const buildGithubAppInstallUrl$ = command(
  async (
    { set },
    args: {
      readonly appSlug: string;
      readonly userId: string;
      readonly orgId: string;
      readonly composeId?: string;
      readonly callbackOrigin: string;
      readonly providerCallbackOrigin: string;
      readonly oauthRequestedScopes?: readonly string[];
      readonly secretsEncryptionKey: string;
      readonly userAuthorization?: {
        readonly clientId: string;
        readonly installationId: string;
      };
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const callbackRedirectUri = githubAppSetupCallbackRedirectUri(
      args.callbackOrigin,
    );
    const state = await buildGithubOauthState({
      userId: args.userId,
      orgId: args.orgId,
      composeId: args.composeId,
      callbackRedirectUri,
      oauthRequestedScopes: args.oauthRequestedScopes,
      secretsEncryptionKey: args.secretsEncryptionKey,
    });
    signal.throwIfAborted();
    const url = new URL(
      args.userAuthorization
        ? "https://github.com/login/oauth/authorize"
        : `${githubAppUrl(args.appSlug)}/installations/new`,
    );
    if (args.userAuthorization) {
      url.searchParams.set("client_id", args.userAuthorization.clientId);
    }
    if (state) {
      url.searchParams.set("state", state);
    }
    url.searchParams.set(
      "redirect_uri",
      githubAppSetupCallbackRedirectUri(args.providerCallbackOrigin),
    );

    await set(
      insertConnectorOAuthState$,
      {
        state,
        connectorSlug: "github",
        authMethod: "github-app-install",
        userId: args.userId,
        orgId: args.orgId,
        agentId: args.composeId,
        redirectUri: callbackRedirectUri,
        oauthContext: args.userAuthorization
          ? JSON.stringify({
              installationId: args.userAuthorization.installationId,
            })
          : null,
        accountMutation: { intent: "add" },
        expiresAt: connectorOAuthStateExpiresAt(),
      },
      signal,
    );
    return url.toString();
  },
);

function normalizeAuthUrlResult(result: string | AuthUrlResult): AuthUrlResult {
  return typeof result === "string" ? { url: result } : result;
}

function parseGithubOauthRequestedScopesState(args: {
  readonly scopes: unknown;
  readonly signature: unknown;
}): ParsedGithubOauthRequestedScopesState {
  if (args.scopes === undefined && args.signature === undefined) {
    return { ok: true, scopes: null, signature: null };
  }
  if (typeof args.signature !== "string") {
    return { ok: false };
  }
  const scopes = array(string()).safeParse(args.scopes);
  return scopes.success
    ? { ok: true, scopes: scopes.data, signature: args.signature }
    : { ok: false };
}

function parseGithubOauthCallbackRedirectUriState(args: {
  readonly redirectUri: unknown;
  readonly signature: unknown;
}): ParsedGithubOauthCallbackRedirectUriState {
  if (
    typeof args.redirectUri !== "string" ||
    typeof args.signature !== "string"
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    redirectUri: args.redirectUri,
    signature: args.signature,
  };
}

export const startGithubUserOAuth$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly origin: string;
      readonly authMethodId: ConnectorAuthMethodId;
      readonly method: ConnectorAuthMethodRuntimeConfig;
      readonly readEnv: ConnectorEnvReader;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    if (args.method.grant.kind !== "auth-code" || !args.method.client) {
      return null;
    }
    const authClient = resolveConnectorAuthClient(
      args.method.client,
      args.readEnv,
    );
    if (!authClient || !isStaticConfidentialConnectorAuthClient(authClient)) {
      return null;
    }

    const state = generateConnectorOAuthState();
    const redirectUri = `${args.origin}/api/connectors/github/callback`;
    const authResult = normalizeAuthUrlResult(
      await buildConnectorAuthCodeAuthorizationUrlWithMethod({
        connectorSlug: "github",
        authMethodId: args.authMethodId,
        method: args.method,
        authClient,
        redirectUri,
        state,
      }),
    );

    await db.insert(connectorOauthStates).values({
      state,
      connectorSlug: "github",
      authMethod: args.authMethodId,
      userId: args.userId,
      orgId: args.orgId,
      redirectUri,
      oauthRequestedScopes: JSON.stringify(
        connectorGrantScopes(args.method.grant),
      ),
      codeVerifier: authResult.codeVerifier,
      oauthContext: authResult.oauthContext,
      accountMutation: { intent: "add" },
      expiresAt: connectorOAuthStateExpiresAt(),
    });
    signal.throwIfAborted();

    return authResult.url;
  },
);

export function parseGithubOauthState(
  state: string | undefined,
): GithubOAuthState | null {
  if (!state) {
    return {
      userId: null,
      orgId: null,
      composeId: null,
      sig: null,
      callbackRedirectUri: null,
      callbackRedirectUriSig: null,
      oauthRequestedScopes: null,
      oauthRequestedScopesSig: null,
    };
  }

  const parsed = safeJsonParse(state);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const stateObject = parsed as {
    readonly userId?: unknown;
    readonly orgId?: unknown;
    readonly composeId?: unknown;
    readonly sig?: unknown;
    readonly callbackRedirectUri?: unknown;
    readonly callbackRedirectUriSig?: unknown;
    readonly oauthRequestedScopes?: unknown;
    readonly oauthRequestedScopesSig?: unknown;
  };

  const callbackRedirectUri = parseGithubOauthCallbackRedirectUriState({
    redirectUri: stateObject.callbackRedirectUri,
    signature: stateObject.callbackRedirectUriSig,
  });
  if (!callbackRedirectUri.ok) {
    return null;
  }

  const oauthRequestedScopes = parseGithubOauthRequestedScopesState({
    scopes: stateObject.oauthRequestedScopes,
    signature: stateObject.oauthRequestedScopesSig,
  });
  if (!oauthRequestedScopes.ok) {
    return null;
  }

  return {
    userId: typeof stateObject.userId === "string" ? stateObject.userId : null,
    orgId: typeof stateObject.orgId === "string" ? stateObject.orgId : null,
    composeId:
      typeof stateObject.composeId === "string" ? stateObject.composeId : null,
    sig: typeof stateObject.sig === "string" ? stateObject.sig : null,
    callbackRedirectUri: callbackRedirectUri.redirectUri,
    callbackRedirectUriSig: callbackRedirectUri.signature,
    oauthRequestedScopes: oauthRequestedScopes.scopes,
    oauthRequestedScopesSig: oauthRequestedScopes.signature,
  };
}

export async function isGithubOauthStateSignatureValid(args: {
  readonly state: GithubOAuthState;
  readonly secretsEncryptionKey: string;
}): Promise<boolean> {
  let identitySignatureValid = args.state.userId === null;
  if (args.state.userId) {
    const expectedSig = await createGithubOauthStateSignature({
      userId: args.state.userId,
      orgId: args.state.orgId,
      composeId: args.state.composeId,
      secretsEncryptionKey: args.secretsEncryptionKey,
    });
    identitySignatureValid = signaturesMatch(args.state.sig, expectedSig);
  }
  if (!identitySignatureValid) {
    return false;
  }

  if (args.state.callbackRedirectUri === null) {
    if (args.state.callbackRedirectUriSig !== null) {
      return false;
    }
  } else {
    const expectedCallbackRedirectUriSig =
      await createGithubOauthCallbackRedirectUriSignature({
        userId: args.state.userId,
        orgId: args.state.orgId,
        composeId: args.state.composeId,
        callbackRedirectUri: args.state.callbackRedirectUri,
        secretsEncryptionKey: args.secretsEncryptionKey,
      });
    if (
      !signaturesMatch(
        args.state.callbackRedirectUriSig,
        expectedCallbackRedirectUriSig,
      )
    ) {
      return false;
    }
  }

  if (args.state.oauthRequestedScopes === null) {
    return args.state.oauthRequestedScopesSig === null;
  }
  const expectedOauthRequestedScopesSig =
    await createGithubOauthRequestedScopesSignature({
      userId: args.state.userId,
      orgId: args.state.orgId,
      composeId: args.state.composeId,
      oauthRequestedScopes: args.state.oauthRequestedScopes,
      secretsEncryptionKey: args.secretsEncryptionKey,
    });
  return signaturesMatch(
    args.state.oauthRequestedScopesSig,
    expectedOauthRequestedScopesSig,
  );
}

export const linkGithubUser$ = command(
  async (
    { set },
    args: {
      readonly installRecordId: string;
      readonly userId: string;
      readonly knownGithubUserId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    let githubUserId = args.knownGithubUserId ?? null;

    if (!githubUserId) {
      const [connector] = await db
        .select({ externalId: connectors.externalId })
        .from(connectors)
        .innerJoin(
          githubInstallations,
          and(
            eq(githubInstallations.id, args.installRecordId),
            eq(githubInstallations.orgId, connectors.orgId),
          ),
        )
        .where(
          and(
            eq(connectors.userId, args.userId),
            eq(connectors.connectorSlug, "github"),
            eq(connectors.isDefault, true),
          ),
        )
        .limit(1);
      signal.throwIfAborted();

      githubUserId = connector?.externalId ?? null;
    }

    if (!githubUserId) {
      return null;
    }

    await db
      .delete(githubUserLinks)
      .where(
        and(
          eq(githubUserLinks.installationId, args.installRecordId),
          eq(githubUserLinks.userId, args.userId),
        ),
      );
    signal.throwIfAborted();

    const [link] = await db
      .insert(githubUserLinks)
      .values({
        githubUserId,
        installationId: args.installRecordId,
        userId: args.userId,
      })
      .onConflictDoNothing()
      .returning({ githubUserId: githubUserLinks.githubUserId });
    signal.throwIfAborted();

    return link?.githubUserId ?? null;
  },
);

export const loadActiveGithubInstallationForOrg$ = command(
  async (
    { get },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<{ readonly id: string } | null> => {
    const db = get(db$);
    const [installation] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, args.orgId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    return installation ?? null;
  },
);

export const tryLinkGithubFromLocalRecord$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [existing] = await db
      .select({
        id: githubInstallations.id,
        adminGithubUserId: githubInstallations.adminGithubUserId,
      })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, args.orgId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!existing) {
      return false;
    }

    const githubUserId = await set(
      linkGithubUser$,
      {
        installRecordId: existing.id,
        userId: args.userId,
      },
      signal,
    );

    if (!githubUserId) {
      return false;
    }

    if (!existing.adminGithubUserId) {
      await db
        .update(githubInstallations)
        .set({ adminGithubUserId: githubUserId })
        .where(eq(githubInstallations.id, existing.id));
      signal.throwIfAborted();
    }

    return true;
  },
);

export const loadComposeFeatureSwitchContext$ = command(
  async (
    { get },
    args: {
      readonly composeId: string;
      readonly userId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<FeatureSwitchContext> => {
    const db = get(db$);
    const [compose] = await db
      .select({ orgId: agents.orgId, userId: agents.owner })
      .from(agents)
      .where(eq(agents.id, args.composeId))
      .limit(1);
    signal.throwIfAborted();

    if (!compose) {
      throw new Error(`Agent compose not found: composeId=${args.composeId}`);
    }

    const featureSwitchContextRows0 = await db
      .select({
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      })
      .from(userFeatureSwitches)
      .where(
        userFeatureSwitchRowCondition(
          compose.orgId,
          args.userId ?? compose.userId,
        ),
      );
    signal.throwIfAborted();
    return featureSwitchContextFromRows(
      compose.orgId,
      args.userId ?? compose.userId,
      featureSwitchContextRows0,
    );
  },
);

export const resolveGithubOauthOrgId$ = command(
  async (
    { get },
    args: {
      readonly orgId: string | null;
      readonly composeId: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    if (args.orgId) {
      return args.orgId;
    }

    const db = get(db$);
    const [compose] = await db
      .select({ orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, args.composeId))
      .limit(1);
    signal.throwIfAborted();

    if (!compose) {
      throw new Error(`Agent compose not found: composeId=${args.composeId}`);
    }

    return compose.orgId;
  },
);

export const findGithubInstallationByInstallationId$ = command(
  async (
    { get },
    args: {
      readonly installationId: string;
      readonly orgId: string | null;
    },
    signal: AbortSignal,
  ): Promise<{ readonly id: string } | null> => {
    const db = get(db$);
    const filters = [
      eq(githubInstallations.installationId, args.installationId),
    ];
    if (args.orgId) {
      filters.push(eq(githubInstallations.orgId, args.orgId));
    }

    const [existing] = await db
      .select({
        id: githubInstallations.id,
      })
      .from(githubInstallations)
      .where(and(...filters))
      .limit(1);
    signal.throwIfAborted();

    return existing ?? null;
  },
);

export const createOrActivateGithubInstallation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly installationId: string;
      readonly installInfo: GitHubInstallationInfo;
      readonly encryptedAccessToken: string;
      readonly adminGithubUserId: string | null;
      readonly composeId: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const [pendingRecord] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, args.orgId),
          eq(githubInstallations.targetId, args.installInfo.targetId),
          eq(githubInstallations.status, "pending"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (pendingRecord) {
      await db
        .update(githubInstallations)
        .set({
          status: "active",
          installationId: args.installationId,
          appId: args.installInfo.appId,
          appSlug: args.installInfo.appSlug,
          encryptedAccessToken: args.encryptedAccessToken,
          targetType: args.installInfo.targetType,
          targetName: args.installInfo.targetName,
          adminGithubUserId: args.adminGithubUserId,
          updatedAt: new Date(now()),
        })
        .where(eq(githubInstallations.id, pendingRecord.id));
      signal.throwIfAborted();

      return pendingRecord.id;
    }

    const [newInstall] = await db
      .insert(githubInstallations)
      .values({
        installationId: args.installationId,
        appId: args.installInfo.appId,
        appSlug: args.installInfo.appSlug,
        encryptedAccessToken: args.encryptedAccessToken,
        status: "active",
        orgId: args.orgId,
        targetType: args.installInfo.targetType,
        targetId: args.installInfo.targetId,
        targetName: args.installInfo.targetName,
        adminGithubUserId: args.adminGithubUserId,
      })
      .returning({ id: githubInstallations.id });
    signal.throwIfAborted();

    if (!newInstall) {
      throw new Error("Expected GitHub installation insert to return a row");
    }

    return newInstall.id;
  },
);
