import { createHash, randomBytes } from "node:crypto";
import type { DeviceAuthSessionPublication } from "./model-provider-device-session-publication";

import type {
  ClaudeCodeDeviceAuthMode,
  ClaudeCodeDeviceAuthScope,
} from "@okouai/api-contracts/contracts/claude-code-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  detach,
  Mechanism,
  safeJsonParse,
  safeSync,
  settle,
  tapError,
} from "../utils";
import { fetchClaudeCodeSubscriptionMetadata } from "./claude-code-usage.service";
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

const CLAUDE_CODE_DEVICE_AUTH_AUTHORIZE_URL =
  "https://claude.com/cai/oauth/authorize";
const CLAUDE_CODE_DEVICE_AUTH_TOKEN_URL =
  "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CODE_DEVICE_AUTH_REDIRECT_URI =
  "https://platform.claude.com/oauth/code/callback";
const CLAUDE_CODE_DEVICE_AUTH_CLIENT_ID =
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_DEVICE_AUTH_SCOPE = "user:profile user:inference";
const CLAUDE_CODE_DEVICE_AUTH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
const CLAUDE_CODE_DEVICE_AUTH_SESSION_TTL_SECONDS = 15 * 60;
const CLAUDE_CODE_DEVICE_AUTH_CONNECTOR_TYPE = "claude-code-oauth-token";
const CLAUDE_CODE_DEVICE_AUTH_SOURCE = "claude-code-device-auth";

const claudeCodeDeviceAuthSessionTokenSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
});

const claudeCodeDeviceAuthProviderStateSchema = z.object({
  version: z.literal(1),
  type: z.literal("claude-code"),
  scope: z.literal("personal"),
  mode: z.enum(["add", "reconnect"]).optional(),
  modelProviderId: z.string().uuid().optional(),
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
});

const claudeCodeOAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
});

type ClaudeCodeDeviceAuthSessionToken = z.infer<
  typeof claudeCodeDeviceAuthSessionTokenSchema
>;
type ClaudeCodeDeviceAuthProviderState = z.infer<
  typeof claudeCodeDeviceAuthProviderStateSchema
>;
type ModelProviderAuthSession = typeof modelProviderAuthSessions.$inferSelect;
type ModelProviderAuthSessionStatus = ModelProviderAuthSession["status"];
const CLAUDE_CODE_DEVICE_AUTH_ACTIVE_STATUSES = [
  "initializing",
  "awaiting_user_approval",
  "completing",
] as const satisfies readonly ModelProviderAuthSessionStatus[];

type ClaudeCodeDeviceAuthFailureCode =
  | "CLAUDE_CODE_DEVICE_AUTH_UNAVAILABLE"
  | "CLAUDE_CODE_DEVICE_AUTH_FAILED"
  | "CLAUDE_CODE_DEVICE_AUTH_EXPIRED";

type ClaudeCodeDeviceAuthStartResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly scope: ClaudeCodeDeviceAuthScope;
      readonly browserUrl: string;
      readonly expiresIn: number;
    }
  | {
      readonly ok: false;
      readonly code: ClaudeCodeDeviceAuthFailureCode;
      readonly message: string;
    };

type ClaudeCodeDeviceAuthCompleteResult =
  | {
      readonly status: "complete";
      readonly body: {
        readonly provider: ModelProviderResponse;
        readonly created: boolean;
      };
    }
  | {
      readonly status: "invalid_token";
      readonly message: string;
    }
  | {
      readonly status: "forbidden";
      readonly message: string;
    }
  | {
      readonly status: "auth_error";
      readonly response: PersonalProviderAccountErrorResponse;
    }
  | {
      readonly status: "error";
      readonly code: ClaudeCodeDeviceAuthFailureCode;
      readonly message: string;
    };

type ClaudeCodeDeviceAuthCancelResult =
  | { readonly status: "cancelled" }
  | { readonly status: "invalid_token"; readonly message: string }
  | { readonly status: "forbidden"; readonly message: string };

type ClaudeCodeOAuthTokens = {
  readonly accessToken: string;
};

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomBase64Url(): string {
  return base64Url(randomBytes(32));
}

function codeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function encodeSession(payload: ClaudeCodeDeviceAuthSessionToken): string {
  return encryptSecretValue(JSON.stringify(payload));
}

async function encodeProviderState(
  payload: ClaudeCodeDeviceAuthProviderState,
  session: ModelProviderAuthSession,
): Promise<string> {
  return await encryptPersistentSecretValue(JSON.stringify(payload), {
    orgId: session.orgId,
    userId: session.userId,
  });
}

function decodeSession(token: string): ClaudeCodeDeviceAuthSessionToken | null {
  const decoded = safeSync(() => {
    const parsed = claudeCodeDeviceAuthSessionTokenSchema.safeParse(
      safeJsonParse(decryptSecretValue(token)),
    );
    return parsed.success ? parsed.data : null;
  });
  if ("error" in decoded) {
    return null;
  }
  return decoded.ok;
}

async function decodeProviderState(
  encryptedProviderState: string | null,
  session: ModelProviderAuthSession,
): Promise<ClaudeCodeDeviceAuthProviderState | null> {
  if (!encryptedProviderState) {
    return null;
  }
  const decrypted = await tapError(
    decryptPersistentSecretValue(encryptedProviderState, {
      orgId: session.orgId,
      userId: session.userId,
    }),
  );
  if (!decrypted) {
    return null;
  }
  const decoded = safeSync(() => {
    const parsed = claudeCodeDeviceAuthProviderStateSchema.safeParse(
      safeJsonParse(decrypted),
    );
    return parsed.success ? parsed.data : null;
  });
  if ("error" in decoded) {
    return null;
  }
  return decoded.ok;
}

function expiresAt(now: Date): Date {
  return new Date(
    now.getTime() + CLAUDE_CODE_DEVICE_AUTH_SESSION_TTL_SECONDS * 1000,
  );
}

function remainingTtlSeconds(expiresAtValue: Date, now: Date): number {
  return Math.max(
    1,
    Math.ceil((expiresAtValue.getTime() - now.getTime()) / 1000),
  );
}

function sanitizeSessionError(message: string): string {
  return message.slice(0, 500);
}

function unknownErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function terminalSessionSet(args: {
  readonly status: Extract<
    ModelProviderAuthSessionStatus,
    "cancelled" | "error" | "expired" | "imported"
  >;
  readonly now: Date;
  readonly message?: string | null;
}) {
  return {
    status: args.status,
    approvalUrl: null,
    verificationCode: null,
    encryptedProviderState: null,
    errorMessage: args.message ? sanitizeSessionError(args.message) : null,
    completedAt: args.status === "imported" ? args.now : null,
    cancelledAt: args.status === "cancelled" ? args.now : null,
    updatedAt: args.now,
  };
}

function ownerWhere(args: { readonly orgId: string; readonly userId: string }) {
  return and(
    eq(modelProviderAuthSessions.orgId, args.orgId),
    eq(modelProviderAuthSessions.userId, args.userId),
    eq(
      modelProviderAuthSessions.connectorType,
      CLAUDE_CODE_DEVICE_AUTH_CONNECTOR_TYPE,
    ),
    eq(modelProviderAuthSessions.source, CLAUDE_CODE_DEVICE_AUTH_SOURCE),
  );
}

function sessionWhere(args: {
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(modelProviderAuthSessions.id, args.sessionId),
    ownerWhere(args),
  );
}

const cancelActiveSessions$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly now: Date;
    },
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(modelProviderAuthSessions)
      .set(
        terminalSessionSet({
          status: "cancelled",
          now: args.now,
          message: "Claude Code device auth session was superseded",
        }),
      )
      .where(
        and(
          ownerWhere(args),
          inArray(modelProviderAuthSessions.status, [
            ...CLAUDE_CODE_DEVICE_AUTH_ACTIVE_STATUSES,
          ]),
        ),
      );
  },
);

const cancelSession$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly message: string;
    },
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(modelProviderAuthSessions)
      .set(
        terminalSessionSet({
          status: "cancelled",
          now: nowDate(),
          message: args.message,
        }),
      )
      .where(
        and(
          sessionWhere({
            sessionId: args.sessionId,
            orgId: args.orgId,
            userId: args.userId,
          }),
          inArray(modelProviderAuthSessions.status, [
            ...CLAUDE_CODE_DEVICE_AUTH_ACTIVE_STATUSES,
          ]),
        ),
      );
  },
);

const createSession$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly expiresAt: Date;
    },
  ): Promise<ModelProviderAuthSession> => {
    const writeDb = set(writeDb$);
    const [session] = await writeDb
      .insert(modelProviderAuthSessions)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        connectorType: CLAUDE_CODE_DEVICE_AUTH_CONNECTOR_TYPE,
        source: CLAUDE_CODE_DEVICE_AUTH_SOURCE,
        status: "initializing",
        expiresAt: args.expiresAt,
      })
      .returning();
    if (!session) {
      throw new Error("Failed to create Claude Code device auth session");
    }
    return session;
  },
);

const markSessionError$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly message: string;
    },
  ) => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(modelProviderAuthSessions)
      .set(
        terminalSessionSet({
          status: "error",
          now: nowDate(),
          message: args.message,
        }),
      )
      .where(
        and(
          eq(modelProviderAuthSessions.id, args.sessionId),
          inArray(modelProviderAuthSessions.status, [
            ...CLAUDE_CODE_DEVICE_AUTH_ACTIVE_STATUSES,
          ]),
        ),
      );
  },
);

const markSessionExpired$ = command(
  async (
    { set },
    args: {
      readonly session: ModelProviderAuthSession;
    },
  ) => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(modelProviderAuthSessions)
      .set(
        terminalSessionSet({
          status: "expired",
          now: nowDate(),
        }),
      )
      .where(
        and(
          eq(modelProviderAuthSessions.id, args.session.id),
          inArray(modelProviderAuthSessions.status, [
            ...CLAUDE_CODE_DEVICE_AUTH_ACTIVE_STATUSES,
          ]),
        ),
      );
  },
);

const moveSessionToAwaitingApproval$ = command(
  async (
    { set },
    args: {
      readonly session: ModelProviderAuthSession;
      readonly scope: ClaudeCodeDeviceAuthScope;
      readonly mode?: ClaudeCodeDeviceAuthMode;
      readonly modelProviderId?: string;
      readonly state: string;
      readonly codeVerifier: string;
      readonly approvalUrl: string;
    },
  ): Promise<ModelProviderAuthSession> => {
    const encryptedProviderState = await encodeProviderState(
      {
        version: 1,
        type: "claude-code",
        scope: args.scope,
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.modelProviderId
          ? { modelProviderId: args.modelProviderId }
          : {}),
        state: args.state,
        codeVerifier: args.codeVerifier,
      },
      args.session,
    );
    const writeDb = set(writeDb$);
    const [updated] = await writeDb
      .update(modelProviderAuthSessions)
      .set({
        status: "awaiting_user_approval",
        approvalUrl: args.approvalUrl,
        verificationCode: null,
        encryptedProviderState,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(modelProviderAuthSessions.id, args.session.id),
          eq(modelProviderAuthSessions.status, "initializing"),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error("Failed to update Claude Code device auth session");
    }
    return updated;
  },
);

function buildApprovalUrl(args: {
  readonly state: string;
  readonly codeVerifier: string;
}): string {
  const url = new URL(CLAUDE_CODE_DEVICE_AUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_CODE_DEVICE_AUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_CODE_DEVICE_AUTH_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_CODE_DEVICE_AUTH_SCOPE);
  url.searchParams.set("code_challenge", codeChallenge(args.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  return url.toString();
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = safeJsonParse(text);
  if (parsed === undefined) {
    throw new Error("Claude Code OAuth returned invalid JSON");
  }
  return parsed;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text();
  const trimmed = text.trim();
  return trimmed
    ? `${fallback}: ${trimmed.slice(0, 500)}`
    : `${fallback} with status ${response.status}`;
}

function parseAuthorizationCodeInput(args: {
  readonly raw: string;
  readonly expectedState: string;
}): string {
  const trimmed = args.raw.trim();
  if (!trimmed) {
    throw new Error("Paste the Claude Code authorization code to continue");
  }

  const fromUrl = safeSync(() => {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    };
  });
  if (!("error" in fromUrl) && fromUrl.ok.code) {
    assertStateMatches(fromUrl.ok.state, args.expectedState);
    return fromUrl.ok.code;
  }

  const [code, state] = trimmed.split("#", 2);
  if (!code) {
    throw new Error("Claude Code authorization code is missing");
  }
  assertStateMatches(state ?? null, args.expectedState);
  return code;
}

function assertStateMatches(
  providedState: string | null,
  expectedState: string,
): void {
  if (providedState && providedState !== expectedState) {
    throw new Error(
      "Claude Code authorization code belongs to another session",
    );
  }
}

async function exchangeClaudeCodeAuthorizationCode(
  args: {
    readonly authorizationCode: string;
    readonly state: string;
    readonly codeVerifier: string;
  },
  signal: AbortSignal,
): Promise<ClaudeCodeOAuthTokens> {
  const response = await fetch(CLAUDE_CODE_DEVICE_AUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: args.authorizationCode,
      redirect_uri: CLAUDE_CODE_DEVICE_AUTH_REDIRECT_URI,
      client_id: CLAUDE_CODE_DEVICE_AUTH_CLIENT_ID,
      code_verifier: args.codeVerifier,
      state: args.state,
      expires_in: CLAUDE_CODE_DEVICE_AUTH_TOKEN_TTL_SECONDS,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Claude Code token exchange failed"),
    );
  }

  const parsed = claudeCodeOAuthTokenResponseSchema.safeParse(
    await readJsonResponse(response),
  );
  if (!parsed.success) {
    throw new Error(
      "Claude Code OAuth returned an unrecognized token response",
    );
  }
  return { accessToken: parsed.data.access_token };
}

export const startClaudeCodeDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly scope: ClaudeCodeDeviceAuthScope;
      readonly mode?: ClaudeCodeDeviceAuthMode;
      readonly modelProviderId?: string;
    },
    signal: AbortSignal,
  ): Promise<ClaudeCodeDeviceAuthStartResult> => {
    const startedAt = nowDate();
    await set(cancelActiveSessions$, {
      orgId: args.orgId,
      userId: args.userId,
      now: startedAt,
    });
    signal.throwIfAborted();

    const session = await set(createSession$, {
      orgId: args.orgId,
      userId: args.userId,
      expiresAt: expiresAt(startedAt),
    });
    if (signal.aborted) {
      await set(cancelSession$, {
        sessionId: session.id,
        orgId: args.orgId,
        userId: args.userId,
        message: "Claude Code device auth session was cancelled",
      });
      signal.throwIfAborted();
    }
    const cancelStartedSession = () => {
      detach(
        set(cancelSession$, {
          sessionId: session.id,
          orgId: args.orgId,
          userId: args.userId,
          message: "Claude Code device auth session was cancelled",
        }),
        Mechanism.WaitUntil,
        "cancel aborted Claude Code device auth session",
      );
    };
    signal.addEventListener("abort", cancelStartedSession, { once: true });
    const unregisterAbortCancellation = () => {
      signal.removeEventListener("abort", cancelStartedSession);
    };

    const codeVerifier = randomBase64Url();
    const state = randomBase64Url();
    const approvalUrl = buildApprovalUrl({ state, codeVerifier });
    const updatedResult = await settle(
      set(moveSessionToAwaitingApproval$, {
        session,
        scope: args.scope,
        mode: args.mode,
        modelProviderId: args.modelProviderId,
        state,
        codeVerifier,
        approvalUrl,
      }),
      signal,
    ).finally(unregisterAbortCancellation);
    signal.throwIfAborted();

    if (!updatedResult.ok) {
      const message = unknownErrorMessage(
        updatedResult.error,
        "Claude Code device auth session failed",
      );
      await set(markSessionError$, {
        sessionId: session.id,
        message,
      });
      signal.throwIfAborted();
      return {
        ok: false,
        code: "CLAUDE_CODE_DEVICE_AUTH_UNAVAILABLE",
        message,
      };
    }

    return {
      ok: true,
      sessionToken: encodeSession({ version: 1, sessionId: session.id }),
      scope: args.scope,
      browserUrl: approvalUrl,
      expiresIn: remainingTtlSeconds(updatedResult.value.expiresAt, nowDate()),
    };
  },
);

const loadSession$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly orgId: string;
      readonly userId: string;
    },
  ): Promise<ModelProviderAuthSession | null> => {
    const writeDb = set(writeDb$);
    const [session] = await writeDb
      .select()
      .from(modelProviderAuthSessions)
      .where(sessionWhere(args))
      .limit(1);
    return session ?? null;
  },
);

const claimCompleting$ = command(
  async (
    { set },
    args: {
      readonly session: ModelProviderAuthSession;
    },
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const [updated] = await writeDb
      .update(modelProviderAuthSessions)
      .set({ status: "completing", updatedAt: nowDate() })
      .where(
        and(
          eq(modelProviderAuthSessions.id, args.session.id),
          eq(modelProviderAuthSessions.status, "awaiting_user_approval"),
        ),
      )
      .returning({ id: modelProviderAuthSessions.id });
    return Boolean(updated);
  },
);

function isSessionExpired(session: ModelProviderAuthSession): boolean {
  return session.expiresAt.getTime() <= nowDate().getTime();
}

function personalAccountMutation(args: {
  readonly mode: ClaudeCodeDeviceAuthMode | undefined;
  readonly modelProviderId: string | undefined;
}): PersonalProviderAccountMutation {
  if (args.mode === "add") {
    return { kind: "add" };
  }
  if (args.mode === "reconnect" && args.modelProviderId) {
    return { kind: "reconnect", accountId: args.modelProviderId };
  }
  return { kind: "replace-active" };
}

const importClaudeCodeOAuthToken$ = command(
  async (
    { get, set },
    args: {
      readonly authSession?: DeviceAuthSessionPublication;
      readonly scope: ClaudeCodeDeviceAuthScope;
      readonly orgId: string;
      readonly userId: string;
      readonly accessToken: string;
      readonly mode: ClaudeCodeDeviceAuthMode | undefined;
      readonly modelProviderId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly provider: ModelProviderResponse;
        readonly created: boolean;
      }
    | PersonalProviderAccountErrorResponse
  > => {
    const metadata = await tapError(
      fetchClaudeCodeSubscriptionMetadata(
        {
          accessToken: args.accessToken,
        },
        signal,
      ),
    );
    signal.throwIfAborted();

    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    return await set(
      upsertPersonalModelProviderAccount$,
      {
        orgId: args.orgId,
        authSession: args.authSession,
        userId: args.userId,
        type: CLAUDE_CODE_DEVICE_AUTH_CONNECTOR_TYPE,
        authMethod: null,
        secretValues: {
          CLAUDE_CODE_OAUTH_TOKEN: args.accessToken,
        },
        metadata,
        mode: personalAccountMutation(args),
        featureSwitchContext,
      },
      signal,
    );
  },
);

const completeLoadedClaudeCodeDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly session: ModelProviderAuthSession;
      readonly orgId: string;
      readonly userId: string;
      readonly orgRole: "admin" | "member" | undefined;
      readonly authorizationCode: string;
    },
    signal: AbortSignal,
  ): Promise<ClaudeCodeDeviceAuthCompleteResult> => {
    const { session } = args;
    if (isSessionExpired(session)) {
      await set(markSessionExpired$, { session });
      signal.throwIfAborted();
      return {
        status: "invalid_token",
        message: "Claude Code device auth session expired",
      };
    }
    if (session.status !== "awaiting_user_approval") {
      return {
        status: "invalid_token",
        message: "Claude Code device auth session is not ready",
      };
    }

    const providerState = await decodeProviderState(
      session.encryptedProviderState,
      session,
    );
    signal.throwIfAborted();
    if (!providerState) {
      return {
        status: "error",
        code: "CLAUDE_CODE_DEVICE_AUTH_FAILED",
        message: "Claude Code device auth session state is invalid",
      };
    }

    const parsedAuthorizationCode = safeSync(() => {
      return parseAuthorizationCodeInput({
        raw: args.authorizationCode,
        expectedState: providerState.state,
      });
    });
    if ("error" in parsedAuthorizationCode) {
      return {
        status: "invalid_token",
        message: unknownErrorMessage(
          parsedAuthorizationCode.error,
          "Invalid Claude Code authorization code",
        ),
      };
    }
    const authorizationCode = parsedAuthorizationCode.ok;

    const claimed = await set(claimCompleting$, { session });
    signal.throwIfAborted();
    if (!claimed) {
      return {
        status: "invalid_token",
        message: "Claude Code device auth session is already completing",
      };
    }

    return await set(
      importClaimedClaudeCodeDeviceAuth$,
      {
        session,
        scope: providerState.scope,
        mode: providerState.mode,
        modelProviderId: providerState.modelProviderId,
        orgId: args.orgId,
        userId: args.userId,
        authorizationCode,
        state: providerState.state,
        codeVerifier: providerState.codeVerifier,
      },
      signal,
    );
  },
);

const importClaimedClaudeCodeDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly session: ModelProviderAuthSession;
      readonly scope: ClaudeCodeDeviceAuthScope;
      readonly mode: ClaudeCodeDeviceAuthMode | undefined;
      readonly modelProviderId: string | undefined;
      readonly orgId: string;
      readonly userId: string;
      readonly authorizationCode: string;
      readonly state: string;
      readonly codeVerifier: string;
    },
    signal: AbortSignal,
  ): Promise<ClaudeCodeDeviceAuthCompleteResult> => {
    const tokens = await settle(
      exchangeClaudeCodeAuthorizationCode(
        {
          authorizationCode: args.authorizationCode,
          state: args.state,
          codeVerifier: args.codeVerifier,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();

    if (!tokens.ok) {
      const message = unknownErrorMessage(
        tokens.error,
        "Claude Code device auth token exchange failed",
      );
      await set(markSessionError$, {
        sessionId: args.session.id,
        message,
      });
      signal.throwIfAborted();
      return {
        status: "error",
        code: "CLAUDE_CODE_DEVICE_AUTH_FAILED",
        message,
      };
    }

    const imported = await settle(
      set(
        importClaudeCodeOAuthToken$,
        {
          authSession: {
            id: args.session.id,
            userId: args.userId,
            source: "claude-code-device-auth",
          },
          scope: args.scope,
          orgId: args.orgId,
          userId: args.userId,
          accessToken: tokens.value.accessToken,
          mode: args.mode,
          modelProviderId: args.modelProviderId,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();

    if (!imported.ok) {
      const message = unknownErrorMessage(
        imported.error,
        "Claude Code device auth import failed",
      );
      await set(markSessionError$, {
        sessionId: args.session.id,
        message,
      });
      signal.throwIfAborted();
      return {
        status: "error",
        code: "CLAUDE_CODE_DEVICE_AUTH_FAILED",
        message,
      };
    }

    if ("status" in imported.value) {
      await set(markSessionError$, {
        sessionId: args.session.id,
        message: imported.value.body.error.message,
      });
      signal.throwIfAborted();
      return {
        status: "auth_error",
        response: imported.value,
      };
    }

    return {
      status: "complete",
      body: imported.value,
    };
  },
);

export const completeClaudeCodeDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly orgRole: "admin" | "member" | undefined;
      readonly sessionToken: string;
      readonly authorizationCode: string;
    },
    signal: AbortSignal,
  ): Promise<ClaudeCodeDeviceAuthCompleteResult> => {
    const decoded = decodeSession(args.sessionToken);
    if (!decoded) {
      return {
        status: "invalid_token",
        message: "Invalid Claude Code device auth session token",
      };
    }

    const session = await set(loadSession$, {
      sessionId: decoded.sessionId,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!session) {
      return {
        status: "forbidden",
        message: "Claude Code device auth session not found",
      };
    }
    return await set(
      completeLoadedClaudeCodeDeviceAuth$,
      {
        session,
        orgId: args.orgId,
        userId: args.userId,
        orgRole: args.orgRole,
        authorizationCode: args.authorizationCode,
      },
      signal,
    );
  },
);

export const cancelClaudeCodeDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly sessionToken: string;
    },
    signal: AbortSignal,
  ): Promise<ClaudeCodeDeviceAuthCancelResult> => {
    const decoded = decodeSession(args.sessionToken);
    if (!decoded) {
      return {
        status: "invalid_token",
        message: "Invalid Claude Code device auth session token",
      };
    }

    const session = await set(loadSession$, {
      sessionId: decoded.sessionId,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!session) {
      return {
        status: "forbidden",
        message: "Claude Code device auth session not found",
      };
    }

    await set(cancelSession$, {
      sessionId: session.id,
      orgId: args.orgId,
      userId: args.userId,
      message: "Claude Code device auth session was cancelled",
    });
    signal.throwIfAborted();

    return { status: "cancelled" };
  },
);

export function claudeCodeDeviceAuthUnavailable(message: string) {
  return {
    status: 503 as const,
    body: {
      error: {
        message,
        code: "CLAUDE_CODE_DEVICE_AUTH_UNAVAILABLE",
      },
    },
  };
}
