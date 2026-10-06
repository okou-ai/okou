import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import type {
  ModelProviderType,
  ModelProviderFramework,
} from "@okouai/api-contracts/contracts/model-providers";

import {
  parseCodexAuthJson,
  extractCodexAccountEmailFromIdToken,
  isCodexAuthJsonShapeError,
  isCodexAuthJsonFreePlanError,
} from "./codex-auth-json-parser";
import { fetchCodexUsageMetadata } from "./codex-usage.service";
import type { PersonalProviderAccountErrorResponse } from "./model-provider-account.service";
import {
  invalidateCodexResetCreditExpiry,
  prepareCodexResetCreditExpiryRead,
} from "./codex-reset-credit-expiry.service";
import { logger } from "../../lib/log";
import { settle, tapError, throwIfAbort } from "../utils";

/**
 * Shape of an upserted provider row that the paste handler serializes into the
 * REST response. Organization writes provide Date timestamps and personal
 * account writes provide ISO strings; both routes share this response DTO.
 */
interface UpsertedProvider {
  id: string;
  modelProviderId?: string;
  isActive?: boolean;
  type: ModelProviderType;
  framework: ModelProviderFramework;
  secretName: string | null;
  authMethod?: string | null;
  secretNames?: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
  accountEmail?: string | null;
  workspaceName?: string | null;
  planType?: string | null;
  subscriptionResetPeriod?: string | null;
  subscriptionNextResetAt?: Date | string | null;
  needsReconnect: boolean;
  lastRefreshErrorCode: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function serializeDate(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function serializeNullableDate(
  value: Date | string | null | undefined,
): string | null {
  return value ? serializeDate(value) : null;
}

/**
 * Serialize an upserted model-provider row into the REST DTO shape (Date →
 * ISO string). Shared between org and personal paste handlers so the wire
 * format cannot drift.
 */
function serializeUpsertedProvider(provider: UpsertedProvider) {
  return {
    id: provider.id,
    ...(provider.modelProviderId
      ? { modelProviderId: provider.modelProviderId }
      : {}),
    ...(provider.isActive !== undefined ? { isActive: provider.isActive } : {}),
    type: provider.type,
    framework: provider.framework,
    secretName: provider.secretName,
    authMethod: provider.authMethod ?? null,
    secretNames: provider.secretNames ?? null,
    isDefault: provider.isDefault,
    selectedModel: provider.selectedModel,
    accountEmail: provider.accountEmail ?? null,
    workspaceName: provider.workspaceName ?? null,
    planType: provider.planType ?? null,
    subscriptionResetPeriod: provider.subscriptionResetPeriod ?? null,
    subscriptionNextResetAt: serializeNullableDate(
      provider.subscriptionNextResetAt,
    ),
    needsReconnect: provider.needsReconnect,
    lastRefreshErrorCode: provider.lastRefreshErrorCode,
    createdAt: serializeDate(provider.createdAt),
    updatedAt: serializeDate(provider.updatedAt),
  };
}

/**
 * Caller-supplied upsert. Org route binds this to
 * `upsertOrgMultiAuthModelProvider$`; personal routes bind it to
 * `upsertPersonalModelProviderAccount$`. Both callbacks normalize to the same
 * shape from the handler's perspective.
 */
type UpsertCodexProvider = (args: {
  authMethod: "auth_json";
  secretValues: {
    CHATGPT_ACCESS_TOKEN: string;
    CHATGPT_REFRESH_TOKEN: string;
    CHATGPT_ACCOUNT_ID: string;
    CHATGPT_ID_TOKEN: string;
  };
  selectedModel: string | undefined;
  metadata: {
    externalAccountId: string;
    accountEmail: string | null;
    tokenExpiresAt: Date | null;
    workspaceName: string | null;
    planType: string | null;
    subscriptionResetPeriod?: string | null;
    subscriptionNextResetAt?: Date | null;
  };
}) => Promise<
  | { provider: UpsertedProvider; created: boolean }
  | PersonalProviderAccountErrorResponse
>;

/**
 * Common args shared by both scopes. Split out so the discriminated union
 * below can intersect each scope's identity fields onto the same payload
 * without repeating the paste-flow inputs.
 */
interface CodexAuthJsonPasteCommonArgs {
  rawAuthJson: string;
  selectedModel: string | undefined;
  upsert: UpsertCodexProvider;
}

type CodexAuthJsonPasteArgs = {
  scope: "personal";
  orgId: string;
  userId: string;
} & CodexAuthJsonPasteCommonArgs;

/**
 * Handle the codex-oauth-token + auth_json paste-based connect flow.
 *
 * Parses the raw `~/.codex/auth.json` server-side and persists the four
 * derived `CHATGPT_*` fields via the caller-supplied upsert. The raw
 * `CODEX_AUTH_JSON` blob is NEVER persisted (per Epic #11974 / #7365).
 *
 * Shared implementation for API org and personal model-provider paste routes.
 */
export async function handleCodexAuthJsonPaste(
  args: CodexAuthJsonPasteArgs,
  signal: AbortSignal,
) {
  const log = logger("api:personal-model-providers");
  const logContext = { orgId: args.orgId, userId: args.userId };

  const pasteResult = await settle(
    (async () => {
      const parsed = parseCodexAuthJson(args.rawAuthJson);
      const invalidateExpiry = () => {
        invalidateCodexResetCreditExpiry(args, { accountId: parsed.accountId });
      };
      invalidateExpiry();
      const readResetCreditExpiry = prepareCodexResetCreditExpiryRead(
        args,
        "connect",
      );
      const usageMetadata =
        (await tapError(
          fetchCodexUsageMetadata(
            {
              accessToken: parsed.accessToken,
              accountId: parsed.accountId,
              idToken: parsed.idToken,
              readResetCreditExpiry,
            },
            signal,
          ),
          () => {
            signal.throwIfAborted();
            return undefined;
          },
        )) ?? null;

      const upserted = await args
        .upsert({
          authMethod: "auth_json",
          secretValues: {
            CHATGPT_ACCESS_TOKEN: parsed.accessToken,
            CHATGPT_REFRESH_TOKEN: parsed.refreshToken,
            CHATGPT_ACCOUNT_ID: parsed.accountId,
            CHATGPT_ID_TOKEN: parsed.idToken,
          },
          selectedModel: args.selectedModel,
          metadata: {
            externalAccountId: parsed.accountId,
            accountEmail:
              usageMetadata?.accountEmail ??
              extractCodexAccountEmailFromIdToken(parsed.idToken),
            tokenExpiresAt: parsed.tokenExpiresAt,
            workspaceName: usageMetadata?.workspaceName ?? parsed.workspaceName,
            planType: usageMetadata?.planType ?? parsed.planType,
            ...(usageMetadata
              ? {
                  subscriptionResetPeriod:
                    usageMetadata.subscriptionResetPeriod,
                  subscriptionNextResetAt:
                    usageMetadata.subscriptionNextResetAt,
                }
              : {}),
          },
        })
        .finally(invalidateExpiry);
      if ("status" in upserted) {
        return upserted;
      }
      const { provider, created } = upserted;

      return {
        status: (created ? 201 : 200) as 200 | 201,
        body: { provider: serializeUpsertedProvider(provider), created },
      };
    })(),
    signal,
  );

  if (pasteResult.ok) {
    return pasteResult.value;
  }

  const { error } = pasteResult;
  throwIfAbort(error);
  if (isCodexAuthJsonFreePlanError(error)) {
    log.debug("rejected personal codex auth_json paste: free plan", logContext);
    return createErrorResponse(
      "CODEX_FREE_PLAN_REJECTED",
      "ChatGPT free plan is not supported — upgrade to Plus or higher.",
    );
  }
  if (isCodexAuthJsonShapeError(error)) {
    log.warn("rejected personal codex auth_json paste: shape", {
      ...logContext,
      errorMessage: error.message,
    });
    return createErrorResponse("CODEX_AUTH_JSON_SHAPE_INVALID", error.message);
  }
  throw error;
}
