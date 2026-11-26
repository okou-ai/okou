import { randomUUID } from "node:crypto";

import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import webClientCompatibility from "../../../lib/web-client-compatibility.json";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncConnectionsRoutes } from "../vnc-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { inlineSshKey } from "./helpers/ssh-credential";
import { vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

const clerkDirectory = createStore();

/** A current Clerk organization member, as VNC ownership requires. */
async function newActor(orgId = `org_${randomUUID()}`): Promise<Actor> {
  const actor = { userId: `user_${randomUUID()}`, orgId };
  await clerkDirectory.set(
    seedOrgMembership$,
    { ...actor, role: "admin" },
    context.signal,
  );
  return actor;
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
}

const sshHosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
const sshCredentials = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};
const vncHosts = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
};
const vncCredentials = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
};

async function createSshHost(owner: Actor) {
  signIn(owner);
  const id = randomUUID();
  const created = await accept(
    sshHosts().create({
      headers,
      body: {
        id,
        displayName: "Build box",
        host: `build-${id.slice(0, 8)}.example.test`,
        credential: inlineSshKey("deploy", `key-${randomUUID()}`),
      },
    }),
    [201],
  );
  return created.body;
}

async function listSshHosts(actor: Actor) {
  signIn(actor);
  return (await accept(sshHosts().list({ headers }), [200])).body.connections;
}

async function createVncHost(owner: Actor, sshConnectionId?: string) {
  signIn(owner);
  const created = await accept(
    vncHosts().create({
      headers,
      body: {
        ...vncConnectionBody(),
        ...(sshConnectionId
          ? {
              transport: {
                type: "ssh" as const,
                connectionId: sshConnectionId,
              },
            }
          : {}),
      },
    }),
    [201],
  );
  return created.body;
}

async function listVncHosts(actor: Actor) {
  signIn(actor);
  return (await accept(vncHosts().list({ headers }), [200])).body.connections;
}

async function createSshCredential(owner: Actor) {
  signIn(owner);
  const created = await accept(
    sshCredentials().create({
      headers,
      body: {
        id: randomUUID(),
        name: "Deploy login",
        username: "deploy",
        authentication: { method: "password", password: "pa55word" },
      },
    }),
    [201],
  );
  return created.body;
}

async function listSshCredentials(actor: Actor) {
  signIn(actor);
  return (await accept(sshCredentials().list({ headers }), [200])).body
    .credentials;
}

async function createVncCredential(owner: Actor) {
  signIn(owner);
  const created = await accept(
    vncCredentials().create({
      headers,
      body: {
        id: randomUUID(),
        name: "Desktop password",
        authentication: { method: "vnc_password", password: "pa55word" },
      },
    }),
    [201],
  );
  return created.body;
}

async function listVncCredentials(actor: Actor) {
  signIn(actor);
  return (await accept(vncCredentials().list({ headers }), [200])).body
    .credentials;
}

function deleteSshHost(connectionId: string, expectedGeneration: number) {
  return sshHosts().delete({
    headers,
    params: { connectionId },
    body: { expectedGeneration },
  });
}

function deleteVncHost(connectionId: string, expectedGeneration: number) {
  return vncHosts().delete({
    headers,
    params: { connectionId },
    body: { expectedGeneration },
  });
}

function deleteSshCredential(credentialId: string, expectedRevision: number) {
  return sshCredentials().delete({
    headers,
    params: { credentialId },
    body: { expectedRevision },
  });
}

function deleteVncCredential(credentialId: string, expectedRevision: number) {
  return vncCredentials().delete({
    headers,
    params: { credentialId },
    body: { expectedRevision },
  });
}

/** Another user's delete attempt and both users' later views of one host. */
async function otherSshUserDeletes(scope: "same" | "different") {
  const owner = await newActor();
  const other = await newActor(scope === "same" ? owner.orgId : undefined);
  const host = await createSshHost(owner);

  signIn(other);
  const denied = await accept(deleteSshHost(host.id, host.generation), [404]);
  const otherView = await listSshHosts(other);
  const ownerView = await listSshHosts(owner);
  return { host, code: denied.body.error.code, otherView, ownerView };
}

/** Another user's delete attempt and both users' later views of one host. */
async function otherVncUserDeletes(scope: "same" | "different") {
  const owner = await newActor();
  const other = await newActor(scope === "same" ? owner.orgId : undefined);
  const host = await createVncHost(owner);

  signIn(other);
  const denied = await accept(deleteVncHost(host.id, host.generation), [404]);
  const otherView = await listVncHosts(other);
  const ownerView = await listVncHosts(owner);
  return { host, code: denied.body.error.code, otherView, ownerView };
}

describe("SSH host reviewed-version deletion", () => {
  it("remote-control-deletion-versions-001 a stale SSH host delete keeps the renamed host until the current version is deleted", async () => {
    const owner = await newActor();
    const host = await createSshHost(owner);
    await accept(
      sshHosts().update({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: host.generation, displayName: "Renamed" },
      }),
      [200],
    );

    const stale = await accept(deleteSshHost(host.id, host.generation), [409]);
    expect(stale.body.error.code).toBe("SSH_GENERATION_CONFLICT");
    const [kept] = await listSshHosts(owner);
    expect(kept).toMatchObject({
      id: host.id,
      displayName: "Renamed",
      generation: host.generation + 1,
    });
    await accept(deleteSshHost(host.id, host.generation + 1), [204]);
    await expect(listSshHosts(owner)).resolves.toStrictEqual([]);
    const missing = await accept(
      deleteSshHost(host.id, host.generation + 1),
      [404],
    );
    expect(missing.body.error.code).toBe("SSH_CONNECTION_NOT_FOUND");
  });

  it("remote-control-deletion-versions-004 hides an SSH host from another user in the same organization", async () => {
    const { host, code, otherView, ownerView } =
      await otherSshUserDeletes("same");
    expect(code).toBe("SSH_CONNECTION_NOT_FOUND");
    expect(otherView).toStrictEqual([]);
    expect(ownerView).toStrictEqual([
      expect.objectContaining({
        id: host.id,
        displayName: host.displayName,
        generation: host.generation,
      }),
    ]);
  });
  it("remote-control-deletion-versions-005 hides an SSH host from another user in the different organization", async () => {
    const { host, code, otherView, ownerView } =
      await otherSshUserDeletes("different");
    expect(code).toBe("SSH_CONNECTION_NOT_FOUND");
    expect(otherView).toStrictEqual([]);
    expect(ownerView).toStrictEqual([
      expect.objectContaining({
        id: host.id,
        displayName: host.displayName,
        generation: host.generation,
      }),
    ]);
  });
});

describe("VNC host reviewed-version deletion", () => {
  it("remote-control-deletion-versions-006 a stale VNC host delete keeps the renamed host until the current version is deleted", async () => {
    const owner = await newActor();
    const host = await createVncHost(owner);
    await accept(
      vncHosts().update({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: host.generation, displayName: "Renamed" },
      }),
      [200],
    );

    const stale = await accept(deleteVncHost(host.id, host.generation), [409]);
    expect(stale.body.error.code).toBe("VNC_GENERATION_CONFLICT");
    const [kept] = await listVncHosts(owner);
    expect(kept).toMatchObject({
      id: host.id,
      displayName: "Renamed",
      generation: host.generation + 1,
    });
    await accept(deleteVncHost(host.id, host.generation + 1), [204]);
    await expect(listVncHosts(owner)).resolves.toStrictEqual([]);
    const missing = await accept(
      deleteVncHost(host.id, host.generation + 1),
      [404],
    );
    expect(missing.body.error.code).toBe("VNC_CONNECTION_NOT_FOUND");
  });

  it("remote-control-deletion-versions-009 hides a VNC host from another user in the same organization", async () => {
    const { host, code, otherView, ownerView } =
      await otherVncUserDeletes("same");
    expect(code).toBe("VNC_CONNECTION_NOT_FOUND");
    expect(otherView).toStrictEqual([]);
    expect(ownerView).toStrictEqual([
      expect.objectContaining({
        id: host.id,
        displayName: host.displayName,
        generation: host.generation,
      }),
    ]);
  });
  it("remote-control-deletion-versions-010 hides a VNC host from another user in the different organization", async () => {
    const { host, code, otherView, ownerView } =
      await otherVncUserDeletes("different");
    expect(code).toBe("VNC_CONNECTION_NOT_FOUND");
    expect(otherView).toStrictEqual([]);
    expect(ownerView).toStrictEqual([
      expect.objectContaining({
        id: host.id,
        displayName: host.displayName,
        generation: host.generation,
      }),
    ]);
  });
});

describe("SSH credential reviewed-version deletion", () => {
  it("remote-control-deletion-versions-011 a stale SSH credential delete keeps the renamed credential until the current revision is deleted", async () => {
    const owner = await newActor();
    const credential = await createSshCredential(owner);
    await accept(
      sshCredentials().update({
        headers,
        params: { credentialId: credential.id },
        body: { expectedRevision: credential.revision, name: "Renamed" },
      }),
      [200],
    );

    const stale = await accept(
      deleteSshCredential(credential.id, credential.revision),
      [409],
    );
    expect(stale.body.error.code).toBe("SSH_CREDENTIAL_REVISION_CONFLICT");
    const [kept] = await listSshCredentials(owner);
    expect(kept).toMatchObject({
      id: credential.id,
      name: "Renamed",
      revision: credential.revision + 1,
    });
    await accept(
      deleteSshCredential(credential.id, credential.revision + 1),
      [204],
    );
    await expect(listSshCredentials(owner)).resolves.toStrictEqual([]);
    const missing = await accept(
      deleteSshCredential(credential.id, credential.revision + 1),
      [404],
    );
    expect(missing.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
  });

  it("remote-control-deletion-versions-014 hides an SSH credential from another user in the same organization", async () => {
    const owner = await newActor();
    const other = await newActor(owner.orgId);
    const credential = await createSshCredential(owner);

    signIn(other);
    const denied = await accept(
      deleteSshCredential(credential.id, credential.revision),
      [404],
    );
    expect(denied.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
    await expect(listSshCredentials(other)).resolves.toStrictEqual([]);
    await expect(listSshCredentials(owner)).resolves.toStrictEqual([
      credential,
    ]);
  });
});

describe("VNC credential reviewed-version deletion", () => {
  it("remote-control-deletion-versions-016 a stale VNC credential delete keeps the renamed credential until the current revision is deleted", async () => {
    const owner = await newActor();
    const credential = await createVncCredential(owner);
    await accept(
      vncCredentials().update({
        headers,
        params: { credentialId: credential.id },
        body: { expectedRevision: credential.revision, name: "Renamed" },
      }),
      [200],
    );

    const stale = await accept(
      deleteVncCredential(credential.id, credential.revision),
      [409],
    );
    expect(stale.body.error.code).toBe("VNC_CREDENTIAL_REVISION_CONFLICT");
    const [kept] = await listVncCredentials(owner);
    expect(kept).toMatchObject({
      id: credential.id,
      name: "Renamed",
      revision: credential.revision + 1,
    });
    await accept(
      deleteVncCredential(credential.id, credential.revision + 1),
      [204],
    );
    await expect(listVncCredentials(owner)).resolves.toStrictEqual([]);
    const missing = await accept(
      deleteVncCredential(credential.id, credential.revision + 1),
      [404],
    );
    expect(missing.body.error.code).toBe("VNC_CREDENTIAL_NOT_FOUND");
  });

  it("remote-control-deletion-versions-019 hides a VNC credential from another user in the same organization", async () => {
    const owner = await newActor();
    const other = await newActor(owner.orgId);
    const credential = await createVncCredential(owner);

    signIn(other);
    const denied = await accept(
      deleteVncCredential(credential.id, credential.revision),
      [404],
    );
    expect(denied.body.error.code).toBe("VNC_CREDENTIAL_NOT_FOUND");
    await expect(listVncCredentials(other)).resolves.toStrictEqual([]);
    await expect(listVncCredentials(owner)).resolves.toStrictEqual([
      credential,
    ]);
  });
});

describe("SSH deletion request validation", () => {
  const rawDelete = (connectionId: string, extra: Record<string, string>) => {
    return setupRawAppRequest({ context, routes: sshConnectionsRoutes })(
      `/api/ssh/connections/${connectionId}`,
      {
        method: "DELETE",
        headers: {
          ...headers,
          "content-type": "application/json",
          ...extra,
        },
        body: JSON.stringify({}),
      },
    );
  };

  it("remote-control-deletion-versions-021 rejects an SSH host delete without the reviewed generation", async () => {
    const owner = await newActor();
    const host = await createSshHost(owner);

    const response = await rawDelete(host.id, {});
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "SSH_INVALID_INPUT" },
    });
    const [kept] = await listSshHosts(owner);
    expect(kept).toMatchObject({ id: host.id, generation: host.generation });
  });

  it("remote-control-deletion-versions-024 force-upgrades an unsupported App before deleting and accepts the supported App", async () => {
    const owner = await newActor();
    const host = await createSshHost(owner);

    const outdated = await rawDelete(host.id, {
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
      [CLIENT_VERSION_HEADER]: "0.1027.1",
    });
    expect(outdated.status).toBe(426);
    expect(outdated.headers.get("cache-control")).toBe("no-store");
    expect(outdated.body).toStrictEqual({ error: "Client update required" });
    await expect(listSshHosts(owner)).resolves.toHaveLength(1);

    await accept(
      sshHosts().delete({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: host.generation },
        extraHeaders: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]:
            webClientCompatibility.minimumSupportedVersion,
        },
      }),
      [204],
    );
    await expect(listSshHosts(owner)).resolves.toStrictEqual([]);
  });

  it("remote-control-deletion-versions-025 keeps an SSH host while a VNC host tunnels through it", async () => {
    const owner = await newActor();
    const sshHost = await createSshHost(owner);
    const vncHost = await createVncHost(owner, sshHost.id);

    signIn(owner);
    const inUse = await accept(
      deleteSshHost(sshHost.id, sshHost.generation),
      [409],
    );
    expect(inUse.body.error.code).toBe("SSH_CONNECTION_IN_USE");
    await expect(listSshHosts(owner)).resolves.toHaveLength(1);
    await accept(deleteVncHost(vncHost.id, vncHost.generation), [204]);
    await accept(deleteSshHost(sshHost.id, sshHost.generation), [204]);
  });
});
