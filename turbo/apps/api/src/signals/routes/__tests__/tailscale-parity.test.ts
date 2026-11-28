import { createHash, randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

async function createMember(
  options: {
    readonly userId?: string;
    readonly orgId?: string;
    readonly role?: "admin" | "member";
  } = {},
): Promise<Actor> {
  const actor: Actor = {
    userId: options.userId ?? `user_${randomUUID()}`,
    orgId: options.orgId ?? `org_${randomUUID()}`,
    role: options.role ?? "member",
  };
  await clerkDirectory.set(seedOrgMembership$, actor, context.signal);
  return actor;
}

function signIn(actor: Actor): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role === "admin" ? "org:admin" : "org:member",
  );
}

const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
const logins = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};
const tailscale = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};
const cloudflareAccess = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const remoteAccess = () => {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
};
const runnerSsh = () => {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
};

function runnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function hostKeyFor(seed: string) {
  return {
    algorithm: "ssh-ed25519" as const,
    fingerprint: `SHA256:${createHash("sha256")
      .update(seed)
      .digest("base64")
      .replace(/=+$/u, "")}`,
  };
}

function credentialIdOf(body: Record<string, unknown>): string {
  if (typeof body.credentialId !== "string") {
    throw new Error("Expected saved credentialId on SSH connection response");
  }
  return body.credentialId;
}

function pinnedGeneration(body: {
  readonly outcome: string;
  readonly generation?: number;
}): number {
  if (body.outcome !== "pinned" || typeof body.generation !== "number") {
    throw new Error(`Expected pinned outcome, received ${body.outcome}`);
  }
  return body.generation;
}

function readRealtimePublications() {
  const gets = context.mocks.ably.channelGet.mock;
  const publishes = context.mocks.ably.publish.mock;
  return publishes.calls.map((call, index) => {
    const publishedAt = publishes.invocationCallOrder[index] ?? 0;
    let channel = "";
    for (const [getIndex, order] of gets.invocationCallOrder.entries()) {
      if (order < publishedAt) {
        channel = String(gets.calls[getIndex]?.[0] ?? "");
      }
    }
    return { channel, topic: call[0], payload: call[1] };
  });
}

function clearRealtimePublications() {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

async function launchActorRun(
  actor: Actor,
  options: {
    readonly runnerGroup?: string;
    readonly bootstrapOrg?: boolean;
    readonly grantTeam?: boolean;
  } = {},
) {
  const fixture = createChatEventsFixture(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const apiUser: ApiTestUser = bdd.user({
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: actor.role === "admin" ? "org:admin" : "org:member",
  });
  const owner = publicRunOwner(context, apiUser);
  fixture.chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();

  const runnerGroup =
    options.runnerGroup ??
    (await runs.configureRunnerGroup({ maxConcurrent: 4 }));
  if (options.bootstrapOrg !== false) {
    await owner.run(() => {
      return bdd.bootstrapLimitedFreeOnboarding(apiUser);
    });
    if (options.grantTeam) {
      await runs.grantProEntitlement(apiUser, { tier: "team" });
    }
  } else {
    await owner.run(() => {
      return bdd.completeOnboarding(apiUser);
    });
  }
  const launched = await owner.run(() => {
    return fixture.sendChatRun(apiUser, {
      prompt: "Manage Tailscale SSH host",
      model: null,
    });
  });
  await owner.executionInput(launched.runId);
  const dispatched = runs.dispatchedRun(launched.runId);
  return {
    runId: launched.runId,
    runnerGroup,
    runnerIdentity: {
      runnerId: dispatched.runnerId,
      heartbeatGeneration: dispatched.heartbeatGeneration,
    },
  };
}

async function enableSshDefault(actor: Actor, connectionId: string) {
  signIn(actor);
  await accept(
    remoteAccess().updateHostDefault({
      headers,
      params: { protocol: "ssh", connectionId },
      body: { enabled: true },
    }),
    [200],
  );
}

function inlineLogin() {
  return {
    create: {
      name: `Login ${randomUUID().slice(0, 8)}`,
      username: "deploy",
      authentication: {
        method: "password" as const,
        password: `pw-${randomUUID()}`,
      },
    },
  };
}

async function createConfig(
  options: { readonly scope?: "personal" | "organization" } = {},
) {
  const id = randomUUID();
  return (
    await accept(
      tailscale().create({
        headers,
        body: {
          id,
          name: `Tailnet ${id.slice(0, 8)}`,
          credentials: {
            clientId: `client-${randomUUID()}`,
            clientSecret: `secret-${randomUUID()}`,
          },
          tags: ["tag:okou"],
          ...(options.scope ? { scope: options.scope } : {}),
        },
      }),
      [201],
    )
  ).body;
}

async function createTailscaleHost(configId: string, host = "100.64.0.10") {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: `Host ${randomUUID().slice(0, 8)}`,
          host,
          port: 22,
          credential: inlineLogin(),
          transport: { type: "tailscale", configId },
        },
      }),
      [201],
    )
  ).body;
}

describe("Tailscale configuration parity", () => {
  beforeAll(() => {
    setupApp({
      context,
      routes: [
        ...tailscaleRoutes,
        ...cloudflareAccessRoutes,
        ...sshConnectionsRoutes,
        ...chatRemoteAccessRoutes,
        ...runnerSshRoutes,
      ],
    });
  });

  it("tailscale-parity-003 allows another current admin to adopt shared configuration but hides the resulting Personal configuration from its former creator", async () => {
    const creator = await createMember({ role: "admin" });
    const secondAdmin = await createMember({
      orgId: creator.orgId,
      role: "admin",
    });

    signIn(creator);
    const shared = await createConfig({ scope: "organization" });
    const creatorHost = await createTailscaleHost(shared.id, "100.64.0.11");

    signIn(secondAdmin);
    const secondAdminHost = await createTailscaleHost(shared.id, "100.64.0.12");

    const preview = await accept(
      tailscale().impactPreview({
        headers,
        params: { configId: shared.id },
        query: { operation: "convert" },
      }),
      [200],
    );
    const converted = await accept(
      tailscale().convertToPersonal({
        headers,
        params: { configId: shared.id },
        body: {
          expectedRevision: shared.revision,
          impactSnapshot: preview.body.impactSnapshot,
        },
      }),
      [200],
    );
    expect(converted.body.scope).toBe("personal");
    expect(converted.body.revision).toBe(2);

    const secondAdminHosts = await accept(hosts().list({ headers }), [200]);
    expect(secondAdminHosts.body.connections).toStrictEqual([
      expect.objectContaining({
        id: secondAdminHost.id,
        generation: secondAdminHost.generation + 1,
        transport: { type: "tailscale", configId: shared.id },
      }),
    ]);

    signIn(creator);
    const creatorConfigs = await accept(tailscale().list({ headers }), [200]);
    expect(creatorConfigs.body.configs).toStrictEqual([]);

    const creatorHosts = await accept(hosts().list({ headers }), [200]);
    expect(creatorHosts.body.connections).toStrictEqual([
      expect.objectContaining({
        id: creatorHost.id,
        transport: { type: "tailscale", needsRebind: true },
      }),
    ]);

    await accept(
      tailscale().convertToOrganization({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: 2 },
      }),
      [404],
    );

    signIn(secondAdmin);
    const promoted = await accept(
      tailscale().convertToOrganization({
        headers,
        params: { configId: shared.id },
        body: { expectedRevision: 2 },
      }),
      [200],
    );
    expect(promoted.body.scope).toBe("organization");
  });

  it("tailscale-parity-007 rejects invisible tailscale host-update configuration before login encryption even when KMS fails", async () => {
    const actor = await createMember();
    const peer = await createMember({ orgId: actor.orgId });
    const otherOrgActor = await createMember({ userId: actor.userId });

    signIn(peer);
    const peerConfig = await createConfig();

    signIn(otherOrgActor);
    const otherOrgConfig = await createConfig();

    signIn(actor);
    const ownConfig = await createConfig();
    const host = (
      await accept(
        hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Direct peer",
            host: "peer.example.com",
            port: 443,
            credential: inlineLogin(),
          },
        }),
        [201],
      )
    ).body;
    const beforeHosts = (await accept(hosts().list({ headers }), [200])).body
      .connections;
    const beforeLogins = (await accept(logins().list({ headers }), [200])).body
      .credentials;

    const kms = useSecretKmsProbe(() => {
      return Promise.reject(new Error("KMS unavailable"));
    });

    const invisibleConfigIds = [randomUUID(), peerConfig.id, otherOrgConfig.id];
    for (const configId of invisibleConfigIds) {
      const response = await accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: host.generation,
            transport: { type: "tailscale", configId },
            credential: inlineLogin(),
          },
        }),
        [404],
      );
      expect(response.body).toMatchObject({
        error: { code: "TAILSCALE_NOT_FOUND" },
      });
    }

    expect(kms.generateDataKeyCalls).toBe(0);
    await expect(
      accept(hosts().list({ headers }), [200]).then((response) => {
        return response.body.connections;
      }),
    ).resolves.toStrictEqual(beforeHosts);
    await expect(
      accept(logins().list({ headers }), [200]).then((response) => {
        return response.body.credentials;
      }),
    ).resolves.toStrictEqual(beforeLogins);

    await accept(
      hosts().update({
        headers,
        params: { connectionId: host.id },
        body: {
          expectedGeneration: host.generation,
          transport: { type: "tailscale", configId: ownConfig.id },
          credential: inlineLogin(),
        },
      }),
      [500],
    );

    expect(kms.generateDataKeyCalls).toBe(1);
    await expect(
      accept(hosts().list({ headers }), [200]).then((response) => {
        return response.body.connections;
      }),
    ).resolves.toStrictEqual(beforeHosts);
    await expect(
      accept(logins().list({ headers }), [200]).then((response) => {
        return response.body.credentials;
      }),
    ).resolves.toStrictEqual(beforeLogins);
  });

  it(
    "tailscale-parity-001 preserves trust through protected endpoint/carrier edits, resets only explicitly or for Direct-to-Direct endpoint changes",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const member = await createMember();
      signIn(member);
      const tailscaleConfig = await createConfig();
      const accessGateway = (
        await accept(
          cloudflareAccess().create({
            headers,
            body: {
              id: randomUUID(),
              name: "Parity gateway",
              credentials: {
                clientId: `cf-id-${randomUUID()}`,
                clientSecret: `cf-sec-${randomUUID()}`,
              },
            },
          }),
          [201],
        )
      ).body;
      const initialHost = (
        await accept(
          hosts().create({
            headers,
            body: {
              id: randomUUID(),
              displayName: "Carrier box",
              host: "direct.example.com",
              port: 22,
              credential: inlineLogin(),
            },
          }),
          [201],
        )
      ).body;
      const loginId = credentialIdOf(initialHost);
      await enableSshDefault(member, initialHost.id);
      const run = await launchActorRun(member);

      const firstKey = hostKeyFor(`first-${initialHost.id}`);
      const firstPin = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: initialHost.id,
            runnerIdentity: run.runnerIdentity,
            expectedGeneration: initialHost.generation,
            observedHostKey: firstKey,
          },
        }),
        [200],
      );
      expect(firstPin.body).toStrictEqual({
        outcome: "pinned",
        generation: initialHost.generation + 1,
      });

      signIn(member);
      const onTailscale1 = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: initialHost.id },
            body: {
              expectedGeneration: pinnedGeneration(firstPin.body),
              host: "peer",
              port: 2222,
              transport: { type: "tailscale", configId: tailscaleConfig.id },
            },
          }),
          [200],
        )
      ).body;
      expect(onTailscale1.learnedHostKey).toStrictEqual(firstKey);

      const onTailscale2 = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: initialHost.id },
            body: {
              expectedGeneration: onTailscale1.generation,
              host: "other-peer",
              port: 65_535,
            },
          }),
          [200],
        )
      ).body;
      expect(onTailscale2.learnedHostKey).toStrictEqual(firstKey);

      const reset = (
        await accept(
          hosts().resetHostKey({
            headers,
            params: { connectionId: initialHost.id },
            body: { expectedGeneration: onTailscale2.generation },
          }),
          [200],
        )
      ).body;
      expect(reset.learnedHostKey).toBeNull();

      const secondKey = hostKeyFor(`second-${initialHost.id}`);
      const secondPin = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: run.runId },
          body: {
            connectionId: initialHost.id,
            runnerIdentity: run.runnerIdentity,
            expectedGeneration: reset.generation,
            observedHostKey: secondKey,
          },
        }),
        [200],
      );
      expect(secondPin.body).toStrictEqual({
        outcome: "pinned",
        generation: reset.generation + 1,
      });

      signIn(member);
      const toDirect2 = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: initialHost.id },
            body: {
              expectedGeneration: pinnedGeneration(secondPin.body),
              host: "direct2.example.com",
              port: 22,
              transport: { type: "direct" },
            },
          }),
          [200],
        )
      ).body;
      expect(toDirect2.learnedHostKey).toStrictEqual(secondKey);
      expect(credentialIdOf(toDirect2)).toBe(loginId);

      const toAccess = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: initialHost.id },
            body: {
              expectedGeneration: toDirect2.generation,
              host: "access.example.com",
              port: 443,
              transport: {
                type: "cloudflare_access",
                configId: accessGateway.id,
              },
            },
          }),
          [200],
        )
      ).body;
      expect(toAccess.learnedHostKey).toStrictEqual(secondKey);
      expect(credentialIdOf(toAccess)).toBe(loginId);

      const backToTailscale = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: initialHost.id },
            body: {
              expectedGeneration: toAccess.generation,
              host: "peer",
              port: 2222,
              transport: { type: "tailscale", configId: tailscaleConfig.id },
            },
          }),
          [200],
        )
      ).body;
      expect(backToTailscale.learnedHostKey).toStrictEqual(secondKey);
      expect(credentialIdOf(backToTailscale)).toBe(loginId);

      const toDirect3 = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: initialHost.id },
            body: {
              expectedGeneration: backToTailscale.generation,
              host: "direct3.example.com",
              port: 22,
              transport: { type: "direct" },
            },
          }),
          [200],
        )
      ).body;
      expect(toDirect3.learnedHostKey).toStrictEqual(secondKey);
      expect(credentialIdOf(toDirect3)).toBe(loginId);

      const directHostChange = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: initialHost.id },
            body: {
              expectedGeneration: toDirect3.generation,
              host: "direct4.example.com",
            },
          }),
          [200],
        )
      ).body;
      expect(directHostChange.learnedHostKey).toBeNull();
      expect(credentialIdOf(directHostChange)).toBe(loginId);
    },
  );

  it(
    "tailscale-parity-002 promotes Personal configuration and requires fresh admin impact review for conversion, retaining SSH identity and explicit private rebind",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kms = useSecretKmsProbe();
      const admin = await createMember({ role: "admin" });
      const member = await createMember({ orgId: admin.orgId, role: "member" });

      signIn(admin);
      const personal = await createConfig({ scope: "personal" });
      const adminHost = await createTailscaleHost(personal.id, "100.64.0.21");

      await accept(
        tailscale().convertToOrganization({
          headers,
          params: { configId: personal.id },
          body: { expectedRevision: personal.revision + 5 },
        }),
        [409],
      );
      const promoted = (
        await accept(
          tailscale().convertToOrganization({
            headers,
            params: { configId: personal.id },
            body: { expectedRevision: personal.revision },
          }),
          [200],
        )
      ).body;
      expect(promoted).toMatchObject({
        scope: "organization",
        revision: 2,
        generation: 2,
        sshHosts: [{ id: adminHost.id, displayName: adminHost.displayName }],
      });
      const adminHostsAfterPromote = (
        await accept(hosts().list({ headers }), [200])
      ).body.connections;
      expect(adminHostsAfterPromote[0]?.generation).toBe(
        adminHost.generation + 1,
      );

      signIn(member);
      const memberHost = await createTailscaleHost(personal.id, "100.64.0.22");
      const memberLoginId = credentialIdOf(memberHost);
      await enableSshDefault(member, memberHost.id);
      const memberRun = await launchActorRun(member);
      const pinnedKey = hostKeyFor(`parity-002-${memberHost.id}`);
      const pinResult = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: memberRun.runId },
          body: {
            connectionId: memberHost.id,
            runnerIdentity: memberRun.runnerIdentity,
            expectedGeneration: memberHost.generation,
            observedHostKey: pinnedKey,
          },
        }),
        [200],
      );
      expect(pinResult.body).toStrictEqual({
        outcome: "pinned",
        generation: memberHost.generation + 1,
      });

      signIn(member);
      await accept(
        tailscale().impactPreview({
          headers,
          params: { configId: personal.id },
          query: { operation: "convert" },
        }),
        [403],
      );
      await accept(
        tailscale().convertToOrganization({
          headers,
          params: { configId: personal.id },
          body: { expectedRevision: promoted.revision },
        }),
        [403],
      );

      signIn(admin);
      const stalePreview = (
        await accept(
          tailscale().impactPreview({
            headers,
            params: { configId: personal.id },
            query: { operation: "convert" },
          }),
          [200],
        )
      ).body;
      expect(stalePreview).toMatchObject({
        ownHostCount: 1,
        otherHostCount: 1,
        affectedOwners: [expect.objectContaining({ userId: member.userId })],
      });
      expect(JSON.stringify(stalePreview)).not.toContain(memberHost.id);

      signIn(member);
      const renamedMemberHost = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: memberHost.id },
            body: {
              expectedGeneration: pinnedGeneration(pinResult.body),
              displayName: "Renamed member host",
            },
          }),
          [200],
        )
      ).body;

      signIn(admin);
      await accept(
        tailscale().convertToPersonal({
          headers,
          params: { configId: personal.id },
          body: {
            expectedRevision: stalePreview.expectedRevision,
            impactSnapshot: stalePreview.impactSnapshot,
          },
        }),
        [409],
      );
      const freshPreview = (
        await accept(
          tailscale().impactPreview({
            headers,
            params: { configId: personal.id },
            query: { operation: "convert" },
          }),
          [200],
        )
      ).body;
      const converted = (
        await accept(
          tailscale().convertToPersonal({
            headers,
            params: { configId: personal.id },
            body: {
              expectedRevision: freshPreview.expectedRevision,
              impactSnapshot: freshPreview.impactSnapshot,
            },
          }),
          [200],
        )
      ).body;
      expect(converted).toMatchObject({
        scope: "personal",
        revision: 3,
        generation: 3,
        sshHosts: [{ id: adminHost.id, displayName: adminHost.displayName }],
      });

      signIn(member);
      const memberConfigsAfterConvert = (
        await accept(tailscale().list({ headers }), [200])
      ).body.configs;
      expect(memberConfigsAfterConvert).toStrictEqual([]);
      const [memberHostAfterConvert] = (
        await accept(hosts().list({ headers }), [200])
      ).body.connections;
      expect(memberHostAfterConvert).toMatchObject({
        id: memberHost.id,
        credentialId: memberLoginId,
        learnedHostKey: pinnedKey,
        host: memberHost.host,
        port: memberHost.port,
        generation: renamedMemberHost.generation + 1,
        transport: { type: "tailscale", needsRebind: true },
      });

      const decryptsBefore = kms.decryptCalls;
      const unavailableResolve = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: memberRun.runId },
          body: {
            connectionId: memberHost.id,
            runnerIdentity: memberRun.runnerIdentity,
          },
        }),
        [200],
      );
      expect(unavailableResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(decryptsBefore);

      signIn(member);
      const afterConvertGen = renamedMemberHost.generation + 1;
      await accept(
        hosts().update({
          headers,
          params: { connectionId: memberHost.id },
          body: {
            expectedGeneration: afterConvertGen,
            displayName: "Blocked rename while unlinked",
          },
        }),
        [400],
      );
      await accept(
        hosts().update({
          headers,
          params: { connectionId: memberHost.id },
          body: {
            expectedGeneration: afterConvertGen,
            transport: { type: "tailscale", configId: personal.id },
          },
        }),
        [404],
      );

      const replacementConfig = await createConfig({ scope: "personal" });
      const rebound = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: memberHost.id },
            body: {
              expectedGeneration: afterConvertGen,
              host: "replacement-peer",
              port: 22,
              transport: { type: "tailscale", configId: replacementConfig.id },
            },
          }),
          [200],
        )
      ).body;
      expect(rebound).toMatchObject({
        id: memberHost.id,
        credentialId: memberLoginId,
        learnedHostKey: pinnedKey,
        host: "replacement-peer",
        port: 22,
        generation: afterConvertGen + 1,
        transport: { type: "tailscale", configId: replacementConfig.id },
      });

      const resolvedAgain = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: memberRun.runId },
          body: {
            connectionId: memberHost.id,
            runnerIdentity: memberRun.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolvedAgain.body).toMatchObject({
        outcome: "resolved_tailscale",
        host: "replacement-peer",
        port: 22,
        tailscale: expect.objectContaining({ configId: replacementConfig.id }),
      });
    },
  );

  it(
    "tailscale-parity-004 refuses own-reference deletion and requires a current impact snapshot before deleting shared configuration referenced only by others",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kms = useSecretKmsProbe();
      const admin = await createMember({ role: "admin" });
      const member = await createMember({ orgId: admin.orgId, role: "member" });

      signIn(admin);
      const shared = await createConfig({ scope: "organization" });
      const adminHost = await createTailscaleHost(shared.id, "100.64.0.31");

      const ownPreview = (
        await accept(
          tailscale().impactPreview({
            headers,
            params: { configId: shared.id },
            query: { operation: "delete" },
          }),
          [200],
        )
      ).body;
      await accept(
        tailscale().delete({
          headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: ownPreview.expectedRevision,
            impactSnapshot: ownPreview.impactSnapshot,
          },
        }),
        [409],
      );
      await accept(
        hosts().delete({
          headers,
          params: { connectionId: adminHost.id },
          body: { expectedGeneration: adminHost.generation },
        }),
        [204],
      );

      signIn(member);
      const memberHost = await createTailscaleHost(shared.id, "100.64.0.32");
      const memberLoginId = credentialIdOf(memberHost);
      await enableSshDefault(member, memberHost.id);
      const memberRun = await launchActorRun(member);
      const pinnedKey = hostKeyFor(`parity-004-${memberHost.id}`);
      const pinResult = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: memberRun.runId },
          body: {
            connectionId: memberHost.id,
            runnerIdentity: memberRun.runnerIdentity,
            expectedGeneration: memberHost.generation,
            observedHostKey: pinnedKey,
          },
        }),
        [200],
      );
      expect(pinResult.body).toStrictEqual({
        outcome: "pinned",
        generation: memberHost.generation + 1,
      });

      signIn(admin);
      const stalePreview = (
        await accept(
          tailscale().impactPreview({
            headers,
            params: { configId: shared.id },
            query: { operation: "delete" },
          }),
          [200],
        )
      ).body;
      await accept(
        tailscale().delete({
          headers,
          params: { configId: shared.id },
          body: { expectedRevision: stalePreview.expectedRevision },
        }),
        [409],
      );

      signIn(member);
      const movedHost = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: memberHost.id },
            body: {
              expectedGeneration: pinnedGeneration(pinResult.body),
              host: "next-peer",
              port: 65_535,
            },
          }),
          [200],
        )
      ).body;

      signIn(admin);
      await accept(
        tailscale().delete({
          headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: stalePreview.expectedRevision,
            impactSnapshot: stalePreview.impactSnapshot,
          },
        }),
        [409],
      );
      const freshPreview = (
        await accept(
          tailscale().impactPreview({
            headers,
            params: { configId: shared.id },
            query: { operation: "delete" },
          }),
          [200],
        )
      ).body;
      await accept(
        tailscale().delete({
          headers,
          params: { configId: shared.id },
          body: {
            expectedRevision: freshPreview.expectedRevision,
            impactSnapshot: freshPreview.impactSnapshot,
          },
        }),
        [204],
      );

      signIn(member);
      const memberConfigsAfterDelete = (
        await accept(tailscale().list({ headers }), [200])
      ).body.configs;
      expect(memberConfigsAfterDelete).toStrictEqual([]);
      const [memberHostAfterDelete] = (
        await accept(hosts().list({ headers }), [200])
      ).body.connections;
      expect(memberHostAfterDelete).toMatchObject({
        id: memberHost.id,
        host: "next-peer",
        port: 65_535,
        credentialId: memberLoginId,
        learnedHostKey: pinnedKey,
        generation: movedHost.generation + 1,
        transport: { type: "tailscale", needsRebind: true },
      });

      const decryptsBefore = kms.decryptCalls;
      const unavailableResolve = await accept(
        runnerSsh().resolve({
          headers: runnerHeaders(),
          params: { runId: memberRun.runId },
          body: {
            connectionId: memberHost.id,
            runnerIdentity: memberRun.runnerIdentity,
          },
        }),
        [200],
      );
      expect(unavailableResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(decryptsBefore);

      signIn(member);
      const directHost = (
        await accept(
          hosts().update({
            headers,
            params: { connectionId: memberHost.id },
            body: {
              expectedGeneration: movedHost.generation + 1,
              host: "direct.example.com",
              port: 22,
              transport: { type: "direct" },
            },
          }),
          [200],
        )
      ).body;
      expect(directHost).toMatchObject({
        id: memberHost.id,
        host: "direct.example.com",
        port: 22,
        credentialId: memberLoginId,
        learnedHostKey: pinnedKey,
      });
      expect("transport" in directHost).toBeFalsy();
    },
  );

  it(
    "tailscale-parity-010 treats tag permutations as metadata-only while real tag additions and removals invalidate all referencing hosts",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const admin = await createMember({ role: "admin" });
      const member = await createMember({ orgId: admin.orgId, role: "member" });

      signIn(admin);
      const shared = (
        await accept(
          tailscale().create({
            headers,
            body: {
              id: randomUUID(),
              name: "Shared tag parity",
              scope: "organization",
              credentials: {
                clientId: `client-${randomUUID()}`,
                clientSecret: `secret-${randomUUID()}`,
              },
              tags: ["tag:prod", "tag:ci"],
            },
          }),
          [201],
        )
      ).body;
      const adminHost = await createTailscaleHost(shared.id, "100.64.0.41");
      await enableSshDefault(admin, adminHost.id);
      const adminRun = await launchActorRun(admin, { grantTeam: true });
      const adminKey = hostKeyFor(`parity-010-admin-${adminHost.id}`);
      const adminPin = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: adminRun.runId },
          body: {
            connectionId: adminHost.id,
            runnerIdentity: adminRun.runnerIdentity,
            expectedGeneration: adminHost.generation,
            observedHostKey: adminKey,
          },
        }),
        [200],
      );
      expect(adminPin.body).toStrictEqual({
        outcome: "pinned",
        generation: adminHost.generation + 1,
      });

      signIn(member);
      const memberHost = await createTailscaleHost(shared.id, "100.64.0.42");
      await enableSshDefault(member, memberHost.id);
      const memberRun = await launchActorRun(member, {
        runnerGroup: adminRun.runnerGroup,
        bootstrapOrg: false,
      });
      const memberKey = hostKeyFor(`parity-010-member-${memberHost.id}`);
      const memberPin = await accept(
        runnerSsh().pin({
          headers: runnerHeaders(),
          params: { runId: memberRun.runId },
          body: {
            connectionId: memberHost.id,
            runnerIdentity: memberRun.runnerIdentity,
            expectedGeneration: memberHost.generation,
            observedHostKey: memberKey,
          },
        }),
        [200],
      );
      expect(memberPin.body).toStrictEqual({
        outcome: "pinned",
        generation: memberHost.generation + 1,
      });

      await flushWaitUntilForTest();
      clearRealtimePublications();

      signIn(admin);
      const reorder1 = (
        await accept(
          tailscale().update({
            headers,
            params: { configId: shared.id },
            body: {
              expectedRevision: shared.revision,
              tags: ["tag:ci", "tag:prod"],
            },
          }),
          [200],
        )
      ).body;
      await flushWaitUntilForTest();
      expect(reorder1).toMatchObject({
        tags: ["tag:ci", "tag:prod"],
        revision: shared.revision + 1,
        generation: shared.generation,
      });
      expect(
        readRealtimePublications().filter((entry) => {
          return entry.topic === "tailscale:changed";
        }),
      ).toHaveLength(1);
      expect(
        readRealtimePublications().filter((entry) => {
          return entry.topic === "ssh-authority-invalidated";
        }),
      ).toHaveLength(0);

      clearRealtimePublications();
      const reorder2 = (
        await accept(
          tailscale().update({
            headers,
            params: { configId: shared.id },
            body: {
              expectedRevision: reorder1.revision,
              tags: ["tag:prod", "tag:ci"],
            },
          }),
          [200],
        )
      ).body;
      await flushWaitUntilForTest();
      expect(reorder2).toMatchObject({
        tags: ["tag:prod", "tag:ci"],
        revision: reorder1.revision + 1,
        generation: shared.generation,
      });
      expect(
        readRealtimePublications().filter((entry) => {
          return entry.topic === "tailscale:changed";
        }),
      ).toHaveLength(1);
      expect(
        readRealtimePublications().filter((entry) => {
          return entry.topic === "ssh-authority-invalidated";
        }),
      ).toHaveLength(0);

      const [adminAfterReorder] = (
        await accept(hosts().list({ headers }), [200])
      ).body.connections;
      const adminPinnedGen = pinnedGeneration(adminPin.body);
      const memberPinnedGen = pinnedGeneration(memberPin.body);
      expect(adminAfterReorder?.generation).toBe(adminPinnedGen);
      signIn(member);
      const [memberAfterReorder] = (
        await accept(hosts().list({ headers }), [200])
      ).body.connections;
      expect(memberAfterReorder?.generation).toBe(memberPinnedGen);

      clearRealtimePublications();
      signIn(admin);
      const addedTag = (
        await accept(
          tailscale().update({
            headers,
            params: { configId: shared.id },
            body: {
              expectedRevision: reorder2.revision,
              tags: ["tag:prod", "tag:ci", "tag:extra"],
            },
          }),
          [200],
        )
      ).body;
      await flushWaitUntilForTest();
      expect(addedTag).toMatchObject({
        tags: ["tag:prod", "tag:ci", "tag:extra"],
        revision: reorder2.revision + 1,
        generation: shared.generation + 1,
      });
      const invalidations1 = readRealtimePublications().filter((entry) => {
        return entry.topic === "ssh-authority-invalidated";
      });
      expect(invalidations1).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: `runner-group:${adminRun.runnerGroup}`,
            topic: "ssh-authority-invalidated",
            payload: { runId: adminRun.runId, connectionId: adminHost.id },
          }),
          expect.objectContaining({
            channel: `runner-group:${adminRun.runnerGroup}`,
            topic: "ssh-authority-invalidated",
            payload: { runId: memberRun.runId, connectionId: memberHost.id },
          }),
        ]),
      );

      clearRealtimePublications();
      const removedTag = (
        await accept(
          tailscale().update({
            headers,
            params: { configId: shared.id },
            body: {
              expectedRevision: addedTag.revision,
              tags: ["tag:ci", "tag:extra"],
            },
          }),
          [200],
        )
      ).body;
      await flushWaitUntilForTest();
      expect(removedTag).toMatchObject({
        tags: ["tag:ci", "tag:extra"],
        revision: addedTag.revision + 1,
        generation: shared.generation + 2,
      });
      const invalidations2 = readRealtimePublications().filter((entry) => {
        return entry.topic === "ssh-authority-invalidated";
      });
      expect(invalidations2).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channel: `runner-group:${adminRun.runnerGroup}`,
            topic: "ssh-authority-invalidated",
            payload: { runId: adminRun.runId, connectionId: adminHost.id },
          }),
          expect.objectContaining({
            channel: `runner-group:${adminRun.runnerGroup}`,
            topic: "ssh-authority-invalidated",
            payload: { runId: memberRun.runId, connectionId: memberHost.id },
          }),
        ]),
      );

      const [adminFinal] = (await accept(hosts().list({ headers }), [200])).body
        .connections;
      expect(adminFinal).toMatchObject({
        id: adminHost.id,
        credentialId: credentialIdOf(adminHost),
        username: adminHost.username,
        learnedHostKey: adminKey,
        generation: adminPinnedGen + 2,
      });
      signIn(member);
      const [memberFinal] = (await accept(hosts().list({ headers }), [200]))
        .body.connections;
      expect(memberFinal).toMatchObject({
        id: memberHost.id,
        credentialId: credentialIdOf(memberHost),
        username: memberHost.username,
        learnedHostKey: memberKey,
        generation: memberPinnedGen + 2,
      });
    },
  );
});
