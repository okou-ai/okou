import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";
import { credentials } from "./helpers/codex-reset-credit-expiry";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";

const context = testContext();
const device = createAuthDeviceApiActions(context);
const userConfig = createUserConfigBddApi(context);
const runCredentials = createRunExecutionCredentials(context);

const SESSION_COOKIE = "__session=browser-session";

async function issueCliToken(actor: ApiTestUser): Promise<string> {
  const started = await device.startCliDevice();
  await device.requestCliApproval(
    actor,
    { device_code: started.device_code },
    [200],
  );
  const issued = await device.requestCliToken(started.device_code, [200]);
  if (issued.status !== 200) {
    throw new Error("Expected an issued CLI token");
  }
  return issued.body.access_token;
}

const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

/** Given of 002: an onboarded Pro admin with a native Codex subscription model. */
async function onboardProAdminWithCodexSubscription(): Promise<void> {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(admin);
  await publicPlanLifecycle(context, admin, "pro").update("active");
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({ plan_type: "pro" });
    }),
  );
  const providers = setupApp({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  await accept(
    providers.upsert({
      headers: sessionHeaders,
      body: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: credentials().raw },
      },
    }),
    [201],
  );
}

function modelPreferences() {
  return setupApp({
    context,
    routes: userModelPreferenceRoutes,
  })(userModelPreferenceContract);
}

async function selectModelWithEffort(
  model: "gpt-6-astra" | "gpt-6-luna",
  effort: "high" | "low",
) {
  return await accept(
    modelPreferences().update({
      headers: sessionHeaders,
      body: {
        selectedModel: model,
        serviceTier: null,
        modelSettingsPatch: { model, effort },
      },
    }),
    [200],
  );
}

async function switchToLunaWithoutSettings() {
  return await accept(
    modelPreferences().update({
      headers: sessionHeaders,
      body: { selectedModel: "gpt-6-luna", serviceTier: null },
    }),
    [200],
  );
}

const astraHigh = Object.freeze({ "gpt-6-astra": { effort: "high" } });
const bothSettings = Object.freeze({
  ...astraHigh,
  "gpt-6-luna": { effort: "low" },
});

function identity(actor: ApiTestUser) {
  return {
    userId: actor.userId,
    email: actor.email,
    orgId: actor.orgId ?? null,
  };
}

test("user-config.bdd-004 resolves session identities and rejects missing or non-bearer credentials", async () => {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  const loner = bdd.user({ orgId: null });
  userConfig.mockClerkUsers([admin, member, loner]);
  const cookie = { cookie: SESSION_COOKIE };

  for (const actor of [admin, member, loner]) {
    userConfig.mockSession(actor);
    const me = await userConfig.requestMe(cookie, [200]);
    expect(me.body).toMatchObject(identity(actor));
  }

  userConfig.mockSession(null);
  await expect(userConfig.requestMe(cookie, [401])).resolves.toMatchObject({
    body: { error: { code: "UNAUTHORIZED" } },
  });

  userConfig.mockSession(admin);
  for (const headers of [
    {},
    { authorization: "Basic YWRtaW46c2VjcmV0" },
    { authorization: "Bearer " },
  ]) {
    await expect(userConfig.requestMe(headers, [401])).resolves.toMatchObject({
      body: { error: { code: "UNAUTHORIZED" } },
    });
  }

  userConfig.mockSession(null);
  await expect(
    userConfig.requestMe({ authorization: "Bearer opaque-format" }, [401]),
  ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });

  userConfig.mockSession(member);
  const withCookie = await userConfig.requestMe(
    { authorization: "Bearer opaque-format", cookie: SESSION_COOKIE },
    [200],
  );
  expect(withCookie.body).toMatchObject(identity(member));
});

test("user-config.bdd-005 resolves CLI tokens with Clerk organization membership", async () => {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.provisionWorkspace(admin);
  const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  const loner = bdd.user();

  for (const actor of [admin, member]) {
    const token = await issueCliToken(actor);
    const me = await device.readMeWithBearer(token, actor, [200]);
    expect(me.body).toStrictEqual(identity(actor));
  }

  const lonerToken = await issueCliToken(loner);
  const withoutMembership = { ...loner, orgId: null };
  const lonerMe = await device.readMeWithBearer(
    lonerToken,
    withoutMembership,
    [200],
  );
  expect(lonerMe.body).toStrictEqual(identity(withoutMembership));
});

test("user-config.bdd-008 expires CLI tokens after their 90-day lifetime", async () => {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.provisionWorkspace(admin);
  const token = await issueCliToken(admin);

  const fresh = await device.readMeWithBearer(token, admin, [200]);
  expect(fresh.body).toMatchObject({
    userId: admin.userId,
    orgId: admin.orgId,
  });

  mockNow(now() + 91 * 24 * 60 * 60 * 1000);
  await expect(
    device.readMeWithBearer(token, admin, [401]),
  ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });
});

test("user-config.bdd-002 (1/3) stores the Astra effort and keeps it when switching to Luna", async () => {
  await onboardProAdminWithCodexSubscription();

  const astra = await selectModelWithEffort("gpt-6-astra", "high");
  expect(astra.body.modelSettings).toStrictEqual(astraHigh);

  const luna = await switchToLunaWithoutSettings();
  expect(luna.body).toMatchObject({
    selectedModel: "gpt-6-luna",
    modelSettings: astraHigh,
  });
});

test("user-config.bdd-002 (2/3) adds the Luna effort next to the Astra effort", async () => {
  await onboardProAdminWithCodexSubscription();
  await selectModelWithEffort("gpt-6-astra", "high");
  await switchToLunaWithoutSettings();

  const lunaLow = await selectModelWithEffort("gpt-6-luna", "low");

  expect(lunaLow.body.modelSettings).toStrictEqual(bothSettings);
});

test("user-config.bdd-002 (3/3) keeps both efforts through image, rejected effort and Auto updates", async () => {
  await onboardProAdminWithCodexSubscription();
  await selectModelWithEffort("gpt-6-astra", "high");
  await selectModelWithEffort("gpt-6-luna", "low");
  const preferences = modelPreferences();

  const image = await accept(
    preferences.updateImageModel({
      headers: sessionHeaders,
      body: { selectedImageModel: "gpt-image-2" },
    }),
    [200],
  );
  expect(image.body).toMatchObject({
    selectedModel: "gpt-6-luna",
    serviceTier: null,
    modelSettings: bothSettings,
    selectedImageModel: "gpt-image-2",
  });
  await expect(
    accept(preferences.get({ headers: sessionHeaders }), [200]),
  ).resolves.toMatchObject({ body: image.body });

  const ultra = await accept(
    preferences.update({
      headers: sessionHeaders,
      body: {
        selectedModel: "gpt-6-luna",
        serviceTier: null,
        modelSettingsPatch: { model: "gpt-6-luna", effort: "ultra" },
      },
    }),
    [400],
  );
  expect(ultra.body).toMatchObject({
    error: {
      message: "Reasoning effort is not available for this subscription",
    },
  });
  await expect(
    accept(preferences.get({ headers: sessionHeaders }), [200]),
  ).resolves.toMatchObject({
    body: { selectedModel: "gpt-6-luna", modelSettings: bothSettings },
  });

  const auto = await accept(
    preferences.update({
      headers: sessionHeaders,
      body: { selectedModel: null, serviceTier: null },
    }),
    [200],
  );
  expect(auto.body).toMatchObject({
    selectedModel: "auto",
    modelSettings: bothSettings,
  });
});

test("user-config.bdd-001 defaults to canonical Auto and accepts a null selection", async () => {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(admin);
  const preferences = modelPreferences();
  const autoPreference = {
    selectedModel: "auto",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: expect.any(String),
  };

  const initial = await accept(
    preferences.get({ headers: sessionHeaders }),
    [200],
  );
  const updated = await accept(
    preferences.update({
      headers: sessionHeaders,
      body: { selectedModel: null, serviceTier: null },
    }),
    [200],
  );
  const reread = await accept(
    preferences.get({ headers: sessionHeaders }),
    [200],
  );

  expect(initial.body).toStrictEqual(autoPreference);
  expect(updated.body).toStrictEqual(autoPreference);
  expect(reread.body).toStrictEqual(updated.body);
});

test(
  "user-config.bdd-009 reads identity with actual Runner-issued sandbox and agent credentials",
  { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
  async () => {
    const bdd = createBddApi(context);
    const member = bdd.user({ orgRole: "org:member" });
    const issued = await runCredentials.forActor(member);

    userConfig.mockSession(null);
    userConfig.mockClerkUsers([member]);
    userConfig.mockMembership(member, "org:member");

    const fromSandbox = await userConfig.requestMe(
      { authorization: `Bearer ${issued.sandboxToken}` },
      [200],
    );
    const fromAgent = await userConfig.requestMe(
      { authorization: `Bearer ${issued.token}` },
      [200],
    );
    const fromFake = await userConfig.requestMe(
      { authorization: "Bearer vm0_sandbox_not-a-real-token" },
      [401],
    );

    expect(fromSandbox.body).toStrictEqual(identity(member));
    expect(fromAgent.body).toStrictEqual(identity(member));
    expect(fromFake.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  },
);

test(
  "user-config.bdd-011 drops the organization from execution agent identity after public member removal",
  { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
  async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const token = await runCredentials.okouToken(member);

    await runCredentials.removeMember(member, admin);
    userConfig.mockSession(null);
    userConfig.mockClerkUsers([member]);

    const me = await userConfig.requestMe(
      { authorization: `Bearer ${token}` },
      [200],
    );

    expect(me.body).toStrictEqual({
      userId: member.userId,
      email: member.email,
      orgId: null,
    });
  },
);
