import { randomUUID } from "node:crypto";
import { rootCertificates } from "node:tls";
import { beforeEach, describe, expect, it, test } from "vitest";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import {
  vncConnectionsContract,
  type VncSecurity,
} from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { tailscaleRoutes } from "../tailscale";
import { vncConnectionsRoutes } from "../vnc-connections";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const query = Object.freeze({ view: "scoped" as const });
const routes = Object.freeze([
  ...cloudflareAccessRoutes,
  ...tailscaleRoutes,
  ...vncConnectionsRoutes,
  ...sshConnectionsRoutes,
]);
type Provider = "cloudflare_access" | "tailscale";
const providers = ["cloudflare_access", "tailscale"] as const;
const api = () => {
  return setupApp({ context, routes });
};
const vnc = () => {
  return api()(vncConnectionsContract);
};
const credentials = () => {
  return api()(vncCredentialsContract);
};
const access = () => {
  return api()(cloudflareAccessContract);
};
const tailscale = () => {
  return api()(tailscaleContract);
};
const oauth = Object.freeze({
  clientId: "native-client-canary",
  clientSecret: "native-secret-canary",
});

function authenticate(owner: { orgId: string; userId: string }) {
  mocks.clerk.session(owner.userId, owner.orgId);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `member_${owner.userId}`,
          publicUserData: { userId: owner.userId },
          organization: { id: owner.orgId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
}
beforeEach(() => {
  useSecretKmsProbe();
  authenticate({
    orgId: `org_native_${randomUUID()}`,
    userId: `user_native_${randomUUID()}`,
  });
});
async function config(
  provider: Provider,
  scope: "personal" | "organization" = "personal",
) {
  const body = {
    id: randomUUID(),
    name: "Native network",
    scope,
    credentials: oauth,
  };
  return provider === "cloudflare_access"
    ? (await accept(access().create({ headers, query, body }), [201])).body
    : (
        await accept(
          tailscale().create({
            headers,
            body: { ...body, tags: ["tag:okou"] },
          }),
          [201],
        )
      ).body;
}
async function configurations(provider: Provider) {
  return provider === "cloudflare_access"
    ? (await accept(access().list({ headers, query }), [200])).body.configs
    : (await accept(tailscale().list({ headers }), [200])).body.configs;
}
function rotate(
  provider: Provider,
  selected: { id: string; revision: number },
) {
  const body = {
    expectedRevision: selected.revision,
    credentials: { clientId: "rotated-client", clientSecret: "rotated-secret" },
  };
  const params = { configId: selected.id };
  return provider === "cloudflare_access"
    ? accept(access().update({ headers, query, params, body }), [200, 409])
    : accept(tailscale().update({ headers, params, body }), [200, 409]);
}
function deleteConfig(
  provider: Provider,
  selected: { id: string; revision: number },
  impactSnapshot?: string,
) {
  const params = { configId: selected.id };
  const body = {
    expectedRevision: selected.revision,
    ...(impactSnapshot ? { impactSnapshot } : {}),
  };
  return provider === "cloudflare_access"
    ? accept(access().delete({ headers, params, body }), [204, 409])
    : accept(tailscale().delete({ headers, params, body }), [204, 409]);
}
async function impact(provider: Provider, id: string) {
  const params = { configId: id };
  const query = { operation: "delete" as const };
  return provider === "cloudflare_access"
    ? (await accept(access().impactPreview({ headers, params, query }), [200]))
        .body
    : (
        await accept(
          tailscale().impactPreview({ headers, params, query }),
          [200],
        )
      ).body;
}
function endpoint(provider: Provider, role: "rfb" | "kdc") {
  return {
    host:
      provider === "cloudflare_access"
        ? `${role}-gateway.example.com`
        : `${role}-peer.tailnet`,
    port: provider === "cloudflare_access" ? 443 : role === "rfb" ? 5900 : 88,
  };
}
function binding(type: Provider, configId: string) {
  return type === "cloudflare_access"
    ? { type: "cloudflare_access" as const, configId }
    : { type: "tailscale" as const, configId };
}
function security(provider: Provider, configId: string) {
  return {
    type: "qemu_x509_gssapi" as const,
    trust: { mode: "system" as const },
    serverName: "desktop.example.com",
    service: {
      realm: "EXAMPLE.COM",
      components: ["vnc", "desktop.example.com"],
    },
    kdc: {
      ...endpoint(provider, "kdc"),
      transport: binding(provider, configId),
      ticketLifetimeSeconds: 1200,
      renewableLifetimeSeconds: 7200,
    },
  };
}
function hostBody(
  provider: Provider,
  configId: string,
  kdcProvider = provider,
  kdcId = configId,
) {
  return {
    id: randomUUID(),
    displayName: "Private desktop and KDC",
    ...endpoint(provider, "rfb"),
    transport: binding(provider, configId),
    security: security(kdcProvider, kdcId),
    credential: {
      create: {
        name: "Kerberos login",
        authentication: {
          method: "qemu_kerberos_password" as const,
          initiator: { realm: "EXAMPLE.COM", components: ["operator"] },
          password: "kerberos-secret-canary",
        },
      },
    },
  };
}
async function latest(id: string) {
  const host = (
    await accept(vnc().list({ headers }), [200])
  ).body.connections.find((host) => {
    return host.id === id;
  });
  if (!host) {
    throw new Error("Expected public native host");
  }
  return host;
}

describe.each(providers)(
  "%s public native publication on PostgreSQL",
  (provider) => {
    it("creates both roles, retains logical config metadata and rotates a dual-role Host exactly once", async () => {
      const selected = await config(provider);
      expect(selected.vncHosts).toStrictEqual([]);
      const body = hostBody(provider, selected.id);
      // PostgreSQL UUID identity is case insensitive across the two roles.
      const created = (
        await accept(
          vnc().create({
            headers,
            body: {
              ...body,
              transport: binding(provider, selected.id.toUpperCase()),
            },
          }),
          [201],
        )
      ).body;
      const probe = useSecretKmsProbe();
      await accept(vnc().create({ headers, body }), [204]);
      expect(probe.generateDataKeyCalls).toBe(0);
      const refs = [
        {
          id: created.id,
          displayName: created.displayName,
          roles: ["rfb", "kdc"],
        },
      ];
      await expect(configurations(provider)).resolves.toStrictEqual([
        { ...selected, vncHosts: refs },
      ]);
      const renamed = (
        await accept(
          vnc().update({
            headers,
            params: { connectionId: created.id },
            body: {
              expectedGeneration: created.generation,
              displayName: "Retained private desktop",
            },
          }),
          [200],
        )
      ).body;
      expect(renamed).toMatchObject({
        id: created.id,
        transport: body.transport,
        security: body.security,
        generation: created.generation + 1,
      });
      const rotated = await rotate(provider, selected);
      expect(rotated.status).toBe(200);
      await expect(latest(created.id)).resolves.toMatchObject({
        id: created.id,
        generation: renamed.generation + 1,
        security: body.security,
      });
      await expect(configurations(provider)).resolves.toMatchObject([
        {
          ...selected,
          revision: selected.revision + 1,
          generation: selected.generation + 1,
          updatedAt: expect.any(String),
          vncHosts: [{ ...refs[0], displayName: renamed.displayName }],
        },
      ]);
      const listed = JSON.stringify(await configurations(provider));
      for (const secret of [
        oauth.clientId,
        oauth.clientSecret,
        body.credential.create.authentication.password,
      ]) {
        expect(listed).not.toContain(secret);
      }
      expect(
        (
          await deleteConfig(
            provider,
            rotated.status === 200 ? rotated.body : selected,
          )
        ).status,
      ).toBe(409);
    });

    it("publishes independent configurations, rebinds only KDC and preserves all credential/trust fields on a failed edit", async () => {
      const rfb = await config(provider),
        kdc = await config(provider),
        replacement = await config(provider);
      const body = hostBody(provider, rfb.id, provider, kdc.id);
      const created = (await accept(vnc().create({ headers, body }), [201]))
        .body;
      const before = (await accept(credentials().list({ headers }), [200]))
        .body;
      await accept(
        vnc().update({
          headers,
          params: { connectionId: created.id },
          body: {
            expectedGeneration: created.generation,
            transport: binding(provider, randomUUID()),
            credential: body.credential,
          },
        }),
        [404],
      );
      await expect(latest(created.id)).resolves.toStrictEqual(created);
      expect(
        (await accept(credentials().list({ headers }), [200])).body,
      ).toStrictEqual(before);
      const rebound = (
        await accept(
          vnc().update({
            headers,
            params: { connectionId: created.id },
            body: {
              expectedGeneration: created.generation,
              security: security(provider, replacement.id),
            },
          }),
          [200],
        )
      ).body;
      expect(rebound).toMatchObject({
        id: created.id,
        transport: body.transport,
        security: security(provider, replacement.id),
        generation: created.generation + 1,
      });
      const configs = await configurations(provider);
      expect(
        configs.find((c) => {
          return c.id === rfb.id;
        })?.vncHosts,
      ).toStrictEqual([
        { id: created.id, displayName: created.displayName, roles: ["rfb"] },
      ]);
      expect(
        configs.find((c) => {
          return c.id === kdc.id;
        })?.vncHosts,
      ).toStrictEqual([]);
      expect(
        configs.find((c) => {
          return c.id === replacement.id;
        })?.vncHosts,
      ).toStrictEqual([
        { id: created.id, displayName: created.displayName, roles: ["kdc"] },
      ]);
    });

    it("removes native KDC bindings when changing profile and clears the RFB reference only on an explicit route change", async () => {
      const selected = await config(provider);
      const created = (
        await accept(
          vnc().create({ headers, body: hostBody(provider, selected.id) }),
          [201],
        )
      ).body;
      const changed = (
        await accept(
          vnc().update({
            headers,
            params: { connectionId: created.id },
            body: {
              expectedGeneration: created.generation,
              credential: { type: "none" },
              security: {
                type: "x509_none",
                serverName: "inner.example.com",
                trust: { mode: "system" },
              },
            },
          }),
          [200],
        )
      ).body;
      expect(changed).toMatchObject({
        id: created.id,
        security: { type: "x509_none" },
        transport: binding(provider, selected.id),
      });
      expect(changed.security).not.toHaveProperty("kdc");
      expect(
        (await configurations(provider)).find((c) => {
          return c.id === selected.id;
        })?.vncHosts,
      ).toStrictEqual([
        { id: created.id, displayName: created.displayName, roles: ["rfb"] },
      ]);
      const direct = (
        await accept(
          vnc().update({
            headers,
            params: { connectionId: created.id },
            body: {
              expectedGeneration: changed.generation,
              host: "direct.example.com",
              port: 5900,
              transport: { type: "direct" },
            },
          }),
          [200],
        )
      ).body;
      expect(direct).not.toHaveProperty("transport");
      expect(
        (await configurations(provider)).find((c) => {
          return c.id === selected.id;
        })?.vncHosts,
      ).toStrictEqual([]);
      expect(
        (await accept(credentials().list({ headers }), [200])).body.credentials,
      ).toMatchObject([{ hosts: [] }]);
    });

    it("rejects deletion during inline credential preparation without any partial Host, config or credential publication", async () => {
      const selected = await config(provider);
      const body = hostBody(provider, selected.id);
      const before = (await accept(credentials().list({ headers }), [200]))
        .body;
      const probe = useSecretKmsProbe(async (request, call) => {
        if (call === 1) {
          expect((await deleteConfig(provider, selected)).status).toBe(204);
        }
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
          encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
        };
      });
      await accept(vnc().create({ headers, body }), [404]);
      expect(probe.generateDataKeyCalls).toBe(1);
      expect(
        (await accept(vnc().list({ headers }), [200])).body.connections,
      ).toStrictEqual([]);
      expect(
        (await accept(credentials().list({ headers }), [200])).body,
      ).toStrictEqual(before);
      await expect(configurations(provider)).resolves.toStrictEqual([]);
    });

    it("rejects a stale retained inline edit after rotation without orphaning its prepared credential", async () => {
      const selected = await config(provider);
      const body = hostBody(provider, selected.id);
      const created = (await accept(vnc().create({ headers, body }), [201]))
        .body;
      const before = (await accept(credentials().list({ headers }), [200]))
        .body;
      const probe = useSecretKmsProbe(async (request, call) => {
        if (call === 1) {
          expect((await rotate(provider, selected)).status).toBe(200);
        }
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
          encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
        };
      });
      await accept(
        vnc().update({
          headers,
          params: { connectionId: created.id },
          body: {
            expectedGeneration: created.generation,
            displayName: "Losing draft",
            credential: body.credential,
          },
        }),
        [409],
      );
      // One Host credential preparation and the config's two encrypted values.
      expect(probe.generateDataKeyCalls).toBe(3);
      expect(
        (await accept(credentials().list({ headers }), [200])).body,
      ).toStrictEqual(before);
      await expect(latest(created.id)).resolves.toMatchObject({
        id: created.id,
        displayName: created.displayName,
        generation: created.generation + 1,
        security: created.security,
      });
    });

    it("keeps SSH/VNC UUID collisions distinct in shared reference accounting", async () => {
      const selected = await config(provider, "organization");
      const body = hostBody(provider, selected.id);
      const created = (await accept(vnc().create({ headers, body }), [201]))
        .body;
      await accept(
        api()(sshConnectionsContract).create({
          headers,
          body: {
            id: created.id,
            displayName: "Same UUID SSH",
            host: "peer.example.com",
            port: 443,
            transport: binding(provider, selected.id),
            credential: {
              create: {
                name: "SSH login",
                username: "operator",
                authentication: {
                  method: "password",
                  password: "synthetic-ssh-password",
                },
              },
            },
          },
        }),
        [201],
      );
      const listed = (await configurations(provider)).find((c) => {
        return c.id === selected.id;
      });
      expect(listed?.sshHosts).toStrictEqual([
        { id: created.id, displayName: "Same UUID SSH" },
      ]);
      expect(listed?.vncHosts).toStrictEqual([
        {
          id: created.id,
          displayName: created.displayName,
          roles: ["rfb", "kdc"],
        },
      ]);
      await expect(impact(provider, selected.id)).resolves.toMatchObject({
        ownHostCount: 2,
        otherHostCount: 0,
      });
    });

    it("commits only one concurrent entering edit and its inline credential", async () => {
      const original = await config(provider),
        first = await config(provider),
        second = await config(provider);
      const body = hostBody(provider, original.id);
      const created = (await accept(vnc().create({ headers, body }), [201]))
        .body;
      const prepared = createDeferredPromise<void>(context.signal);
      const probe = useSecretKmsProbe(async (request, call) => {
        if (call === 2) {
          prepared.resolve();
        }
        await prepared.promise;
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
          encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
        };
      });
      const results = await Promise.all(
        [first, second].map((selected) => {
          return accept(
            vnc().update({
              headers,
              params: { connectionId: created.id },
              body: {
                expectedGeneration: created.generation,
                transport: binding(provider, selected.id),
                credential: {
                  create: {
                    ...body.credential.create,
                    name: `Login ${selected.id}`,
                  },
                },
              },
            }),
            [200, 409],
          );
        }),
      );
      expect(
        results
          .map((r) => {
            return r.status;
          })
          .sort(),
      ).toStrictEqual([200, 409]);
      expect(probe.generateDataKeyCalls).toBe(2);
      const winner = await latest(created.id);
      expect(winner.generation).toBe(created.generation + 1);
      expect(
        (await accept(credentials().list({ headers }), [200])).body.credentials,
      ).toHaveLength(2);
      const refs = await configurations(provider);
      for (const selected of [first, second]) {
        expect(
          refs.find((c) => {
            return c.id === selected.id;
          }),
        ).toMatchObject({
          ...selected,
          vncHosts:
            winner.transport &&
            "configId" in winner.transport &&
            winner.transport.configId === selected.id
              ? [
                  {
                    id: created.id,
                    displayName: created.displayName,
                    roles: ["rfb"],
                  },
                ]
              : [],
        });
      }
    });

    it("includes a newly published dual-role Host admitted during configuration encryption", async () => {
      const selected = await config(provider);
      const body = hostBody(provider, selected.id);
      useSecretKmsProbe(async (request, call) => {
        if (call === 1) {
          await accept(vnc().create({ headers, body }), [201]);
        }
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
          encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
        };
      });
      const rotated = await rotate(provider, selected);
      expect(rotated.status).toBe(200);
      if (rotated.status !== 200) {
        throw new Error("Expected current mixed-reference rotation");
      }
      expect(rotated.body.vncHosts).toStrictEqual([
        { id: body.id, displayName: body.displayName, roles: ["rfb", "kdc"] },
      ]);
      await expect(latest(body.id)).resolves.toMatchObject({
        generation: 2,
        transport: body.transport,
        security: body.security,
      });
    });

    it("does not reveal or encrypt for another member's personal configuration", async () => {
      const owner = {
        orgId: `org_private_${randomUUID()}`,
        userId: `owner_${randomUUID()}`,
      };
      authenticate(owner);
      const selected = await config(provider);
      authenticate({
        orgId: owner.orgId,
        userId: `other_${randomUUID()}`,
      });
      const probe = useSecretKmsProbe();
      await accept(
        vnc().create({ headers, body: hostBody(provider, selected.id) }),
        [404],
      );
      expect(probe.generateDataKeyCalls).toBe(0);
      await expect(configurations(provider)).resolves.toStrictEqual([]);
      expect(
        (await accept(credentials().list({ headers }), [200])).body.credentials,
      ).toStrictEqual([]);
    });

    it("detaches both roles once after reviewed others-only deletion and requires an explicit rebind", async () => {
      const organization = {
        orgId: `org_detach_${randomUUID()}`,
        userId: `admin_${randomUUID()}`,
      };
      authenticate(organization);
      const selected = await config(provider, "organization");
      const member = {
        orgId: organization.orgId,
        userId: `member_${randomUUID()}`,
      };
      authenticate(member);
      const body = hostBody(provider, selected.id);
      const created = (await accept(vnc().create({ headers, body }), [201]))
        .body;
      authenticate(organization);
      const preview = await impact(provider, selected.id);
      expect(preview).toMatchObject({ ownHostCount: 0, otherHostCount: 1 });
      expect(
        preview.affectedOwners.map((owner) => {
          return owner.userId;
        }),
      ).toStrictEqual([member.userId]);
      expect(JSON.stringify(preview)).not.toContain(created.displayName);
      authenticate(member);
      await accept(
        vnc().update({
          headers,
          params: { connectionId: created.id },
          body: {
            expectedGeneration: created.generation,
            displayName: "Changed after review",
          },
        }),
        [200],
      );
      authenticate(organization);
      expect(
        (await deleteConfig(provider, selected, preview.impactSnapshot)).status,
      ).toBe(409);
      const currentPreview = await impact(provider, selected.id);
      expect(
        (await deleteConfig(provider, selected, currentPreview.impactSnapshot))
          .status,
      ).toBe(204);
      authenticate(member);
      const detached = await latest(created.id);
      expect(detached).toMatchObject({
        id: created.id,
        generation: created.generation + 2,
        transport: { type: provider, needsRebind: true },
        security: { kdc: { transport: { type: provider, needsRebind: true } } },
      });
      await accept(
        vnc().update({
          headers,
          params: { connectionId: created.id },
          body: {
            expectedGeneration: detached.generation,
            displayName: "Do not downgrade",
          },
        }),
        [400],
      );
      await expect(latest(created.id)).resolves.toStrictEqual(detached);
      const replacement = await config(provider);
      const rebound = (
        await accept(
          vnc().update({
            headers,
            params: { connectionId: created.id },
            body: {
              expectedGeneration: detached.generation,
              transport: binding(provider, replacement.id),
              security: security(provider, replacement.id),
            },
          }),
          [200],
        )
      ).body;
      expect(rebound).toMatchObject({
        id: created.id,
        credentialId:
          "credentialId" in created ? created.credentialId : undefined,
        generation: detached.generation + 1,
        transport: binding(provider, replacement.id),
        security: security(provider, replacement.id),
      });
    });
  },
);

test.each([
  ["cloudflare_access", "tailscale"],
  ["tailscale", "cloudflare_access"],
] as const)(
  "keeps %s RFB and %s KDC authority independent",
  async (rfbProvider, kdcProvider) => {
    const rfb = await config(rfbProvider),
      kdc = await config(kdcProvider);
    const body = hostBody(rfbProvider, rfb.id, kdcProvider, kdc.id);
    const created = (await accept(vnc().create({ headers, body }), [201])).body;
    expect(created).toMatchObject({
      transport: body.transport,
      security: body.security,
    });
    expect(
      (await configurations(rfbProvider)).find((c) => {
        return c.id === rfb.id;
      })?.vncHosts,
    ).toStrictEqual([
      { id: created.id, displayName: created.displayName, roles: ["rfb"] },
    ]);
    expect(
      (await configurations(kdcProvider)).find((c) => {
        return c.id === kdc.id;
      })?.vncHosts,
    ).toStrictEqual([
      { id: created.id, displayName: created.displayName, roles: ["kdc"] },
    ]);
  },
);

const rawProfiles = [
  {
    security: { type: "apple_vnc_password" },
    authentication: { method: "vnc_password", password: "secret" },
  },
  {
    security: { type: "apple_dh" },
    authentication: {
      method: "apple_dh_username_password",
      username: "operator",
      password: "synthetic",
    },
  },
  {
    security: { type: "apple_srp" },
    authentication: {
      method: "apple_srp_username_password",
      username: "operator",
      password: "synthetic",
    },
  },
  {
    security: { type: "apple_rsa_srp" },
    authentication: {
      method: "apple_rsa_srp_username_password",
      username: "operator",
      password: "synthetic",
    },
  },
  ...(["rsa_aes_ra2ne", "rsa_aes_ra2ne_256"] as const).flatMap((type) => {
    return [
      {
        security: { type, serverKeySha256: "ab".repeat(32) },
        authentication: {
          method: "rsa_aes_password" as const,
          password: "synthetic",
        },
      },
      {
        security: { type, serverKeySha256: "ab".repeat(32) },
        authentication: {
          method: "rsa_aes_username_password" as const,
          username: "operator",
          password: "synthetic",
        },
      },
    ];
  }),
] as const;
describe.each(providers)("%s raw-profile owner validation", (provider) => {
  it.each(rawProfiles)(
    "admits $security.type only with its protective route",
    async ({ security, authentication }) => {
      const selected = await config(provider);
      const originTls = {
        serverName: "origin.example.com",
        trust: { mode: "system" as const },
      };
      const body = {
        id: randomUUID(),
        displayName: "Protected desktop",
        ...endpoint(provider, "rfb"),
        security,
        credential: { create: { name: "Protected login", authentication } },
        transport: {
          ...binding(provider, selected.id),
          ...(provider === "cloudflare_access" ? { originTls } : {}),
        },
      };
      if (provider === "cloudflare_access") {
        await accept(
          vnc().create({
            headers,
            body: { ...body, transport: binding(provider, selected.id) },
          }),
          [400],
        );
      }
      const created = (await accept(vnc().create({ headers, body }), [201]))
        .body;
      expect(created).toMatchObject({
        id: body.id,
        transport: body.transport,
        security,
      });
      await accept(
        vnc().update({
          headers,
          params: { connectionId: created.id },
          body: {
            expectedGeneration: created.generation,
            host: "public.example.com",
            transport: { type: "direct" },
          },
        }),
        [400],
      );
      await expect(latest(created.id)).resolves.toStrictEqual(created);
    },
  );
});

test("validates independent origin and inner certificate identities and preserves a failed trust edit", async () => {
  const selected = await config("cloudflare_access");
  const caBundle = rootCertificates[0];
  if (!caBundle) {
    throw new Error("Expected a public CA fixture");
  }
  const transport = {
    type: "cloudflare_access" as const,
    configId: selected.id,
    originTls: {
      serverName: "origin.example.com",
      trust: { mode: "custom_ca" as const, caBundle },
    },
  };
  const security: VncSecurity = {
    type: "x509_none",
    serverName: "inner.example.com",
    trust: { mode: "system" },
  };
  const body = {
    id: randomUUID(),
    displayName: "Independent identities",
    ...endpoint("cloudflare_access", "rfb"),
    transport,
    security,
    credential: { type: "none" as const },
  };
  const created = (await accept(vnc().create({ headers, body }), [201])).body;
  expect(created).toMatchObject({
    host: "rfb-gateway.example.com",
    security: { serverName: "inner.example.com" },
    transport: { originTls: { serverName: "origin.example.com" } },
  });
  await accept(
    vnc().update({
      headers,
      params: { connectionId: created.id },
      body: {
        expectedGeneration: created.generation,
        transport: {
          ...transport,
          originTls: {
            ...transport.originTls,
            trust: { mode: "custom_ca", caBundle: "invalid CA" },
          },
        },
      },
    }),
    [400],
  );
  await expect(latest(created.id)).resolves.toStrictEqual(created);
  const peer = await config("tailscale");
  const changed = (
    await accept(
      vnc().update({
        headers,
        params: { connectionId: created.id },
        body: {
          expectedGeneration: created.generation,
          host: "desktop.tailnet",
          port: 5900,
          transport: binding("tailscale", peer.id),
        },
      }),
      [200],
    )
  ).body;
  expect(changed).toMatchObject({
    security: created.security,
    transport: binding("tailscale", peer.id),
  });
  expect(changed.transport).not.toHaveProperty("originTls");
  expect(
    (await configurations("cloudflare_access")).find((c) => {
      return c.id === selected.id;
    })?.vncHosts,
  ).toStrictEqual([]);
});
