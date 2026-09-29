import type { DeviceAuthSessionPublication } from "./model-provider-device-session-publication";
import { command } from "ccstate";
import type {
  CodexDeviceAuthMode,
  CodexDeviceAuthScope,
} from "@okouai/api-contracts/contracts/codex-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
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
import {
  decryptPersistentSecretValue,
  decryptSecretValue,
  encryptPersistentSecretValue,
  encryptSecretValue,
} from "./crypto.utils";
import { handleCodexAuthJsonPaste } from "./codex-auth-json-paste-handler";
import {
  upsertPersonalModelProviderAccount$,
  type PersonalProviderAccountErrorResponse,
  type PersonalProviderAccountMutation,
} from "./model-provider-account.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import {
  upsertOrgMultiAuthModelProvider$,
  upsertUserMultiAuthModelProvider$,
} from "./model-provider.service";

const CODEX_DEVICE_AUTH_ISSUER = "https://auth.openai.com";
const CODEX_DEVICE_AUTH_API_BASE_URL = `${CODEX_DEVICE_AUTH_ISSUER}/api/accounts`;
const CODEX_DEVICE_AUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEVICE_AUTH_VERIFICATION_URL = `${CODEX_DEVICE_AUTH_ISSUER}/codex/device`;
const CODEX_DEVICE_AUTH_REDIRECT_URI = `${CODEX_DEVICE_AUTH_ISSUER}/deviceauth/callback`;
const CODEX_DEVICE_AUTH_SESSION_TTL_SECONDS = 15 * 60;
const CODEX_DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;
const CODEX_DEVICE_AUTH_CONNECTOR_TYPE = "codex-oauth-token";
const CODEX_DEVICE_AUTH_SOURCE = "codex-device-auth";

const codexDeviceAuthSessionTokenSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
});

const codexDeviceAuthProviderStateSchema = z.object({
  version: z.literal(1),
  type: z.literal("codex"),
  scope: z.enum(["org", "personal"]),
  mode: z.enum(["add", "reconnect"]).optional(),
  modelProviderId: z.string().uuid().optional(),
  deviceAuthId: z.string().min(1),
  userCode: z.string().min(1),
});

const codexDeviceUserCodeResponseSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1).optional(),
  usercode: z.string().min(1).optional(),
  interval: z.coerce
    .number()
    .int()
    .positive()
    .default(CODEX_DEVICE_AUTH_POLL_INTERVAL_SECONDS),
});

const codexDeviceTokenResponseSchema = z.object({
  authorization_code: z.string().min(1),
  code_challenge: z.string().min(1),
  code_verifier: z.string().min(1),
});

const codexOAuthTokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

type CodexDeviceAuthSessionToken = z.infer<
  typeof codexDeviceAuthSessionTokenSchema
>;
type CodexDeviceAuthProviderState = z.infer<
  typeof codexDeviceAuthProviderStateSchema
>;
type ModelProviderAuthSession = typeof modelProviderAuthSessions.$inferSelect;
type ModelProviderAuthSessionStatus = ModelProviderAuthSession["status"];
const CODEX_DEVICE_AUTH_ACTIVE_STATUSES = [
  "initializing",
  "awaiting_user_approval",
  "completing",
] as const satisfies readonly ModelProviderAuthSessionStatus[];
type CodexDeviceAuthFailureCode =
  | "CODEX_DEVICE_AUTH_UNAVAILABLE"
  | "CODEX_DEVICE_AUTH_FAILED"
  | "CODEX_DEVICE_AUTH_EXPIRED";

type CodexDeviceAuthStartResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly scope: CodexDeviceAuthScope;
      readonly browserUrl: string;
      readonly verificationCode: string;
      readonly expiresIn: number;
      readonly interval: number;
    }
  | {
      readonly ok: false;
      readonly code: CodexDeviceAuthFailureCode;
      readonly message: string;
    };

type CodexDeviceAuthCompleteResult =
  | {
      readonly status: "pending";
      readonly errorMessage: string | null;
    }
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
      readonly response: CodexAuthJsonPasteErrorResponse;
    }
  | {
      readonly status: "error";
      readonly code: CodexDeviceAuthFailureCode;
      readonly message: string;
    };

type CodexDeviceAuthCancelResult =
  | { readonly status: "cancelled" }
  | { readonly status: "invalid_token"; readonly message: string }
  | { readonly status: "forbidden"; readonly message: string };

type CodexDeviceUserCode = {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly interval: number;
};

type CodexDeviceTokenPollResult =
  | {
      readonly status: "pending";
    }
  | {
      readonly status: "complete";
      readonly authorizationCode: string;
      readonly codeVerifier: string;
    }
  | {
      readonly status: "error";
      readonly message: string;
    };

type CodexOAuthTokens = {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
};

type CodexAuthJsonPasteResult = Awaited<
  ReturnType<typeof handleCodexAuthJsonPaste>
>;
interface CodexAuthJsonPasteErrorResponse {
  readonly status: 400 | 404;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

interface CodexAuthJsonPasteSuccessBody {
  readonly provider: ModelProviderResponse;
  readonly created: boolean;
}

function encodeSession(payload: CodexDeviceAuthSessionToken): string {
  return encryptSecretValue(JSON.stringify(payload));
}

async function encodeProviderState(
  payload: CodexDeviceAuthProviderState,
  session: ModelProviderAuthSession,
): Promise<string> {
  return await encryptPersistentSecretValue(JSON.stringify(payload), {
    orgId: session.orgId,
    userId: session.userId,
  });
}

function decodeSession(token: string): CodexDeviceAuthSessionToken | null {
  const decoded = safeSync(() => {
    const parsed = codexDeviceAuthSessionTokenSchema.safeParse(
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
): Promise<CodexDeviceAuthProviderState | null> {
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
    const parsed = codexDeviceAuthProviderStateSchema.safeParse(
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
  return new Date(now.getTime() + CODEX_DEVICE_AUTH_SESSION_TTL_SECONDS * 1000);
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
      CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
    ),
    eq(modelProviderAuthSessions.source, CODEX_DEVICE_AUTH_SOURCE),
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
          message: "Codex device auth session was superseded",
        }),
      )
      .where(
        and(
          ownerWhere(args),
          inArray(modelProviderAuthSessions.status, [
            ...CODEX_DEVICE_AUTH_ACTIVE_STATUSES,
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
            ...CODEX_DEVICE_AUTH_ACTIVE_STATUSES,
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
        connectorType: CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
        source: CODEX_DEVICE_AUTH_SOURCE,
        status: "initializing",
        expiresAt: args.expiresAt,
      })
      .returning();
    if (!session) {
      throw new Error("Failed to create Codex device auth session");
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
            ...CODEX_DEVICE_AUTH_ACTIVE_STATUSES,
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
            ...CODEX_DEVICE_AUTH_ACTIVE_STATUSES,
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
      readonly scope: CodexDeviceAuthScope;
      readonly mode?: CodexDeviceAuthMode;
      readonly modelProviderId?: string;
      readonly deviceAuthId: string;
      readonly userCode: string;
    },
  ): Promise<ModelProviderAuthSession> => {
    const encryptedProviderState = await encodeProviderState(
      {
        version: 1,
        type: "codex",
        scope: args.scope,
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.modelProviderId
          ? { modelProviderId: args.modelProviderId }
          : {}),
        deviceAuthId: args.deviceAuthId,
        userCode: args.userCode,
      },
      args.session,
    );
    const writeDb = set(writeDb$);
    const [updated] = await writeDb
      .update(modelProviderAuthSessions)
      .set({
        status: "awaiting_user_approval",
        approvalUrl: CODEX_DEVICE_AUTH_VERIFICATION_URL,
        verificationCode: args.userCode,
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
      throw new Error("Failed to update Codex device auth session");
    }
    return updated;
  },
);

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = safeJsonParse(text);
  if (parsed === undefined) {
    throw new Error("OpenAI auth returned invalid JSON");
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

async function requestOpenAiDeviceUserCode(
  signal: AbortSignal,
): Promise<CodexDeviceUserCode> {
  const response = await fetch(
    `${CODEX_DEVICE_AUTH_API_BASE_URL}/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_DEVICE_AUTH_CLIENT_ID }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Codex device code request failed"),
    );
  }

  const parsed = codexDeviceUserCodeResponseSchema.safeParse(
    await readJsonResponse(response),
  );
  if (!parsed.success) {
    throw new Error(
      "OpenAI auth returned an unrecognized device code response",
    );
  }
  const userCode = parsed.data.user_code ?? parsed.data.usercode;
  if (!userCode) {
    throw new Error("OpenAI auth returned a device code response without code");
  }
  return {
    deviceAuthId: parsed.data.device_auth_id,
    userCode,
    interval: parsed.data.interval,
  };
}

async function pollOpenAiDeviceToken(
  args: {
    readonly deviceAuthId: string;
    readonly userCode: string;
  },
  signal: AbortSignal,
): Promise<CodexDeviceTokenPollResult> {
  const response = await fetch(
    `${CODEX_DEVICE_AUTH_API_BASE_URL}/deviceauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: args.deviceAuthId,
        user_code: args.userCode,
      }),
      signal,
    },
  );

  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }
  if (!response.ok) {
    return {
      status: "error",
      message: await readErrorMessage(response, "Codex device auth failed"),
    };
  }

  const parsed = codexDeviceTokenResponseSchema.safeParse(
    await readJsonResponse(response),
  );
  if (!parsed.success) {
    return {
      status: "error",
      message: "OpenAI auth returned an unrecognized device token response",
    };
  }
  return {
    status: "complete",
    authorizationCode: parsed.data.authorization_code,
    codeVerifier: parsed.data.code_verifier,
  };
}

async function exchangeOpenAiAuthorizationCode(
  args: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
  },
  signal: AbortSignal,
): Promise<CodexOAuthTokens> {
  const response = await fetch(`${CODEX_DEVICE_AUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.authorizationCode,
      redirect_uri: CODEX_DEVICE_AUTH_REDIRECT_URI,
      client_id: CODEX_DEVICE_AUTH_CLIENT_ID,
      code_verifier: args.codeVerifier,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Codex token exchange failed"),
    );
  }

  const parsed = codexOAuthTokenResponseSchema.safeParse(
    await readJsonResponse(response),
  );
  if (!parsed.success) {
    throw new Error("OpenAI auth returned an unrecognized token response");
  }
  return {
    idToken: parsed.data.id_token,
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
  };
}

export const startCodexDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly scope: CodexDeviceAuthScope;
      readonly mode?: CodexDeviceAuthMode;
      readonly modelProviderId?: string;
    },
    signal: AbortSignal,
  ): Promise<CodexDeviceAuthStartResult> => {
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
        message: "Codex device auth session was cancelled",
      });
      signal.throwIfAborted();
    }
    const cancelStartedSession = () => {
      detach(
        set(cancelSession$, {
          sessionId: session.id,
          orgId: args.orgId,
          userId: args.userId,
          message: "Codex device auth session was cancelled",
        }),
        Mechanism.WaitUntil,
        "cancel aborted Codex device auth session",
      );
    };
    signal.addEventListener("abort", cancelStartedSession, { once: true });
    const unregisterAbortCancellation = () => {
      signal.removeEventListener("abort", cancelStartedSession);
    };
    return await (async (): Promise<CodexDeviceAuthStartResult> => {
      const userCodeResult = await settle(
        requestOpenAiDeviceUserCode(signal),
        signal,
      );
      signal.throwIfAborted();
      if (!userCodeResult.ok) {
        const message = unknownErrorMessage(
          userCodeResult.error,
          "Codex device code request failed",
        );
        await set(markSessionError$, {
          sessionId: session.id,
          message,
        });
        signal.throwIfAborted();
        return {
          ok: false,
          code: "CODEX_DEVICE_AUTH_UNAVAILABLE",
          message,
        };
      }

      const updated = await settle(
        set(moveSessionToAwaitingApproval$, {
          session,
          scope: args.scope,
          mode: args.mode,
          modelProviderId: args.modelProviderId,
          deviceAuthId: userCodeResult.value.deviceAuthId,
          userCode: userCodeResult.value.userCode,
        }),
        signal,
      );
      signal.throwIfAborted();

      if (!updated.ok) {
        return {
          ok: false,
          code: "CODEX_DEVICE_AUTH_UNAVAILABLE",
          message: unknownErrorMessage(
            updated.error,
            "Codex device auth session changed",
          ),
        };
      }
      return {
        ok: true,
        sessionToken: encodeSession({ version: 1, sessionId: session.id }),
        scope: args.scope,
        browserUrl: CODEX_DEVICE_AUTH_VERIFICATION_URL,
        verificationCode: userCodeResult.value.userCode,
        expiresIn: remainingTtlSeconds(updated.value.expiresAt, nowDate()),
        interval: userCodeResult.value.interval,
      };
    })().finally(unregisterAbortCancellation);
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
  readonly mode: CodexDeviceAuthMode | undefined;
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

interface ImportCodexAuthJsonArgs {
  readonly authSession?: DeviceAuthSessionPublication;
  readonly scope: CodexDeviceAuthScope;
  readonly orgId: string;
  readonly userId: string;
  readonly rawAuthJson: string;
  readonly accountMutation?: PersonalProviderAccountMutation;
}

interface ImportedCodexPasteArgs {
  readonly authMethod: "auth_json";
  readonly secretValues: {
    readonly CHATGPT_ACCESS_TOKEN: string;
    readonly CHATGPT_REFRESH_TOKEN: string;
    readonly CHATGPT_ACCOUNT_ID: string;
    readonly CHATGPT_ID_TOKEN: string;
  };
  readonly selectedModel: string | undefined;
  readonly metadata: {
    readonly externalAccountId: string;
    readonly accountEmail: string | null;
    readonly tokenExpiresAt: Date | null;
    readonly workspaceName: string | null;
    readonly planType: string | null;
    readonly subscriptionResetPeriod?: string | null;
    readonly subscriptionNextResetAt?: Date | null;
  };
}

type ImportCodexAuthJsonResult =
  | {
      readonly status: "complete";
      readonly body: CodexAuthJsonPasteSuccessBody;
    }
  | {
      readonly status: "auth_error";
      readonly response: CodexAuthJsonPasteErrorResponse;
    };

const importCodexAuthJson$ = command(
  async (
    { get, set },
    args: ImportCodexAuthJsonArgs,
    signal: AbortSignal,
  ): Promise<ImportCodexAuthJsonResult> => {
    const common = {
      rawAuthJson: args.rawAuthJson,
      selectedModel: undefined,
      signal,
      upsert: async (pasteArgs: ImportedCodexPasteArgs) => {
        if (args.scope === "org") {
          const result = await set(
            upsertOrgMultiAuthModelProvider$,
            {
              orgId: args.orgId,
              authSession: args.authSession,
              type: CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
              authMethod: pasteArgs.authMethod,
              secretValues: pasteArgs.secretValues,
              metadata: pasteArgs.metadata,
            },
            signal,
          );
          if ("status" in result) {
            throw new Error(
              "upsertOrgMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex device auth",
            );
          }
          return result;
        }
        if (args.accountMutation) {
          const featureSwitchContext = await get(
            userFeatureSwitchContext(args.orgId, args.userId),
          );
          const result = await set(
            upsertPersonalModelProviderAccount$,
            {
              orgId: args.orgId,
              authSession: args.authSession,
              userId: args.userId,
              type: CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
              authMethod: pasteArgs.authMethod,
              secretValues: pasteArgs.secretValues,
              selectedModel: pasteArgs.selectedModel,
              metadata: pasteArgs.metadata,
              mode: args.accountMutation,
              featureSwitchContext,
            },
            signal,
          );
          return result;
        }
        const result = await set(
          upsertUserMultiAuthModelProvider$,
          {
            orgId: args.orgId,
            authSession: args.authSession,
            userId: args.userId,
            type: CODEX_DEVICE_AUTH_CONNECTOR_TYPE,
            authMethod: pasteArgs.authMethod,
            secretValues: pasteArgs.secretValues,
            metadata: pasteArgs.metadata,
          },
          signal,
        );
        if ("status" in result) {
          throw new Error(
            "upsertUserMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex device auth",
          );
        }
        return result;
      },
    };

    const response =
      args.scope === "org"
        ? await handleCodexAuthJsonPaste(
            {
              scope: "org",
              orgId: args.orgId,
              ...common,
            },
            common.signal,
          )
        : await handleCodexAuthJsonPaste(
            {
              scope: "personal",
              orgId: args.orgId,
              userId: args.userId,
              ...common,
            },
            common.signal,
          );

    if (response.status === 400 || response.status === 404) {
      return {
        status: "auth_error",
        response: codexAuthJsonPasteErrorResponse(response),
      };
    }
    return {
      status: "complete",
      body: codexAuthJsonPasteSuccessBody(response),
    };
  },
);

function extractApiErrorBody(
  body: unknown,
): CodexAuthJsonPasteErrorResponse["body"] {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    const code =
      "code" in body.error && typeof body.error.code === "string"
        ? body.error.code
        : "BAD_REQUEST";
    return { error: { message: body.error.message, code } };
  }
  return {
    error: {
      message: "Codex login tokens were rejected",
      code: "BAD_REQUEST",
    },
  };
}

function codexAuthJsonPasteErrorResponse(
  response: PersonalProviderAccountErrorResponse | CodexAuthJsonPasteResult,
): CodexAuthJsonPasteErrorResponse {
  return {
    status: response.status === 404 ? 404 : 400,
    body: extractApiErrorBody(response.body),
  };
}

function codexAuthJsonPasteSuccessBody(
  response: CodexAuthJsonPasteResult,
): CodexAuthJsonPasteSuccessBody {
  if (
    typeof response.body === "object" &&
    response.body !== null &&
    "provider" in response.body &&
    "created" in response.body &&
    typeof response.body.created === "boolean"
  ) {
    return response.body as CodexAuthJsonPasteSuccessBody;
  }
  throw new Error("Codex login token import returned an unexpected response");
}

function authJsonFromTokens(tokens: CodexOAuthTokens): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: "device-auth",
      id_token: tokens.idToken,
    },
  });
}

const completeLoadedCodexDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly session: ModelProviderAuthSession;
      readonly orgId: string;
      readonly userId: string;
      readonly orgRole: "admin" | "member" | undefined;
    },
    signal: AbortSignal,
  ): Promise<CodexDeviceAuthCompleteResult> => {
    const { session } = args;
    if (isSessionExpired(session)) {
      await set(markSessionExpired$, { session });
      signal.throwIfAborted();
      return {
        status: "invalid_token",
        message: "Codex device auth session expired",
      };
    }
    if (session.status !== "awaiting_user_approval") {
      return {
        status: "pending",
        errorMessage: session.errorMessage,
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
        code: "CODEX_DEVICE_AUTH_FAILED",
        message: "Codex device auth session state is invalid",
      };
    }
    if (providerState.scope === "org" && args.orgRole !== "admin") {
      return {
        status: "forbidden",
        message: "Only admins can manage org model providers",
      };
    }

    const deviceToken = await pollOpenAiDeviceToken(
      {
        deviceAuthId: providerState.deviceAuthId,
        userCode: providerState.userCode,
      },
      signal,
    );
    signal.throwIfAborted();
    if (deviceToken.status === "pending") {
      return { status: "pending", errorMessage: null };
    }
    if (deviceToken.status === "error") {
      await set(markSessionError$, {
        sessionId: session.id,
        message: deviceToken.message,
      });
      signal.throwIfAborted();
      return {
        status: "error",
        code: "CODEX_DEVICE_AUTH_FAILED",
        message: deviceToken.message,
      };
    }

    const claimed = await set(claimCompleting$, { session });
    signal.throwIfAborted();
    if (!claimed) {
      return { status: "pending", errorMessage: null };
    }

    return await set(
      importClaimedCodexDeviceAuth$,
      {
        session,
        scope: providerState.scope,
        mode: providerState.mode,
        modelProviderId: providerState.modelProviderId,
        orgId: args.orgId,
        userId: args.userId,
        authorizationCode: deviceToken.authorizationCode,
        codeVerifier: deviceToken.codeVerifier,
      },
      signal,
    );
  },
);

const importClaimedCodexDeviceAuth$ = command(
  async (
    { get, set },
    args: {
      readonly session: ModelProviderAuthSession;
      readonly scope: CodexDeviceAuthScope;
      readonly mode: CodexDeviceAuthMode | undefined;
      readonly modelProviderId: string | undefined;
      readonly orgId: string;
      readonly userId: string;
      readonly authorizationCode: string;
      readonly codeVerifier: string;
    },
    signal: AbortSignal,
  ): Promise<CodexDeviceAuthCompleteResult> => {
    const tokens = await settle(
      exchangeOpenAiAuthorizationCode(
        {
          authorizationCode: args.authorizationCode,
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
        "Codex device auth token exchange failed",
      );
      await set(markSessionError$, {
        sessionId: args.session.id,
        message,
      });
      signal.throwIfAborted();
      return {
        status: "error",
        code: "CODEX_DEVICE_AUTH_FAILED",
        message,
      };
    }

    const featureSwitchContext =
      args.scope === "personal"
        ? await get(userFeatureSwitchContext(args.orgId, args.userId))
        : undefined;
    signal.throwIfAborted();
    const accountMutation =
      featureSwitchContext &&
      isFeatureEnabled(
        FeatureSwitchKey.PersonalModelProviderAccounts,
        featureSwitchContext,
      )
        ? personalAccountMutation(args)
        : undefined;
    const imported = await settle(
      set(
        importCodexAuthJson$,
        {
          authSession: {
            id: args.session.id,
            userId: args.userId,
            source: "codex-device-auth",
          },
          scope: args.scope,
          orgId: args.orgId,
          userId: args.userId,
          rawAuthJson: authJsonFromTokens(tokens.value),
          ...(accountMutation ? { accountMutation } : {}),
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();

    if (!imported.ok) {
      const message = unknownErrorMessage(
        imported.error,
        "Codex device auth import failed",
      );
      await set(markSessionError$, {
        sessionId: args.session.id,
        message,
      });
      signal.throwIfAborted();
      return {
        status: "error",
        code: "CODEX_DEVICE_AUTH_FAILED",
        message,
      };
    }

    if (imported.value.status === "auth_error") {
      await set(markSessionError$, {
        sessionId: args.session.id,
        message: imported.value.response.body.error.message,
      });
      signal.throwIfAborted();
      return imported.value;
    }

    return {
      status: "complete",
      body: {
        provider: imported.value.body.provider,
        created: imported.value.body.created,
      },
    };
  },
);

export const completeCodexDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly orgRole: "admin" | "member" | undefined;
      readonly sessionToken: string;
    },
    signal: AbortSignal,
  ): Promise<CodexDeviceAuthCompleteResult> => {
    const decoded = decodeSession(args.sessionToken);
    if (!decoded) {
      return {
        status: "invalid_token",
        message: "Invalid Codex device auth session token",
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
        message: "Codex device auth session not found",
      };
    }
    return await set(
      completeLoadedCodexDeviceAuth$,
      {
        session,
        orgId: args.orgId,
        userId: args.userId,
        orgRole: args.orgRole,
      },
      signal,
    );
  },
);

export const cancelCodexDeviceAuth$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly sessionToken: string;
    },
    signal: AbortSignal,
  ): Promise<CodexDeviceAuthCancelResult> => {
    const decoded = decodeSession(args.sessionToken);
    if (!decoded) {
      return {
        status: "invalid_token",
        message: "Invalid Codex device auth session token",
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
        message: "Codex device auth session not found",
      };
    }

    await set(cancelSession$, {
      sessionId: session.id,
      orgId: args.orgId,
      userId: args.userId,
      message: "Codex device auth session was cancelled",
    });
    signal.throwIfAborted();

    return { status: "cancelled" };
  },
);

export function codexDeviceAuthUnavailable(message: string) {
  return {
    status: 503 as const,
    body: {
      error: {
        message,
        code: "CODEX_DEVICE_AUTH_UNAVAILABLE",
      },
    },
  };
}
