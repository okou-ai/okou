import { createAuthDeviceSupportApi } from "../signals/routes/__tests__/helpers/api-bdd-auth-device-support";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
  makeCodexAuthJson,
  makeCodexJwt,
} from "../signals/routes/__tests__/helpers/api-bdd-auth-device";
import { randomUUID } from "node:crypto";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  modelProviderConnectionsMainContract,
  modelProviderConnectionsByIdContract,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { secrets } from "@okouai/db/schema/secret";
import { eq } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { accept, type TestContext } from "../__tests__/test-context";
import { setupApp } from "../__tests__/test-helpers";
import { db } from "../lib/db";
import { now } from "../lib/time";
import { meModelProviderAccountRoutes } from "../signals/routes/me-model-provider-accounts";
import { modelProviderGatewayRoutes } from "../signals/routes/model-provider-gateways";
import { createRouteMocks } from "../signals/routes/__tests__/helpers/route-test";
import { createBddApi } from "../signals/routes/__tests__/helpers/api-bdd";
import { createMiscRoutesApi } from "../signals/routes/__tests__/helpers/api-bdd-misc";
import { updateFeatureSwitchesForUser } from "../signals/routes/__tests__/helpers/feature-switches";
import type { Phase2SourceBinding } from "../signals/services/__tests__/pi-memory-phase2-job.test-fixture";

export const phase2ApiKeyRoutes = [
  {
    type: "openai-api-key",
    url: "https://api.openai.com/v1/responses",
    model: "gpt-5.6-terra",
  },
  {
    type: "openrouter-codex",
    url: "https://openrouter.ai/api/v1/responses",
    model: "openai/gpt-5.6-terra",
  },
  {
    type: "vercel-ai-gateway-codex",
    url: "https://ai-gateway.vercel.sh/v1/responses",
    model: "openai/gpt-5.6-terra",
  },
] as const;
export type Phase2ProviderType =
  | (typeof phase2ApiKeyRoutes)[number]["type"]
  | "codex-oauth-token"
  | "custom-openai-responses";

async function createPhase2CustomProvider(
  context: TestContext,
  owner: { orgId: string; userId: string },
  mapsTerra: boolean,
) {
  const key = `phase2-key-${randomUUID()}`;
  createRouteMocks(context).clerk.session(
    owner.userId,
    owner.orgId,
    "org:admin",
  );
  const created = await accept(
    setupApp({ context, routes: modelProviderGatewayRoutes })(
      modelProviderConnectionsMainContract,
    ).create({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        displayName: "Phase 2 source",
        secret: key,
        surfaces: [
          {
            protocol: "openai-responses",
            apiBaseUrl: "https://phase2-gateway.example/v1",
            authHeaderName: "x-source-key",
            authHeaderTemplate: "Key {{secret}}",
            modelMappings: mapsTerra
              ? { "gpt-5.6-terra": "mapped-terra" }
              : { "gpt-5.6-luna": "mapped-luna" },
          },
        ],
      },
    }),
    [201],
  );
  const surface = created.body.surfaces[0];
  if (!surface) {
    throw new Error("Missing custom surface");
  }
  onTestFinished(async () => {
    createRouteMocks(context).clerk.session(
      owner.userId,
      owner.orgId,
      "org:admin",
    );
    await accept(
      setupApp({ context, routes: modelProviderGatewayRoutes })(
        modelProviderConnectionsByIdContract,
      ).delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: created.body.id },
      }),
      [204],
    );
  });
  return {
    key,
    account: undefined,
    binding: {
      modelProvider: "custom-openai-responses",
      modelProviderId: surface.id,
      modelProviderCredentialScope: "org",
    } satisfies Phase2SourceBinding,
  };
}

export async function createPhase2Provider(
  context: TestContext,
  owner: { orgId: string; userId: string },
  type: Phase2ProviderType,
  scope: "org" | "member" = "org",
  {
    mapsTerra = true,
    subscription,
  }: {
    mapsTerra?: boolean;
    subscription?: { accountId: string; expired: boolean };
  } = {},
) {
  const actor = createBddApi(context).user({ ...owner, orgRole: "org:admin" });
  const misc = createMiscRoutesApi(context);
  const key = `phase2-key-${randomUUID()}`;
  if (type === "custom-openai-responses") {
    return await createPhase2CustomProvider(context, owner, mapsTerra);
  }
  if (type === "codex-oauth-token") {
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.PiMemory]: true,
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
    });
    const account = subscription?.accountId ?? `account-${randomUUID()}`;
    const token = makeCodexJwt({
      exp: Math.floor(now() / 1000) + (subscription?.expired ? -60 : 7200),
      identity: account,
    });
    const created = await misc.upsertPersonalModelProvider(
      actor,
      {
        type,
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accessToken: token,
            accountId: account,
            refreshToken: `refresh-${account}`,
          }),
        },
      },
      [200, 201],
    );
    if (created.status !== 200 && created.status !== 201) {
      throw new Error("Missing subscription account");
    }
    onTestFinished(async () => {
      await misc.deletePersonalModelProvider(actor, type, [204, 404]);
    });
    return {
      key: token,
      account,
      binding: {
        modelProvider: type,
        modelProviderId: created.body.provider.id,
        modelProviderCredentialScope: "member",
      } satisfies Phase2SourceBinding,
    };
  }
  const created = await misc.upsertOrgModelProvider(
    actor,
    { type, secret: key },
    [200, 201],
  );
  if (created.status !== 200 && created.status !== 201) {
    throw new Error("Missing API-key provider");
  }
  const id = created.body.provider.id;
  const historicalOwner = async (userId: string) => {
    // Historical member API keys no longer have a settings write API.
    const [provider] = await db()
      .update(modelProviders)
      .set({ userId })
      .where(eq(modelProviders.id, id))
      .returning({ secretId: modelProviders.secretId });
    if (provider?.secretId) {
      await db()
        .update(secrets)
        .set({ userId })
        .where(eq(secrets.id, provider.secretId));
    }
  };
  if (scope === "member") {
    await historicalOwner(owner.userId);
  }
  onTestFinished(async () => {
    if (scope === "member") {
      await historicalOwner("__org__");
    }
    await misc.deleteOrgModelProvider(actor, type, [204, 404]);
  });
  return {
    key,
    account: undefined,
    binding: {
      modelProvider: type,
      modelProviderId: id,
      modelProviderCredentialScope: scope,
    } satisfies Phase2SourceBinding,
  };
}

export async function disconnectPhase2Codex(
  context: TestContext,
  owner: { orgId: string; userId: string },
  id: string,
) {
  createRouteMocks(context).clerk.session(
    owner.userId,
    owner.orgId,
    "org:admin",
  );
  await accept(
    setupApp({ context, routes: meModelProviderAccountRoutes })(
      personalModelProviderAccountsByIdContract,
    ).delete({
      headers: { authorization: "Bearer clerk-session" },
      params: { id },
    }),
    [204],
  );
}

export async function activateAnotherPhase2Codex(
  context: TestContext,
  owner: { orgId: string; userId: string },
) {
  const actor = createBddApi(context).user({ ...owner, orgRole: "org:admin" });
  const auth = createAuthDeviceApiActions(context);
  mockCodexDeviceAuthProvider({
    tokenScope: "personal",
    accountId: `active-${randomUUID()}`,
  });
  const started = await auth.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected device auth start");
  }
  const result = await auth.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in result.body) || result.body.status !== "complete") {
    throw new Error("Expected device auth completion");
  }
  await createAuthDeviceSupportApi(
    context,
  ).activatePersonalModelProviderAccount(actor, result.body.provider.id);
}
