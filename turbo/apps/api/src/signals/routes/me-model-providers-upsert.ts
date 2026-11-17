import {
  subscriptionSwitchRecoveries,
  enqueueSubscriptionRecovery$,
} from "../services/subscription-switch-recovery.service";
import { waitUntil } from "../context/wait-until";
import { continueIntegrationRecovery$ } from "../services/integration-recovery-continuation.service";
import { command } from "ccstate";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import { handleCodexAuthJsonPaste } from "../services/codex-auth-json-paste-handler";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { upsertPersonalModelProviderAccount$ } from "../services/model-provider-account.service";

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
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ) => {
    return await handleCodexAuthJsonPaste(
      {
        orgId: args.orgId,
        userId: args.userId,
        rawAuthJson: args.rawAuthJson,
        upsert: async (pasteArgs) => {
          const result = await set(
            upsertPersonalModelProviderAccount$,
            {
              orgId: args.orgId,
              userId: args.userId,
              type: "codex-oauth-token",
              authMethod: pasteArgs.authMethod,
              secretValues: pasteArgs.secretValues,
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
        },
      },
      signal,
    );
  },
);

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
  const { type, secret, authMethod, secrets } = bodyResult.data;
  const featureSwitchContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();

  const recoveries = await get(subscriptionSwitchRecoveries({ ...auth, type }));
  signal.throwIfAborted();

  // Branch 1: codex-oauth-token + auth_json paste flow
  if (type === "codex-oauth-token" && authMethod === "auth_json") {
    const raw = secrets?.CODEX_AUTH_JSON;
    if (!raw) {
      return badRequestMessage("Missing CODEX_AUTH_JSON secret");
    }
    const result = await set(
      upsertPersonalCodexAuthJson$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        rawAuthJson: raw,
        featureSwitchContext,
      },
      signal,
    );
    if (result.status === 200 || result.status === 201) {
      for (const recovery of recoveries) {
        const input = await set(
          enqueueSubscriptionRecovery$,
          {
            ...auth,
            recovery,
            account: result.body.provider,
            change: "credentials",
          },
          signal,
        );
        if (input) {
          waitUntil(set(continueIntegrationRecovery$, input, signal));
        }
      }
    }
    return result;
  }

  // Codex subscriptions are connected only through the auth_json paste flow.
  if (type === "codex-oauth-token") {
    return badRequestMessage(
      `Provider "${type}" requires authMethod "auth_json"`,
    );
  }

  // Claude Code subscription: single-secret provider
  if (!secret) {
    return badRequestMessage(`Provider "${type}" requires a secret`);
  }
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
      mode: { kind: "replace-active" },
      featureSwitchContext,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!("status" in result)) {
    for (const recovery of recoveries) {
      const input = await set(
        enqueueSubscriptionRecovery$,
        { ...auth, recovery, account: result.provider, change: "credentials" },
        signal,
      );
      if (input) {
        waitUntil(set(continueIntegrationRecovery$, input, signal));
      }
    }
  }
  return "status" in result
    ? result
    : shapeAccountUpsertResult(result.provider, result.created);
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
