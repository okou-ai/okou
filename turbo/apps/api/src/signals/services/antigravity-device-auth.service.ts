import { createHash, randomBytes } from "node:crypto";

import type { AntigravityDeviceAuthMode } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import {
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { safeJsonParse, safeSync, settle, tapError } from "../utils";
import {
  decryptPersistentSecretValue,
  decryptSecretValue,
  encryptPersistentSecretValue,
  encryptSecretValue,
} from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import {
  upsertPersonalModelProviderAccount$,
  type PersonalProviderAccountErrorResponse,
  type PersonalProviderAccountMutation,
} from "./model-provider-account.service";

// Google OAuth for the official Antigravity desktop client, as used by
// NoeFabris/opencode-antigravity-auth. Internal staff pilot only.
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
// The client's registered loopback redirect. Nothing listens there: the
// member copies the address Google redirects to and pastes it back.
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");
const SESSION_TTL_SECONDS = 15 * 60;
const CONNECTOR_TYPE = "antigravity";
const SOURCE = "antigravity-device-auth";
const ACTIVE_STATUSES = [
  "initializing",
  "awaiting_user_approval",
  "completing",
] as const;

const sessionTokenSchema = object({
  version: literal(1),
  sessionId: uuid(),
});

const providerStateSchema = object({
  version: literal(1),
  mode: zEnum(["add", "reconnect"]).optional(),
  modelProviderId: uuid().optional(),
  state: string().min(1),
  codeVerifier: string().min(1),
});

const tokenResponseSchema = object({
  access_token: string().min(1),
  refresh_token: string().min(1).optional(),
  expires_in: number().optional(),
});

const userInfoSchema = object({
  id: string().min(1),
  email: string().min(1),
});

type ProviderState = zInfer<typeof providerStateSchema>;
type Session = typeof modelProviderAuthSessions.$inferSelect;
type Owner = { readonly orgId: string; readonly userId: string };

type StartResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly browserUrl: string;
      readonly expiresIn: number;
    }
  | { readonly ok: false; readonly message: string };

type CompleteResult =
  | {
      readonly status: "complete";
      readonly body: {
        readonly provider: ModelProviderResponse;
        readonly created: boolean;
      };
    }
  | { readonly status: "invalid_token"; readonly message: string }
  | { readonly status: "forbidden"; readonly message: string }
  | {
      readonly status: "auth_error";
      readonly response: PersonalProviderAccountErrorResponse;
    }
  | { readonly status: "error"; readonly message: string };

type CancelResult =
  | { readonly status: "cancelled" }
  | { readonly status: "invalid_token"; readonly message: string }
  | { readonly status: "forbidden"; readonly message: string };

/** Both values come from deployment config; neither is committed. */
function oauthClient() {
  const clientId = optionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function randomBase64Url(): string {
  return randomBytes(32).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 500) : fallback;
}

function ownerWhere(owner: Owner) {
  return and(
    eq(modelProviderAuthSessions.orgId, owner.orgId),
    eq(modelProviderAuthSessions.userId, owner.userId),
    eq(modelProviderAuthSessions.connectorType, CONNECTOR_TYPE),
    eq(modelProviderAuthSessions.source, SOURCE),
  );
}

function activeSessionWhere(sessionId: string, owner: Owner) {
  return and(
    eq(modelProviderAuthSessions.id, sessionId),
    ownerWhere(owner),
    inArray(modelProviderAuthSessions.status, [...ACTIVE_STATUSES]),
  );
}

function terminalSet(
  status: "cancelled" | "error" | "expired",
  message: string | null,
) {
  const now = nowDate();
  return {
    status,
    approvalUrl: null,
    encryptedProviderState: null,
    errorMessage: message?.slice(0, 500) ?? null,
    cancelledAt: status === "cancelled" ? now : null,
    updatedAt: now,
  };
}

const endSession$ = command(
  async (
    { set },
    args: Owner & {
      readonly sessionId: string;
      readonly status: "cancelled" | "error" | "expired";
      readonly message: string | null;
    },
  ) => {
    await set(writeDb$)
      .update(modelProviderAuthSessions)
      .set(terminalSet(args.status, args.message))
      .where(activeSessionWhere(args.sessionId, args));
  },
);

function authorizationUrl(args: {
  readonly clientId: string;
  readonly state: string;
  readonly codeVerifier: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", codeChallenge(args.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export const startAntigravityDeviceAuth$ = command(
  async (
    { set },
    args: Owner & {
      readonly mode?: AntigravityDeviceAuthMode;
      readonly modelProviderId?: string;
    },
    signal: AbortSignal,
  ): Promise<StartResult> => {
    const client = oauthClient();
    if (!client) {
      return { ok: false, message: "Google AI sign-in is not configured" };
    }
    const codeVerifier = randomBase64Url();
    const state = randomBase64Url();
    const browserUrl = authorizationUrl({
      clientId: client.clientId,
      state,
      codeVerifier,
    });
    const providerState: ProviderState = {
      version: 1,
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.modelProviderId
        ? { modelProviderId: args.modelProviderId }
        : {}),
      state,
      codeVerifier,
    };
    const encryptedProviderState = await encryptPersistentSecretValue(
      JSON.stringify(providerState),
      { orgId: args.orgId, userId: args.userId },
    );
    signal.throwIfAborted();
    const now = nowDate();
    const writeDb = set(writeDb$);
    // A new sign-in supersedes any unfinished one for this member.
    await writeDb
      .update(modelProviderAuthSessions)
      .set(terminalSet("cancelled", "Superseded by a new sign-in"))
      .where(
        and(
          ownerWhere(args),
          inArray(modelProviderAuthSessions.status, [...ACTIVE_STATUSES]),
        ),
      );
    signal.throwIfAborted();
    const [session] = await writeDb
      .insert(modelProviderAuthSessions)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        connectorType: CONNECTOR_TYPE,
        source: SOURCE,
        status: "awaiting_user_approval",
        approvalUrl: browserUrl,
        encryptedProviderState,
        expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
      })
      .returning({ id: modelProviderAuthSessions.id });
    signal.throwIfAborted();
    if (!session) {
      throw new Error("Failed to create Google AI sign-in session");
    }
    return {
      ok: true,
      sessionToken: encryptSecretValue(
        JSON.stringify({ version: 1, sessionId: session.id }),
      ),
      browserUrl,
      expiresIn: SESSION_TTL_SECONDS,
    };
  },
);

function decodeSessionId(token: string): string | null {
  const decoded = safeSync(() => {
    return sessionTokenSchema.safeParse(
      safeJsonParse(decryptSecretValue(token)),
    );
  });
  return "error" in decoded || !decoded.ok.success
    ? null
    : decoded.ok.data.sessionId;
}

async function decodeProviderState(
  session: Session,
): Promise<ProviderState | null> {
  if (!session.encryptedProviderState) {
    return null;
  }
  const decrypted = await tapError(
    decryptPersistentSecretValue(session.encryptedProviderState, {
      orgId: session.orgId,
      userId: session.userId,
    }),
  );
  const parsed = providerStateSchema.safeParse(
    decrypted ? safeJsonParse(decrypted) : undefined,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Accept the full redirect address Google navigated to, or its bare `code`.
 * A pasted address must carry this session's `state`.
 */
function authorizationCodeFromInput(
  raw: string,
  expectedState: string,
): string {
  const input = raw.trim();
  const url = URL.canParse(input) ? new URL(input) : null;
  if (!url) {
    if (/^[\w./~%-]+$/u.test(input)) {
      return decodeURIComponent(input);
    }
    throw new Error("Paste the full address from your browser to continue");
  }
  const denied = url.searchParams.get("error");
  if (denied) {
    throw new Error(`Google sign-in was not approved: ${denied}`);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("The pasted address has no authorization code");
  }
  if (url.searchParams.get("state") !== expectedState) {
    throw new Error("The pasted address belongs to another sign-in");
  }
  return code;
}

async function exchangeAuthorizationCode(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string;
  },
  signal: AbortSignal,
) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: args.codeVerifier,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300);
    throw new Error(
      `Google token exchange failed with status ${response.status}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  const tokens = tokenResponseSchema.safeParse(await response.json());
  if (!tokens.success) {
    throw new Error("Google returned an unrecognized token response");
  }
  if (!tokens.data.refresh_token) {
    throw new Error("Google did not grant offline access. Sign in again.");
  }
  return {
    accessToken: tokens.data.access_token,
    refreshToken: tokens.data.refresh_token,
  };
}

async function fetchGoogleIdentity(accessToken: string, signal: AbortSignal) {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Google account lookup failed with status ${response.status}`,
    );
  }
  const identity = userInfoSchema.safeParse(await response.json());
  if (!identity.success) {
    throw new Error("Google returned an unrecognized account profile");
  }
  return identity.data;
}

function accountMutation(
  state: ProviderState,
): PersonalProviderAccountMutation {
  if (state.mode === "reconnect" && state.modelProviderId) {
    return { kind: "reconnect", accountId: state.modelProviderId };
  }
  return state.mode === "add" ? { kind: "add" } : { kind: "replace-active" };
}

const failSession$ = command(
  async (
    { set },
    args: Owner & { readonly sessionId: string; readonly message: string },
    signal: AbortSignal,
  ) => {
    await set(endSession$, { ...args, status: "error" });
    signal.throwIfAborted();
  },
);

const importClaimedSession$ = command(
  async (
    { get, set },
    args: Owner & {
      readonly session: Session;
      readonly providerState: ProviderState;
      readonly code: string;
    },
    signal: AbortSignal,
  ): Promise<CompleteResult> => {
    const fail = async (error: unknown): Promise<CompleteResult> => {
      const message = errorMessage(error, "Google AI sign-in failed");
      await set(
        failSession$,
        { ...args, sessionId: args.session.id, message },
        signal,
      );
      return { status: "error", message };
    };
    const client = oauthClient();
    if (!client) {
      return await fail(new Error("Google AI sign-in is not configured"));
    }
    const tokens = await settle(
      exchangeAuthorizationCode(
        {
          ...client,
          code: args.code,
          codeVerifier: args.providerState.codeVerifier,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!tokens.ok) {
      return await fail(tokens.error);
    }
    const identity = await settle(
      fetchGoogleIdentity(tokens.value.accessToken, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!identity.ok) {
      return await fail(identity.error);
    }
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const imported = await settle(
      set(
        upsertPersonalModelProviderAccount$,
        {
          orgId: args.orgId,
          userId: args.userId,
          authSession: {
            id: args.session.id,
            userId: args.userId,
            source: SOURCE,
          },
          type: CONNECTOR_TYPE,
          authMethod: null,
          secretValues: {
            ANTIGRAVITY_REFRESH_TOKEN: tokens.value.refreshToken,
          },
          metadata: {
            externalAccountId: identity.value.id,
            accountEmail: identity.value.email,
          },
          mode: accountMutation(args.providerState),
          featureSwitchContext,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!imported.ok) {
      return await fail(imported.error);
    }
    if ("status" in imported.value) {
      await set(
        failSession$,
        {
          ...args,
          sessionId: args.session.id,
          message: imported.value.body.error.message,
        },
        signal,
      );
      return { status: "auth_error", response: imported.value };
    }
    return { status: "complete", body: imported.value };
  },
);

const loadSession$ = command(
  async ({ set }, owner: Owner, sessionToken: string, signal: AbortSignal) => {
    const sessionId = decodeSessionId(sessionToken);
    if (!sessionId) {
      return null;
    }
    const [session] = await set(writeDb$)
      .select()
      .from(modelProviderAuthSessions)
      .where(
        and(eq(modelProviderAuthSessions.id, sessionId), ownerWhere(owner)),
      )
      .limit(1);
    signal.throwIfAborted();
    return session ?? "missing";
  },
);

export const completeAntigravityDeviceAuth$ = command(
  async (
    { set },
    args: Owner & {
      readonly sessionToken: string;
      readonly authorizationCode: string;
    },
    signal: AbortSignal,
  ): Promise<CompleteResult> => {
    const session = await set(loadSession$, args, args.sessionToken, signal);
    if (session === null) {
      return { status: "invalid_token", message: "Invalid sign-in session" };
    }
    if (session === "missing") {
      return { status: "forbidden", message: "Sign-in session not found" };
    }
    if (session.expiresAt.getTime() <= nowDate().getTime()) {
      await set(endSession$, {
        ...args,
        sessionId: session.id,
        status: "expired",
        message: null,
      });
      signal.throwIfAborted();
      return {
        status: "invalid_token",
        message: "Sign-in expired. Start again.",
      };
    }
    if (session.status !== "awaiting_user_approval") {
      return { status: "invalid_token", message: "Sign-in is not pending" };
    }
    const providerState = await decodeProviderState(session);
    signal.throwIfAborted();
    if (!providerState) {
      return { status: "error", message: "Sign-in session state is invalid" };
    }
    const code = safeSync(() => {
      return authorizationCodeFromInput(
        args.authorizationCode,
        providerState.state,
      );
    });
    if ("error" in code) {
      return {
        status: "invalid_token",
        message: errorMessage(code.error, "Invalid authorization code"),
      };
    }
    // Claim the one-time code before exchanging it.
    const [claimed] = await set(writeDb$)
      .update(modelProviderAuthSessions)
      .set({ status: "completing", updatedAt: nowDate() })
      .where(
        and(
          eq(modelProviderAuthSessions.id, session.id),
          eq(modelProviderAuthSessions.status, "awaiting_user_approval"),
        ),
      )
      .returning({ id: modelProviderAuthSessions.id });
    signal.throwIfAborted();
    if (!claimed) {
      return {
        status: "invalid_token",
        message: "Sign-in is already completing",
      };
    }
    return await set(
      importClaimedSession$,
      { ...args, session, providerState, code: code.ok },
      signal,
    );
  },
);

export const cancelAntigravityDeviceAuth$ = command(
  async (
    { set },
    args: Owner & { readonly sessionToken: string },
    signal: AbortSignal,
  ): Promise<CancelResult> => {
    const session = await set(loadSession$, args, args.sessionToken, signal);
    if (session === null) {
      return { status: "invalid_token", message: "Invalid sign-in session" };
    }
    if (session === "missing") {
      return { status: "forbidden", message: "Sign-in session not found" };
    }
    await set(endSession$, {
      ...args,
      sessionId: session.id,
      status: "cancelled",
      message: "Sign-in was cancelled",
    });
    signal.throwIfAborted();
    return { status: "cancelled" };
  },
);

export function antigravityDeviceAuthUnavailable(message: string) {
  return {
    status: 503 as const,
    body: {
      error: { message, code: "ANTIGRAVITY_DEVICE_AUTH_UNAVAILABLE" },
    },
  };
}
