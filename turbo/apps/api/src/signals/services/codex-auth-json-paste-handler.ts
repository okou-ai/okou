import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

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
 * Caller-supplied upsert. Personal routes bind it to
 * `upsertPersonalModelProviderAccount$`.
 */
type UpsertCodexProvider = (args: {
  authMethod: "auth_json";
  secretValues: {
    CHATGPT_ACCESS_TOKEN: string;
    CHATGPT_REFRESH_TOKEN: string;
    CHATGPT_ACCOUNT_ID: string;
    CHATGPT_ID_TOKEN: string;
  };
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
  | { provider: ModelProviderResponse; created: boolean }
  | PersonalProviderAccountErrorResponse
>;

interface CodexAuthJsonPasteArgs {
  orgId: string;
  userId: string;
  rawAuthJson: string;
  upsert: UpsertCodexProvider;
}

/**
 * Handle the codex-oauth-token + auth_json paste-based connect flow.
 *
 * Parses the raw `~/.codex/auth.json` server-side and persists the four
 * derived `CHATGPT_*` fields via the caller-supplied upsert. The raw
 * `CODEX_AUTH_JSON` blob is NEVER persisted (per Epic #11974 / #7365).
 *
 * Shared implementation for personal model-provider paste and device-auth
 * routes.
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
      return {
        status: (upserted.created ? 201 : 200) as 200 | 201,
        body: upserted,
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
