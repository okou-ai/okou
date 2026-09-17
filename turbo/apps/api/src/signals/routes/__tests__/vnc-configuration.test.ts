import { randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../utils";
import { vncConnectionsRoutes } from "../vnc-connections";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const security = Object.freeze({
  type: "x509_vnc" as const,
  trust: Object.freeze({ mode: "system" as const }),
});
const leafCertificate = readFileSync(
  new URL("./fixtures/vnc-leaf.txt", import.meta.url),
  "utf8",
);
function credentials() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
}
function connections() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
}
async function owner(
  overrides: Partial<{ orgId: string; userId: string }> = {},
) {
  const value = {
    orgId: `org_vnc_${randomUUID()}`,
    userId: `user_vnc_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  mocks.clerk.session(value.userId, value.orgId);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `member_${value.orgId}_${value.userId}`,
          publicUserData: { userId: value.userId },
          organization: { id: value.orgId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
  return value;
}
function passwordAuthentication(password: string) {
  return { method: "vnc_password" as const, password };
}
function hostBody(host = "vnc.example.com") {
  return {
    id: randomUUID(),
    displayName: "Desktop",
    host,
    credential: {
      create: {
        name: "Desktop password",
        authentication: passwordAuthentication(" secret "),
      },
    },
    security,
  };
}
function rawRequest(path: string, body: unknown, method = "POST") {
  const request = setupRawAppRequest({ context, routes: vncConnectionsRoutes });
  return request(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("VNC owner configuration", () => {
  it("requires session, feature and current membership before exposing configuration", async () => {
    const kms = useSecretKmsProbe();
    await accept(credentials().list({ headers: {} }), [401]);
    mocks.clerk.session(
      `user_disabled_${randomUUID()}`,
      `org_disabled_${randomUUID()}`,
    );
    expect(
      (
        await rawRequest("/api/vnc/credentials", {
          authentication: passwordAuthentication("canary"),
        })
      ).status,
    ).toBe(404);
    await owner();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    await accept(credentials().list({ headers }), [404]);
    await accept(connections().create({ headers, body: hostBody() }), [404]);
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("returns secret-free metadata, shared references and an accurate summary", async () => {
    useSecretKmsProbe();
    await owner();
    const credential = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: " Shared ",
          authentication: passwordAuthentication(" secret "),
        },
      }),
      [201],
    );
    expect(credential.body).toMatchObject({
      name: "Shared",
      authMethod: "vnc_password",
      revision: 1,
      hosts: [],
    });
    const hosts = [];
    for (const host of ["VNC.EXAMPLE.COM.", "192.0.2.5"]) {
      const created = await accept(
        connections().create({
          headers,
          body: { ...hostBody(host), credential: { id: credential.body.id } },
        }),
        [201],
      );
      hosts.push(created.body);
      expect(created.headers.get("cache-control")).toBe("no-store");
    }
    expect(hosts[0]?.host).toBe("vnc.example.com");
    expect(hosts[0]?.port).toBe(5900);
    expect(hosts[0]?.security).toStrictEqual(security);
    expect(
      (await accept(connections().summary({ headers }), [200])).body,
    ).toStrictEqual({ configuredCount: 2 });
    const listed = await accept(credentials().list({ headers }), [200]);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.body.credentials[0]?.authMethod).toBe("vnc_password");
    expect(listed.body.credentials[0]?.hosts).toStrictEqual(
      expect.arrayContaining(
        hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
    );
    for (const response of [credential.body, hosts, listed.body]) {
      for (const secret of [
        " secret ",
        '"password":',
        "encryptedPassword",
        "vm0secret:",
      ]) {
        expect(JSON.stringify(response)).not.toContain(secret);
      }
    }
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: credential.body.id },
        body: { expectedRevision: 1 },
      }),
      [409],
    );
    for (const host of hosts) {
      await accept(
        connections().delete({
          headers,
          params: { connectionId: host.id },
          body: { expectedGeneration: 1 },
        }),
        [204],
      );
    }
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: credential.body.id },
        body: { expectedRevision: 1 },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
  });

  it("rejects non-ASCII and oversized passwords without truncating or echoing them", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const password of [
      "",
      "123456789",
      "秘密",
      "x\n",
      "x\t",
      "\u007f",
      "é",
    ]) {
      const response = await rawRequest("/api/vnc/credentials", {
        id: randomUUID(),
        name: "Canary",
        authentication: passwordAuthentication(password),
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: { code: "VNC_INVALID_INPUT" },
      });
    }
    expect(kms.generateDataKeyCalls).toBe(0);
    await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Spaces",
          authentication: passwordAuthentication("        "),
        },
      }),
      [201],
    );
  });

  it("rejects unsupported authentication and security profiles without changing saved configuration", async () => {
    useSecretKmsProbe();
    await owner();
    const saved = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const before = (await accept(credentials().list({ headers }), [200])).body;
    for (const authentication of [
      { method: "none" },
      { method: "username_password", username: "canary", password: "secret" },
      { method: "vnc_password" },
      { method: "vnc_password", password: "secret", username: "canary" },
    ]) {
      expect(
        (
          await rawRequest("/api/vnc/credentials", {
            id: randomUUID(),
            name: "Unsupported",
            authentication,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await rawRequest("/api/vnc/connections", {
            ...hostBody(),
            credential: { create: { name: "Unsupported", authentication } },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await rawRequest(
            `/api/vnc/credentials/${saved.body.credentialId}`,
            {
              expectedRevision: 1,
              authentication,
            },
            "PATCH",
          )
        ).status,
      ).toBe(400);
    }
    for (const unsupportedSecurity of [
      { type: "none" },
      { type: "tls_vnc" },
      { type: "x509_vnc" },
      { type: "x509_vnc", trust: { mode: "insecure" } },
    ]) {
      expect(
        (
          await rawRequest("/api/vnc/connections", {
            ...hostBody(),
            security: unsupportedSecurity,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await rawRequest(
            `/api/vnc/connections/${saved.body.id}`,
            {
              expectedGeneration: 1,
              security: unsupportedSecurity,
            },
            "PATCH",
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([saved.body]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body,
    ).toStrictEqual(before);
  });

  it("validates canonical endpoints and bounded certificate-only trust", async () => {
    const kms = useSecretKmsProbe();
    await owner();
    for (const host of [
      "https://vnc.example.com",
      "user@vnc.example.com",
      "vnc.example.com/path",
      "bad host",
      "localhost:5900",
      "-bad.example",
      "a".repeat(254),
    ]) {
      expect(
        (await rawRequest("/api/vnc/connections", hostBody(host))).status,
      ).toBe(400);
    }
    for (const port of [0, 65_536, 1.5]) {
      expect(
        (await rawRequest("/api/vnc/connections", { ...hostBody(), port }))
          .status,
      ).toBe(400);
    }
    const certificate = rootCertificates[0];
    expect(certificate).toBeDefined();
    const appendedDer = Buffer.concat([
      new X509Certificate(certificate!).raw,
      Buffer.from("junk"),
    ]);
    const appendedCertificate = `-----BEGIN CERTIFICATE-----\n${appendedDer.toString("base64")}\n-----END CERTIFICATE-----`;
    for (const invalidTrust of [
      { mode: "insecure" },
      { mode: "custom_ca", caBundle: leafCertificate },
      { mode: "custom_ca", caBundle: appendedCertificate },
      { mode: "custom_ca", caBundle: `${certificate}\ntrailing-junk` },
      { mode: "system", caBundle: certificate },
      {
        mode: "custom_ca",
        caBundle:
          "-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----",
      },
      { mode: "custom_ca", caBundle: "malformed-canary" },
      {
        mode: "custom_ca",
        caBundle: Array.from({ length: 9 }, () => {
          return certificate;
        }).join("\n"),
      },
      { mode: "custom_ca", caBundle: "x".repeat(65_537) },
    ]) {
      expect(
        (
          await rawRequest("/api/vnc/connections", {
            ...hostBody(),
            security: { type: "x509_vnc", trust: invalidTrust },
          })
        ).status,
      ).toBe(400);
    }
    expect(kms.generateDataKeyCalls).toBe(0);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    const created = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("2001:0db8::1"),
          security: {
            type: "x509_vnc",
            trust: { mode: "custom_ca", caBundle: certificate! },
          },
        },
      }),
      [201],
    );
    expect(created.body.host).toBe("2001:db8::1");
    expect(created.body.security.type).toBe("x509_vnc");
    expect(created.body.security.trust.mode).toBe("custom_ca");
  });

  it("isolates owners and rejects foreign creation IDs and credentials", async () => {
    useSecretKmsProbe();
    const first = await owner();
    const credential = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "First",
          authentication: passwordAuthentication("first"),
        },
      }),
      [201],
    );
    const host = await accept(
      connections().create({
        headers,
        body: { ...hostBody(), credential: { id: credential.body.id } },
      }),
      [201],
    );
    for (const other of [{ orgId: first.orgId }, { userId: first.userId }]) {
      await owner(other);
      expect(
        (await accept(credentials().list({ headers }), [200])).body.credentials,
      ).toStrictEqual([]);
      expect(
        (await accept(connections().list({ headers }), [200])).body.connections,
      ).toStrictEqual([]);
      await accept(
        credentials().create({
          headers,
          body: {
            id: credential.body.id,
            name: "Foreign",
            authentication: passwordAuthentication("foreign"),
          },
        }),
        [409],
      );
      await accept(
        connections().create({
          headers,
          body: { ...hostBody(), id: host.body.id },
        }),
        [409],
      );
      await accept(
        connections().create({
          headers,
          body: { ...hostBody(), credential: { id: credential.body.id } },
        }),
        [404],
      );
      await accept(
        credentials().update({
          headers,
          params: { credentialId: credential.body.id },
          body: { expectedRevision: 1, name: "Foreign" },
        }),
        [404],
      );
      await accept(
        connections().delete({
          headers,
          params: { connectionId: host.body.id },
          body: { expectedGeneration: 1 },
        }),
        [404],
      );
    }
  });

  it("makes creation retries no-ops even with changed inline secrets and metadata", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const created = await accept(
      connections().create({ headers, body }),
      [201],
    );
    await accept(
      connections().create({
        headers,
        body: {
          ...body,
          displayName: "Retry",
          host: "retry.example.com",
          credential: {
            create: {
              name: "Retry",
              authentication: passwordAuthentication("changed"),
            },
          },
        },
      }),
      [204],
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([created.body]);
    const before = (await accept(credentials().list({ headers }), [200])).body
      .credentials;
    expect(before).toHaveLength(1);
    const credential = before[0]!;
    await accept(
      credentials().create({
        headers,
        body: {
          id: credential.id,
          name: "Retry",
          authentication: passwordAuthentication("changed"),
        },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual(before);
  });

  it("keeps configurations for one canonical endpoint independent during updates and deletion", async () => {
    useSecretKmsProbe();
    await owner();
    const first = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const certificate = rootCertificates[0];
    expect(certificate).toBeDefined();
    const second = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("VNC.EXAMPLE.COM."),
          displayName: "Other login and trust",
          credential: {
            create: {
              name: "Other login",
              authentication: passwordAuthentication("other"),
            },
          },
          security: {
            type: "x509_vnc",
            trust: { mode: "custom_ca", caBundle: certificate! },
          },
        },
      }),
      [201],
    );
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.credentialId).not.toBe(first.body.credentialId);
    expect(second.body.host).toBe(first.body.host);
    expect(second.body.port).toBe(first.body.port);
    expect(second.body.security.trust.mode).toBe("custom_ca");
    expect(
      (await accept(connections().summary({ headers }), [200])).body,
    ).toStrictEqual({ configuredCount: 2 });
    const updated = await accept(
      connections().update({
        headers,
        params: { connectionId: second.body.id },
        body: { expectedGeneration: 1, displayName: "Renamed", security },
      }),
      [200],
    );
    expect(updated.body).toMatchObject({
      id: second.body.id,
      credentialId: second.body.credentialId,
      generation: 2,
      displayName: "Renamed",
      security,
    });
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual(expect.arrayContaining([first.body, updated.body]));
    await accept(
      connections().delete({
        headers,
        params: { connectionId: first.body.id },
        body: { expectedGeneration: 1 },
      }),
      [204],
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([updated.body]);
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: first.body.credentialId },
        body: { expectedRevision: 1 },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toMatchObject([
      {
        id: second.body.credentialId,
        authMethod: "vnc_password",
        revision: 1,
        hosts: [{ id: second.body.id, displayName: "Renamed" }],
      },
    ]);
  });

  it("allows a new credential creation to reuse a deleted credential ID", async () => {
    useSecretKmsProbe();
    await owner();
    const body = {
      id: randomUUID(),
      name: "Deleted",
      authentication: passwordAuthentication("original"),
    };
    const saved = await accept(credentials().create({ headers, body }), [201]);
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: saved.body.id },
        body: { expectedRevision: saved.body.revision },
      }),
      [204],
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    const recreated = await accept(
      credentials().create({
        headers,
        body: {
          ...body,
          name: "New credential",
          authentication: passwordAuthentication("new"),
        },
      }),
      [201],
    );
    expect(recreated.body).toMatchObject({
      id: body.id,
      name: "New credential",
      revision: 1,
      hosts: [],
    });
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([recreated.body]);
  });

  it("allows a new host creation to reuse a deleted host ID with a new inline credential", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const saved = await accept(connections().create({ headers, body }), [201]);
    await accept(
      connections().delete({
        headers,
        params: { connectionId: saved.body.id },
        body: { expectedGeneration: saved.body.generation },
      }),
      [204],
    );
    await accept(
      credentials().delete({
        headers,
        params: { credentialId: saved.body.credentialId },
        body: { expectedRevision: 1 },
      }),
      [204],
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    const recreated = await accept(
      connections().create({
        headers,
        body: {
          ...body,
          displayName: "New desktop",
          credential: {
            create: {
              name: "New login",
              authentication: passwordAuthentication("new"),
            },
          },
        },
      }),
      [201],
    );
    expect(recreated.body).toMatchObject({
      id: body.id,
      displayName: "New desktop",
      generation: 1,
    });
    expect(recreated.body.credentialId).not.toBe(saved.body.credentialId);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([recreated.body]);
    const logins = await accept(credentials().list({ headers }), [200]);
    expect(logins.body.credentials).toMatchObject([
      { id: recreated.body.credentialId, name: "New login", revision: 1 },
    ]);
  });

  it("acknowledges completed creation retries during a KMS outage", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const saved = await accept(connections().create({ headers, body }), [201]);
    const kms = useSecretKmsProbe(() => {
      return Promise.reject(new Error("Synthetic KMS outage"));
    });
    await accept(connections().create({ headers, body }), [204]);
    await accept(
      credentials().create({
        headers,
        body: {
          id: saved.body.credentialId,
          name: "Retry",
          authentication: passwordAuthentication("changed"),
        },
      }),
      [204],
    );
    await accept(
      credentials().update({
        headers,
        params: { credentialId: randomUUID() },
        body: {
          expectedRevision: 1,
          authentication: passwordAuthentication("changed"),
        },
      }),
      [404],
    );
    await accept(
      connections().update({
        headers,
        params: { connectionId: randomUUID() },
        body: {
          expectedGeneration: 1,
          credential: {
            create: {
              name: "Missing",
              authentication: passwordAuthentication("changed"),
            },
          },
        },
      }),
      [404],
    );
    expect(kms.generateDataKeyCalls).toBe(0);
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([saved.body]);
  });

  it("advances shared host generations on password rotation and rejects stale edits and deletes", async () => {
    useSecretKmsProbe();
    await owner();
    const first = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const second = await accept(
      connections().create({
        headers,
        body: {
          ...hostBody("VNC.EXAMPLE.COM."),
          credential: { id: first.body.credentialId },
        },
      }),
      [201],
    );
    const independent = await accept(
      connections().create({ headers, body: hostBody() }),
      [201],
    );
    const params = { credentialId: first.body.credentialId };
    const rotated = await accept(
      credentials().update({
        headers,
        params,
        body: {
          expectedRevision: 1,
          authentication: passwordAuthentication("rotated"),
        },
      }),
      [200],
    );
    expect(rotated.body.revision).toBe(2);
    const hosts = (await accept(connections().list({ headers }), [200])).body
      .connections;
    expect(hosts).toHaveLength(3);
    expect(hosts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.body.id, generation: 2 }),
        expect.objectContaining({ id: second.body.id, generation: 2 }),
        independent.body,
      ]),
    );
    await accept(
      credentials().update({
        headers,
        params,
        body: { expectedRevision: 1, name: "Stale" },
      }),
      [409],
    );
    await accept(
      credentials().delete({ headers, params, body: { expectedRevision: 1 } }),
      [409],
    );
    for (const host of [first.body, second.body]) {
      const connectionParams = { connectionId: host.id };
      await accept(
        connections().update({
          headers,
          params: connectionParams,
          body: {
            expectedGeneration: 1,
            credential: {
              create: {
                name: "Stale inline credential",
                authentication: passwordAuthentication("stale"),
              },
            },
          },
        }),
        [409],
      );
      await accept(
        connections().delete({
          headers,
          params: connectionParams,
          body: { expectedGeneration: 1 },
        }),
        [409],
      );
    }
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toHaveLength(2);
    const edited = await accept(
      connections().update({
        headers,
        params: { connectionId: first.body.id },
        body: { expectedGeneration: 2, host: "new.example.com", security },
      }),
      [200],
    );
    expect(edited.body).toMatchObject({
      generation: 3,
      host: "new.example.com",
    });
  });

  it("rechecks revision after delayed KMS encryption without overwriting the winner", async () => {
    useSecretKmsProbe();
    await owner();
    const created = await accept(
      credentials().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Initial",
          authentication: passwordAuthentication("initial"),
        },
      }),
      [201],
    );
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    useSecretKmsProbe(async (request) => {
      entered.resolve();
      await release.promise;
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
        encryptedDataKey: Buffer.from("test-wrapped-key"),
      };
    });
    const params = { credentialId: created.body.id };
    const delayed = accept(
      credentials().update({
        headers,
        params,
        body: {
          expectedRevision: 1,
          authentication: passwordAuthentication("delayed"),
        },
      }),
      [409],
    );
    await entered.promise;
    const winner = await accept(
      credentials().update({
        headers,
        params,
        body: { expectedRevision: 1, name: "Winner" },
      }),
      [200],
    );
    release.resolve();
    expect((await delayed).body.error.code).toBe(
      "VNC_CREDENTIAL_REVISION_CONFLICT",
    );
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([winner.body]);
  });

  it("serializes concurrent duplicate creation and binding against credential deletion", async () => {
    useSecretKmsProbe();
    await owner();
    const body = hostBody();
    const results = await Promise.all([
      connections().create({ headers, body }),
      connections().create({ headers, body }),
    ]);
    expect(
      results
        .map(({ status }) => {
          return status;
        })
        .sort(),
    ).toStrictEqual([201, 204]);
    const listed = (await accept(connections().list({ headers }), [200])).body
      .connections;
    expect(listed).toHaveLength(1);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toHaveLength(1);
    const host = listed[0]!;
    await accept(
      connections().delete({
        headers,
        params: { connectionId: host.id },
        body: { expectedGeneration: 1 },
      }),
      [204],
    );
    const [bound, deleted] = await Promise.all([
      accept(
        connections().create({
          headers,
          body: {
            ...hostBody("race.example.com"),
            credential: { id: host.credentialId },
          },
        }),
        [201, 404],
      ),
      accept(
        credentials().delete({
          headers,
          params: { credentialId: host.credentialId },
          body: { expectedRevision: 1 },
        }),
        [204, 409],
      ),
    ]);
    expect([bound.status, deleted.status]).toStrictEqual(
      bound.status === 201 ? [201, 409] : [404, 204],
    );
  });
});
