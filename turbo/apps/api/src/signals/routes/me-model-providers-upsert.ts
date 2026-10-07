import { command } from "ccstate";
import {
  hasAuthMethods,
  type ModelProviderResponse,
} from "@okouai/api-contracts/contracts/model-providers";
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
      readonly selectedModel: string | undefined;
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
  const { type, secret, authMethod, secrets, selectedModel } = bodyResult.data;
  const featureSwitchContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
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

  // Branch 3: single-secret provider
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
