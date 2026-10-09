import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicFirewallFixture } from "./helpers/public-firewall-fixture";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

/*
Round-5 cluster auth-03 (AUTH-01/AUTH-03): user-owned configuration plus the
public identity matrix. Selected identity cases use normal APIs (onboarding,
CLI auth, and agents); the only mocks are the Clerk SDK boundary and the S3
accept for agent creation. The selected identity case uses actual Runner claims; adjacent capability
cases still use test signers and remain outside this batch.
*/

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const cfg = createUserConfigBddApi(context);

afterEach(() => {
  clearMockNow();
});

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function slug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

async function onboardAdmin(
  admin: ApiTestUser,
  options: { readonly slug?: string } = {},
): Promise<string> {
  const orgState: { slug?: string } = {};
  if (options.slug !== undefined) {
    orgState.slug = options.slug;
  }
  api.mockClerkOrg(admin, orgState);
  const bootstrap = await api.bootstrapLimitedFreeOnboarding(admin, {
    displayName: "BDD User Config Agent",
    sound: "calm",
  });
  if (bootstrap.status !== 200) {
    throw new Error(
      `Expected onboarding bootstrap to succeed, got ${bootstrap.status}`,
    );
  }
  return bootstrap.body.agentId;
}

describe("AUTH-03 user config CRUD error boundaries", () => {
  it("rejects invalid config bodies with 400s", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-a2") });

    const invalidPush = await cfg.requestRegisterPush(
      admin,
      { endpoint: "not-a-url", keys: { p256dh: "", auth: "" } },
      [400],
    );
    expectApiError(invalidPush.body);
    expect(invalidPush.body.error.code).toBe("BAD_REQUEST");

    const invalidTimezone = await cfg.requestUpdatePreferences(
      admin,
      { timezone: "Invalid/Timezone" },
      [400],
    );
    expectApiError(invalidTimezone.body);
    expect(invalidTimezone.body.error).toStrictEqual({
      message: "Invalid request",
      code: "BAD_REQUEST",
    });

    const emptyPreferences = await cfg.requestUpdatePreferences(
      admin,
      {},
      [400],
    );
    expectApiError(emptyPreferences.body);
    expect(emptyPreferences.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("AUTH-03 agent user connectors", () => {
  it("replaces, dedupes, clears, validates, and isolates per-agent user connectors", async () => {
    const admin = api.user();
    const otherAdmin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-b1") });
    api.acceptAgentStorageWrites();
    const agent = await api.createAgent(admin, {
      displayName: "BDD Connector Agent",
    });

    const set = await cfg.updateUserBuiltinConnectors(admin, agent.agentId, [
      "github",
      "slack",
    ]);
    expect(new Set(set.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack"]),
    );
    const readBack = await cfg.readUserConnectors(admin, agent.agentId);
    expect(new Set(readBack.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    const deduped = await cfg.updateUserBuiltinConnectors(
      admin,
      agent.agentId,
      ["slack", "github", "slack"],
    );
    expect(deduped.enabledConnectorSlugs).toHaveLength(2);
    expect(new Set(deduped.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    for (const operation of ["add", "remove"] as const) {
      const unchanged = await cfg.updateUserBuiltinConnectors(
        admin,
        agent.agentId,
        [],
        operation,
      );
      expect(new Set(unchanged.enabledConnectorSlugs)).toStrictEqual(
        new Set(["github", "slack"]),
      );
      const readUnchanged = await cfg.readUserConnectors(admin, agent.agentId);
      expect(new Set(readUnchanged.enabledConnectorSlugs)).toStrictEqual(
        new Set(["github", "slack"]),
      );
    }

    const added = await cfg.updateUserBuiltinConnectors(
      admin,
      agent.agentId,
      ["linear"],
      "add",
    );
    expect(new Set(added.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack", "linear"]),
    );
    const readAfterAdd = await cfg.readUserConnectors(admin, agent.agentId);
    expect(new Set(readAfterAdd.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack", "linear"]),
    );

    const replaced = await cfg.updateUserBuiltinConnectors(
      admin,
      agent.agentId,
      ["linear"],
    );
    expect(replaced.enabledConnectorSlugs).toStrictEqual(["linear"]);
    const readReplaced = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readReplaced.enabledConnectorSlugs).toStrictEqual(["linear"]);

    const cleared = await cfg.updateUserBuiltinConnectors(
      admin,
      agent.agentId,
      [],
    );
    expect(cleared.enabledConnectorSlugs).toStrictEqual([]);
    const readCleared = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readCleared.enabledConnectorSlugs).toStrictEqual([]);

    const invalid = await cfg.requestUpdateUserConnectors(
      admin,
      agent.agentId,
      ["github", "not-a-connector"],
      [400],
    );
    expectApiError(invalid.body);
    expect(invalid.body.error).toStrictEqual({
      message: "Invalid connector slugs: not-a-connector",
      code: "VALIDATION_ERROR",
    });

    const discoveryHidden = await cfg.updateUserBuiltinConnectors(
      admin,
      agent.agentId,
      ["bentoml"],
    );
    expect(discoveryHidden.enabledConnectorSlugs).toStrictEqual(["bentoml"]);
    const readAfterHidden = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readAfterHidden.enabledConnectorSlugs).toStrictEqual(["bentoml"]);

    const missingAgentId = randomUUID();
    const missingRead = await cfg.requestReadUserConnectors(
      admin,
      missingAgentId,
      [404],
    );
    expectApiError(missingRead.body);
    expect(missingRead.body.error.code).toBe("NOT_FOUND");
    const missingUpdate = await cfg.requestUpdateUserConnectors(
      admin,
      missingAgentId,
      ["github"],
      [404],
    );
    expectApiError(missingUpdate.body);
    expect(missingUpdate.body.error.code).toBe("NOT_FOUND");
    const missingEmptyUpdate = await cfg.requestUpdateUserConnectors(
      admin,
      missingAgentId,
      [],
      [404],
    );
    expectApiError(missingEmptyUpdate.body);
    expect(missingEmptyUpdate.body.error.code).toBe("NOT_FOUND");

    const crossOrgRead = await cfg.requestReadUserConnectors(
      otherAdmin,
      agent.agentId,
      [404],
    );
    expectApiError(crossOrgRead.body);
    expect(crossOrgRead.body.error.code).toBe("NOT_FOUND");

    const pat = await api.createCliToken(admin);
    cfg.mockMembership(admin, "org:admin");
    const patSet = await cfg.updateUserBuiltinConnectors(
      { bearer: pat.token },
      agent.agentId,
      ["github"],
    );
    expect(patSet.enabledConnectorSlugs).toStrictEqual(["github"]);
    const readAfterPat = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readAfterPat.enabledConnectorSlugs).toStrictEqual(["github"]);
  });

  it("serializes concurrent user-connector replaces for the same agent", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-b1r") });
    api.acceptAgentStorageWrites();
    const agent = await api.createAgent(admin, {
      displayName: "BDD Concurrent Connector Agent",
    });

    const sameSetUpdates = await Promise.all([
      cfg.updateUserBuiltinConnectors(admin, agent.agentId, [
        "github",
        "slack",
      ]),
      cfg.updateUserBuiltinConnectors(admin, agent.agentId, [
        "github",
        "slack",
      ]),
    ]);
    for (const update of sameSetUpdates) {
      expect(new Set(update.enabledConnectorSlugs)).toStrictEqual(
        new Set(["github", "slack"]),
      );
    }

    await Promise.all([
      cfg.updateUserBuiltinConnectors(admin, agent.agentId, ["github"]),
      cfg.updateUserBuiltinConnectors(admin, agent.agentId, ["slack"]),
    ]);
    const readBack = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readBack.enabledConnectorSlugs).toHaveLength(1);
    const enabledType = readBack.enabledConnectorSlugs[0];
    expect(["github", "slack"]).toContain(enabledType);

    await cfg.updateUserBuiltinConnectors(admin, agent.agentId, [], "replace");
    await Promise.all([
      cfg.updateUserBuiltinConnectors(admin, agent.agentId, ["github"], "add"),
      cfg.updateUserBuiltinConnectors(admin, agent.agentId, ["slack"], "add"),
    ]);
    const readAfterAdds = await cfg.readUserConnectors(admin, agent.agentId);
    expect(new Set(readAfterAdds.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    await Promise.all([
      cfg.updateUserBuiltinConnectors(
        admin,
        agent.agentId,
        ["github"],
        "remove",
      ),
      cfg.updateUserBuiltinConnectors(admin, agent.agentId, ["slack"], "add"),
    ]);
    const readAfterRemoveAdd = await cfg.readUserConnectors(
      admin,
      agent.agentId,
    );
    expect(readAfterRemoveAdd.enabledConnectorSlugs).toStrictEqual(["slack"]);
  });
});

describe("AUTH-03 user model preference", () => {
  it("defaults to Auto, rejects the Auto run model, and stores Auto as null", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-b2") });

    const defaults = await cfg.readModelPreference(admin);
    expect(defaults).toStrictEqual({
      selectedModel: null,
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: null,
      updatedAt: null,
    });

    // Nullable and explicit Auto are request intents; the legacy capture ID is
    // readable history metadata, not a selectable public model.
    const rejected = await cfg.requestUpdateModelPreference(
      admin,
      { selectedModel: SEEDED_SYSTEM_DEFAULT_MODEL, serviceTier: null },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("BAD_REQUEST");
    await expect(cfg.readModelPreference(admin)).resolves.toStrictEqual(
      defaults,
    );

    const cleared = await cfg.updateModelPreference(admin, {
      selectedModel: null,
      serviceTier: null,
    });
    expect(cleared).toStrictEqual({
      selectedModel: null,
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: null,
      updatedAt: null,
    });
    const readCleared = await cfg.readModelPreference(admin);
    expect(readCleared).toStrictEqual({
      selectedModel: null,
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: null,
      updatedAt: null,
    });
  });

  it("stores independent model effort preferences without deleting prior entries", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-effort") });
    // Astra is restricted on the limited-free plan this admin starts on.
    await createRunsApi(context).grantProEntitlement(admin);
    await createBddIntegrationApi(context).configureNativeSubscriptionModels(
      admin,
    );

    const astra = await cfg.updateModelPreference(admin, {
      selectedModel: "gpt-6-astra",
      serviceTier: null,
      modelSettingsPatch: { model: "gpt-6-astra", effort: "high" },
    });
    expect(astra.modelSettings).toStrictEqual({
      "gpt-6-astra": { effort: "high" },
    });

    const switched = await cfg.updateModelPreference(admin, {
      selectedModel: "gpt-6-luna",
      serviceTier: null,
    });
    expect(switched.modelSettings).toStrictEqual(astra.modelSettings);

    const luna = await cfg.updateModelPreference(admin, {
      selectedModel: "gpt-6-luna",
      serviceTier: null,
      modelSettingsPatch: { model: "gpt-6-luna", effort: "low" },
    });
    expect(luna.modelSettings).toStrictEqual({
      "gpt-6-astra": { effort: "high" },
      "gpt-6-luna": { effort: "low" },
    });

    const unsupported = await cfg.requestUpdateModelPreference(
      admin,
      {
        selectedModel: "gpt-6-luna",
        serviceTier: null,
        modelSettingsPatch: { model: "gpt-6-luna", effort: "ultra" },
      },
      [400],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toBe(
      "Reasoning effort is not available for this subscription",
    );
    await expect(cfg.readModelPreference(admin)).resolves.toMatchObject({
      selectedModel: "gpt-6-luna",
      modelSettings: luna.modelSettings,
    });
    // Selecting Auto stores the null selection and keeps model settings.
    const auto = await cfg.updateModelPreference(admin, {
      selectedModel: null,
      serviceTier: null,
    });
    expect(auto).toMatchObject({
      selectedModel: null,
      modelSettings: luna.modelSettings,
    });
    await expect(cfg.readModelPreference(admin)).resolves.toMatchObject({
      selectedModel: null,
    });
  });

  it("rejects contract-invalid model preference bodies and unauthenticated access", async () => {
    const admin = api.user();
    const noOrg = api.user({ orgId: null });

    const emptyBody = await cfg.rawUpdateModelPreference(admin, {}, [400]);
    expectApiError(emptyBody.body);
    expect(emptyBody.body.error.code).toBe("BAD_REQUEST");
    expect(emptyBody.body.error.message).toContain(
      "selectedModel: Invalid input",
    );

    const unauthenticated = await cfg.requestReadModelPreference(null, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const noOrgRead = await cfg.requestReadModelPreference(noOrg, [401]);
    expectApiError(noOrgRead.body);
    expect(noOrgRead.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-01 public session identity", () => {
  it("resolves clerk sessions and rejects missing or non-bearer credentials", async () => {
    const admin = api.user();
    const member = api.user({ orgRole: "org:member" });
    const solo = api.user({ orgId: null });
    cfg.mockClerkUsers([admin, member, solo]);
    const cookie = "__session=opaque";

    cfg.mockSession(admin);
    const adminProbe = await cfg.requestMe({ cookie }, [200]);
    expect(adminProbe.body).toStrictEqual({
      userId: admin.userId,
      email: admin.email,
      orgId: admin.orgId,
    });

    cfg.mockSession(member);
    const memberProbe = await cfg.requestMe({ cookie }, [200]);
    expect(memberProbe.body).toStrictEqual({
      userId: member.userId,
      email: member.email,
      orgId: member.orgId,
    });

    cfg.mockSession(solo);
    const soloProbe = await cfg.requestMe({ cookie }, [200]);
    expect(soloProbe.body).toStrictEqual({
      userId: solo.userId,
      email: solo.email,
      orgId: null,
    });

    cfg.mockSession(null);
    const unauthenticated = await cfg.requestMe({ cookie }, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const noCredentials = await cfg.requestMe({}, [401]);
    expectApiError(noCredentials.body);
    expect(noCredentials.body.error.code).toBe("UNAUTHORIZED");

    const basicHeader = await cfg.requestMe(
      { authorization: "Basic dXNlcjpwYXNz" },
      [401],
    );
    expectApiError(basicHeader.body);
    expect(basicHeader.body.error.code).toBe("UNAUTHORIZED");

    const emptyBearer = await cfg.requestMe(
      { authorization: "Bearer " },
      [401],
    );
    expectApiError(emptyBearer.body);
    expect(emptyBearer.body.error.code).toBe("UNAUTHORIZED");

    cfg.mockSession(member);
    const unknownShapeWithCookie = await cfg.requestMe(
      { authorization: "Bearer some-unknown-token-format", cookie },
      [200],
    );
    expect(unknownShapeWithCookie.body).toStrictEqual({
      userId: member.userId,
      email: member.email,
      orgId: member.orgId,
    });

    cfg.mockSession(null);
    const unknownShapeNoCookie = await cfg.requestMe(
      { authorization: "Bearer some-unknown-token-format" },
      [401],
    );
    expectApiError(unknownShapeNoCookie.body);
    expect(unknownShapeNoCookie.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-02 public CLI PAT identity", () => {
  it("resolves CLI PAT bearers with organization membership from clerk", async () => {
    const admin = api.user();
    const memberUser = api.user({ orgRole: "org:member" });
    const orphan = api.user();
    cfg.mockClerkUsers([admin, memberUser, orphan]);

    const adminKey = await api.createCliToken(admin);
    cfg.mockMembership(admin, "org:admin");
    const adminProbe = await cfg.requestMe(
      { authorization: `Bearer ${adminKey.token}` },
      [200],
    );
    expect(adminProbe.body).toStrictEqual({
      userId: admin.userId,
      email: admin.email,
      orgId: admin.orgId,
    });

    const memberKey = await api.createCliToken(memberUser);
    cfg.mockMembership(memberUser, "org:member");
    const memberProbe = await cfg.requestMe(
      { authorization: `Bearer ${memberKey.token}` },
      [200],
    );
    expect(memberProbe.body).toStrictEqual({
      userId: memberUser.userId,
      email: memberUser.email,
      orgId: memberUser.orgId,
    });

    const orphanKey = await api.createCliToken(orphan);
    cfg.mockMembership(orphan, null);
    const orphanProbe = await cfg.requestMe(
      { authorization: `Bearer ${orphanKey.token}` },
      [200],
    );
    expect(orphanProbe.body).toStrictEqual({
      userId: orphan.userId,
      email: orphan.email,
      orgId: null,
    });
  });

  it("serves cached membership inside the ttl and drops stale rows through the api", async () => {
    const admin = api.user();
    cfg.mockClerkUsers([admin]);
    const base = now();
    mockNow(base);
    const key = await api.createCliToken(admin);
    const bearer = { authorization: `Bearer ${key.token}` };

    cfg.mockMembership(admin, "org:admin");
    const first = await cfg.requestMe(bearer, [200]);
    expect(first.body).toStrictEqual({
      userId: admin.userId,
      email: admin.email,
      orgId: admin.orgId,
    });

    cfg.mockMembership(admin, null);
    mockNow(base + 30_000);
    const cached = await cfg.requestMe(bearer, [200]);
    expect(cached.body).toStrictEqual(first.body);

    mockNow(base + 120_000);
    const stale = await cfg.requestMe(bearer, [200]);
    expect(stale.body).toStrictEqual({
      userId: admin.userId,
      email: admin.email,
      orgId: null,
    });

    cfg.mockMembership(admin, "org:admin");
    mockNow(base + 125_000);
    const refreshed = await cfg.requestMe(bearer, [200]);
    expect(refreshed.body).toStrictEqual(first.body);
  });

  it("rejects forged and malformed pat bearers", async () => {
    cfg.mockSession(null);

    const forged = await cfg.requestMe(
      {
        authorization: `Bearer ${cfg.forgedPatBearer(`user_${randomUUID()}`)}`,
      },
      [401],
    );
    expectApiError(forged.body);
    expect(forged.body.error.code).toBe("UNAUTHORIZED");

    const garbage = await cfg.requestMe(
      { authorization: "Bearer vm0_pat_garbage" },
      [401],
    );
    expectApiError(garbage.body);
    expect(garbage.body.error.code).toBe("UNAUTHORIZED");
  });

  it("expires CLI PATs by their db expiry under mocked time", async () => {
    const admin = api.user();
    cfg.mockClerkUsers([admin]);
    const base = now();
    mockNow(base);
    const key = await api.createCliToken(admin);
    cfg.mockMembership(admin, "org:admin");
    const fresh = await cfg.requestMe(
      { authorization: `Bearer ${key.token}` },
      [200],
    );
    expect(fresh.body).toMatchObject({
      userId: admin.userId,
      orgId: admin.orgId,
    });

    mockNow(base + 91 * 24 * 60 * 60 * 1000);
    const expired = await cfg.requestMe(
      { authorization: `Bearer ${key.token}` },
      [401],
    );
    expectApiError(expired.body);
    expect(expired.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-01 sandbox and agent bearers", () => {
  it("reads identity with actual Runner-issued sandbox and agent credentials", async () => {
    const owned = createPublicFirewallFixture(context);
    await owned.run(async () => {
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      runs.configureRunnerGroup();
      await owned.fund();
      await runs.ensurePersonalSubscriptionModel(owned.actor, {
        model: "claude-fable-5-1",
      });
      const agent = await bdd.createAgent(owned.actor, {
        visibility: "private",
      });
      owned.registerAgent(agent.agentId);
      const run = await runs.createThreadRun(owned.actor, {
        agentId: agent.agentId,
        prompt: "read the identity issued to this Run",
        model: "claude-fable-5-1",
      });
      const claim = await runs.claimRunnerJob(run.runId);
      owned.registerClaim(run.runId, claim.sandboxToken);
      cfg.mockSession(null);
      cfg.mockClerkUsers([owned.actor]);
      cfg.mockMembership(owned.actor, "org:admin");
      const agentToken = claim.platformEnvironment?.OKOU_TOKEN;
      if (!agentToken) {
        throw new Error("Expected the actual claim's Okou token");
      }
      for (const token of [claim.sandboxToken, agentToken]) {
        const identity = await cfg.requestMe(
          { authorization: `Bearer ${token}` },
          [200],
        );
        expect(identity.body).toStrictEqual({
          userId: owned.actor.userId,
          orgId: owned.actor.orgId,
          email: owned.actor.email,
        });
      }
      const badSignature = await cfg.requestMe(
        { authorization: "Bearer vm0_sandbox_not-a-real-token" },
        [401],
      );
      expectApiError(badSignature.body);
      expect(badSignature.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  it("enforces agent capabilities on real user-config routes", async () => {
    const admin = api.user();
    api.acceptAgentStorageWrites();
    const agent = await api.createAgent(admin, {
      displayName: "BDD Nova Cap Agent",
    });
    cfg.mockMembership(admin, "org:admin");

    const readCap = cfg.okouBearer(admin, ["agent:read"]);
    const updated = await cfg.updateUserBuiltinConnectors(
      { bearer: readCap.token },
      agent.agentId,
      ["github"],
    );
    expect(updated.enabledConnectorSlugs).toStrictEqual(["github"]);
    const readBack = await cfg.readUserConnectors(admin, agent.agentId);
    expect(readBack.enabledConnectorSlugs).toStrictEqual(["github"]);

    const fileCap = cfg.okouBearer(admin, ["file:read"]);
    const forbidden = await cfg.requestUpdateUserConnectors(
      { bearer: fileCap.token },
      agent.agentId,
      ["github"],
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });

    const pushForbidden = await cfg.requestRegisterPush(
      { bearer: fileCap.token },
      {
        endpoint: "https://push.example.test/subscription",
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
      },
      [403],
    );
    expectApiError(pushForbidden.body);
    expect(pushForbidden.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
  });

  it("accepts sandbox and agent bearers on auth me", async () => {
    const sandboxActor = api.user();
    const writeActor = api.user();
    const bareActor = api.user();
    cfg.mockSession(null);

    cfg.mockClerkUsers([sandboxActor]);
    const sandbox = cfg.sandboxBearer(sandboxActor);
    const sandboxMe = await cfg.readMe({ bearer: sandbox.token });
    expect(sandboxMe).toStrictEqual({
      userId: sandboxActor.userId,
      email: sandboxActor.email,
      orgId: sandboxActor.orgId,
    });

    cfg.mockClerkUsers([writeActor]);
    cfg.mockMembership(writeActor, null);
    const okouWrite = cfg.okouBearer(writeActor, ["file:write"]);
    const okouWriteMe = await cfg.readMe({ bearer: okouWrite.token });
    expect(okouWriteMe).toStrictEqual({
      userId: writeActor.userId,
      email: writeActor.email,
      orgId: null,
    });

    cfg.mockClerkUsers([bareActor]);
    cfg.mockMembership(bareActor, null);
    const okouBare = cfg.okouBearer(bareActor, []);
    const okouBareMe = await cfg.readMe({ bearer: okouBare.token });
    expect(okouBareMe).toStrictEqual({
      userId: bareActor.userId,
      email: bareActor.email,
      orgId: null,
    });
  });

  it("serves auth me from the fresh user cache and refreshes after the ttl", async () => {
    const admin = api.user();
    const base = now();
    mockNow(base);

    cfg.mockClerkUsers([admin]);
    const first = await cfg.readMe(admin);
    expect(first).toStrictEqual({
      userId: admin.userId,
      email: admin.email,
      orgId: admin.orgId,
    });
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledExactlyOnceWith(
      admin.userId,
    );
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();

    const rotatedEmail = `rotated-${shortId()}@example.test`;
    cfg.mockClerkUsers([{ ...admin, email: rotatedEmail }]);
    const cached = await cfg.readMe(admin);
    expect(cached.email).toBe(admin.email);
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledOnce();

    mockNow(base + 16 * 60 * 1000);
    const refreshed = await cfg.readMe(admin);
    expect(refreshed.email).toBe(rotatedEmail);
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(2);
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });
});
