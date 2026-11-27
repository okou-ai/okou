import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";

import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  type VncConnectionResponse,
  type createVncConnectionRequestSchema,
  type updateVncConnectionRequestSchema,
  vncConnectionsContract,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  type VncAuthentication,
  vncCredentialsContract,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import type { input as zInput } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow } from "../../../lib/time";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { remoteDevicesRoutes } from "../remote-devices";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncConnectionsRoutes } from "../vnc-connections";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";
import { certificateChain, privateKey } from "./helpers/vnc-synthetic-client";

const context = testContext();

/** A disposable self-signed end-entity certificate (CA:FALSE) for trust checks. */
const leafMatch =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u.exec(
    spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ed25519",
        "-nodes",
        "-keyout",
        "/dev/null",
        "-out",
        "-",
        "-days",
        "2",
        "-subj",
        "/CN=synthetic-vnc-leaf",
        "-addext",
        "basicConstraints=critical,CA:FALSE",
      ],
      { encoding: "utf8" },
    ).stdout,
  );
if (!leafMatch) {
  throw new Error("OpenSSL did not produce a disposable leaf certificate");
}
const leafCertificate = leafMatch[0];
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

type CreateHostBody = zInput<typeof createVncConnectionRequestSchema>;
type UpdateHostBody = zInput<typeof updateVncConnectionRequestSchema>;
type HostSecurity = CreateHostBody["security"];

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

const hosts = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
};
const credentials = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
};

const sshConnections = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};

async function sshGateway(displayName: string) {
  const created = await accept(
    sshConnections().create({
      headers,
      body: {
        id: randomUUID(),
        displayName,
        host: "gateway.example.com",
        credential: inlineSshKey("deploy", `key-${randomUUID()}`),
      },
    }),
    [201],
  );
  return created.body;
}

/** A Clerk directory the case seeds with workspace admins. */
function clerkDirectory() {
  const store = createStore();
  return async (
    orgId = `org_${randomUUID()}`,
    userId = `user_${randomUUID()}`,
  ): Promise<Actor> => {
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    return { orgId, userId };
  };
}

/** A signed-in workspace admin whose secrets are sealed by the KMS double. */
async function signedInAdmin() {
  useSecretKmsProbe();
  const join = clerkDirectory();
  const admin = await join();
  signIn(admin);
  return { ...admin, join };
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
}

const systemTrust = Object.freeze({ mode: "system" as const });
const x509Vnc = Object.freeze({
  type: "x509_vnc" as const,
  trust: systemTrust,
});
const x509None = Object.freeze({
  type: "x509_none" as const,
  trust: systemTrust,
});
const vncPassword = (password: string) => {
  return { method: "vnc_password" as const, password };
};

function credentialIdOf(host: VncConnectionResponse): string {
  if (!("credentialId" in host)) {
    throw new Error("Expected a credential-bound VNC host");
  }
  return host.credentialId;
}

function errorCode(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "code" in body.error &&
    typeof body.error.code === "string"
  ) {
    return body.error.code;
  }
  return undefined;
}

async function rawSend(method: string, path: string, body: object) {
  const raw = setupRawAppRequest({ context, routes: vncConnectionsRoutes });
  return await raw(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Status plus error code, so a refusal for the wrong reason fails visibly. */
function outcome(response: { status: number; body: unknown }): string {
  const code = errorCode(response.body);
  return code === undefined || response.status === 404
    ? String(response.status)
    : `${response.status} ${code}`;
}

async function createHost(body: CreateHostBody) {
  const created = await accept(hosts().create({ headers, body }), [201]);
  return created.body;
}

async function updateHost(connectionId: string, body: UpdateHostBody) {
  return await hosts().update({ headers, params: { connectionId }, body });
}

async function inlinePasswordHost(displayName: string, host: string) {
  return await createHost({
    id: randomUUID(),
    displayName,
    host,
    credential: {
      create: {
        name: `${displayName} password`,
        authentication: vncPassword("s3cret"),
      },
    },
    security: x509Vnc,
  });
}

async function savedPasswordCredential(name: string, password = "s3cret") {
  const created = await accept(
    credentials().create({
      headers,
      body: { id: randomUUID(), name, authentication: vncPassword(password) },
    }),
    [201],
  );
  return created.body;
}

async function listHosts() {
  const listed = await accept(hosts().list({ headers }), [200]);
  return listed.body.connections;
}

async function listCredentials() {
  const listed = await accept(credentials().list({ headers }), [200]);
  return listed.body.credentials;
}

function expectNoSecrets(responses: readonly unknown[], secrets: string[]) {
  const text = JSON.stringify(responses);
  expect(text).not.toContain('"password":');
  expect(text).not.toContain("encrypted");
  expect(text).not.toContain(privateKey);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

function kerberosPasswordAuthentication(user: string, password: string) {
  return {
    method: "qemu_kerberos_password" as const,
    initiator: { realm: "EXAMPLE.INVALID", components: [user] },
    password,
  };
}

function kerberosSecurity(realm: string) {
  return {
    type: "qemu_x509_gssapi" as const,
    trust: systemTrust,
    service: { realm, components: ["vnc", "desk.example.com"] },
    kdc: {
      host: "kdc.example.com",
      port: 88,
      transport: { type: "direct" as const },
      ticketLifetimeSeconds: 1200,
      renewableLifetimeSeconds: 7200,
    },
  };
}

async function kerberosHost(password: string) {
  return await createHost({
    id: randomUUID(),
    displayName: "Kerberos desk",
    host: "desk.example.com",
    credential: {
      create: {
        name: "Kerberos login",
        authentication: kerberosPasswordAuthentication("alice", password),
      },
    },
    security: kerberosSecurity("EXAMPLE.INVALID"),
  });
}

describe("explicit Owner Kerberos sources", () => {
  it("vnc-configuration-006 refuses a Kerberos host whose service realm differs from the initiator realm", async () => {
    await signedInAdmin();

    const refused = await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Kerberos desk",
          host: "desk.example.com",
          credential: {
            create: {
              name: "Kerberos login",
              authentication: kerberosPasswordAuthentication(
                "alice",
                "kerberos-secret",
              ),
            },
          },
          security: kerberosSecurity("OTHER.INVALID"),
        },
      }),
      [400],
    );

    expect(errorCode(refused.body)).toBe("VNC_PROFILE_MISMATCH");
    await expect(listCredentials()).resolves.toStrictEqual([]);
  });

  it("vnc-configuration-005 reads back a Kerberos host and credential as metadata only", async () => {
    await signedInAdmin();
    const password = `kerberos-${randomUUID()}`;
    const security = kerberosSecurity("EXAMPLE.INVALID");

    const created = await kerberosHost(password);
    const listedHosts = await listHosts();
    const listedCredentials = await listCredentials();

    expect(created).toMatchObject({
      kerberosAuthentication: "qemu_kerberos_password",
      security,
    });
    expect(listedHosts).toStrictEqual([created]);
    expect(listedCredentials).toHaveLength(1);
    expect(listedCredentials[0]).toMatchObject({
      authMethod: "qemu_kerberos_password",
      initiator: { realm: "EXAMPLE.INVALID", components: ["alice"] },
    });
    expectNoSecrets([created, listedHosts, listedCredentials], [password]);
  });

  it("vnc-configuration-009 rotates the Kerberos password but refuses an initiator change", async () => {
    await signedInAdmin();
    const host = await kerberosHost("first-secret");
    const credentialId = credentialIdOf(host);

    const rotated = await accept(
      credentials().update({
        headers,
        params: { credentialId },
        body: {
          expectedRevision: 1,
          authentication: kerberosPasswordAuthentication(
            "alice",
            "second-secret",
          ),
        },
      }),
      [200],
    );
    const listedHosts = await listHosts();
    const principalChange = await accept(
      credentials().update({
        headers,
        params: { credentialId },
        body: {
          expectedRevision: 2,
          authentication: kerberosPasswordAuthentication("bob", "third-secret"),
        },
      }),
      [400],
    );

    expect(rotated.body.revision).toBe(2);
    expect(listedHosts).toHaveLength(1);
    expect(listedHosts[0]).toMatchObject({ id: host.id, generation: 2 });
    expect(errorCode(principalChange.body)).toBe("VNC_PROFILE_MISMATCH");
  });
});

const sharedPassword = "Sh4red!";

/** A saved " Shared " password referenced by two hosts on distinct endpoints. */
async function sharedCredentialHosts() {
  const shared = await savedPasswordCredential(" Shared ", sharedPassword);
  const hostAt = async (displayName: string, host: string) => {
    return await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName,
          host,
          credential: { id: shared.id },
          security: x509Vnc,
        },
      }),
      [201],
    );
  };
  const first = await hostAt("First desk", "VNC.EXAMPLE.COM.");
  const second = await hostAt("Second desk", "192.0.2.5");
  return { shared, first, second };
}

async function rebindScenario(
  authentication: VncAuthentication,
  security: HostSecurity,
  throughSsh = false,
) {
  await signedInAdmin();
  const route = throughSsh
    ? {
        host: "127.0.0.1",
        transport: {
          type: "ssh" as const,
          connectionId: (await sshGateway("VNC gateway")).id,
        },
      }
    : { host: "rebound.example.com" };
  const initial = await createHost({
    id: randomUUID(),
    displayName: "Initial desktop",
    host: "initial.example.com",
    credential: { type: "none" },
    security: x509None,
  });

  const rebound = await accept(
    updateHost(initial.id, {
      expectedGeneration: 1,
      displayName: "Rebound 桌面",
      ...route,
      port: 5901,
      security,
      credential: { create: { name: "新 credential", authentication } },
    }),
    [200],
  );
  const listedHosts = await listHosts();
  const listedCredentials = await listCredentials();
  const renamed = await accept(
    updateHost(initial.id, {
      expectedGeneration: 2,
      displayName: "Renamed 桌面",
    }),
    [200],
  );
  const credentialId = credentialIdOf(rebound.body);

  expect(rebound.body).toMatchObject({
    id: initial.id,
    createdAt: initial.createdAt,
    displayName: "Rebound 桌面",
    host: route.host,
    port: 5901,
    credentialName: "新 credential",
    security,
    generation: 2,
  });
  expect(credentialId).not.toBe(initial.id);
  expect(listedHosts).toStrictEqual([rebound.body]);
  expect(listedCredentials).toHaveLength(1);
  expect(listedCredentials[0]).toMatchObject({
    id: credentialId,
    authMethod: authentication.method,
    revision: 1,
    hosts: [{ id: initial.id, displayName: "Rebound 桌面" }],
  });
  return {
    credentialId,
    renamed: renamed.body,
    responses: [rebound.body, listedHosts, listedCredentials, renamed.body],
  };
}

/** Two hosts on vnc.example.com, the second with its own credential and custom CA. */
async function canonicalPair() {
  const first = await inlinePasswordHost("First desk", "vnc.example.com");
  const second = await createHost({
    id: randomUUID(),
    displayName: "Second desk",
    host: "VNC.EXAMPLE.COM.",
    credential: {
      create: {
        name: "Second password",
        authentication: vncPassword("s3cond"),
      },
    },
    security: {
      type: "x509_vnc",
      trust: { mode: "custom_ca", caBundle: certificateChain },
    },
  });
  return { first, second };
}

async function renameToSystemTrust(connectionId: string) {
  const updated = await accept(
    updateHost(connectionId, {
      expectedGeneration: 1,
      displayName: "Renamed",
      security: x509Vnc,
    }),
    [200],
  );
  return updated.body;
}

/** Saved credential and host of an admin, probed by one other identity. */
async function probeAsOtherIdentity(kind: "peer" | "elsewhere") {
  const admin = await signedInAdmin();
  const credential = await savedPasswordCredential("Owner password");
  const host = await createHost({
    id: randomUUID(),
    displayName: "Owner desk",
    host: "owner.example.com",
    credential: { id: credential.id },
    security: x509Vnc,
  });
  const other =
    kind === "peer"
      ? await admin.join(admin.orgId)
      : await admin.join(`org_${randomUUID()}`, admin.userId);
  signIn(other);
  return {
    credentials: await listCredentials(),
    hosts: await listHosts(),
    reusedCredentialId: (
      await credentials().create({
        headers,
        body: {
          id: credential.id,
          name: "Reused",
          authentication: vncPassword("s3cret"),
        },
      })
    ).status,
    reusedHostId: (
      await hosts().create({
        headers,
        body: {
          id: host.id,
          displayName: "Reused desk",
          host: "reused.example.com",
          credential: { type: "none" },
          security: x509None,
        },
      })
    ).status,
    foreignReference: (
      await hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Foreign reference",
          host: "foreign.example.com",
          credential: { id: credential.id },
          security: x509Vnc,
        },
      })
    ).status,
    credentialUpdate: (
      await credentials().update({
        headers,
        params: { credentialId: credential.id },
        body: { expectedRevision: 1, name: "Taken over" },
      })
    ).status,
    hostDeletion: (
      await hosts().delete({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: 1 },
      })
    ).status,
  };
}

const expectedProbe = Object.freeze({
  credentials: [],
  hosts: [],
  reusedCredentialId: 409,
  reusedHostId: 409,
  foreignReference: 404,
  credentialUpdate: 404,
  hostDeletion: 404,
});

describe("VNC owner configuration", () => {
  it("vnc-configuration-023 hides configuration from signed-out callers and non-members", async () => {
    useSecretKmsProbe();
    const workspace = await clerkDirectory()();
    const signedOut = await credentials().list({ headers: {} });
    signIn({ orgId: workspace.orgId, userId: `user_${randomUUID()}` });
    const nonMemberList = await credentials().list({ headers });
    const nonMemberCreate = await hosts().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Outsider desk",
        host: "outsider.example.com",
        credential: {
          create: {
            name: "Outsider password",
            authentication: vncPassword("s3cret"),
          },
        },
        security: x509Vnc,
      },
    });

    expect(signedOut.status).toBe(401);
    expect(nonMemberList.status).toBe(404);
    expect(nonMemberCreate.status).toBe(404);
  });

  it("vnc-configuration-010 rebinds a host to an inline VNC password with x509_vnc", async () => {
    const result = await rebindScenario(vncPassword("rebind1"), x509Vnc);

    expect(result.renamed).toMatchObject({
      generation: 3,
      credentialId: result.credentialId,
      security: x509Vnc,
    });
    expectNoSecrets(result.responses, ["rebind1"]);
  });

  it("vnc-configuration-011 rebinds a host to an inline username and password with x509_plain", async () => {
    const security = { type: "x509_plain" as const, trust: systemTrust };
    const result = await rebindScenario(
      {
        method: "username_password",
        username: "operator",
        password: "plain-secret",
      },
      security,
    );

    expect(result.renamed).toMatchObject({
      generation: 3,
      credentialId: result.credentialId,
      security,
    });
    expectNoSecrets(result.responses, ["plain-secret"]);
  });

  it("vnc-configuration-015 rebinds a host to an inline RSA-AES password with rsa_aes_ra2", async () => {
    const security = {
      type: "rsa_aes_ra2" as const,
      serverKeySha256: "ab".repeat(32),
    };
    const result = await rebindScenario(
      { method: "rsa_aes_password", password: "rsa-secret" },
      security,
    );

    expect(result.renamed).toMatchObject({
      generation: 3,
      credentialId: result.credentialId,
      security,
    });
    expectNoSecrets(result.responses, ["rsa-secret"]);
  });

  it("vnc-configuration-019 rebinds a tunneled host to an inline VNC password with apple_vnc_password", async () => {
    const security = { type: "apple_vnc_password" as const };
    const result = await rebindScenario(vncPassword("apple1"), security, true);

    expect(result.renamed).toMatchObject({
      generation: 3,
      credentialId: result.credentialId,
      security,
    });
    expectNoSecrets(result.responses, ["apple1"]);
  });

  it("vnc-configuration-020 rebinds a tunneled host to an inline Apple DH login with apple_dh", async () => {
    const security = { type: "apple_dh" as const };
    const result = await rebindScenario(
      {
        method: "apple_dh_username_password",
        username: "operator",
        password: "apple-dh-secret",
      },
      security,
      true,
    );

    expect(result.renamed).toMatchObject({
      generation: 3,
      credentialId: result.credentialId,
      security,
    });
    expectNoSecrets(result.responses, ["apple-dh-secret"]);
  });

  it("vnc-configuration-013 rebinds a host to an inline client certificate with x509_none", async () => {
    const result = await rebindScenario(
      { method: "client_certificate", certificateChain, privateKey },
      x509None,
    );
    const listedCredentials = await listCredentials();

    expect(result.renamed).toMatchObject({
      generation: 3,
      credential: { type: "none" },
      security: x509None,
    });
    expect("credentialId" in result.renamed).toBeFalsy();
    expect(listedCredentials).toHaveLength(1);
    expect(listedCredentials[0]).toMatchObject({
      id: result.credentialId,
      revision: 1,
      hosts: [],
    });
    expectNoSecrets([...result.responses, listedCredentials], []);
  });

  it("vnc-configuration-029 rejects non-ASCII and overlong VNC passwords but accepts eight spaces", async () => {
    await signedInAdmin();
    const invalid = ["123456789", "秘密", "x\n", "x\t", "\u007f", "é"];

    const statuses: { status: number; code: string | undefined }[] = [];
    for (const password of invalid) {
      const response = await credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Rejected password",
          authentication: vncPassword(password),
        },
      });
      statuses.push({
        status: response.status,
        code: errorCode(response.body),
      });
    }
    const spaces = await credentials().create({
      headers,
      body: {
        id: randomUUID(),
        name: "Spaces",
        authentication: vncPassword("        "),
      },
    });

    expect(statuses).toStrictEqual(
      invalid.map(() => {
        return { status: 400, code: "VNC_INVALID_INPUT" };
      }),
    );
    expect(spaces.status).toBe(201);
  });

  it("vnc-configuration-024 (1/2) shares one secret-free credential between two hosts with an accurate summary", async () => {
    await signedInAdmin();
    const { shared, first, second } = await sharedCredentialHosts();
    const summary = await accept(hosts().summary({ headers }), [200]);
    const listed = await accept(credentials().list({ headers }), [200]);

    expect(shared).toMatchObject({
      name: "Shared",
      authMethod: "vnc_password",
      revision: 1,
      hosts: [],
    });
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(second.headers.get("cache-control")).toContain("no-store");
    expect(first.body).toMatchObject({
      host: "vnc.example.com",
      port: 5900,
      security: x509Vnc,
    });
    expect("transport" in first.body).toBeFalsy();
    expect(summary.body).toStrictEqual({ configuredCount: 2 });
    expect(listed.headers.get("cache-control")).toContain("no-store");
    expect(listed.body.credentials).toHaveLength(1);
    expect(listed.body.credentials[0]?.authMethod).toBe("vnc_password");
    expect(
      listed.body.credentials[0]?.hosts
        .map(({ id }) => {
          return id;
        })
        .sort(),
    ).toStrictEqual([first.body.id, second.body.id].sort());
    const text = JSON.stringify([shared, first.body, second.body, listed.body]);
    expect(text).not.toContain(sharedPassword);
    expect(text).not.toContain('"password":');
    expect(text).not.toContain("encryptedPassword");
    expect(text).not.toContain("vm0secret:");
  });

  it("vnc-configuration-024 (2/2) deletes the shared credential only after both hosts are gone", async () => {
    await signedInAdmin();
    const { shared, first, second } = await sharedCredentialHosts();

    const inUse = await credentials().delete({
      headers,
      params: { credentialId: shared.id },
      body: { expectedRevision: 1 },
    });
    const deletedHosts = [];
    for (const host of [first.body, second.body]) {
      const deleted = await hosts().delete({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: 1 },
      });
      deletedHosts.push(deleted.status);
    }
    const deletedCredential = await credentials().delete({
      headers,
      params: { credentialId: shared.id },
      body: { expectedRevision: 1 },
    });

    expect(inUse.status).toBe(409);
    expect(deletedHosts).toStrictEqual([204, 204]);
    expect(deletedCredential.status).toBe(204);
    await expect(listCredentials()).resolves.toStrictEqual([]);
  });

  it("vnc-configuration-027 keeps a credential-free X509None host until it is explicitly rebound", async () => {
    await signedInAdmin();
    const created = await createHost({
      id: randomUUID(),
      displayName: "No VNC password",
      host: "open.example.com",
      credential: { type: "none" },
      security: x509None,
    });
    const listedHosts = await listHosts();
    const listedCredentials = await listCredentials();
    const passwordWithNone = await hosts().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Contradiction",
        host: "contradiction.example.com",
        credential: {
          create: {
            name: "Contradiction password",
            authentication: vncPassword("s3cret"),
          },
        },
        security: x509None,
      },
    });
    const silentSwitch = await updateHost(created.id, {
      expectedGeneration: 1,
      security: x509Vnc,
    });
    const rebound = await accept(
      updateHost(created.id, {
        expectedGeneration: 1,
        security: x509Vnc,
        credential: {
          create: {
            name: "Desk password",
            authentication: vncPassword("s3cret"),
          },
        },
      }),
      [200],
    );
    const reboundBack = await accept(
      updateHost(created.id, {
        expectedGeneration: 2,
        security: x509None,
        credential: { type: "none" },
      }),
      [200],
    );

    expect(created).toMatchObject({
      generation: 1,
      security: x509None,
      credential: { type: "none" },
    });
    expect("credentialId" in created).toBeFalsy();
    expect(listedHosts).toStrictEqual([created]);
    expect(listedCredentials).toStrictEqual([]);
    expect(passwordWithNone.status).toBe(400);
    expect(silentSwitch.status).toBe(400);
    expect(rebound.body).toMatchObject({ generation: 2, security: x509Vnc });
    expect(credentialIdOf(rebound.body)).toBeTruthy();
    expect(reboundBack.body).toMatchObject({
      generation: 3,
      security: x509None,
      credential: { type: "none" },
    });
    expect("credentialId" in reboundBack.body).toBeFalsy();
    await expect(listCredentials()).resolves.toHaveLength(1);
  });

  it("vnc-configuration-042 treats a creation retry with the same IDs as a no-op", async () => {
    await signedInAdmin();
    const original = await inlinePasswordHost(
      "Original desk",
      "original.example.com",
    );
    const credentialsBefore = await listCredentials();

    const hostRetry = await hosts().create({
      headers,
      body: {
        id: original.id,
        displayName: "Changed desk",
        host: "changed.example.com",
        credential: {
          create: {
            name: "Changed password",
            authentication: vncPassword("chang3d"),
          },
        },
        security: x509Vnc,
      },
    });
    const credentialRetry = await credentials().create({
      headers,
      body: {
        id: credentialIdOf(original),
        name: "Changed credential",
        authentication: vncPassword("chang3d"),
      },
    });

    expect(hostRetry.status).toBe(204);
    expect(credentialRetry.status).toBe(204);
    await expect(listHosts()).resolves.toStrictEqual([original]);
    await expect(listCredentials()).resolves.toStrictEqual(credentialsBefore);
  });

  it("vnc-configuration-049 keeps the shared credential and both hosts when the new method violates the profile", async () => {
    await signedInAdmin();
    const shared = await savedPasswordCredential("Shared password");
    for (const name of ["First", "Second"]) {
      await createHost({
        id: randomUUID(),
        displayName: `${name} desk`,
        host: `${name.toLowerCase()}.example.com`,
        credential: { id: shared.id },
        security: x509Vnc,
      });
    }
    const hostsBefore = await listHosts();
    const credentialsBefore = await listCredentials();

    const refused = await accept(
      credentials().update({
        headers,
        params: { credentialId: shared.id },
        body: {
          expectedRevision: 1,
          name: "Certificate password",
          authentication: {
            method: "client_certificate_vnc_password",
            certificateChain,
            privateKey,
            password: "s3cret",
          },
        },
      }),
      [400],
    );

    expect(errorCode(refused.body)).toBe("VNC_PROFILE_MISMATCH");
    await expect(listCredentials()).resolves.toStrictEqual(credentialsBefore);
    await expect(listHosts()).resolves.toStrictEqual(hostsBefore);
  });

  it("vnc-configuration-038 refuses to rebind a host to a peer's credential in the same organization", async () => {
    const admin = await signedInAdmin();
    const host = await inlinePasswordHost("Own desk", "own.example.com");
    const hostsBefore = await listHosts();
    const credentialsBefore = await listCredentials();
    const peer = await admin.join(admin.orgId);
    signIn(peer);
    const foreign = await savedPasswordCredential("Foreign credential");

    signIn(admin);
    const refused = await accept(
      updateHost(host.id, {
        expectedGeneration: 1,
        credential: { id: foreign.id },
      }),
      [404],
    );
    const hostsAfter = await listHosts();
    const credentialsAfter = await listCredentials();
    signIn(peer);
    const peerCredentials = await listCredentials();
    signIn(admin);
    const renamed = await accept(
      updateHost(host.id, { expectedGeneration: 1, displayName: "Recovered" }),
      [200],
    );

    expect(errorCode(refused.body)).toBe("VNC_CREDENTIAL_NOT_FOUND");
    expect(hostsAfter).toStrictEqual(hostsBefore);
    expect(credentialsAfter).toStrictEqual(credentialsBefore);
    expect(peerCredentials).toStrictEqual([foreign]);
    expect(renamed.body).toMatchObject({
      credentialId: credentialIdOf(host),
      displayName: "Recovered",
      generation: 2,
    });
  });

  it("vnc-configuration-040 refuses to route a host through a peer's SSH connection without storing the inline credential", async () => {
    const admin = await signedInAdmin();
    const host = await inlinePasswordHost("Own desk", "own.example.com");
    const hostsBefore = await listHosts();
    const credentialsBefore = await listCredentials();
    const peer = await admin.join(admin.orgId);
    signIn(peer);
    const foreignGateway = await sshGateway("Foreign gateway");
    const peerSshBefore = await accept(
      sshConnections().list({ headers }),
      [200],
    );

    signIn(admin);
    const refused = await accept(
      updateHost(host.id, {
        expectedGeneration: 1,
        host: "127.0.0.1",
        transport: {
          type: "ssh",
          connectionId: foreignGateway.id,
        },
        credential: {
          create: {
            name: "Tunnel password",
            authentication: vncPassword("tunn3l"),
          },
        },
      }),
      [404],
    );
    const hostsAfter = await listHosts();
    const credentialsAfter = await listCredentials();
    signIn(peer);
    const peerSshAfter = await accept(
      sshConnections().list({ headers }),
      [200],
    );
    const peerCredentials = await listCredentials();
    signIn(admin);
    const renamed = await accept(
      updateHost(host.id, { expectedGeneration: 1, displayName: "Recovered" }),
      [200],
    );

    expect(errorCode(refused.body)).toBe("VNC_SSH_CONNECTION_NOT_FOUND");
    expect(hostsAfter).toStrictEqual(hostsBefore);
    expect(credentialsAfter).toStrictEqual(credentialsBefore);
    expect(peerSshAfter.body).toStrictEqual(peerSshBefore.body);
    expect(peerCredentials).toStrictEqual([]);
    expect(renamed.body).toMatchObject({
      credentialId: credentialIdOf(host),
      host: "own.example.com",
      displayName: "Recovered",
      generation: 2,
    });
    expect("transport" in renamed.body).toBeFalsy();
  });

  it("vnc-configuration-033 rejects unsupported authentication and security profiles without changing saved configuration", async () => {
    await signedInAdmin();
    const saved = await inlinePasswordHost("Saved desk", "saved.example.com");
    const credentialId = credentialIdOf(saved);
    const hostsBefore = await listHosts();
    const credentialsBefore = await listCredentials();
    const raw = setupRawAppRequest({ context, routes: vncConnectionsRoutes });
    const send = async (method: string, path: string, body: object) => {
      const response = await raw(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.status;
    };
    const noAuthentication = { method: "none" };
    const unsupportedSecurity = [
      { type: "none" },
      { type: "tls_vnc", trust: systemTrust },
      { type: "x509_vnc", trust: { mode: "insecure" } },
    ];

    const statuses = [
      await send("POST", "/api/vnc/credentials", {
        id: randomUUID(),
        name: "No authentication",
        authentication: noAuthentication,
      }),
      await send("POST", "/api/vnc/connections", {
        id: randomUUID(),
        displayName: "No authentication desk",
        host: "none.example.com",
        credential: {
          create: { name: "None", authentication: noAuthentication },
        },
        security: x509Vnc,
      }),
      await send("PATCH", `/api/vnc/credentials/${credentialId}`, {
        expectedRevision: 1,
        authentication: noAuthentication,
      }),
    ];
    for (const security of unsupportedSecurity) {
      statuses.push(
        await send("POST", "/api/vnc/connections", {
          id: randomUUID(),
          displayName: "Unsupported desk",
          host: "unsupported.example.com",
          credential: { id: credentialId },
          security,
        }),
        await send("PATCH", `/api/vnc/connections/${saved.id}`, {
          expectedGeneration: 1,
          security,
        }),
      );
    }

    expect(statuses).toStrictEqual(
      statuses.map(() => {
        return 400;
      }),
    );
    expect(statuses).toHaveLength(9);
    await expect(listHosts()).resolves.toStrictEqual(hostsBefore);
    await expect(listCredentials()).resolves.toStrictEqual(credentialsBefore);
  });

  it("vnc-configuration-037 (1/2) hides and protects the configuration from a peer in the same organization", async () => {
    await expect(probeAsOtherIdentity("peer")).resolves.toStrictEqual(
      expectedProbe,
    );
  });

  it("vnc-configuration-037 (2/2) hides and protects the configuration from the same user in another organization", async () => {
    await expect(probeAsOtherIdentity("elsewhere")).resolves.toStrictEqual(
      expectedProbe,
    );
  });

  it("vnc-configuration-043 (1/2) keeps a second host for the same canonical endpoint independent during an update", async () => {
    await signedInAdmin();
    const { first, second } = await canonicalPair();
    const summary = await accept(hosts().summary({ headers }), [200]);
    const updated = await renameToSystemTrust(second.id);
    const bothListed = await listHosts();

    expect(second).toMatchObject({
      host: first.host,
      port: first.port,
      security: { type: "x509_vnc", trust: { mode: "custom_ca" } },
    });
    expect(summary.body).toStrictEqual({ configuredCount: 2 });
    expect(updated).toMatchObject({
      generation: 2,
      credentialId: credentialIdOf(second),
      displayName: "Renamed",
      security: x509Vnc,
    });
    expect(
      bothListed
        .map(({ id }) => {
          return id;
        })
        .sort(),
    ).toStrictEqual([first.id, second.id].sort());
  });

  it("vnc-configuration-043 (2/2) deletes the first host and credential without touching the second", async () => {
    await signedInAdmin();
    const { first, second } = await canonicalPair();
    const updated = await renameToSystemTrust(second.id);

    const deletedHost = await hosts().delete({
      headers,
      params: { connectionId: first.id },
      body: { expectedGeneration: 1 },
    });
    const remainingHosts = await listHosts();
    const deletedCredential = await credentials().delete({
      headers,
      params: { credentialId: credentialIdOf(first) },
      body: { expectedRevision: 1 },
    });
    const remainingCredentials = await listCredentials();

    expect(deletedHost.status).toBe(204);
    expect(remainingHosts).toStrictEqual([updated]);
    expect(deletedCredential.status).toBe(204);
    expect(remainingCredentials).toHaveLength(1);
    expect(remainingCredentials[0]).toMatchObject({
      id: credentialIdOf(second),
      revision: 1,
      hosts: [{ id: second.id, displayName: "Renamed" }],
    });
  });

  it("vnc-configuration-001 rejects unknown cloudflare_access routes for RFB and KDC without changing saved data", async () => {
    await signedInAdmin();
    const saved = await inlinePasswordHost("Saved desk", "saved.example.com");
    const hostsBefore = await listHosts();
    const credentialsBefore = await listCredentials();
    const unknownAccess = {
      type: "cloudflare_access" as const,
      configId: randomUUID(),
    };
    const accessSecurity = { ...x509Vnc, serverName: "desk.internal.example" };
    const kerberosWithAccessKdc = {
      ...kerberosSecurity("EXAMPLE.INVALID"),
      kdc: { host: "kdc.example.com", port: 443, transport: unknownAccess },
    };
    const kerberosCredential = {
      create: {
        name: "Kerberos login",
        authentication: kerberosPasswordAuthentication("alice", "kdc-secret"),
      },
    };

    const statuses = [
      outcome(
        await hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Access desk",
            host: "access.example.com",
            port: 443,
            credential: { id: credentialIdOf(saved) },
            security: accessSecurity,
            transport: unknownAccess,
          },
        }),
      ),
      outcome(
        await updateHost(saved.id, {
          expectedGeneration: 1,
          host: "access.example.com",
          port: 443,
          security: accessSecurity,
          transport: unknownAccess,
        }),
      ),
      outcome(
        await hosts().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Kerberos desk",
            host: "desk.example.com",
            credential: kerberosCredential,
            security: kerberosWithAccessKdc,
          },
        }),
      ),
      outcome(
        await updateHost(saved.id, {
          expectedGeneration: 1,
          credential: kerberosCredential,
          security: kerberosWithAccessKdc,
        }),
      ),
    ];

    expect(statuses).toStrictEqual(["404", "404", "404", "404"]);
    await expect(listHosts()).resolves.toStrictEqual(hostsBefore);
    await expect(listCredentials()).resolves.toStrictEqual(credentialsBefore);
  });
});

const scramPassword = "scram-secret".padEnd(1023, " ");

async function scramCredential() {
  const created = await accept(
    credentials().create({
      headers,
      body: {
        id: randomUUID(),
        name: "SCRAM login",
        authentication: {
          method: "qemu_scram_sha256",
          username: "operator",
          password: scramPassword,
        },
      },
    }),
    [201],
  );
  return created.body;
}

describe("VNC owner configuration (QEMU SCRAM and username/password)", () => {
  it("vnc-configuration-034 (1/2) rejects invalid SCRAM credentials and stores the exact valid one", async () => {
    await signedInAdmin();
    const invalid = [
      { username: "op erator", password: "secret" },
      { username: "op,erator", password: "secret" },
      { username: "op=erator", password: "secret" },
      { username: "opérator", password: "secret" },
      { username: "o".repeat(256), password: "secret" },
      { username: "operator", password: "sec\u0000ret" },
      { username: "operator", password: "sécret" },
      { username: "operator", password: "s".repeat(1024) },
    ];

    const statuses = [];
    for (const { username, password } of invalid) {
      const response = await credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Invalid SCRAM",
          authentication: { method: "qemu_scram_sha256", username, password },
        },
      });
      statuses.push(response.status);
    }
    const valid = await scramCredential();

    expect(statuses).toStrictEqual(
      invalid.map(() => {
        return 400;
      }),
    );
    expect(valid).toMatchObject({
      authMethod: "qemu_scram_sha256",
      username: "operator",
      revision: 1,
    });
    expectNoSecrets([valid], [scramPassword]);
  });

  it("vnc-configuration-034 (2/2) binds SCRAM only with qemu_x509_sasl and rotates it without leaking secrets", async () => {
    await signedInAdmin();
    const credential = await scramCredential();
    const bindingStatuses = [];
    for (const type of ["x509_plain", "x509_vnc", "x509_none"] as const) {
      const response = await hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Mismatched desk",
          host: "mismatch.example.com",
          credential: { id: credential.id },
          security: { type, trust: systemTrust },
        },
      });
      bindingStatuses.push(response.status);
    }
    const sasl = { type: "qemu_x509_sasl" as const, trust: systemTrust };
    const bound = await createHost({
      id: randomUUID(),
      displayName: "SCRAM desk",
      host: "scram.example.com",
      credential: { id: credential.id },
      security: sasl,
    });
    const listedCredentials = await listCredentials();
    const listedHosts = await listHosts();
    const rotated = await accept(
      credentials().update({
        headers,
        params: { credentialId: credential.id },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "qemu_scram_sha256",
            username: "operator",
            password: "rotated-secret",
          },
        },
      }),
      [200],
    );

    expect(bindingStatuses).toStrictEqual([400, 400, 400]);
    expect(bound).toMatchObject({
      credentialId: credential.id,
      security: sasl,
      generation: 1,
    });
    expect(rotated.body.revision).toBe(2);
    const text = JSON.stringify([
      bound,
      listedCredentials,
      listedHosts,
      rotated.body,
    ]);
    expect(text).not.toContain("scram-secret");
    expect(text).not.toContain("rotated-secret");
    expect(text).not.toContain("encryptedPassword");
  });

  it("vnc-configuration-035 (1/2) validates username/password credentials and refuses mismatched profile pairs", async () => {
    await signedInAdmin();
    const invalid = [
      { username: "op\u0000", password: "secret" },
      { username: "é".repeat(128), password: "secret" },
      { username: "operator", password: "sec\u0000" },
      { username: "operator", password: "é".repeat(512) },
    ];
    const invalidOutcomes = [];
    for (const { username, password } of invalid) {
      const response = await credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Invalid login",
          authentication: { method: "username_password", username, password },
        },
      });
      invalidOutcomes.push(errorCode(response.body));
    }
    const username = `${"é".repeat(127)}a`;
    const password = " ".repeat(1023);
    const valid = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Operator login",
          authentication: { method: "username_password", username, password },
        },
      }),
      [201],
    );
    const plain = { type: "x509_plain" as const, trust: systemTrust };
    const host = await createHost({
      id: randomUUID(),
      displayName: "Plain desk",
      host: "plain.example.com",
      credential: { id: valid.body.id },
      security: plain,
    });
    const mismatches = [
      await hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Inline login desk",
          host: "inline.example.com",
          credential: {
            create: {
              name: "Inline login",
              authentication: {
                method: "username_password",
                username: "operator",
                password: "secret",
              },
            },
          },
          security: x509Vnc,
        },
      }),
      await hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Saved login desk",
          host: "saved.example.com",
          credential: { id: valid.body.id },
          security: x509Vnc,
        },
      }),
      await hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Password desk",
          host: "password.example.com",
          credential: {
            create: {
              name: "Inline password",
              authentication: vncPassword("s3cret"),
            },
          },
          security: plain,
        },
      }),
      await credentials().update({
        headers,
        params: { credentialId: valid.body.id },
        body: { expectedRevision: 1, authentication: vncPassword("s3cret") },
      }),
      await updateHost(host.id, { expectedGeneration: 1, security: x509Vnc }),
    ];

    expect(invalidOutcomes).toStrictEqual(
      invalid.map(() => {
        return "VNC_INVALID_INPUT";
      }),
    );
    expect(valid.body).toMatchObject({
      authMethod: "username_password",
      username,
      revision: 1,
      hosts: [],
    });
    expect(JSON.stringify(valid.body)).not.toContain('"password":');
    expect(JSON.stringify(valid.body)).not.toContain("encryptedPassword");
    expect(host.security).toStrictEqual(plain);
    expect(
      mismatches.map((response) => {
        return { status: response.status, code: errorCode(response.body) };
      }),
    ).toStrictEqual(
      mismatches.map(() => {
        return { status: 400, code: "VNC_PROFILE_MISMATCH" };
      }),
    );
  });

  it("vnc-configuration-035 (2/2) rebinds the host to a VNC password and converts the unreferenced login", async () => {
    await signedInAdmin();
    const login = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Operator login",
          authentication: {
            method: "username_password",
            username: "operator",
            password: "secret",
          },
        },
      }),
      [201],
    );
    const host = await createHost({
      id: randomUUID(),
      displayName: "Plain desk",
      host: "plain.example.com",
      credential: { id: login.body.id },
      security: { type: "x509_plain", trust: systemTrust },
    });
    const password = await savedPasswordCredential("Desk password");

    const rebound = await accept(
      updateHost(host.id, {
        expectedGeneration: 1,
        credential: { id: password.id },
        security: x509Vnc,
      }),
      [200],
    );
    const converted = await accept(
      credentials().update({
        headers,
        params: { credentialId: login.body.id },
        body: { expectedRevision: 1, authentication: vncPassword("s3cret") },
      }),
      [200],
    );

    expect(rebound.body).toMatchObject({
      generation: 2,
      credentialId: password.id,
      security: x509Vnc,
    });
    expect(converted.body).toMatchObject({
      authMethod: "vnc_password",
      revision: 2,
      hosts: [],
    });
    expect("username" in converted.body).toBeFalsy();
  });
});

function credentialFreeHostBody(host: string, security: object) {
  return {
    id: randomUUID(),
    displayName: "Endpoint check",
    host,
    credential: { type: "none" },
    security,
  };
}

async function tunneledHost(connectionId: string) {
  return await createHost({
    id: randomUUID(),
    displayName: "Tunneled desk",
    host: "127.0.0.1",
    credential: {
      create: {
        name: "Tunneled password",
        authentication: vncPassword("s3cret"),
      },
    },
    security: { ...x509Vnc, serverName: "DESKTOP.Internal.Example." },
    transport: { type: "ssh", connectionId },
  });
}

describe("VNC owner configuration (endpoints and routes)", () => {
  it("vnc-configuration-036 (1/2) rejects malformed hosts and server names", async () => {
    await signedInAdmin();
    const malformedHosts = [
      "vnc://desk.example.com",
      "user@desk.example.com",
      "desk.example.com/path",
      "desk example.com",
      " desk.example.com",
      "desk.example.com ",
      "localhost:5900",
      "-desk.example.com",
      `${"a".repeat(250)}.com`,
    ];
    const malformedServerNames = [
      "bad name.example.com",
      "-bad.example.com",
      "https://bad.example.com",
    ];

    const hostStatuses = [];
    for (const host of malformedHosts) {
      const response = await rawSend(
        "POST",
        "/api/vnc/connections",
        credentialFreeHostBody(host, x509None),
      );
      hostStatuses.push(response.status);
    }
    const serverNameOutcomes = [];
    for (const serverName of malformedServerNames) {
      const response = await rawSend(
        "POST",
        "/api/vnc/connections",
        credentialFreeHostBody("desk.example.com", { ...x509None, serverName }),
      );
      serverNameOutcomes.push(outcome(response));
    }

    expect(hostStatuses).toStrictEqual(
      malformedHosts.map(() => {
        return 400;
      }),
    );
    expect(serverNameOutcomes).toStrictEqual(
      malformedServerNames.map(() => {
        return "400 VNC_INVALID_SERVER_NAME";
      }),
    );
    await expect(listCredentials()).resolves.toStrictEqual([]);
    await expect(listHosts()).resolves.toStrictEqual([]);
  });

  it("vnc-configuration-036 (2/2) rejects invalid trust and keeps a bounded custom CA", async () => {
    await signedInAdmin();
    const invalidTrust = [
      { mode: "insecure" },
      { mode: "custom_ca", caBundle: leafCertificate },
      { mode: "custom_ca", caBundle: `${certificateChain}junk` },
      { mode: "custom_ca", caBundle: `${certificateChain}\ntrailing text` },
      { mode: "system", caBundle: certificateChain },
      { mode: "custom_ca", caBundle: privateKey },
      { mode: "custom_ca", caBundle: "not a certificate" },
      {
        mode: "custom_ca",
        caBundle: Array.from({ length: 9 }, () => {
          return certificateChain;
        }).join("\n"),
      },
      { mode: "custom_ca", caBundle: "a".repeat(65_537) },
    ];

    const trustStatuses = [];
    for (const trust of invalidTrust) {
      const response = await rawSend(
        "POST",
        "/api/vnc/connections",
        credentialFreeHostBody("desk.example.com", {
          type: "x509_none",
          trust,
        }),
      );
      trustStatuses.push(response.status);
    }
    const credentialsAfter = await listCredentials();
    const hostsAfter = await listHosts();
    const valid = await createHost({
      id: randomUUID(),
      displayName: "IPv6 desk",
      host: "2001:0db8::1",
      credential: {
        create: {
          name: "IPv6 password",
          authentication: vncPassword("s3cret"),
        },
      },
      security: {
        type: "x509_vnc",
        trust: { mode: "custom_ca", caBundle: certificateChain },
      },
    });

    expect(trustStatuses).toStrictEqual(
      invalidTrust.map(() => {
        return 400;
      }),
    );
    expect(credentialsAfter).toStrictEqual([]);
    expect(hostsAfter).toStrictEqual([]);
    expect(valid).toMatchObject({
      host: "2001:db8::1",
      security: { type: "x509_vnc", trust: { mode: "custom_ca" } },
    });
  });

  it("vnc-configuration-028 (1/2) refuses private direct hosts and keeps a tunneled host on the owner's SSH route", async () => {
    const admin = await signedInAdmin();
    const gateway = await sshGateway("VNC gateway");
    const other = await admin.join(admin.orgId);

    const directOutcomes = [];
    for (const host of ["127.0.0.1", "0:0:0:0:0:0:0:1", "::ffff:192.168.1.8"]) {
      const response = await hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Private desk",
          host,
          credential: {
            create: {
              name: "Private password",
              authentication: vncPassword("s3cret"),
            },
          },
          security: x509Vnc,
        },
      });
      directOutcomes.push(outcome(response));
    }
    const tunneled = await tunneledHost(gateway.id);
    const listed = await listHosts();
    signIn(other);
    const foreignRoute = await hosts().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Borrowed route",
        host: "127.0.0.1",
        credential: {
          create: {
            name: "Borrowed password",
            authentication: vncPassword("s3cret"),
          },
        },
        security: x509Vnc,
        transport: { type: "ssh", connectionId: gateway.id },
      },
    });
    const otherCredentials = await listCredentials();
    signIn(admin);
    const inUse = await sshConnections().delete({
      headers,
      params: { connectionId: gateway.id },
      body: { expectedGeneration: gateway.generation },
    });

    expect(directOutcomes).toStrictEqual([
      "400 VNC_INVALID_HOST",
      "400 VNC_INVALID_HOST",
      "400 VNC_INVALID_HOST",
    ]);
    expect(tunneled).toMatchObject({
      generation: 1,
      transport: { type: "ssh", connectionId: gateway.id },
      security: { serverName: "desktop.internal.example" },
    });
    expect(listed).toStrictEqual([tunneled]);
    expect(foreignRoute.status).toBe(404);
    expect(errorCode(foreignRoute.body)).toBe("VNC_SSH_CONNECTION_NOT_FOUND");
    expect(otherCredentials).toStrictEqual([]);
    expect(inUse.status).toBe(409);
    expect(errorCode(inUse.body)).toBe("SSH_CONNECTION_IN_USE");
  });

  it("vnc-configuration-028 (2/2) moves a tunneled host to a direct route and releases the SSH connection", async () => {
    await signedInAdmin();
    const gateway = await sshGateway("VNC gateway");
    const tunneled = await tunneledHost(gateway.id);

    const renamed = await accept(
      updateHost(tunneled.id, {
        expectedGeneration: 1,
        displayName: "Renamed",
      }),
      [200],
    );
    const direct = await accept(
      updateHost(tunneled.id, {
        expectedGeneration: 2,
        host: "public.example.com",
        transport: { type: "direct" },
      }),
      [200],
    );
    const cleared = await accept(
      updateHost(tunneled.id, { expectedGeneration: 3, security: x509Vnc }),
      [200],
    );
    const released = await sshConnections().delete({
      headers,
      params: { connectionId: gateway.id },
      body: { expectedGeneration: gateway.generation },
    });

    expect(renamed.body).toMatchObject({
      generation: 2,
      transport: { type: "ssh", connectionId: gateway.id },
    });
    expect(direct.body).toMatchObject({
      generation: 3,
      host: "public.example.com",
      security: { serverName: "desktop.internal.example" },
    });
    expect("transport" in direct.body).toBeFalsy();
    expect(cleared.body).toMatchObject({ generation: 4, security: x509Vnc });
    expect(cleared.body.security).toStrictEqual(x509Vnc);
    expect(released.status).toBe(204);
  });
});

describe("VNC owner configuration (client certificates)", () => {
  it("vnc-configuration-025 stores both client-certificate profiles without leaking the identity", async () => {
    await signedInAdmin();
    const certificateOnly = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Certificate",
          authentication: {
            method: "client_certificate",
            certificateChain,
            privateKey,
          },
        },
      }),
      [201],
    );
    const first = await createHost({
      id: randomUUID(),
      displayName: "Certificate desk",
      host: "certificate.example.com",
      credential: { id: certificateOnly.body.id },
      security: x509None,
    });
    const withPassword = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Certificate and password",
          authentication: {
            method: "client_certificate_vnc_password",
            certificateChain,
            privateKey,
            password: "c3rtpw",
          },
        },
      }),
      [201],
    );
    const second = await createHost({
      id: randomUUID(),
      displayName: "Certificate password desk",
      host: "certificate-password.example.com",
      credential: { id: withPassword.body.id },
      security: x509Vnc,
    });
    const listedCredentials = await listCredentials();
    const listedHosts = await listHosts();
    const downgrade = await hosts().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Downgraded desk",
        host: "downgrade.example.com",
        credential: { id: withPassword.body.id },
        security: x509None,
      },
    });
    const rotated = await accept(
      credentials().update({
        headers,
        params: { credentialId: certificateOnly.body.id },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "client_certificate",
            certificateChain,
            privateKey,
          },
        },
      }),
      [200],
    );
    const hostsAfterRotation = await listHosts();

    expect(certificateOnly.body).toMatchObject({
      authMethod: "client_certificate",
      revision: 1,
    });
    expect(first).toMatchObject({
      credentialId: certificateOnly.body.id,
      clientCertificateAuthentication: "client_certificate",
      security: x509None,
      generation: 1,
    });
    expect("credential" in first).toBeFalsy();
    expect(second).toMatchObject({
      clientCertificateAuthentication: "client_certificate_vnc_password",
      security: x509Vnc,
    });
    const text = JSON.stringify([
      certificateOnly.body,
      first,
      withPassword.body,
      second,
      listedCredentials,
      listedHosts,
      rotated.body,
      hostsAfterRotation,
    ]);
    expect(text).not.toContain(privateKey);
    expect(text).not.toContain("privateKey");
    expect(text).not.toContain("encryptedClientIdentity");
    expect(text).not.toContain("c3rtpw");
    expect(downgrade.status).toBe(400);
    expect(rotated.body.revision).toBe(2);
    expect(
      hostsAfterRotation.find(({ id }) => {
        return id === first.id;
      })?.generation,
    ).toBe(2);
  });

  it("vnc-configuration-026 rejects malformed or mismatched client identities", async () => {
    await signedInAdmin();
    const unrelatedKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const encryptedKey = createPrivateKey(privateKey)
      .export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "synthetic-passphrase",
      })
      .toString();
    const identities = [
      {
        certificateChain,
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----",
      },
      { certificateChain, privateKey: unrelatedKey },
      { certificateChain: `${certificateChain}\ngarbage`, privateKey },
      { certificateChain: certificateChain.padEnd(96_001, "A"), privateKey },
      { certificateChain, privateKey: `${privateKey}\n${privateKey}` },
      { certificateChain, privateKey: encryptedKey },
    ];

    const responses = [];
    for (const identity of identities) {
      responses.push(
        await rawSend("POST", "/api/vnc/credentials", {
          id: randomUUID(),
          name: "Rejected certificate",
          authentication: { method: "client_certificate", ...identity },
        }),
        await rawSend("POST", "/api/vnc/credentials", {
          id: randomUUID(),
          name: "Rejected certificate and password",
          authentication: {
            method: "client_certificate_vnc_password",
            ...identity,
            password: "c3rtpw",
          },
        }),
      );
    }
    // The synthetic certificate is valid for two days, so it has expired by 2037.
    mockNow(Date.parse("2037-01-01T00:00:00Z"));
    const expired = await rawSend("POST", "/api/vnc/credentials", {
      id: randomUUID(),
      name: "Expired certificate",
      authentication: {
        method: "client_certificate",
        certificateChain,
        privateKey,
      },
    });
    clearMockNow();
    const inline = await hosts().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Inline certificate desk",
        host: "inline-certificate.example.com",
        credential: {
          create: {
            name: "Inline certificate",
            authentication: {
              method: "client_certificate",
              certificateChain,
              privateKey: identities[0]?.privateKey ?? "",
            },
          },
        },
        security: x509None,
      },
    });

    expect(
      responses.map(({ status }) => {
        return status;
      }),
    ).toStrictEqual(
      responses.map(() => {
        return 400;
      }),
    );
    expect(responses).toHaveLength(12);
    expect(
      JSON.stringify(
        responses.map(({ body }) => {
          return body;
        }),
      ),
    ).not.toContain(unrelatedKey.split("\n")[1] ?? unrelatedKey);
    expect(expired.status).toBe(400);
    expect(outcome(inline)).toBe("400 VNC_INVALID_CLIENT_IDENTITY");
  });

  it("pf-137 attaches using an inline credential and rejects another member's device atomically", async () => {
    const owner = await signedInAdmin();
    const peer = await owner.join(owner.orgId);
    const devices = setupApp({ context, routes: remoteDevicesRoutes })(
      remoteDevicesContract,
    );
    await updateFeatureSwitchesForUser(
      context,
      { userId: owner.userId, orgId: owner.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.RemoteDevices]: true },
    );
    await updateFeatureSwitchesForUser(
      context,
      { userId: peer.userId, orgId: peer.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.RemoteDevices]: true },
    );

    const ownerDeviceId = randomUUID();
    const peerDeviceId = randomUUID();
    signIn(owner);
    await accept(
      devices.create({
        headers,
        body: { id: ownerDeviceId, displayName: "Owner Workstation" },
      }),
      [201],
    );
    signIn(peer);
    await accept(
      devices.create({
        headers,
        body: { id: peerDeviceId, displayName: "Peer Workstation" },
      }),
      [201],
    );

    signIn(owner);
    const foreignAttempt = await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          remoteDeviceId: peerDeviceId,
          displayName: "Foreign Device VNC",
          host: "foreign.example.com",
          credential: {
            create: {
              name: "Should Not Persist",
              authentication: vncPassword("secretpw"),
            },
          },
          security: x509Vnc,
        },
      }),
      [404],
    );
    expect(foreignAttempt.status).toBe(404);
    const credsAfterReject = await accept(
      credentials().list({ headers }),
      [200],
    );
    expect(credsAfterReject.body.credentials).toStrictEqual([]);

    const hostId = randomUUID();
    await accept(
      hosts().create({
        headers,
        body: {
          id: hostId,
          remoteDeviceId: ownerDeviceId,
          displayName: "Owned Device VNC",
          host: "owned.example.com",
          credential: {
            create: {
              name: "Owned Inline Password",
              authentication: vncPassword("secretpw"),
            },
          },
          security: x509Vnc,
        },
      }),
      [201],
    );
    const directory = await accept(devices.list({ headers }), [200]);
    const attached = directory.body.devices.find((device) => {
      return device.id === ownerDeviceId;
    });
    expect(attached?.channels).toContainEqual(
      expect.objectContaining({
        id: hostId,
        kind: "vnc",
        displayName: "Owned Device VNC",
      }),
    );
  });

  it("pf-151 deletes dependent channels together and protects channels on other devices", async () => {
    const owner = await signedInAdmin();
    const devices = setupApp({ context, routes: remoteDevicesRoutes })(
      remoteDevicesContract,
    );
    await updateFeatureSwitchesForUser(
      context,
      { userId: owner.userId, orgId: owner.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.RemoteDevices]: true },
    );
    signIn(owner);

    const gatewayDeviceId = randomUUID();
    const targetDeviceId = randomUUID();
    await Promise.all([
      accept(
        devices.create({
          headers,
          body: { id: gatewayDeviceId, displayName: "Gateway Workstation" },
        }),
        [201],
      ),
      accept(
        devices.create({
          headers,
          body: { id: targetDeviceId, displayName: "Display Workstation" },
        }),
        [201],
      ),
    ]);

    const sshId = randomUUID();
    await accept(
      sshConnections().create({
        headers,
        body: {
          id: sshId,
          remoteDeviceId: gatewayDeviceId,
          displayName: "Shared Bastion",
          host: "bastion.example.com",
          credential: inlineSshKey("ops", `key-${randomUUID()}`),
        },
      }),
      [201],
    );

    const vncId = randomUUID();
    await accept(
      hosts().create({
        headers,
        body: {
          id: vncId,
          remoteDeviceId: targetDeviceId,
          displayName: "Tunneled Desktop",
          host: "127.0.0.1",
          port: 5900,
          transport: { type: "ssh", connectionId: sshId },
          credential: {
            create: {
              name: "Tunneled Password",
              authentication: vncPassword("secretpw"),
            },
          },
          security: x509Vnc,
        },
      }),
      [201],
    );

    const blocked = await accept(
      devices.delete({ headers, params: { deviceId: gatewayDeviceId } }),
      [409],
    );
    expect(blocked.body.error.message).toContain("channel dependency");

    await accept(
      devices.moveChannel({
        headers,
        params: {
          deviceId: gatewayDeviceId,
          kind: "vnc",
          channelId: vncId,
        },
      }),
      [204],
    );

    await accept(
      devices.delete({ headers, params: { deviceId: gatewayDeviceId } }),
      [204],
    );

    const [directory, remainingSsh, remainingVnc] = await Promise.all([
      accept(devices.list({ headers }), [200]),
      accept(sshConnections().list({ headers }), [200]),
      accept(hosts().list({ headers }), [200]),
    ]);
    expect(
      directory.body.devices.map((device) => {
        return device.id;
      }),
    ).toStrictEqual([targetDeviceId]);
    expect(remainingSsh.body.connections).toStrictEqual([]);
    expect(remainingVnc.body.connections).toStrictEqual([]);
  });
});
