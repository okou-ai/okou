import { randomUUID } from "node:crypto";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { onTestFinished } from "vitest";
import { accept, type TestContext } from "../__tests__/test-context";
import { setupApp } from "../__tests__/test-helpers";
import { now } from "../lib/time";
import { meModelProviderAccountRoutes } from "../signals/routes/me-model-provider-accounts";
import { createAuthDeviceSupportApi } from "../signals/routes/__tests__/helpers/api-bdd-auth-device-support";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
  makeCodexAuthJson,
  makeCodexJwt,
} from "../signals/routes/__tests__/helpers/api-bdd-auth-device";
import { createRouteMocks } from "../signals/routes/__tests__/helpers/route-test";
import { createBddApi } from "../signals/routes/__tests__/helpers/api-bdd";
import { createMiscRoutesApi } from "../signals/routes/__tests__/helpers/api-bdd-misc";
import { updateFeatureSwitchesForUser } from "../signals/routes/__tests__/helpers/feature-switches";
import type { Phase2SourceBinding } from "../signals/services/__tests__/pi-memory-phase2-job.test-fixture";

export async function createPhase2CodexProvider(
  context: TestContext,
  owner: { orgId: string; userId: string },
  {
    subscription,
    registerCleanup = onTestFinished,
    miscApi,
  }: {
    subscription?: { accountId: string; expired: boolean };
    registerCleanup?: (cleanup: () => Promise<void>) => void;
    miscApi?: ReturnType<typeof createMiscRoutesApi>;
  } = {},
) {
  const actor = createBddApi(context).user({ ...owner, orgRole: "org:admin" });
  const misc = miscApi ?? createMiscRoutesApi(context);
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.PiMemory]: true,
  });
  const account = subscription?.accountId ?? `account-${randomUUID()}`;
  const token = makeCodexJwt({
    exp: Math.floor(now() / 1000) + (subscription?.expired ? -60 : 7200),
    identity: account,
  });
  const created = await misc.upsertPersonalModelProvider(
    actor,
    {
      type: "codex-oauth-token",
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
  registerCleanup(async () => {
    await misc.deletePersonalModelProvider(
      actor,
      "codex-oauth-token",
      [204, 404],
    );
  });
  return {
    key: token,
    account,
    binding: {
      modelProvider: "codex-oauth-token",
      modelProviderId: created.body.provider.id,
      modelProviderCredentialScope: "member",
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

async function createAdditionalPhase2CodexAccount(
  context: TestContext,
  owner: { orgId: string; userId: string },
): Promise<string> {
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
  return result.body.provider.id;
}

export async function activateAnotherPhase2Codex(
  context: TestContext,
  owner: { orgId: string; userId: string },
) {
  const id = await createAdditionalPhase2CodexAccount(context, owner);
  const actor = createBddApi(context).user({ ...owner, orgRole: "org:admin" });
  await createAuthDeviceSupportApi(
    context,
  ).activatePersonalModelProviderAccount(actor, id);
}

/** Complete real account creation before entering a historical worker clock. */
export async function preparePhase2CodexActivation(
  context: TestContext,
  owner: { orgId: string; userId: string },
  originalAccountId: string,
) {
  const id = await createAdditionalPhase2CodexAccount(context, owner);
  const actor = createBddApi(context).user({ ...owner, orgRole: "org:admin" });
  const support = createAuthDeviceSupportApi(context);
  await support.activatePersonalModelProviderAccount(actor, originalAccountId);
  return async () => {
    await support.activatePersonalModelProviderAccount(actor, id);
  };
}
