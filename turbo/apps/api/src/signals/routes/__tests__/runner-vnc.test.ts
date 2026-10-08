import { randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import {
  runnerVncContract,
  type RunnerVncCheckRequest,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, onRejection } from "../../utils";
import { runnerVncRoutes } from "../runner-vnc";
import { runnersRoutes } from "../runners";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { requireVncCredentialId } from "./helpers/vnc-response";
import { certificateChain, privateKey } from "./helpers/vnc-synthetic-client";
import { inlineSshKey } from "./helpers/ssh-credential";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncPassword,
  vncProfiles,
  vncRunnerHeaders,
  vncSecurity,
  vncSessionHeaders,
  vncX509VncProfiles,
  type VncRuntimeFixture,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);
const runs = createRunsApi(context);
beforeEach(initializeVncRuntimeTest);

function check(
  f: VncRuntimeFixture,
  expectedGeneration: number,
  override: Partial<RunnerVncCheckRequest> = {},
) {
  return accept(
    api.runner().check({
      headers: vncRunnerHeaders,
      params: { runId: f.runId },
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        expectedGeneration,
        expectedTransport: { type: "direct" },
        ...override,
      },
    }),
    [200],
  );
}

describe("private Runner VNC authority", () => {
  const claimedRunCleanups: (() => Promise<void>)[] = [];

  // Cancel owned Runs while the parent context still owns its signal and mocks.
  afterEach(async () => {
    for (const cleanup of claimedRunCleanups.splice(0)) {
      await cleanup();
      await flushWaitUntilForTest();
    }
  });

  async function claimedRuntime(
    owner: Pick<VncRuntimeFixture, "orgId" | "userId" | "agentId">,
  ) {
    const actor = createBddApi(context).user(owner);
    const group = runs.configureRunnerGroup();
    const { runId, threadId } = await runs.createThreadRun(actor, {
      agentId: owner.agentId,
      prompt: "Use my configured VNC desktop",
    });
    claimedRunCleanups.push(async () => {
      // Negative admission and KMS cases must not prevent owned Run cleanup.
      api.authenticate(owner);
      useSecretKmsProbe();
      await runs.requestCancelRun(actor, runId, [200]);
    });
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    await runs.requestHeartbeatRunnerAs(vncRunnerHeaders.authorization, [200], {
      group,
      runnerId: runnerIdentity.runnerId,
      snapshotGeneration: runnerIdentity.heartbeatGeneration,
    });
    const claim = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).claim({
        headers: vncRunnerHeaders,
        params: { id: runId },
        body: {
          runnerIdentity,
          capabilities: { piModelConfigGenerations: [1, 2, 3] },
        },
      }),
      [200],
    );
    const sandboxToken = claim.body.sandboxToken;
    if (!sandboxToken) {
      throw new Error("Expected the Runner claim to issue its sandbox token");
    }
    await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
      status: "running",
    });
    api.authenticate(owner);
    return { runId, threadId, runnerIdentity, sandboxToken };
  }

  /** Ordinary chat Runs use production launch and claim; historical cases keep api.runtime. */
  async function claimedFixture(
    options: { readonly defaultEnabled?: boolean } = {},
  ): Promise<VncRuntimeFixture> {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected a VNC owner organization");
    }
    const owner = { orgId: actor.orgId, userId: actor.userId };
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const { defaultAgentId: agentId } = await bdd.readOnboardingStatus(actor);
    if (!agentId) {
      throw new Error("Expected onboarding to provide the default Agent");
    }
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    api.authenticate(owner);
    const connection = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: vncConnectionBody(),
      }),
      [201],
    );
    if (options.defaultEnabled !== false) {
      await api.enableDefault(owner, "vnc", connection.body.id);
    }
    const running = await claimedRuntime({ ...owner, agentId });
    return {
      ...owner,
      ...running,
      agentId,
      connectionId: connection.body.id,
      credentialId: requireVncCredentialId(connection.body),
    };
  }

  it("uses current chat VNC and exact SSH dependency access during an active Run", async () => {
    const f = await claimedFixture({
      defaultEnabled: false,
    });
    if (!f.threadId) {
      throw new Error("Missing fixture chat thread");
    }
    const threadId = f.threadId;
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    api.authenticate(f);
    const remote = setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    );
    const vncHost = { protocol: "vnc" as const, connectionId: f.connectionId };
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    await accept(
      remote.updateHostDefault({
        headers: vncSessionHeaders,
        params: vncHost,
        body: { enabled: true },
      }),
      [200],
    );
    await expect(api.resolve(f)).resolves.toMatchObject({
      outcome: "resolved_transport",
    });
    expect((await check(f, 1)).body).toStrictEqual({ outcome: "valid" });
    await accept(
      remote.setThreadOverride({
        headers: vncSessionHeaders,
        params: { threadId, ...vncHost },
        body: { enabled: false },
      }),
      [200],
    );
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect((await check(f, 1)).body).toStrictEqual({ outcome: "unavailable" });
    await accept(
      remote.clearThreadOverride({
        headers: vncSessionHeaders,
        params: { threadId, ...vncHost },
      }),
      [200],
    );
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "VNC gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("deploy", "private-key"),
        },
      }),
      [201],
    );
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          transport: { type: "ssh", connectionId: ssh.body.id },
          security: { ...vncSecurity, serverName: "desktop.internal" },
        },
      }),
      [200],
    );
    await expect(
      api.resolve(f, { supportedProfiles: [...vncProfiles] }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    await accept(
      remote.updateHostDefault({
        headers: vncSessionHeaders,
        params: { protocol: "ssh", connectionId: ssh.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(
      api.resolve(f, { supportedProfiles: [...vncProfiles] }),
    ).resolves.toMatchObject({ outcome: "resolved_transport" });
    await accept(
      remote.setThreadOverride({
        headers: vncSessionHeaders,
        params: { threadId, protocol: "ssh", connectionId: ssh.body.id },
        body: { enabled: false },
      }),
      [200],
    );
    await expect(
      api.resolve(f, { supportedProfiles: [...vncProfiles] }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect((await check(f, 2)).body).toStrictEqual({ outcome: "unavailable" });
  });

  it("preserves the exact VNC secret only in the no-store Runner handoff", async () => {
    const f = await claimedFixture();
    const kms = useSecretKmsProbe();
    expect(kms.decryptCalls).toBe(0);
    const result = await accept(
      api.runner().resolve({
        headers: vncRunnerHeaders,
        params: { runId: f.runId },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
          supportedProfiles: [...vncX509VncProfiles],
        },
      }),
      [200],
    );
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toMatchObject({
      outcome: "resolved_transport",
      host: "vnc.example.com",
      port: 5900,
      authentication: { method: "vnc_password", password: vncPassword },
      security: vncSecurity,
      generation: 1,
    });
    const first = await api.resolved(f);
    const listed = await accept(
      api.connections().list({ headers: vncSessionHeaders }),
      [200],
    );
    expect(JSON.stringify(listed.body)).not.toContain(vncPassword);
    expect((await api.resolved(f)).generation).toBe(first.generation);
    expect((await check(f, first.generation)).body).toStrictEqual({
      outcome: "valid",
    });
  });

  it("requires an exact X509None capability and resolves without decrypting a credential", async () => {
    const f = await claimedFixture();
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          security: { type: "x509_none", trust: { mode: "system" } },
          credential: { type: "none" },
        },
      }),
      [200],
    );
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { supportedProfiles: [...vncProfiles] }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect((await check(f, 1)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    const resolved = await api.resolve(f, {
      supportedProfiles: [
        {
          authMethod: "none",
          securityType: "x509_none",
          transportType: "direct",
        },
      ],
    });
    expect(resolved).toMatchObject({
      outcome: "resolved_transport",
      authentication: { method: "none" },
      security: { type: "x509_none", trust: { mode: "system" } },
      generation: 2,
    });
    expect(kms.decryptCalls).toBe(0);
    expect((await check(f, 2)).body).toStrictEqual({ outcome: "valid" });
  });

  it.each([
    ["client_certificate", "x509_none", false],
    ["client_certificate_vnc_password", "x509_vnc", true],
  ] as const)(
    "requires exact %s capability before KMS and hands identity only to the Runner",
    async (method, securityType, passwordRequired) => {
      const f = await claimedFixture();
      const host = await accept(
        api.connections().create({
          headers: vncSessionHeaders,
          body: {
            id: randomUUID(),
            displayName: "mTLS QEMU desktop",
            host: "qemu.example.com",
            security: { type: securityType, trust: { mode: "system" } },
            credential: {
              create: {
                name: "mTLS client identity",
                authentication: passwordRequired
                  ? {
                      method: "client_certificate_vnc_password",
                      certificateChain,
                      privateKey,
                      password: " secret ",
                    }
                  : {
                      method: "client_certificate",
                      certificateChain,
                      privateKey,
                    },
              },
            },
          },
        }),
        [201],
      );
      await api.enableDefault(f, "vnc", host.body.id);
      const selected = { ...f, connectionId: host.body.id };
      const kms = useSecretKmsProbe();
      await expect(
        api.resolve(selected, { supportedProfiles: [...vncProfiles] }),
      ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
      expect(kms.decryptCalls).toBe(0);
      const resolved = await api.resolve(selected, {
        supportedProfiles: [
          {
            authMethod: method,
            securityType,
            transportType: "direct",
          },
        ],
      });
      expect(resolved).toMatchObject({
        outcome: "resolved_transport",
        authentication: {
          method,
          certificateChainDer: [expect.any(String)],
          privateKeyPkcs8Der: expect.any(String),
          ...(passwordRequired ? { password: " secret " } : {}),
        },
        security: { type: securityType },
      });
      expect(kms.decryptCalls).toBe(passwordRequired ? 2 : 1);
      const listed = await accept(
        api.connections().list({ headers: vncSessionHeaders }),
        [200],
      );
      expect(JSON.stringify(listed.body)).not.toContain(privateKey);
      expect(JSON.stringify(listed.body)).not.toContain("privateKeyPkcs8Der");
      expect((await check(selected, 1)).body).toStrictEqual({
        outcome: "valid",
      });
    },
  );

  it("requires independent SSH access and the exact certificate/SSH tuple before decrypting a client key", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "QEMU gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("deploy", "private-key"),
        },
      }),
      [201],
    );
    const created = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Tunnelled QEMU",
          host: "127.0.0.1",
          transport: { type: "ssh", connectionId: ssh.body.id },
          security: { type: "x509_none", trust: { mode: "system" } },
          credential: {
            create: {
              name: "Tunnelled identity",
              authentication: {
                method: "client_certificate",
                certificateChain,
                privateKey,
              },
            },
          },
        },
      }),
      [201],
    );
    await api.enableDefault(f, "vnc", created.body.id);
    const selected = { ...f, connectionId: created.body.id };
    const kms = useSecretKmsProbe();
    const profile = {
      authMethod: "client_certificate" as const,
      securityType: "x509_none" as const,
      transportType: "ssh" as const,
    };
    await expect(
      api.resolve(selected, { supportedProfiles: [profile] }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
    await accept(
      setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      ).updateHostDefault({
        headers: vncSessionHeaders,
        params: { protocol: "ssh", connectionId: ssh.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(
      api.resolve(selected, {
        supportedProfiles: [{ ...profile, transportType: "direct" }],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(0);
    await expect(
      api.resolve(selected, { supportedProfiles: [profile] }),
    ).resolves.toMatchObject({
      outcome: "resolved_transport",
      authentication: {
        method: "client_certificate",
        privateKeyPkcs8Der: expect.any(String),
      },
      transport: { type: "ssh", connectionId: ssh.body.id },
    });
    expect(kms.decryptCalls).toBe(1);
  });

  it("requires the SSH-specific X509None capability and independent SSH authority", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "VNC gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("deploy", "private-key"),
        },
      }),
      [201],
    );
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          transport: { type: "ssh", connectionId: ssh.body.id },
          security: { type: "x509_none", trust: { mode: "system" } },
          credential: { type: "none" },
        },
      }),
      [200],
    );
    const profiles = [
      {
        authMethod: "none" as const,
        securityType: "x509_none" as const,
        transportType: "ssh" as const,
      },
    ];
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { supportedProfiles: profiles }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    await accept(
      setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      ).updateHostDefault({
        headers: vncSessionHeaders,
        params: { protocol: "ssh", connectionId: ssh.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(
      api.resolve(f, {
        supportedProfiles: [{ ...profiles[0]!, transportType: "direct" }],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    await expect(
      api.resolve(f, { supportedProfiles: profiles }),
    ).resolves.toMatchObject({
      outcome: "resolved_transport",
      authentication: { method: "none" },
      security: { type: "x509_none" },
      transport: { type: "ssh", connectionId: ssh.body.id },
      generation: 2,
    });
    expect(kms.decryptCalls).toBe(0);
  });

  it("rejects wrong auth classes and exact winning-process mismatches before KMS", async () => {
    const f = await claimedFixture();
    const { generation } = await api.resolved(f);
    const kms = useSecretKmsProbe();
    const body = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      supportedProfiles: [...vncProfiles],
    };
    for (const authorization of [
      undefined,
      "Bearer vm0_official_wrong",
      "Bearer clerk-session",
      `Bearer ${f.sandboxToken}`,
    ]) {
      const result = await api.runner().resolve({
        headers: { authorization },
        params: { runId: f.runId },
        body,
      });
      expect(result.status).toBe(401);
      expect(result.headers.get("cache-control")).toBe("no-store");
      const checked = await api.runner().check({
        headers: { authorization },
        params: { runId: f.runId },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
          expectedGeneration: generation,
          expectedTransport: { type: "direct" },
        },
      });
      expect(checked.status).toBe(401);
      expect(checked.headers.get("cache-control")).toBe("no-store");
    }
    const auth = createAuthOrgAgentsBddApi(context);
    const actor = auth.user();
    auth.mockClerkOrg(actor);
    const pat = await auth.createCliToken(actor);
    await accept(
      api.runner().resolve({
        headers: { authorization: `Bearer ${pat.token}` },
        params: { runId: f.runId },
        body,
      }),
      [403],
    );
    await accept(
      api.runner().check({
        headers: { authorization: `Bearer ${pat.token}` },
        params: { runId: f.runId },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
          expectedGeneration: generation,
          expectedTransport: { type: "direct" },
        },
      }),
      [403],
    );
    api.authenticate(f);
    for (const override of [
      { connectionId: randomUUID() },
      { runnerIdentity: { ...f.runnerIdentity, runnerId: randomUUID() } },
      { runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 7 } },
    ]) {
      await expect(api.resolve(f, override)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect((await check(f, generation, override)).body).toStrictEqual({
        outcome: "unavailable",
      });
    }
    await expect(
      api.resolve({ ...f, runId: randomUUID() }),
    ).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(
      (await check({ ...f, runId: randomUUID() }, generation)).body,
    ).toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("keeps cross-owner connections opaque", async () => {
    const f = await claimedFixture();
    const foreign = await claimedFixture();
    const { generation } = await api.resolved(foreign);
    api.authenticate(f);
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { connectionId: foreign.connectionId }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(
      (await check(f, generation, { connectionId: foreign.connectionId })).body,
    ).toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("reports unsupported exact profiles before decrypting and rejects injected authority fields", async () => {
    const f = await claimedFixture();
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { supportedProfiles: [] }),
    ).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    const request = setupRawAppRequest({ context, routes: runnerVncRoutes });
    const base = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      supportedProfiles: [...vncProfiles],
    };
    for (const body of [
      {
        ...base,
        supportedProfiles: [
          { authMethod: "vnc_password", securityType: "none" },
        ],
      },
      {
        ...base,
        supportedProfiles: [{ authMethod: "none", securityType: "x509_vnc" }],
      },
      {
        ...base,
        supportedProfiles: [
          { authMethod: "vnc_password", securityType: "x509_plain" },
        ],
      },
      {
        ...base,
        supportedProfiles: [
          { authMethod: "username_password", securityType: "x509_vnc" },
        ],
      },
      { ...base, host: "attacker.example.com" },
      { ...base, userId: f.userId },
      {
        ...base,
        authentication: { method: "vnc_password", password: "injected" },
      },
    ]) {
      const result = await request(
        runnerVncContract.resolve.path.replace(":runId", f.runId),
        {
          method: "POST",
          headers: { ...vncRunnerHeaders, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).not.toContain("injected");
    }
    const checkBody = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      expectedGeneration: 1,
    };
    for (const body of [
      { ...checkBody, host: "attacker.example.com" },
      { ...checkBody, userId: f.userId },
      { ...checkBody, expectedGeneration: 0 },
    ]) {
      const result = await request(
        runnerVncContract.check.path.replace(":runId", f.runId),
        {
          method: "POST",
          headers: { ...vncRunnerHeaders, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(result.status).toBe(400);
    }
    expect(kms.decryptCalls).toBe(0);
  });

  it("returns an explicit direct snapshot to a capable Runner", async () => {
    const f = await claimedFixture();
    await expect(
      api.resolve(f, { supportedProfiles: [...vncProfiles] }),
    ).resolves.toStrictEqual({
      outcome: "resolved_transport",
      host: "vnc.example.com",
      port: 5900,
      generation: 1,
      serverName: "vnc.example.com",
      transport: { type: "direct" },
      authentication: { method: "vnc_password", password: vncPassword },
      security: vncSecurity,
    });
    expect((await check(f, 1)).body).toStrictEqual({ outcome: "valid" });
    expect(
      (
        await check(f, 1, {
          expectedTransport: { type: "direct" },
        })
      ).body,
    ).toStrictEqual({ outcome: "valid" });
    expect(
      (
        await check(f, 1, {
          expectedTransport: {
            type: "ssh",
            connectionId: randomUUID(),
            generation: 1,
          },
        })
      ).body,
    ).toStrictEqual({ outcome: "configuration_changed" });
  });

  it("refuses saved SSH transport before decrypting VNC credentials", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "VNC gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("deploy", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          transport: { type: "ssh", connectionId: ssh.body.id },
        },
      }),
      [200],
    );
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, {
        supportedProfiles: vncProfiles.filter((profile) => {
          return profile.transportType === "direct";
        }),
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, false);
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "unavailable",
    });
    await api.setDefault(f, "ssh", ssh.body.id, true);
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
  });

  it("requires both chat host permissions and binds SSH-backed handoff and checks to the exact SSH generation", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "VNC gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("deploy", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          transport: { type: "ssh", connectionId: ssh.body.id },
          security: {
            ...vncSecurity,
            serverName: "desktop.internal",
          },
        },
      }),
      [200],
    );
    await api.setDefault(f, "ssh", ssh.body.id, false);
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { supportedProfiles: [...vncProfiles] }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);

    await api.setDefault(f, "ssh", ssh.body.id, true);
    const resolved = await api.resolve(f, {
      supportedProfiles: [...vncProfiles],
    });
    expect(resolved).toStrictEqual({
      outcome: "resolved_transport",
      host: "vnc.example.com",
      port: 5900,
      generation: 2,
      serverName: "desktop.internal",
      transport: {
        type: "ssh",
        connectionId: ssh.body.id,
        generation: 1,
      },
      authentication: { method: "vnc_password", password: vncPassword },
      security: vncSecurity,
    });
    expect(JSON.stringify(resolved)).not.toContain("private-key");
    const expectedTransport = {
      type: "ssh" as const,
      connectionId: ssh.body.id,
      generation: 1,
    };
    expect((await check(f, 2, { expectedTransport })).body).toStrictEqual({
      outcome: "valid",
    });
    for (const override of [
      {},
      { expectedTransport: { type: "direct" as const } },
      {
        expectedTransport: {
          ...expectedTransport,
          connectionId: randomUUID(),
        },
      },
      {
        expectedTransport: { ...expectedTransport, generation: 2 },
      },
    ]) {
      expect((await check(f, 2, override)).body).toStrictEqual({
        outcome: "configuration_changed",
      });
    }

    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    useSecretKmsProbe(undefined, (_request, call) => {
      if (call !== 1) {
        return undefined;
      }
      entered.resolve(undefined);
      return release.promise;
    });
    const pending = api.resolve(f, {
      supportedProfiles: [...vncProfiles],
    });
    await entered.promise;
    const rotated = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).update({
        headers: vncSessionHeaders,
        params: { connectionId: ssh.body.id },
        body: {
          expectedGeneration: 1,
          displayName: "Rotated VNC gateway",
        },
      }),
      [200],
    ).finally(() => {
      release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
    });
    expect(rotated.body.generation).toBe(2);
    await expect(pending).resolves.toStrictEqual({ outcome: "unavailable" });
    expect((await check(f, 2, { expectedTransport })).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(
      api.resolve(f, { supportedProfiles: [...vncProfiles] }),
    ).resolves.toMatchObject({
      outcome: "resolved_transport",
      generation: 2,
      transport: {
        type: "ssh",
        connectionId: ssh.body.id,
        generation: 2,
      },
    });

    await api.setDefault(f, "ssh", ssh.body.id, false);
    expect(
      (
        await check(f, 2, {
          expectedTransport: { ...expectedTransport, generation: 2 },
        })
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("resolves QEMU SCRAM only for the exact Runner capability, before and after rotation", async () => {
    const f = await claimedFixture();
    const scramSecurity = {
      type: "qemu_x509_sasl" as const,
      trust: { mode: "system" as const },
      serverName: "qemu.example.com",
    };
    const saved = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: {
          ...vncConnectionBody(),
          id: randomUUID(),
          host: "qemu.example.com",
          credential: {
            create: {
              name: "QEMU SCRAM",
              authentication: {
                method: "qemu_scram_sha256" as const,
                username: "operator",
                password: " first-secret ",
              },
            },
          },
          security: scramSecurity,
        },
      }),
      [201],
    );
    const target = { ...f, connectionId: saved.body.id };
    await api.enableDefault(f, "vnc", target.connectionId);
    const direct = {
      authMethod: "qemu_scram_sha256" as const,
      securityType: "qemu_x509_sasl" as const,
      transportType: "direct" as const,
    };
    const kms = useSecretKmsProbe();
    await expect(api.resolve(target)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    await expect(
      api.resolve(target, {
        supportedProfiles: [
          {
            authMethod: "username_password",
            securityType: "x509_plain",
            transportType: "direct",
          },
        ],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    await expect(
      api.resolve(target, {
        supportedProfiles: [{ ...direct, transportType: "ssh" }],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(0);
    await expect(
      api.resolve(target, { supportedProfiles: [direct] }),
    ).resolves.toStrictEqual({
      outcome: "resolved_transport",
      host: "qemu.example.com",
      port: 5900,
      serverName: "qemu.example.com",
      generation: 1,
      transport: { type: "direct" },
      authentication: {
        method: "qemu_scram_sha256",
        username: "operator",
        password: " first-secret ",
      },
      security: { type: "qemu_x509_sasl", trust: { mode: "system" } },
    });
    expect(kms.decryptCalls).toBe(1);
    expect((await check(target, 1)).body).toStrictEqual({ outcome: "valid" });
    const credentialId = requireVncCredentialId(saved.body);
    const rotated = await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "qemu_scram_sha256",
            username: "operator",
            password: "new-secret",
          },
        },
      }),
      [200],
    );
    expect(rotated.body.revision).toBe(2);
    expect(JSON.stringify(rotated.body)).not.toContain("new-secret");
    expect((await check(target, 1)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(
      api.resolve(target, { supportedProfiles: [direct] }),
    ).resolves.toMatchObject({
      outcome: "resolved_transport",
      generation: 2,
      authentication: { password: "new-secret" },
    });

    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "QEMU SSH gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("operator", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    const throughSsh = await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: target.connectionId },
        body: {
          expectedGeneration: 2,
          host: "127.0.0.1",
          transport: { type: "ssh", connectionId: ssh.body.id },
          security: { ...scramSecurity, serverName: "qemu.internal" },
        },
      }),
      [200],
    );
    expect(throughSsh.body.generation).toBe(3);
    await expect(
      api.resolve(target, { supportedProfiles: [direct] }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    const sshProfile = { ...direct, transportType: "ssh" as const };
    await expect(
      api.resolve(target, { supportedProfiles: [sshProfile] }),
    ).resolves.toMatchObject({
      outcome: "resolved_transport",
      host: "127.0.0.1",
      serverName: "qemu.internal",
      generation: 3,
      transport: { type: "ssh", connectionId: ssh.body.id, generation: 1 },
      authentication: { method: "qemu_scram_sha256", password: "new-secret" },
    });
    await api.setDefault(f, "ssh", ssh.body.id, false);
    await expect(
      api.resolve(target, { supportedProfiles: [sshProfile] }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
  });

  it("admits Mac classic password only for an exact authorized SSH loopback profile", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Mac SSH",
          host: "mac.example.com",
          credential: inlineSshKey("operator", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    const body = {
      id: randomUUID(),
      displayName: "Mac classic VNC password",
      host: "127.0.0.1",
      credential: {
        create: {
          name: "Mac classic password",
          authentication: {
            method: "vnc_password" as const,
            password: "secret",
          },
        },
      },
      security: { type: "apple_vnc_password" as const },
      transport: { type: "ssh" as const, connectionId: ssh.body.id },
    };
    const invalidRoute = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: { ...body, host: "localhost" },
      }),
      [400],
    );
    expect(invalidRoute.body.error.code).toBe(
      "VNC_INVALID_APPLE_VNC_PASSWORD_ROUTE",
    );
    const direct = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: {
          ...body,
          host: "mac.example.com",
          transport: { type: "direct" },
        },
      }),
      [400],
    );
    expect(direct.body.error.code).toBe("VNC_INVALID_APPLE_VNC_PASSWORD_ROUTE");
    const mismatch = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: { ...body, security: { type: "apple_dh" } },
      }),
      [400],
    );
    expect(mismatch.body.error.code).toBe("VNC_PROFILE_MISMATCH");
    const saved = await accept(
      api.connections().create({ headers: vncSessionHeaders, body }),
      [201],
    );
    expect(saved.body).toMatchObject({
      host: "127.0.0.1",
      security: { type: "apple_vnc_password" },
      transport: { type: "ssh", connectionId: ssh.body.id },
    });
    expect(JSON.stringify(saved.body)).not.toContain("secret");
    const target = { ...f, connectionId: saved.body.id };
    await api.enableDefault(f, "vnc", target.connectionId);
    const profile = [
      {
        authMethod: "vnc_password" as const,
        securityType: "apple_vnc_password" as const,
        transportType: "ssh" as const,
      },
    ];
    const kms = useSecretKmsProbe();
    await expect(api.resolve(target)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    await expect(
      api.resolve(target, {
        supportedProfiles: [
          {
            authMethod: "vnc_password",
            securityType: "x509_vnc",
            transportType: "ssh",
          },
        ],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, false);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, true);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({
      outcome: "resolved_apple_vnc_password",
      host: "127.0.0.1",
      port: 5900,
      generation: 1,
      transport: { type: "ssh", connectionId: ssh.body.id, generation: 1 },
      authentication: { method: "vnc_password", password: "secret" },
      security: { type: "apple_vnc_password" },
    });
    expect(kms.decryptCalls).toBe(1);
    const expectedTransport = {
      type: "ssh" as const,
      connectionId: ssh.body.id,
      generation: 1,
    };
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "valid",
    });
    const rotated = await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: requireVncCredentialId(saved.body) },
        body: {
          expectedRevision: 1,
          authentication: { method: "vnc_password", password: "rotated" },
        },
      }),
      [200],
    );
    expect(JSON.stringify(rotated.body)).not.toContain("rotated");
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toMatchObject({
      outcome: "resolved_apple_vnc_password",
      generation: 2,
      authentication: { password: "rotated" },
    });
    const denied = await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: saved.body.id },
        body: { expectedGeneration: 2, host: "localhost" },
      }),
      [400],
    );
    expect(denied.body.error.code).toBe("VNC_INVALID_APPLE_VNC_PASSWORD_ROUTE");
    await api.setDefault(f, "ssh", ssh.body.id, false);
    expect((await check(target, 2, { expectedTransport })).body).toStrictEqual({
      outcome: "unavailable",
    });
  });

  it("admits Apple DH only for an authorized SSH-to-Mac-loopback profile", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Mac SSH",
          host: "mac.example.com",
          credential: inlineSshKey("ec2-user", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    const appleBody = {
      id: randomUUID(),
      displayName: "Mac Screen Sharing",
      host: "127.0.0.1",
      credential: {
        create: {
          name: "Mac login",
          authentication: {
            method: "apple_dh_username_password" as const,
            username: "operator",
            password: "secret",
          },
        },
      },
      security: { type: "apple_dh" as const },
      transport: { type: "ssh" as const, connectionId: ssh.body.id },
    };
    for (const [invalid, expectedCode] of [
      [
        { ...appleBody, transport: { type: "direct" as const } },
        "VNC_INVALID_HOST",
      ],
      [{ ...appleBody, host: "mac.example.com" }, "VNC_INVALID_APPLE_DH_ROUTE"],
    ] as const) {
      const result = await accept(
        api.connections().create({ headers: vncSessionHeaders, body: invalid }),
        [400],
      );
      expect(result.body.error.code).toBe(expectedCode);
    }
    const apple = await accept(
      api.connections().create({ headers: vncSessionHeaders, body: appleBody }),
      [201],
    );
    expect(apple.body.security).toStrictEqual({ type: "apple_dh" });
    const target = { ...f, connectionId: apple.body.id };
    await api.enableDefault(f, "vnc", target.connectionId);
    const profile = [
      {
        authMethod: "apple_dh_username_password" as const,
        securityType: "apple_dh" as const,
        transportType: "ssh" as const,
      },
    ];
    const kms = useSecretKmsProbe();
    await expect(api.resolve(target)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    await api.setDefault(f, "ssh", ssh.body.id, false);
    expect(kms.decryptCalls).toBe(0);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, true);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({
      outcome: "resolved_apple_dh",
      host: "127.0.0.1",
      port: 5900,
      generation: 1,
      transport: { type: "ssh", connectionId: ssh.body.id, generation: 1 },
      authentication: {
        method: "apple_dh_username_password",
        username: "operator",
        password: "secret",
      },
      security: { type: "apple_dh" },
    });
    expect(kms.decryptCalls).toBe(1);
    const expectedTransport = {
      type: "ssh" as const,
      connectionId: ssh.body.id,
      generation: 1,
    };
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "valid",
    });
    const rotated = await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: requireVncCredentialId(apple.body) },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "apple_dh_username_password",
            username: "operator",
            password: "new-secret",
          },
        },
      }),
      [200],
    );
    expect(rotated.body).toMatchObject({
      authMethod: "apple_dh_username_password",
      username: "operator",
      revision: 2,
    });
    expect(JSON.stringify(rotated.body)).not.toContain("new-secret");
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toMatchObject({
      outcome: "resolved_apple_dh",
      generation: 2,
      authentication: { password: "new-secret" },
    });
    await api.setDefault(f, "ssh", ssh.body.id, false);
    expect((await check(target, 2, { expectedTransport })).body).toStrictEqual({
      outcome: "unavailable",
    });
  });

  it("admits Apple SRP only for an authorized SSH-to-Mac-loopback profile", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Mac SSH",
          host: "mac.example.com",
          credential: inlineSshKey("ec2-user", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    const body = {
      id: randomUUID(),
      displayName: "Mac Screen Sharing SRP",
      host: "127.0.0.1",
      credential: {
        create: {
          name: "Mac SRP login",
          authentication: {
            method: "apple_srp_username_password" as const,
            username: "operator",
            password: "secret",
          },
        },
      },
      security: { type: "apple_srp" as const },
      transport: { type: "ssh" as const, connectionId: ssh.body.id },
    };
    expect(
      (
        await accept(
          api.connections().create({
            headers: vncSessionHeaders,
            body: { ...body, host: "localhost" },
          }),
          [400],
        )
      ).body.error.code,
    ).toBe("VNC_INVALID_APPLE_SRP_ROUTE");
    expect(
      (
        await accept(
          api.connections().create({
            headers: vncSessionHeaders,
            body: { ...body, security: { type: "apple_dh" } },
          }),
          [400],
        )
      ).body.error.code,
    ).toBe("VNC_PROFILE_MISMATCH");
    const saved = await accept(
      api.connections().create({ headers: vncSessionHeaders, body }),
      [201],
    );
    expect(saved.body.security).toStrictEqual({ type: "apple_srp" });
    const target = { ...f, connectionId: saved.body.id };
    await api.enableDefault(f, "vnc", target.connectionId);
    const profile = [
      {
        authMethod: "apple_srp_username_password" as const,
        securityType: "apple_srp" as const,
        transportType: "ssh" as const,
      },
    ];
    const kms = useSecretKmsProbe();
    await expect(api.resolve(target)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, false);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, true);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({
      outcome: "resolved_apple_srp",
      host: "127.0.0.1",
      port: 5900,
      generation: 1,
      transport: { type: "ssh", connectionId: ssh.body.id, generation: 1 },
      authentication: {
        method: "apple_srp_username_password",
        username: "operator",
        password: "secret",
      },
      security: { type: "apple_srp" },
    });
    expect(kms.decryptCalls).toBe(1);
    const expectedTransport = {
      type: "ssh" as const,
      connectionId: ssh.body.id,
      generation: 1,
    };
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "valid",
    });
    for (const [change, code] of [
      [{ host: "localhost" }, "VNC_INVALID_APPLE_SRP_ROUTE"],
      [{ security: { type: "apple_dh" as const } }, "VNC_PROFILE_MISMATCH"],
    ] as const) {
      const rejected = await accept(
        api.connections().update({
          headers: vncSessionHeaders,
          params: { connectionId: saved.body.id },
          body: { expectedGeneration: 1, ...change },
        }),
        [400],
      );
      expect(rejected.body.error.code).toBe(code);
    }
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "valid",
    });
    const rotated = await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: requireVncCredentialId(saved.body) },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "apple_srp_username_password",
            username: "operator",
            password: "new-secret",
          },
        },
      }),
      [200],
    );
    expect(rotated.body).toMatchObject({
      authMethod: "apple_srp_username_password",
      username: "operator",
      revision: 2,
    });
    expect(JSON.stringify(rotated.body)).not.toContain("new-secret");
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toMatchObject({
      outcome: "resolved_apple_srp",
      generation: 2,
      authentication: { password: "new-secret" },
    });
    const reboundSsh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Other Mac SSH",
          host: "other-mac.example.com",
          credential: inlineSshKey("ec2-user", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", reboundSsh.body.id);
    const rebound = await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: saved.body.id },
        body: {
          expectedGeneration: 2,
          transport: { type: "ssh", connectionId: reboundSsh.body.id },
        },
      }),
      [200],
    );
    expect(rebound.body).toMatchObject({
      generation: 3,
      transport: { type: "ssh", connectionId: reboundSsh.body.id },
      security: { type: "apple_srp" },
    });
    expect((await check(target, 2, { expectedTransport })).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    const reboundTransport = {
      type: "ssh" as const,
      connectionId: reboundSsh.body.id,
      generation: 1,
    };
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toMatchObject({
      outcome: "resolved_apple_srp",
      generation: 3,
      transport: reboundTransport,
    });
    await api.setDefault(f, "ssh", reboundSsh.body.id, false);
    expect(
      (await check(target, 3, { expectedTransport: reboundTransport })).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("admits Apple RSA/SRP only for a matching saved SSH loopback and exact Runner capability", async () => {
    const f = await claimedFixture();
    const ssh = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Controlled Mac SSH",
          host: "mac.example.com",
          credential: inlineSshKey("operator", "private-key"),
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    const body = {
      id: randomUUID(),
      displayName: "Mac Screen Sharing RSA/SRP",
      host: "127.0.0.1",
      credential: {
        create: {
          name: "RSA/SRP login",
          authentication: {
            method: "apple_rsa_srp_username_password" as const,
            username: "operator",
            password: "secret",
          },
        },
      },
      security: { type: "apple_rsa_srp" as const },
      transport: { type: "ssh" as const, connectionId: ssh.body.id },
    };
    for (const [change, code] of [
      [{ host: "localhost" }, "VNC_INVALID_APPLE_RSA_SRP_ROUTE"],
      [{ host: "mac.example.com" }, "VNC_INVALID_APPLE_RSA_SRP_ROUTE"],
      [{ transport: { type: "direct" as const } }, "VNC_INVALID_HOST"],
    ] as const) {
      const invalid = await accept(
        api.connections().create({
          headers: vncSessionHeaders,
          body: { ...body, ...change },
        }),
        [400],
      );
      expect(invalid.body.error.code).toBe(code);
    }
    for (const security of [
      { type: "apple_dh" as const },
      { type: "apple_srp" as const },
    ]) {
      const mismatch = await accept(
        api.connections().create({
          headers: vncSessionHeaders,
          body: { ...body, security },
        }),
        [400],
      );
      expect(mismatch.body.error.code).toBe("VNC_PROFILE_MISMATCH");
    }
    const saved = await accept(
      api.connections().create({ headers: vncSessionHeaders, body }),
      [201],
    );
    const target = { ...f, connectionId: saved.body.id };
    await api.enableDefault(f, "vnc", target.connectionId);
    const profile = [
      {
        authMethod: "apple_rsa_srp_username_password" as const,
        securityType: "apple_rsa_srp" as const,
        transportType: "ssh" as const,
      },
    ];
    const kms = useSecretKmsProbe();
    await expect(api.resolve(target)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    await expect(
      api.resolve(target, {
        supportedProfiles: [
          {
            authMethod: "apple_srp_username_password",
            securityType: "apple_srp",
            transportType: "ssh",
          },
        ],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, false);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(f, "ssh", ssh.body.id, true);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({
      outcome: "resolved_apple_rsa_srp",
      host: "127.0.0.1",
      port: 5900,
      generation: 1,
      transport: { type: "ssh", connectionId: ssh.body.id, generation: 1 },
      authentication: {
        method: "apple_rsa_srp_username_password",
        username: "operator",
        password: "secret",
      },
      security: { type: "apple_rsa_srp" },
    });
    expect(kms.decryptCalls).toBe(1);
    const expectedTransport = {
      type: "ssh" as const,
      connectionId: ssh.body.id,
      generation: 1,
    };
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "valid",
    });
    const invalidUpdate = await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: saved.body.id },
        body: { expectedGeneration: 1, host: "localhost" },
      }),
      [400],
    );
    expect(invalidUpdate.body.error.code).toBe(
      "VNC_INVALID_APPLE_RSA_SRP_ROUTE",
    );
    const rotated = await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: requireVncCredentialId(saved.body) },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "apple_rsa_srp_username_password",
            username: "operator",
            password: "new-secret",
          },
        },
      }),
      [200],
    );
    expect(JSON.stringify(rotated.body)).not.toContain("new-secret");
    expect((await check(target, 1, { expectedTransport })).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toMatchObject({
      outcome: "resolved_apple_rsa_srp",
      generation: 2,
      authentication: { password: "new-secret" },
    });
  });

  it("rejects X509Plain for an old Runner before KMS and resolves it for a capable Runner", async () => {
    const f = await claimedFixture();
    const kms = useSecretKmsProbe();
    const plain = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "Plain desktop",
          host: "plain.example.com",
          credential: {
            create: {
              name: "Plain credential",
              authentication: {
                method: "username_password",
                username: "operator",
                password: " private secret ",
              },
            },
          },
          security: {
            type: "x509_plain",
            trust: { mode: "system" },
          },
        },
      }),
      [201],
    );
    await api.enableDefault(f, "vnc", plain.body.id);
    await expect(
      api.resolve(f, {
        connectionId: plain.body.id,
        supportedProfiles: [...vncX509VncProfiles],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(0);
    await expect(
      api.resolve(f, { connectionId: plain.body.id }),
    ).resolves.toStrictEqual({
      outcome: "resolved_transport",
      host: "plain.example.com",
      port: 5900,
      generation: 1,
      serverName: "plain.example.com",
      transport: { type: "direct" },
      authentication: {
        method: "username_password",
        username: "operator",
        password: " private secret ",
      },
      security: { type: "x509_plain", trust: { mode: "system" } },
    });
    expect(kms.decryptCalls).toBe(1);
    expect(
      (
        await check(f, plain.body.generation, {
          connectionId: plain.body.id,
        })
      ).body,
    ).toStrictEqual({ outcome: "valid" });
  });

  it("rejects inactive and unclaimed Runs without requiring chat provenance", async () => {
    const f = await api.fixture();
    const { generation } = await api.resolved(f);
    const kms = useSecretKmsProbe();
    for (const runtime of [
      { status: "pending" as const },
      { status: "completed" as const },
      { status: "cancelled" as const },
      { status: "failed" as const },
      { runnerId: null, heartbeatGeneration: null },
    ]) {
      const other = await api.runtime(f, { agentId: f.agentId, ...runtime });
      await expect(api.resolve({ ...f, ...other })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect((await check({ ...f, ...other }, generation)).body).toStrictEqual({
        outcome: "unavailable",
      });
    }
    expect(kms.decryptCalls).toBe(0);
    for (const triggerSource of [
      "automation-schedule",
      "automation-event",
      "webhook",
      null,
    ] as const) {
      const other = await api.runtime(f, {
        agentId: f.agentId,
        triggerSource,
        chat: false,
      });
      expect((await api.resolve({ ...f, ...other })).outcome).toBe(
        "unavailable",
      );
    }
  });

  it("rechecks feature and current membership on private calls", async () => {
    const f = await claimedFixture();
    const { generation } = await api.resolved(f);
    const kms = useSecretKmsProbe();
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: false,
    });
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect((await check(f, generation)).body).toStrictEqual({
      outcome: "unavailable",
    });
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect((await check(f, generation)).body).toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
  });

  it("authorizes independent Runs concurrently without reserving the connection or decrypting on checks", async () => {
    const f = await claimedFixture();
    const other = { ...f, ...(await claimedRuntime(f)) };
    const [first, second] = await Promise.all([
      api.resolved(f),
      api.resolved(other),
    ]);
    expect(second.generation).toBe(first.generation);
    const kms = useSecretKmsProbe();
    for (const result of await Promise.all([
      check(f, first.generation),
      check(other, second.generation),
    ])) {
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.body).toStrictEqual({ outcome: "valid" });
    }
    expect(kms.decryptCalls).toBe(0);
  });

  it("checks the current generation through rotation, deletion and recreation with the same connection UUID", async () => {
    const f = await claimedFixture();
    const original = await api.resolved(f);
    await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: f.credentialId },
        body: {
          expectedRevision: 1,
          authentication: { method: "vnc_password", password: "rotated" },
        },
      }),
      [200],
    );
    const rotated = await api.resolved(f);
    expect(rotated.generation).toBe(2);
    expect((await check(f, original.generation)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    expect((await check(f, rotated.generation)).body).toStrictEqual({
      outcome: "valid",
    });
    await accept(
      api.connections().delete({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: 2 },
      }),
      [204],
    );
    expect((await check(f, rotated.generation)).body).toStrictEqual({
      outcome: "unavailable",
    });
    await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: {
          ...vncConnectionBody(f.connectionId),
          credential: {
            create: {
              name: "Replacement VNC password",
              authentication: {
                method: "vnc_password",
                password: "replaced",
              },
            },
          },
        },
      }),
      [201],
    );
    await api.enableDefault(f, "vnc", f.connectionId);
    const replacement = await api.resolved(f);
    expect(replacement.generation).toBe(1);
    expect(replacement.authentication).toStrictEqual({
      method: "vnc_password",
      password: "replaced",
    });
    expect((await check(f, original.generation)).body).toStrictEqual({
      outcome: "valid",
    });
    expect((await check(f, rotated.generation)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
  });

  it("surfaces KMS failure as a sanitized error", async () => {
    const f = await claimedFixture();
    useSecretKmsProbe(undefined, () => {
      return Promise.reject(new Error("KMS secret-response-canary"));
    });
    const result = await accept(
      api.runner().resolve({
        headers: vncRunnerHeaders,
        params: { runId: f.runId },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
          supportedProfiles: [...vncProfiles],
        },
      }),
      [500],
    );
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(result.body)).not.toContain("secret-response-canary");
    expect(JSON.stringify(result.body)).not.toContain(vncPassword);
  });

  it("allows rotation while KMS is pending and discards the old secret handoff", async () => {
    const f = await claimedFixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    useSecretKmsProbe(undefined, (_request, call) => {
      if (call !== 1) {
        return undefined;
      }
      entered.resolve(undefined);
      return release.promise;
    });
    const pending = api.resolve(f);
    await entered.promise;
    await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: f.credentialId },
        body: {
          expectedRevision: 1,
          authentication: { method: "vnc_password", password: "rotated" },
        },
      }),
      [200],
    ).finally(() => {
      release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
    });
    await expect(pending).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(api.resolved(f)).resolves.toMatchObject({
      authentication: { method: "vnc_password", password: "rotated" },
      generation: 2,
    });
  });

  it("discards an in-flight direct VNC password when its Run is cancelled before KMS returns", async () => {
    const f = await claimedFixture();
    const peer = await claimedFixture();
    api.authenticate(f);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    useSecretKmsProbe(undefined, (_request, call) => {
      if (call === 1) {
        entered.resolve(undefined);
        return release.promise;
      }
      return undefined;
    });
    const pending = api.resolve(f);
    await entered.promise;
    const releaseKms = () => {
      release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
    };
    const cancellation = await onRejection(
      runs.requestCancelRun(
        {
          userId: f.userId,
          orgId: f.orgId,
          orgRole: "org:admin",
          email: `${f.userId}@example.com`,
        },
        f.runId,
        [200],
      ),
      () => {
        releaseKms();
      },
    );
    expect(cancellation.body).toMatchObject({
      id: f.runId,
      status: "cancelled",
    });
    releaseKms();
    await expect(pending).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(check(f, 1)).resolves.toMatchObject({
      body: { outcome: "unavailable" },
    });
    api.authenticate(peer);
    await expect(api.resolve(peer)).resolves.toMatchObject({
      outcome: "resolved_transport",
    });
  }, 20_000);
});
