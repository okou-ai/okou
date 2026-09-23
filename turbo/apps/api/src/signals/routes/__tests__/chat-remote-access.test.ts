import { randomUUID } from "node:crypto";

import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
} from "./helpers/vnc-runtime";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { sshConnectionsRoutes } from "../ssh-connections";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const vnc = createVncRuntimeApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function accessClient() {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
}

function sshClient() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

async function ownerWithThread() {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Remote access test agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, { agentId: agent.agentId });
  if (!actor.orgId) throw new Error("Expected an organization");
  const actorWithOrg = { ...actor, orgId: actor.orgId };
  mocks.clerk.session(
    actorWithOrg.userId,
    actorWithOrg.orgId,
    actorWithOrg.orgRole,
  );
  return { actor: actorWithOrg, agentId: agent.agentId, threadId: thread.id };
}

async function createSshHost(displayName: string, id = randomUUID()) {
  await accept(
    sshClient().create({
      headers,
      body: {
        id,
        displayName,
        host: `${id}.example.com`,
        credential: inlineSshKey("deploy", "private-key", null),
      },
    }),
    [201],
  );
  return id;
}

describe("chat remote access owner API", () => {
  it("inherits the current default without chat rows and preserves explicit allow or deny across multiple hosts", async () => {
    useSecretKmsProbe();
    const owner = await ownerWithThread();
    await updateFeatureSwitchesForUser(context, owner.actor, {
      [FeatureSwitchKey.ThreadRemoteAccess]: true,
    });
    mocks.clerk.session(
      owner.actor.userId,
      owner.actor.orgId,
      owner.actor.orgRole,
    );
    const secondThread = await chat.createThread(owner.actor, {
      agentId: owner.agentId,
    });
    const first = await createSshHost("First host");
    const second = await createSshHost("Second host");

    const initial = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: owner.threadId },
      }),
      [200],
    );
    expect(initial.body.ssh).toEqual([
      {
        connectionId: first,
        displayName: "First host",
        defaultEnabled: false,
        overrideEnabled: null,
        enabled: false,
        source: "default",
      },
      {
        connectionId: second,
        displayName: "Second host",
        defaultEnabled: false,
        overrideEnabled: null,
        enabled: false,
        source: "default",
      },
    ]);
    expect(initial.body.vnc).toEqual([]);

    await accept(
      accessClient().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: first },
        body: { enabled: true },
      }),
      [200],
    );
    await accept(
      accessClient().setThreadOverride({
        headers,
        params: {
          threadId: owner.threadId,
          protocol: "ssh",
          connectionId: first,
        },
        body: { enabled: false },
      }),
      [200],
    );
    await accept(
      accessClient().setThreadOverride({
        headers,
        params: {
          threadId: owner.threadId,
          protocol: "ssh",
          connectionId: second,
        },
        body: { enabled: true },
      }),
      [200],
    );
    const overridden = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: owner.threadId },
      }),
      [200],
    );
    expect(
      overridden.body.ssh.map((host) => {
        return [host.enabled, host.source];
      }),
    ).toEqual([
      [false, "override"],
      [true, "override"],
    ]);
    const inherited = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: secondThread.id },
      }),
      [200],
    );
    expect(
      inherited.body.ssh.map((host) => {
        return [host.enabled, host.source];
      }),
    ).toEqual([
      [true, "default"],
      [false, "default"],
    ]);

    const cleared = await accept(
      accessClient().clearThreadOverride({
        headers,
        params: {
          threadId: owner.threadId,
          protocol: "ssh",
          connectionId: first,
        },
      }),
      [200],
    );
    expect(cleared.body).toMatchObject({
      enabled: true,
      overrideEnabled: null,
      source: "default",
    });
    await accept(
      accessClient().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: first },
        body: { enabled: false },
      }),
      [200],
    );
    const afterFlip = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: owner.threadId },
      }),
      [200],
    );
    expect(afterFlip.body.ssh[0]).toMatchObject({
      enabled: false,
      overrideEnabled: null,
      source: "default",
    });
    expect(afterFlip.body.ssh[1]).toMatchObject({
      enabled: true,
      overrideEnabled: true,
      source: "override",
    });

    await accept(
      sshClient().delete({ headers, params: { connectionId: second } }),
      [204],
    );
    const afterDelete = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: owner.threadId },
      }),
      [200],
    );
    expect(
      afterDelete.body.ssh.map((host) => {
        return host.connectionId;
      }),
    ).toEqual([first]);
    await createSshHost("Reused host ID", second);
    const afterReuse = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: owner.threadId },
      }),
      [200],
    );
    expect(afterReuse.body.ssh[1]).toMatchObject({
      connectionId: second,
      defaultEnabled: false,
      overrideEnabled: null,
      enabled: false,
      source: "default",
    });
  });

  it("keeps the new API gated and gives cross-owner IDs the same not-found result", async () => {
    useSecretKmsProbe();
    const firstOwner = await ownerWithThread();
    const firstHost = await createSshHost("Private host");
    await accept(accessClient().listHostDefaults({ headers }), [404]);

    const secondOwner = await ownerWithThread();
    await updateFeatureSwitchesForUser(context, secondOwner.actor, {
      [FeatureSwitchKey.ThreadRemoteAccess]: true,
    });
    mocks.clerk.session(
      secondOwner.actor.userId,
      secondOwner.actor.orgId,
      secondOwner.actor.orgRole,
    );
    await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: firstOwner.threadId },
      }),
      [404],
    );
    await accept(
      accessClient().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: firstHost },
        body: { enabled: true },
      }),
      [404],
    );
    await accept(
      accessClient().setThreadOverride({
        headers,
        params: {
          threadId: secondOwner.threadId,
          protocol: "ssh",
          connectionId: firstHost,
        },
        body: { enabled: true },
      }),
      [404],
    );
  });

  it("exposes VNC defaults and overrides only when VNC admission is available", async () => {
    initializeVncRuntimeTest();
    const owner = await ownerWithThread();
    await updateFeatureSwitchesForUser(context, owner.actor, {
      [FeatureSwitchKey.ThreadRemoteAccess]: true,
      [FeatureSwitchKey.VncAccess]: true,
    });
    vnc.authenticate({
      orgId: owner.actor.orgId,
      userId: owner.actor.userId,
    });
    const created = await accept(
      vnc.connections().create({ headers, body: vncConnectionBody() }),
      [201],
    );
    const vncId = created.body.id;
    const listed = await accept(
      accessClient().listHostDefaults({ headers }),
      [200],
    );
    expect(listed.body.vnc).toEqual([
      {
        connectionId: vncId,
        displayName: "VNC desktop",
        defaultEnabled: false,
      },
    ]);
    await accept(
      accessClient().setThreadOverride({
        headers,
        params: {
          threadId: owner.threadId,
          protocol: "vnc",
          connectionId: vncId,
        },
        body: { enabled: true },
      }),
      [200],
    );
    const effective = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: owner.threadId },
      }),
      [200],
    );
    expect(effective.body.vnc[0]).toMatchObject({
      connectionId: vncId,
      enabled: true,
      source: "override",
    });
    await accept(
      accessClient().updateHostDefault({
        headers,
        params: { protocol: "vnc", connectionId: vncId },
        body: { enabled: true },
      }),
      [200],
    );
    await accept(
      accessClient().setThreadOverride({
        headers,
        params: {
          threadId: owner.threadId,
          protocol: "vnc",
          connectionId: vncId,
        },
        body: { enabled: false },
      }),
      [200],
    );
    const denied = await accept(
      accessClient().listThreadAccess({
        headers,
        params: { threadId: owner.threadId },
      }),
      [200],
    );
    expect(denied.body.vnc[0]).toMatchObject({
      defaultEnabled: true,
      overrideEnabled: false,
      enabled: false,
      source: "override",
    });
    const inherited = await accept(
      accessClient().clearThreadOverride({
        headers,
        params: {
          threadId: owner.threadId,
          protocol: "vnc",
          connectionId: vncId,
        },
      }),
      [200],
    );
    expect(inherited.body).toMatchObject({
      defaultEnabled: true,
      overrideEnabled: null,
      enabled: true,
      source: "default",
    });
    await updateFeatureSwitchesForUser(context, owner.actor, {
      [FeatureSwitchKey.ThreadRemoteAccess]: true,
      [FeatureSwitchKey.VncAccess]: false,
    });
    vnc.authenticate({
      orgId: owner.actor.orgId,
      userId: owner.actor.userId,
    });
    const hidden = await accept(
      accessClient().listHostDefaults({ headers }),
      [200],
    );
    expect(hidden.body.vnc).toEqual([]);
    await accept(
      accessClient().updateHostDefault({
        headers,
        params: { protocol: "vnc", connectionId: vncId },
        body: { enabled: false },
      }),
      [404],
    );
  });
});
