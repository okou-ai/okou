import { command } from "ccstate";
import {
  hasAuthMethods,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import { handleCodexAuthJsonPaste } from "../services/codex-auth-json-paste-handler";
import {
  upsertUserModelProvider$,
  upsertUserMultiAuthModelProvider$,
  type ModelProviderInfo,
} from "../services/model-provider.service";
import type { RouteEntry } from "../route-entry";
import { writeDb$, type Db } from "../external/db";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { personalAccountsEnabledForOrg } from "../services/personal-accounts-availability.service";
import {
  upsertPersonalModelProviderAccount$,
  type PersonalSubscriptionProviderType,
} from "../services/model-provider-account.service";

function providerNotFound(type: string) {
  return {
    status: 404 as const,
    body: {
      error: {
        message: `Provider "${type}" not found`,
        code: "NOT_FOUND" as const,
      },
    },
  };
}

function isModelFirstPersonalProviderType(
  type: ModelProviderType,
): type is PersonalSubscriptionProviderType {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function toModelProviderResponse(
  provider: ModelProviderInfo,
): ModelProviderResponse {
  // `provider.type` is statically `ModelProviderType`, so no parse is needed —
  // the response shape is a direct projection of `ModelProviderInfo`.
  return {
    id: provider.id,
    type: provider.type,
    framework: provider.framework,
    secretName: provider.secretName,
    authMethod: provider.authMethod,
    secretNames: provider.secretNames,
    isDefault: provider.isDefault,
    selectedModel: provider.selectedModel,
    workspaceName: provider.workspaceName,
    planType: provider.planType,
    subscriptionResetPeriod: provider.subscriptionResetPeriod,
    subscriptionNextResetAt:
      provider.subscriptionNextResetAt?.toISOString() ?? null,
    needsReconnect: provider.needsReconnect,
    lastRefreshErrorCode: provider.lastRefreshErrorCode,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function shapeUpsertResult(
  provider: ModelProviderInfo,
  created: boolean,
): {
  readonly status: 200 | 201;
  readonly body: {
    readonly provider: ModelProviderResponse;
    readonly created: boolean;
  };
} {
  return {
    status: (created ? 201 : 200) as 200 | 201,
    body: { provider: toModelProviderResponse(provider), created },
  };
}

function shapeAccountUpsertResult(
  provider: ModelProviderResponse,
  created: boolean,
) {
  return {
    status: (created ? 201 : 200) as 200 | 201,
    body: { provider, created },
  };
}

const upsertPersonalCodexAuthJson$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly rawAuthJson: string;
      readonly selectedModel: string | undefined;
      readonly accountsEnabled: boolean;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ) => {
    return await handleCodexAuthJsonPaste(
      {
        scope: "personal",
        orgId: args.orgId,
        userId: args.userId,
        rawAuthJson: args.rawAuthJson,
        selectedModel: args.selectedModel,
        upsert: async (pasteArgs) => {
          if (args.accountsEnabled) {
            const result = await set(
              upsertPersonalModelProviderAccount$,
              {
                orgId: args.orgId,
                userId: args.userId,
                type: "codex-oauth-token",
                authMethod: pasteArgs.authMethod,
                secretValues: pasteArgs.secretValues,
                selectedModel: pasteArgs.selectedModel,
                metadata: pasteArgs.metadata,
                mode: { kind: "replace-active" },
                featureSwitchContext: args.featureSwitchContext,
              },
              signal,
            );
            if ("status" in result) {
              throw new Error(result.body.error.message);
            }
            return result;
          }
          const result = await set(
            upsertUserMultiAuthModelProvider$,
            {
              orgId: args.orgId,
              userId: args.userId,
              type: "codex-oauth-token",
              authMethod: pasteArgs.authMethod,
              secretValues: pasteArgs.secretValues,
              selectedModel: pasteArgs.selectedModel,
              metadata: pasteArgs.metadata,
            },
            signal,
          );
          if ("status" in result) {
            throw new Error(
              "upsertUserMultiAuthModelProvider$ unexpectedly returned BAD_REQUEST during codex paste",
            );
          }
          return result;
        },
      },
      signal,
    );
  },
);

async function personalAccountsAvailableForProvider(
  db: Db,
  orgId: string,
  featureSwitchContext: FeatureSwitchContext,
): Promise<boolean> {
  return await personalAccountsEnabledForOrg(
    db,
    orgId,
    isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProviderAccounts,
      featureSwitchContext,
    ),
  );
}

const upsertInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  // Body parse
  const bodyResult = await get(
    bodyResultOf(personalModelProvidersMainContract.upsert),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { type, secret, authMethod, secrets, selectedModel } = bodyResult.data;

  // Gate 2: personal provider routes only support model-first provider types.
  if (!isModelFirstPersonalProviderType(type)) {
    return providerNotFound(type);
  }
  const featureSwitchContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  const accountsEnabled = await personalAccountsAvailableForProvider(
    set(writeDb$),
    auth.orgId,
    featureSwitchContext,
  );
  signal.throwIfAborted();

  // Branch 1: codex-oauth-token + auth_json paste flow
  if (type === "codex-oauth-token" && authMethod === "auth_json") {
    const raw = secrets?.CODEX_AUTH_JSON;
    if (!raw) {
      return badRequestMessage("Missing CODEX_AUTH_JSON secret");
    }
    return await set(
      upsertPersonalCodexAuthJson$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        rawAuthJson: raw,
        selectedModel,
        accountsEnabled,
        featureSwitchContext,
      },
      signal,
    );
  }

  // Branch 2: multi-auth provider
  if (hasAuthMethods(type)) {
    if (!authMethod || !secrets) {
      return badRequestMessage(
        `Provider "${type}" requires authMethod and secrets`,
      );
    }
    if (accountsEnabled) {
      const result = await set(
        upsertPersonalModelProviderAccount$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          type,
          authMethod,
          secretValues: secrets,
          selectedModel,
          mode: { kind: "replace-active" },
          featureSwitchContext,
        },
        signal,
      );
      signal.throwIfAborted();
      return "status" in result
        ? result
        : shapeAccountUpsertResult(result.provider, result.created);
    }
    const result = await set(
      upsertUserMultiAuthModelProvider$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type,
        authMethod,
        secretValues: secrets,
        selectedModel,
      },
      signal,
    );
    signal.throwIfAborted();
    return "status" in result
      ? result
      : shapeUpsertResult(result.provider, result.created);
  }

  // Branch 3: single-secret provider
  if (!secret) {
    return badRequestMessage(`Provider "${type}" requires a secret`);
  }
  if (accountsEnabled) {
    const result = await set(
      upsertPersonalModelProviderAccount$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        type,
        authMethod: null,
        secretValues: {
          CLAUDE_CODE_OAUTH_TOKEN: secret,
        },
        selectedModel,
        mode: { kind: "replace-active" },
        featureSwitchContext,
      },
      signal,
    );
    signal.throwIfAborted();
    return "status" in result
      ? result
      : shapeAccountUpsertResult(result.provider, result.created);
  }
  const result = await set(
    upsertUserModelProvider$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      type,
      secret,
      selectedModel,
    },
    signal,
  );
  signal.throwIfAborted();
  return "status" in result
    ? result
    : shapeUpsertResult(result.provider, result.created);
});

export const meModelProvidersUpsertRoutes: readonly RouteEntry[] = [
  {
    route: personalModelProvidersMainContract.upsert,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      upsertInner$,
    ),
  },
];
