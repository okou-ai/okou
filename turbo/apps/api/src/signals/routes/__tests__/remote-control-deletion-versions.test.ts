import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import webClientCompatibility from "../../../lib/web-client-compatibility.json";
import { joinAll } from "../../utils";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncConnectionsRoutes } from "../vnc-connections";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const targets = [
  "SSH host",
  "VNC host",
  "SSH credential",
  "VNC credential",
] as const;
type Target = (typeof targets)[number];
interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
interface Snapshot {
  readonly id: string;
  readonly version: number;
  readonly name: string;
}
interface MutationResult {
  readonly status: number;
  readonly body: unknown;
}
interface Fixture {
  readonly snapshot: Snapshot;
  readonly conflictCode: string;
  readonly notFoundCode: string;
  readonly update: () => Promise<MutationResult>;
  readonly remove: (version?: number) => Promise<MutationResult>;
  readonly list: () => Promise<Snapshot[]>;
}
const updatedName = "Updated reviewed resource";

function sshHosts() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}
function sshCredentials() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
}
function vncHosts() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
}
function vncCredentials() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
}
function authenticate(actor: Owner) {
  mocks.clerk.session(actor.userId, actor.orgId);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `om_${actor.orgId}_${actor.userId}`,
          role: "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    },
  );
}
async function owner(overrides: Partial<Owner> = {}) {
  const actor = {
    orgId: `org_delete_${randomUUID()}`,
    userId: `user_delete_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  authenticate(actor);
  return actor;
}
function sshHostBody() {
  return {
    id: randomUUID(),
    displayName: "Reviewed SSH host",
    host: "ssh.example.com",
    credential: {
      create: {
        name: "Host login",
        username: "deploy",
        authentication: { method: "password" as const, password: "canary" },
      },
    },
  };
}

// These fixtures only translate the four public contracts into caller-visible
// metadata. Construction, mutation and readback all use production endpoints.
async function fixture(target: Target): Promise<Fixture> {
  switch (target) {
    case "SSH host": {
      const created = await accept(
        sshHosts().create({ headers, body: sshHostBody() }),
        [201],
      );
      const { id, generation, displayName } = created.body;
      const params = { connectionId: id };
      return {
        snapshot: { id, version: generation, name: displayName },
        conflictCode: "SSH_GENERATION_CONFLICT",
        notFoundCode: "SSH_CONNECTION_NOT_FOUND",
        update: async () => {
          return await accept(
            sshHosts().update({
              headers,
              params,
              body: {
                expectedGeneration: generation,
                displayName: updatedName,
              },
            }),
            [200, 404],
          );
        },
        remove: async (version = generation) => {
          return await accept(
            sshHosts().delete({
              headers,
              params,
              body: { expectedGeneration: version },
            }),
            [204, 404, 409],
          );
        },
        list: async () => {
          const result = await accept(sshHosts().list({ headers }), [200]);
          return result.body.connections.map((host) => {
            return {
              id: host.id,
              version: host.generation,
              name: host.displayName,
            };
          });
        },
      };
    }
    case "VNC host": {
      const created = await accept(
        vncHosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Reviewed VNC host",
            host: "vnc.example.com",
            security: { type: "x509_none", trust: { mode: "system" } },
            credential: { type: "none" },
          },
        }),
        [201],
      );
      const { id, generation, displayName } = created.body;
      const params = { connectionId: id };
      return {
        snapshot: { id, version: generation, name: displayName },
        conflictCode: "VNC_GENERATION_CONFLICT",
        notFoundCode: "VNC_CONNECTION_NOT_FOUND",
        update: async () => {
          return await accept(
            vncHosts().update({
              headers,
              params,
              body: {
                expectedGeneration: generation,
                displayName: updatedName,
              },
            }),
            [200, 404, 409],
          );
        },
        remove: async (version = generation) => {
          return await accept(
            vncHosts().delete({
              headers,
              params,
              body: { expectedGeneration: version },
            }),
            [204, 404, 409],
          );
        },
        list: async () => {
          const result = await accept(vncHosts().list({ headers }), [200]);
          return result.body.connections.map((host) => {
            return {
              id: host.id,
              version: host.generation,
              name: host.displayName,
            };
          });
        },
      };
    }
    case "SSH credential": {
      const created = await accept(
        sshCredentials().create({
          headers,
          body: {
            id: randomUUID(),
            name: "Reviewed SSH credential",
            username: "deploy",
            authentication: { method: "password", password: "canary" },
          },
        }),
        [201],
      );
      const { id, revision, name } = created.body;
      const params = { credentialId: id };
      return {
        snapshot: { id, version: revision, name },
        conflictCode: "SSH_CREDENTIAL_REVISION_CONFLICT",
        notFoundCode: "SSH_CREDENTIAL_NOT_FOUND",
        update: async () => {
          return await accept(
            sshCredentials().update({
              headers,
              params,
              body: { expectedRevision: revision, name: updatedName },
            }),
            [200, 404],
          );
        },
        remove: async (version = revision) => {
          return await accept(
            sshCredentials().delete({
              headers,
              params,
              body: { expectedRevision: version },
            }),
            [204, 404, 409],
          );
        },
        list: async () => {
          const result = await accept(
            sshCredentials().list({ headers }),
            [200],
          );
          return result.body.credentials.map((credential) => {
            return {
              id: credential.id,
              version: credential.revision,
              name: credential.name,
            };
          });
        },
      };
    }
    case "VNC credential": {
      const created = await accept(
        vncCredentials().create({
          headers,
          body: {
            id: randomUUID(),
            name: "Reviewed VNC credential",
            authentication: { method: "vnc_password", password: "canary" },
          },
        }),
        [201],
      );
      const { id, revision, name } = created.body;
      const params = { credentialId: id };
      return {
        snapshot: { id, version: revision, name },
        conflictCode: "VNC_CREDENTIAL_REVISION_CONFLICT",
        notFoundCode: "VNC_CREDENTIAL_NOT_FOUND",
        update: async () => {
          return await accept(
            vncCredentials().update({
              headers,
              params,
              body: { expectedRevision: revision, name: updatedName },
            }),
            [200, 404],
          );
        },
        remove: async (version = revision) => {
          return await accept(
            vncCredentials().delete({
              headers,
              params,
              body: { expectedRevision: version },
            }),
            [204, 404, 409],
          );
        },
        list: async () => {
          const result = await accept(
            vncCredentials().list({ headers }),
            [200],
          );
          return result.body.credentials.map((credential) => {
            return {
              id: credential.id,
              version: credential.revision,
              name: credential.name,
            };
          });
        },
      };
    }
  }
}

describe.each(targets)("%s reviewed-version deletion", (target) => {
  it("preserves a newer version, deletes its reviewed version, and reports a missing resource", async () => {
    useSecretKmsProbe();
    await owner();
    const resource = await fixture(target);
    expect((await resource.update()).status).toBe(200);
    const stale = await resource.remove();
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: { code: resource.conflictCode },
    });
    const current = {
      ...resource.snapshot,
      version: resource.snapshot.version + 1,
      name: updatedName,
    };
    await expect(resource.list()).resolves.toStrictEqual([current]);
    expect((await resource.remove(current.version)).status).toBe(204);
    await expect(resource.list()).resolves.toStrictEqual([]);
    const missing = await resource.remove(current.version);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      error: { code: resource.notFoundCode },
    });
  });

  it("allows only one competing deletion to report success", async () => {
    useSecretKmsProbe();
    await owner();
    const resource = await fixture(target);
    const results = await joinAll([resource.remove(), resource.remove()]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([204, 404]);
    await expect(resource.list()).resolves.toStrictEqual([]);
  });

  it("never deletes an unreviewed version when update and deletion overlap", async () => {
    useSecretKmsProbe();
    await owner();
    const resource = await fixture(target);
    const [updated, deleted] = await joinAll([
      resource.update(),
      resource.remove(),
    ]);
    if (updated.status === 200) {
      expect(deleted.status).toBe(409);
      expect(deleted.body).toMatchObject({
        error: { code: resource.conflictCode },
      });
      await expect(resource.list()).resolves.toStrictEqual([
        {
          ...resource.snapshot,
          version: resource.snapshot.version + 1,
          name: updatedName,
        },
      ]);
    } else {
      // VNC PATCH can observe the row before DELETE commits and then lose its
      // conditional write with 409; an earlier miss returns 404. Neither wins.
      expect(target === "VNC host" ? [404, 409] : [404]).toContain(
        updated.status,
      );
      expect(updated.body).toMatchObject({
        error: {
          code:
            updated.status === 404
              ? resource.notFoundCode
              : resource.conflictCode,
        },
      });
      expect(deleted.status).toBe(204);
      await expect(resource.list()).resolves.toStrictEqual([]);
    }
  });

  it.each(["same organization", "different organization"])(
    "conceals another owner's resource in the %s",
    async (scope) => {
      useSecretKmsProbe();
      const original = await owner();
      const resource = await fixture(target);
      await owner(
        scope === "same organization" ? { orgId: original.orgId } : {},
      );
      const denied = await resource.remove();
      expect(denied.status).toBe(404);
      expect(denied.body).toMatchObject({
        error: { code: resource.notFoundCode },
      });
      await expect(resource.list()).resolves.toStrictEqual([]);
      authenticate(original);
      await expect(resource.list()).resolves.toStrictEqual([resource.snapshot]);
    },
  );
});

describe("SSH deletion request validation", () => {
  it.each(["absent", "missing version", "unparseable version"] as const)(
    "requires the reviewed generation with %s App headers",
    async (client) => {
      useSecretKmsProbe();
      await owner();
      const created = await accept(
        sshHosts().create({ headers, body: sshHostBody() }),
        [201],
      );
      const requestHeaders = new Headers(headers);
      if (client !== "absent") {
        requestHeaders.set(CLIENT_TYPE_HEADER, CLIENT_TYPE_APP);
      }
      if (client === "unparseable version") {
        requestHeaders.set(CLIENT_VERSION_HEADER, "unparseable");
      }
      const request = setupRawAppRequest({
        context,
        routes: sshConnectionsRoutes,
      });
      const result = await request(`/api/ssh/connections/${created.body.id}`, {
        method: "DELETE",
        headers: requestHeaders,
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "SSH_INVALID_INPUT" },
      });
      expect(
        (await accept(sshHosts().list({ headers }), [200])).body.connections,
      ).toStrictEqual([created.body]);
    },
  );

  it("force-upgrades an unsupported App before deletion and accepts the supported App's reviewed generation", async () => {
    useSecretKmsProbe();
    await owner();
    const created = await accept(
      sshHosts().create({ headers, body: sshHostBody() }),
      [201],
    );
    const request = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    const result = await request(`/api/ssh/connections/${created.body.id}`, {
      method: "DELETE",
      headers: {
        ...headers,
        [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
        [CLIENT_VERSION_HEADER]: "0.1027.1",
      },
    });
    expect(result.status).toBe(426);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toStrictEqual({ error: "Client update required" });
    expect(
      (await accept(sshHosts().list({ headers }), [200])).body.connections,
    ).toStrictEqual([created.body]);
    await accept(
      sshHosts().delete({
        headers,
        extraHeaders: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]:
            webClientCompatibility.minimumSupportedVersion,
        },
        params: { connectionId: created.body.id },
        body: { expectedGeneration: created.body.generation },
      }),
      [204],
    );
    expect(
      (await accept(sshHosts().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
  });

  it.each(["{}"])(
    "rejects an invalid deletion body and preserves the host: %s",
    async (body) => {
      useSecretKmsProbe();
      await owner();
      const created = await accept(
        sshHosts().create({ headers, body: sshHostBody() }),
        [201],
      );
      const request = setupRawAppRequest({
        context,
        routes: sshConnectionsRoutes,
      });
      const result = await request(`/api/ssh/connections/${created.body.id}`, {
        method: "DELETE",
        headers: { ...headers, "content-type": "application/json" },
        body,
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "SSH_INVALID_INPUT" },
      });
      expect(
        (await accept(sshHosts().list({ headers }), [200])).body.connections,
      ).toStrictEqual([created.body]);
    },
  );

  it("keeps a versioned SSH host while a VNC host references it", async () => {
    useSecretKmsProbe();
    await owner();
    const host = await accept(
      sshHosts().create({ headers, body: sshHostBody() }),
      [201],
    );
    const referenced = await accept(
      vncHosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Tunneled desktop",
          host: "127.0.0.1",
          security: { type: "x509_none", trust: { mode: "system" } },
          credential: { type: "none" },
          transport: { type: "ssh", connectionId: host.body.id },
        },
      }),
      [201],
    );
    const deleted = await accept(
      sshHosts().delete({
        headers,
        params: { connectionId: host.body.id },
        body: { expectedGeneration: host.body.generation },
      }),
      [409],
    );
    expect(deleted.body.error.code).toBe("SSH_CONNECTION_IN_USE");
    expect(
      (await accept(sshHosts().list({ headers }), [200])).body.connections,
    ).toStrictEqual([host.body]);
    await accept(
      vncHosts().delete({
        headers,
        params: { connectionId: referenced.body.id },
        body: { expectedGeneration: referenced.body.generation },
      }),
      [204],
    );
    await accept(
      sshHosts().delete({
        headers,
        params: { connectionId: host.body.id },
        body: { expectedGeneration: host.body.generation },
      }),
      [204],
    );
  });
});
