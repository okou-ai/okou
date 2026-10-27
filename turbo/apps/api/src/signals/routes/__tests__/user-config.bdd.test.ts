import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { expectApiError } from "./helpers/api-bdd";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { env, mockEnv } from "../../../lib/env";
import { publicChatActor } from "./helpers/public-chat-actor";

/*
Round-5 cluster auth-03 (AUTH-01/AUTH-03): user-owned configuration plus the
public identity matrix. Selected identity cases use normal APIs (onboarding,
CLI auth, and agents); the only mocks are the Clerk SDK boundary and the S3
accept for agent creation. Runner credentials come from actual claims; CLI
credentials come from device authorization.
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
  });
  if (bootstrap.status !== 200) {
    throw new Error(
      `Expected onboarding bootstrap to succeed, got ${bootstrap.status}`,
    );
  }
  return bootstrap.body.agentId;
}

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
  it("defaults to canonical Auto and accepts a null selection", async () => {
    const admin = api.user();
    await onboardAdmin(admin, { slug: slug("bdd-uc-b2") });

    const defaults = await cfg.readModelPreference(admin);
    expect(defaults).toStrictEqual({
      selectedModel: "auto",
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: null,
      updatedAt: expect.any(String),
    });

    const cleared = await cfg.updateModelPreference(admin, {
      selectedModel: null,
      serviceTier: null,
    });
    expect(cleared).toStrictEqual({
      selectedModel: "auto",
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: null,
      updatedAt: expect.any(String),
    });
    const readCleared = await cfg.readModelPreference(admin);
    expect(readCleared).toStrictEqual(cleared);
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
    // Selecting Auto stores its canonical identity and keeps model settings.
    const auto = await cfg.updateModelPreference(admin, {
      selectedModel: null,
      serviceTier: null,
    });
    expect(auto).toMatchObject({
      selectedModel: "auto",
      modelSettings: luna.modelSettings,
    });
    await expect(cfg.readModelPreference(admin)).resolves.toMatchObject({
      selectedModel: "auto",
    });
  });

  it("rejects model preference access without authentication or an organization", async () => {
    const noOrg = api.user({ orgId: null });

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

  it("rejects a tampered issued PAT and malformed pat bearers", async () => {
    const actor = api.user();
    const issued = await api.createCliToken(actor);
    cfg.mockSession(null);
    const parts = issued.token.split(".");
    if (parts.length !== 3) {
      throw new Error("Expected the device flow to issue a JWT PAT");
    }
    const signature = parts[2];
    if (!signature) {
      throw new Error("Expected the issued PAT signature");
    }
    parts[2] = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
    const tampered = await cfg.requestMe(
      { authorization: `Bearer ${parts.join(".")}` },
      [401],
    );
    expectApiError(tampered.body);
    expect(tampered.body.error.code).toBe("UNAUTHORIZED");

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
    const fixture = createChatEventsFixture(context);
    const runs = createRunsApi(context);
    let carrier:
      | {
          actor: ApiTestUser;
          agentId: string;
          kmsKeyId: string | undefined;
          storageBucket: string;
          runId?: string;
          sandboxToken?: string;
        }
      | undefined;
    const owner = createFixtureOperationOwner(async () => {
      if (!carrier) {
        return;
      }
      mockEnv("SECRETS_KMS_KEY_ID", carrier.kmsKeyId);
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", carrier.storageBucket);
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      if (carrier.runId) {
        const current = await runs.readRun(carrier.actor, carrier.runId);
        if (current.status === "pending" || current.status === "running") {
          await runs.requestCancelRun(carrier.actor, carrier.runId, [200]);
        }
        if (
          carrier.sandboxToken &&
          ["pending", "running", "cancelled"].includes(current.status)
        ) {
          await createWebhookCallbackApi(context).requestAgentComplete(
            {
              runId: carrier.runId,
              exitCode: 1,
              error: "Identity carrier cancelled",
            },
            { authorization: `Bearer ${carrier.sandboxToken}` },
            [200],
          );
        }
      }
      await flushWaitUntilForTest();
      await api.deleteAgent(carrier.actor, carrier.agentId);
      await flushWaitUntilForTest();
    });
    await owner.run(async () => {
      const owned = await fixture.entitledNativeChatActor();
      const activeCarrier: NonNullable<typeof carrier> = {
        actor: owned.actor,
        agentId: owned.agentId,
        kmsKeyId: env("SECRETS_KMS_KEY_ID"),
        storageBucket: env("R2_USER_STORAGES_BUCKET_NAME"),
      };
      carrier = activeCarrier;
      const run = await fixture.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "read the identity issued to this Run",
        model: "claude-fable-5-1",
      });
      activeCarrier.runId = run.runId;
      const { claim } = await fixture.claimChatRun(
        owned.runnerGroup,
        run.runId,
      );
      activeCarrier.sandboxToken = claim.sandboxToken;
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

  it("updates user connectors with a claimed agent token and rejects push registration", async () => {
    const owned = await publicChatActor(context);
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "configure connectors with the issued agent credential",
    });
    const { claim } = await owned.claimChatRun(owned.runnerGroup, run.runId);
    const token = claim.platformEnvironment?.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected the claim's Okou token");
    }
    await owned.run(async () => {
      cfg.mockMembership(owned.actor, "org:admin");
      const updated = await cfg.updateUserBuiltinConnectors(
        { bearer: token },
        owned.agentId,
        ["github"],
      );
      expect(updated.enabledConnectorSlugs).toStrictEqual(["github"]);
      const readBack = await cfg.readUserConnectors(owned.actor, owned.agentId);
      expect(readBack.enabledConnectorSlugs).toStrictEqual(["github"]);

      const pushForbidden = await cfg.requestRegisterPush(
        { bearer: token },
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
  });

  it("drops the organization from claimed agent identity after public member removal", async () => {
    const owned = await publicChatActor(context);
    const run = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "read identity after organization membership removal",
    });
    const { claim } = await owned.claimChatRun(owned.runnerGroup, run.runId);
    const token = claim.platformEnvironment?.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected the claim's Okou token");
    }
    await owned.run(async () => {
      const admin = api.user({ orgId: owned.actor.orgId });
      api.mockClerkOrg(admin, {
        members: [
          { actor: admin, role: "org:admin" },
          { actor: owned.actor, role: "org:member" },
        ],
      });
      await api.removeMember(admin, { email: owned.actor.email });
      cfg.mockSession(null);
      cfg.mockClerkUsers([owned.actor]);
      cfg.mockMembership(owned.actor, null);
      const identity = await cfg.readMe({ bearer: token });
      expect(identity).toStrictEqual({
        userId: owned.actor.userId,
        email: owned.actor.email,
        orgId: null,
      });
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

    const rotatedEmail = `rotated-${shortId()}@example.test`;
    cfg.mockClerkUsers([{ ...admin, email: rotatedEmail }]);
    const cached = await cfg.readMe(admin);
    expect(cached.email).toBe(admin.email);
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledOnce();

    mockNow(base + 16 * 60 * 1000);
    const refreshed = await cfg.readMe(admin);
    expect(refreshed.email).toBe(rotatedEmail);
    expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(2);
  });
});
