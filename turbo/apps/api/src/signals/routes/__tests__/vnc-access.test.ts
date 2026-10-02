import { randomUUID } from "node:crypto";

import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { agentsRoutes } from "../agents";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncAccessRoutes } from "../vnc-access";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { createBddApi } from "./helpers/api-bdd";
import { createClaimedVncApi } from "./helpers/claimed-vnc-runtime";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";
import { certificateChain, privateKey } from "./helpers/vnc-synthetic-client";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncSessionHeaders as headers,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);

beforeEach(initializeVncRuntimeTest);

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

async function owner(overrides: Partial<Owner> = {}) {
  const value = {
    orgId: `org_vnc_access_${randomUUID()}`,
    userId: `user_vnc_access_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  api.authenticate(value);
  return value;
}

function token(
  runtime: Owner & { readonly runId: string },
  capabilities = ["vnc:read"],
  expiresInSeconds = 3600,
) {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      orgId: runtime.orgId,
      userId: runtime.userId,
      runId: runtime.runId,
      capabilities,
      iat: seconds,
      exp: seconds + expiresInSeconds,
    })}`,
  };
}

function inventory() {
  return setupApp({ context, routes: vncAccessRoutes })(vncHostsContract);
}

function sshConnections() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

async function visibility(agentId: string, value: "public" | "private") {
  await accept(
    setupApp({ context, routes: agentsRoutes })(agentsByIdContract).update({
      headers,
      params: { id: agentId },
      body: { visibility: value },
    }),
    [200],
  );
}

describe("live chat VNC Run inventory", () => {
  const claimed = createClaimedVncApi(context);
  afterEach(claimed.cleanup);

  it("advertises the exact client-certificate profile without revealing private material", async () => {
    useSecretKmsProbe();
    const f = await claimed.fixture({
      defaultEnabled: false,
    });
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    api.authenticate(f);
    const created = await accept(
      api.connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Client certificate QEMU",
          host: "qemu.example.com",
          security: { type: "x509_none", trust: { mode: "system" } },
          credential: {
            create: {
              name: "QEMU identity",
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
    await accept(
      setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      ).updateHostDefault({
        headers,
        params: { protocol: "vnc", connectionId: created.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    const result = await accept(
      inventory().list({ headers: claimed.agentHeaders(f) }),
      [200],
    );
    const item = result.body.hosts.find((host) => {
      return host.id === created.body.id;
    });
    expect(item).toMatchObject({
      authMethod: "client_certificate",
      securityType: "x509_none",
      availability: { status: "ready" },
    });
    expect(JSON.stringify(result.body)).not.toContain(privateKey);
    expect(JSON.stringify(result.body)).not.toContain("certificateChain");
  });

  it("lists the owner-selected QEMU SCRAM pair without exposing its password", async () => {
    const f = await claimed.fixture({
      defaultEnabled: false,
    });
    api.authenticate(f);
    const password = "synthetic-scram-secret";
    const created = await accept(
      api.connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "QEMU SCRAM desktop",
          host: "qemu.example.com",
          security: { type: "qemu_x509_sasl", trust: { mode: "system" } },
          credential: {
            create: {
              name: "QEMU SCRAM login",
              authentication: {
                method: "qemu_scram_sha256",
                username: "operator",
                password,
              },
            },
          },
        },
      }),
      [201],
    );
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(f) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
    await accept(
      setupApp({ context, routes: chatRemoteAccessRoutes })(
        chatRemoteAccessContract,
      ).updateHostDefault({
        headers,
        params: { protocol: "vnc", connectionId: created.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    const kms = useSecretKmsProbe();
    const listed = await accept(
      inventory().list({ headers: claimed.agentHeaders(f) }),
      [200],
    );
    expect(listed.body.hosts).toContainEqual({
      id: created.body.id,
      displayName: "QEMU SCRAM desktop",
      host: "qemu.example.com",
      port: 5900,
      authMethod: "qemu_scram_sha256",
      securityType: "qemu_x509_sasl",
      availability: { status: "ready" },
    });
    expect(JSON.stringify(listed.body)).not.toContain(password);
    expect(kms.decryptCalls).toBe(0);
  });

  it("filters live chat inventory by VNC access and the exact SSH dependency", async () => {
    const f = await claimed.fixture({
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
    const listIds = async () => {
      return (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(f) }),
          [200],
        )
      ).body.hosts.map((host) => {
        return host.id;
      });
    };
    await expect(listIds()).resolves.toStrictEqual([]);
    await accept(
      remote.updateHostDefault({
        headers,
        params: { protocol: "vnc", connectionId: f.connectionId },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([f.connectionId]);
    const ssh = await accept(
      sshConnections().create({
        headers,
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
        headers,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          transport: { type: "ssh", connectionId: ssh.body.id },
          security: {
            ...vncConnectionBody().security,
            serverName: "desktop.internal",
          },
        },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([]);
    await accept(
      remote.updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: ssh.body.id },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([f.connectionId]);
    await accept(
      remote.setThreadOverride({
        headers,
        params: { threadId, protocol: "ssh", connectionId: ssh.body.id },
        body: { enabled: false },
      }),
      [200],
    );
    await expect(listIds()).resolves.toStrictEqual([]);
  });

  async function createHost(host = "vnc.example.com") {
    return await accept(
      api.connections().create({
        headers,
        body: { ...vncConnectionBody(), host },
      }),
      [201],
    );
  }

  it("keeps first-host and recreated-host chat access default off", async () => {
    const current = await claimed.paidOwner();
    const runtime = { ...current, ...(await claimed.runtime(current)) };
    const first = await createHost();
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
    await accept(
      api.connections().delete({
        headers,
        params: { connectionId: first.body.id },
        body: { expectedGeneration: first.body.generation },
      }),
      [204],
    );
    await createHost("replacement.example.com");
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
  });

  it("commits concurrent first hosts without implicit chat access", async () => {
    const current = await claimed.paidOwner();
    const runtime = { ...current, ...(await claimed.runtime(current)) };
    await Promise.all([
      createHost("one.example.com"),
      createHost("two.example.com"),
    ]);
    expect(
      (await accept(api.connections().list({ headers }), [200])).body
        .connections,
    ).toHaveLength(2);
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
  });

  it("lists a chat-enabled host for an Agent without decrypting credentials", async () => {
    const f = await claimed.fixture();
    const listed = await accept(
      inventory().list({ headers: claimed.agentHeaders(f) }),
      [200],
    );
    expect(listed.body).toStrictEqual({
      hosts: [
        {
          id: f.connectionId,
          displayName: "VNC desktop",
          host: "vnc.example.com",
          port: 5900,
          authMethod: "vnc_password",
          securityType: "x509_vnc",
          availability: { status: "ready" },
        },
      ],
    });
    const kms = useSecretKmsProbe();
    await accept(inventory().list({ headers: claimed.agentHeaders(f) }), [200]);
    expect(kms.decryptCalls).toBe(0);
    await accept(
      api.connections().create({ headers, body: vncConnectionBody() }),
      [201],
    );
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(f) }),
          [200],
        )
      ).body,
    ).toStrictEqual(listed.body);
  });

  it("returns an authorized empty inventory for current and later Agents", async () => {
    const current = await claimed.paidOwner();
    const runtime = { ...current, ...(await claimed.runtime(current)) };
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
    const bdd = createBddApi(context);
    const laterAgent = await bdd.createAgent(bdd.user(current), {
      displayName: "Later VNC Agent",
    });
    const other = await claimed.runtime({
      ...current,
      agentId: laterAgent.agentId,
    });
    expect(
      (
        await accept(
          inventory().list({
            headers: claimed.agentHeaders({ ...current, ...other }),
          }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
  });

  it("requires both VNC and SSH chat host permissions for SSH-backed inventory rows", async () => {
    const current = await claimed.paidOwner();
    const runtime = { ...current, ...(await claimed.runtime(current)) };
    const ssh = await accept(
      sshConnections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "VNC gateway",
          host: "gateway.example.com",
          credential: inlineSshKey("deploy", "private-key"),
        },
      }),
      [201],
    );
    const direct = await accept(
      api.connections().create({
        headers,
        body: {
          ...vncConnectionBody(),
          displayName: "Direct desktop",
          host: "direct.example.com",
        },
      }),
      [201],
    );
    const tunneled = await accept(
      api.connections().create({
        headers,
        body: {
          ...vncConnectionBody(),
          id: randomUUID(),
          displayName: "Tunneled desktop",
          host: "127.0.0.1",
          transport: { type: "ssh", connectionId: ssh.body.id },
        },
      }),
      [201],
    );
    await api.enableDefault(current, "vnc", direct.body.id);
    await api.enableDefault(current, "vnc", tunneled.body.id);

    const listIds = async () => {
      const result = await accept(
        inventory().list({ headers: claimed.agentHeaders(runtime) }),
        [200],
      );
      expect(JSON.stringify(result.body)).not.toContain(ssh.body.id);
      return result.body.hosts.map((entry) => {
        return entry.id;
      });
    };

    await expect(listIds()).resolves.toStrictEqual([direct.body.id]);
    await api.enableDefault(current, "ssh", ssh.body.id);
    await expect(listIds()).resolves.toStrictEqual([
      direct.body.id,
      tunneled.body.id,
    ]);
    await api.setDefault(current, "ssh", ssh.body.id, false);
    await expect(listIds()).resolves.toStrictEqual([direct.body.id]);
  });

  it("lists the authorized Mac classic password profile without exposing its secret", async () => {
    const current = await claimed.paidOwner();
    const runtime = { ...current, ...(await claimed.runtime(current)) };
    const ssh = await accept(
      sshConnections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Mac SSH",
          host: "mac.example.com",
          credential: inlineSshKey("operator", "private-key"),
        },
      }),
      [201],
    );
    const saved = await accept(
      api.connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Classic desktop",
          host: "127.0.0.1",
          credential: {
            create: {
              name: "Classic password",
              authentication: {
                method: "vnc_password",
                password: "testpass",
              },
            },
          },
          security: { type: "apple_vnc_password" },
          transport: { type: "ssh", connectionId: ssh.body.id },
        },
      }),
      [201],
    );
    await api.enableDefault(current, "vnc", saved.body.id);
    await api.enableDefault(current, "ssh", ssh.body.id);
    const kms = useSecretKmsProbe();
    const listed = await accept(
      inventory().list({ headers: claimed.agentHeaders(runtime) }),
      [200],
    );
    expect(listed.body).toStrictEqual({
      hosts: [
        {
          id: saved.body.id,
          displayName: "Classic desktop",
          host: "127.0.0.1",
          port: 5900,
          authMethod: "vnc_password",
          securityType: "apple_vnc_password",
          availability: { status: "ready" },
        },
      ],
    });
    expect(JSON.stringify(listed.body)).not.toContain("testpass");
    expect(kms.decryptCalls).toBe(0);
    await api.setDefault(current, "ssh", ssh.body.id, false);
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
  });

  it("returns both exact supported pairs without decrypting credentials", async () => {
    const current = await claimed.paidOwner();
    const runtime = { ...current, ...(await claimed.runtime(current)) };
    const kms = useSecretKmsProbe();
    const plain = await accept(
      api.connections().create({
        headers,
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
    expect(plain.body.security.type).toBe("x509_plain");
    await api.enableDefault(current, "vnc", plain.body.id);
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({
      hosts: [
        {
          id: plain.body.id,
          displayName: "Plain desktop",
          host: "plain.example.com",
          port: 5900,
          authMethod: "username_password",
          securityType: "x509_plain",
          availability: { status: "ready" },
        },
      ],
    });

    const supported = await createHost("supported.example.com");
    await api.enableDefault(current, "vnc", supported.body.id);
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({
      hosts: [
        {
          id: plain.body.id,
          displayName: "Plain desktop",
          host: "plain.example.com",
          port: 5900,
          authMethod: "username_password",
          securityType: "x509_plain",
          availability: { status: "ready" },
        },
        {
          id: supported.body.id,
          displayName: "VNC desktop",
          host: "supported.example.com",
          port: 5900,
          authMethod: "vnc_password",
          securityType: "x509_vnc",
          availability: { status: "ready" },
        },
      ],
    });
    expect(kms.decryptCalls).toBe(0);
  });

  it("isolates a shared Agent's inventory by the Run owner", async () => {
    const creator = await claimed.fixture();
    const consumer = await owner({ orgId: creator.orgId });
    const runtime = {
      ...consumer,
      ...(await claimed.runtime({ ...consumer, agentId: creator.agentId })),
    };
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body,
    ).toStrictEqual({ hosts: [] });
    const host = await accept(
      api.connections().create({
        headers,
        body: { ...vncConnectionBody(), host: "consumer.example.com" },
      }),
      [201],
    );
    await api.enableDefault(consumer, "vnc", host.body.id);
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(runtime) }),
          [200],
        )
      ).body.hosts.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual([host.body.id]);
    api.authenticate(creator);
    expect(
      (
        await accept(
          inventory().list({ headers: claimed.agentHeaders(creator) }),
          [200],
        )
      ).body.hosts.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual([creator.connectionId]);
    await visibility(creator.agentId, "private");
    api.authenticate(consumer);
    await accept(
      inventory().list({ headers: claimed.agentHeaders(runtime) }),
      [404],
    );
  });

  it("does not accept another organization or Run owner from a valid token", async () => {
    const f = await claimed.fixture();
    const foreign = await owner({ userId: f.userId });
    expect(
      (
        await accept(
          inventory().list({ headers: token({ ...foreign, runId: f.runId }) }),
          [404],
        )
      ).status,
    ).toBe(404);
    const other = await owner({ orgId: f.orgId });
    expect(
      (
        await accept(
          inventory().list({ headers: token({ ...other, runId: f.runId }) }),
          [404],
        )
      ).status,
    ).toBe(404);
    api.authenticate(f);
    expect(
      (
        await accept(
          inventory().list({ headers: token({ ...f, runId: randomUUID() }) }),
          [404],
        )
      ).status,
    ).toBe(404);
  });

  it("rechecks the VNC feature and membership for already issued tokens", async () => {
    const f = await claimed.fixture();
    const stale = claimed.agentHeaders(f);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: false,
    });
    const disabledInventory = await accept(
      inventory().list({ headers: stale }),
      [404],
    );
    expect(disabledInventory.body.error.code).toBe("VNC_UNAVAILABLE");
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    await accept(inventory().list({ headers: stale }), [404]);
  });

  it.each(["pending", "completed", "cancelled", "failed"] as const)(
    "rejects inventory for a %s Run despite an enabled host default",
    async (status) => {
      const f = await api.fixture({ runtime: { status } });
      const unavailableInventory = await accept(
        inventory().list({ headers: token(f) }),
        [404],
      );
      expect(unavailableInventory.body.error.code).toBe("VNC_UNAVAILABLE");
    },
  );

  it("keeps VNC inventory Agent-token and capability-specific", async () => {
    const f = await claimed.fixture();
    expect((await accept(inventory().list({ headers }), [403])).status).toBe(
      403,
    );
    expect(
      (
        await accept(
          inventory().list({
            headers: { authorization: `Bearer ${f.sandboxToken}` },
          }),
          [403],
        )
      ).status,
    ).toBe(403);
    for (const capabilities of [
      [],
      ["ssh:read", "ssh:write"],
      ["computer-use:write"],
      ["vnc:write"],
    ]) {
      await accept(
        inventory().list({ headers: token(f, capabilities) }),
        [403],
      );
    }
    await accept(inventory().list({ headers: token(f) }), [200]);
    await accept(
      inventory().list({ headers: token(f, ["vnc:read"], -1) }),
      [401],
    );
  });
});
