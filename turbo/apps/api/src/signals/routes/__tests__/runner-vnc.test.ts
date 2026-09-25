import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  runnerVncContract,
  type RunnerVncCheckRequest,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { createDeferredPromise, onRejection } from "../../utils";
import { runnerVncRoutes } from "../runner-vnc";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
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
  vncTransportProfiles,
  vncX509VncProfiles,
  type VncRuntimeFixture,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);
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
        ...override,
      },
    }),
    [200],
  );
}

describe("private Runner VNC authority", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 2 });
  const db = drizzle(pool);
  afterAll(async () => {
    await pool.end();
  });

  it("uses current chat VNC and exact SSH dependency access during an active Run", async () => {
    const f = await api.fixture({
      grant: false,
      runtime: { chat: true, access: false },
    });
    if (!f.threadId) {
      throw new Error("Missing fixture chat thread");
    }
    const threadId = f.threadId;
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
      [FeatureSwitchKey.ThreadRemoteAccess]: true,
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
      outcome: "resolved",
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
      api.resolve(f, { supportedProfiles: [...vncTransportProfiles] }),
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
      api.resolve(f, { supportedProfiles: [...vncTransportProfiles] }),
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
      api.resolve(f, { supportedProfiles: [...vncTransportProfiles] }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect((await check(f, 2)).body).toStrictEqual({ outcome: "unavailable" });
  });

  it("requires an explicit VNC grant and preserves the exact secret only in the no-store handoff", async () => {
    const f = await api.fixture({ grant: false });
    const kms = useSecretKmsProbe();
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
    await api.grant(f, true);
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
      outcome: "resolved",
      host: "vnc.example.com",
      port: 5900,
      authentication: { method: "vnc_password", password: vncPassword },
      security: vncSecurity,
      generation: 1,
    });
    const first = await api.resolved(f);
    await api.grant(f, true);
    expect((await api.resolved(f)).generation).toBe(first.generation);
    const listed = await accept(
      api.connections().list({ headers: vncSessionHeaders }),
      [200],
    );
    expect(JSON.stringify(listed.body)).not.toContain(vncPassword);
    await api.grant(f, false);
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect((await check(f, first.generation)).body).toStrictEqual({
      outcome: "unavailable",
    });
    await api.grant(f, true);
    expect((await api.resolved(f)).generation).toBe(first.generation);
    expect((await check(f, first.generation)).body).toStrictEqual({
      outcome: "valid",
    });
  });

  it("rejects wrong auth classes and exact winning-process mismatches before KMS", async () => {
    const f = await api.fixture();
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
    const f = await api.fixture();
    const foreign = await api.fixture();
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
    const f = await api.fixture();
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

  it("preserves the legacy direct response and returns an explicit direct snapshot to a capable Runner", async () => {
    const f = await api.fixture();
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "resolved",
      host: "vnc.example.com",
      port: 5900,
      generation: 1,
      authentication: { method: "vnc_password", password: vncPassword },
      security: vncSecurity,
    });
    await expect(
      api.resolve(f, { supportedProfiles: [...vncTransportProfiles] }),
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
    const f = await api.fixture();
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
        },
      }),
      [200],
    );
    await api.grantSsh(f, false);
    const kms = useSecretKmsProbe();
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    expect(kms.decryptCalls).toBe(0);
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "unavailable",
    });
    await api.grantSsh(f, true);
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
  });

  it("requires both grants and binds SSH-backed handoff and checks to the exact SSH generation", async () => {
    const f = await api.fixture();
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
          security: {
            ...vncSecurity,
            serverName: "desktop.internal",
          },
        },
      }),
      [200],
    );
    await api.grantSsh(f, false);
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { supportedProfiles: [...vncTransportProfiles] }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);

    await api.grantSsh(f, true);
    const resolved = await api.resolve(f, {
      supportedProfiles: [...vncTransportProfiles],
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
      supportedProfiles: [...vncTransportProfiles],
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
      api.resolve(f, { supportedProfiles: [...vncTransportProfiles] }),
    ).resolves.toMatchObject({
      outcome: "resolved_transport",
      generation: 2,
      transport: {
        type: "ssh",
        connectionId: ssh.body.id,
        generation: 2,
      },
    });

    await api.grantSsh(f, false);
    expect(
      (
        await check(f, 2, {
          expectedTransport: { ...expectedTransport, generation: 2 },
        })
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("admits Apple DH only for an authorized SSH-to-Mac-loopback profile", async () => {
    const f = await api.fixture();
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
    const profile = [
      {
        authMethod: "apple_dh_username_password" as const,
        securityType: "apple_dh" as const,
        transportType: "ssh" as const,
      },
    ];
    await api.grantSsh(f, false);
    const kms = useSecretKmsProbe();
    await expect(api.resolve(target)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    expect(kms.decryptCalls).toBe(0);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
    await api.grantSsh(f, true);
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
        params: { credentialId: apple.body.credentialId },
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
    await api.grantSsh(f, false);
    expect((await check(target, 2, { expectedTransport })).body).toStrictEqual({
      outcome: "unavailable",
    });
  });

  it("admits Apple SRP only for an authorized SSH-to-Mac-loopback profile", async () => {
    const f = await api.fixture();
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
    await api.grantSsh(f, false);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
    await api.grantSsh(f, true);
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
        params: { credentialId: saved.body.credentialId },
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
    await api.grantSsh(f, false);
    expect(
      (await check(target, 3, { expectedTransport: reboundTransport })).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("admits Apple RSA/SRP only for a matching saved SSH loopback and exact Runner capability", async () => {
    const f = await api.fixture();
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
    await api.grantSsh(f, false);
    await expect(
      api.resolve(target, { supportedProfiles: profile }),
    ).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
    await api.grantSsh(f, true);
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
        params: { credentialId: saved.body.credentialId },
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
    const f = await api.fixture();
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
      outcome: "resolved",
      host: "plain.example.com",
      port: 5900,
      generation: 1,
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
      expect((await api.resolve({ ...f, ...other })).outcome).toBe("resolved");
    }
  });

  it("rechecks feature and current membership on private calls", async () => {
    const f = await api.fixture();
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
    const f = await api.fixture();
    const other = { ...f, ...(await api.runtime(f, { agentId: f.agentId })) };
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
    const f = await api.fixture();
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
    const f = await api.fixture();
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
    const f = await api.fixture();
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
    const f = await api.fixture();
    const peer = await api.fixture();
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
    await onRejection(
      db
        .update(agentRuns)
        .set({ status: "cancelled", runnerCancellationMode: "hard" })
        .where(eq(agentRuns.id, f.runId)),
      () => {
        releaseKms();
      },
    );
    releaseKms();
    await expect(pending).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(check(f, 1)).resolves.toMatchObject({
      body: { outcome: "unavailable" },
    });
    api.authenticate(peer);
    await expect(api.resolve(peer)).resolves.toMatchObject({
      outcome: "resolved",
    });
  }, 20_000);
});
