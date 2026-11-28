import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import {
  type VncConnectionResponse,
  type createVncConnectionRequestSchema,
  type updateVncConnectionRequestSchema,
  vncConnectionsContract,
} from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import type { input as zInput } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { tailscaleRoutes } from "../tailscale";
import { vncConnectionsRoutes } from "../vnc-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { certificateChain } from "./helpers/vnc-synthetic-client";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

/** Request bodies as clients send them (server defaults still optional). */
type CreateVncConnectionRequest = zInput<
  typeof createVncConnectionRequestSchema
>;
type UpdateVncConnectionRequest = zInput<
  typeof updateVncConnectionRequestSchema
>;
type Provider = "cloudflare_access" | "tailscale";
type Scope = "personal" | "organization";

interface ProviderSecrets {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface ConfigRef {
  readonly id: string;
  readonly revision: number;
  readonly generation: number;
}

interface Route {
  readonly type: Provider;
  readonly configId: string;
}

async function workspace() {
  const orgId = `org_${randomUUID()}`;
  const store = createStore();
  const join = async (role: Actor["role"]): Promise<Actor> => {
    const actor = { userId: `user_${randomUUID()}`, orgId, role };
    await store.set(
      seedOrgMembership$,
      {
        orgId,
        userId: actor.userId,
        role: role === "org:admin" ? "admin" : "member",
      },
      context.signal,
    );
    return actor;
  };
  const admin = await join("org:admin");
  const member = await join("org:member");
  const other = await join("org:member");
  return { admin, member, other };
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
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
const accessConfigs = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const tailscaleConfigs = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};

function providerSecrets(): ProviderSecrets {
  return {
    clientId: `client-${randomUUID()}`,
    clientSecret: `secret-${randomUUID()}`,
  };
}

async function createConfig(
  actor: Actor,
  provider: Provider,
  scope: Scope = "personal",
  secrets: ProviderSecrets = providerSecrets(),
): Promise<ConfigRef> {
  signIn(actor);
  const id = randomUUID();
  const name = `${provider} ${id.slice(0, 8)}`;
  if (provider === "cloudflare_access") {
    const created = await accept(
      accessConfigs().create({
        headers,
        query: { view: "scoped" },
        body: { id, name, scope, credentials: secrets },
      }),
      [201],
    );
    return created.body;
  }
  const created = await accept(
    tailscaleConfigs().create({
      headers,
      body: { id, name, scope, credentials: secrets, tags: ["tag:okou"] },
    }),
    [201],
  );
  return created.body;
}

async function rotateConfig(
  actor: Actor,
  provider: Provider,
  config: ConfigRef,
  secrets: ProviderSecrets,
): Promise<ConfigRef> {
  signIn(actor);
  const request = {
    headers,
    params: { configId: config.id },
    body: { expectedRevision: config.revision, credentials: secrets },
  };
  if (provider === "cloudflare_access") {
    const updated = await accept(
      accessConfigs().update({ ...request, query: { view: "scoped" } }),
      [200],
    );
    return updated.body;
  }
  const updated = await accept(tailscaleConfigs().update(request), [200]);
  return updated.body;
}

async function deleteConfig(
  actor: Actor,
  provider: Provider,
  configId: string,
  body: { readonly expectedRevision: number; readonly impactSnapshot?: string },
): Promise<number> {
  signIn(actor);
  const request = { headers, params: { configId }, body };
  if (provider === "cloudflare_access") {
    const deleted = await accept(
      accessConfigs().delete({ ...request, query: { view: "scoped" } }),
      [204, 409],
    );
    return deleted.status;
  }
  const deleted = await accept(tailscaleConfigs().delete(request), [204, 409]);
  return deleted.status;
}

async function previewDeletion(
  actor: Actor,
  provider: Provider,
  configId: string,
) {
  signIn(actor);
  const request = {
    headers,
    params: { configId },
    query: { operation: "delete" as const },
  };
  if (provider === "cloudflare_access") {
    const preview = await accept(accessConfigs().impactPreview(request), [200]);
    return preview.body;
  }
  const preview = await accept(
    tailscaleConfigs().impactPreview(request),
    [200],
  );
  return preview.body;
}

async function listConfigs(actor: Actor, provider: Provider) {
  signIn(actor);
  if (provider === "cloudflare_access") {
    const listed = await accept(
      accessConfigs().list({ headers, query: { view: "scoped" } }),
      [200],
    );
    return listed.body.configs;
  }
  const listed = await accept(tailscaleConfigs().list({ headers }), [200]);
  return listed.body.configs;
}

async function vncHostsOf(actor: Actor, provider: Provider, configId: string) {
  const configs = await listConfigs(actor, provider);
  return configs.find((config) => {
    return config.id === configId;
  })?.vncHosts;
}

async function listHosts(actor: Actor) {
  signIn(actor);
  const listed = await accept(hosts().list({ headers }), [200]);
  return listed.body.connections;
}

async function hostOf(actor: Actor, hostId: string) {
  const listed = await listHosts(actor);
  return listed.find((host) => {
    return host.id === hostId;
  });
}

async function listCredentials(actor: Actor) {
  signIn(actor);
  const listed = await accept(credentials().list({ headers }), [200]);
  return listed.body.credentials;
}

async function createHost(actor: Actor, body: CreateVncConnectionRequest) {
  signIn(actor);
  const created = await accept(hosts().create({ headers, body }), [201]);
  return created.body;
}

async function updateHost(
  actor: Actor,
  host: VncConnectionResponse,
  body: Omit<UpdateVncConnectionRequest, "expectedGeneration">,
) {
  signIn(actor);
  return await accept(
    hosts().update({
      headers,
      params: { connectionId: host.id },
      body: { ...body, expectedGeneration: host.generation },
    }),
    [200, 400, 404],
  );
}

function credentialIdOf(host: VncConnectionResponse | undefined): string {
  if (!host || !("credentialId" in host)) {
    throw new Error("Expected a credential-bound VNC host");
  }
  return host.credentialId;
}

const kerberosPassword = "kerberos-private-password";
const providerRoute = {
  cloudflare_access: {
    rfb: { host: "rfb-gateway.example.com", port: 443 },
    kdc: { host: "kdc-gateway.example.com", port: 443 },
  },
  tailscale: {
    rfb: { host: "desktop.tailnet", port: 5900 },
    kdc: { host: "kdc.tailnet", port: 88 },
  },
} as const;

function kerberosCredential() {
  return {
    create: {
      name: "Kerberos password",
      authentication: {
        method: "qemu_kerberos_password" as const,
        initiator: { realm: "EXAMPLE.COM", components: ["alice"] },
        password: kerberosPassword,
      },
    },
  };
}

function kerberosSecurity(kdc: Route) {
  const route = providerRoute[kdc.type].kdc;
  return {
    type: "qemu_x509_gssapi" as const,
    trust: { mode: "system" as const },
    serverName: "desktop.example.com",
    service: {
      realm: "EXAMPLE.COM",
      components: ["vnc", "desktop.example.com"],
    },
    kdc: { host: route.host, port: route.port, transport: kdc },
  };
}

function kerberosHost(rfb: Route, kdc: Route): CreateVncConnectionRequest {
  const route = providerRoute[rfb.type].rfb;
  return {
    id: randomUUID(),
    displayName: "Kerberos desktop",
    host: route.host,
    port: route.port,
    credential: kerberosCredential(),
    security: kerberosSecurity(kdc),
    transport: rfb,
  };
}

function hostReference(host: VncConnectionResponse, roles: string[]) {
  return [{ id: host.id, displayName: host.displayName, roles }];
}

async function rotatesDualRoleHostOnce(provider: Provider) {
  const kms = useSecretKmsProbe();
  const { admin } = await workspace();
  const secrets = providerSecrets();
  const config = await createConfig(admin, provider, "personal", secrets);
  const route = { type: provider, configId: config.id.toUpperCase() };
  const body = kerberosHost(route, route);

  const created = await createHost(admin, body);
  const dataKeys = kms.generateDataKeyCalls;
  signIn(admin);
  await accept(hosts().create({ headers, body }), [204]);
  expect(kms.generateDataKeyCalls).toBe(dataKeys);
  await expect(vncHostsOf(admin, provider, config.id)).resolves.toStrictEqual(
    hostReference(created, ["rfb", "kdc"]),
  );

  const renamed = await updateHost(admin, created, {
    displayName: "Renamed desktop",
  });
  if (renamed.status !== 200) {
    throw new Error(`Expected the rename to succeed, got ${renamed.status}`);
  }
  expect(renamed.body.generation).toBe(created.generation + 1);
  expect(renamed.body.transport).toStrictEqual(created.transport);
  expect(renamed.body.security).toStrictEqual(created.security);

  const rotatedSecrets = providerSecrets();
  const rotated = await rotateConfig(admin, provider, config, rotatedSecrets);
  await expect(hostOf(admin, created.id)).resolves.toMatchObject({
    generation: renamed.body.generation + 1,
    displayName: "Renamed desktop",
  });
  const listed = await listConfigs(admin, provider);
  expect(listed).toStrictEqual([
    expect.objectContaining({
      id: config.id,
      revision: config.revision + 1,
      generation: config.generation + 1,
      vncHosts: hostReference(renamed.body, ["rfb", "kdc"]),
    }),
  ]);
  expect(rotated.revision).toBe(config.revision + 1);
  const disclosed = JSON.stringify(listed);
  for (const hidden of [
    secrets.clientId,
    secrets.clientSecret,
    rotatedSecrets.clientId,
    rotatedSecrets.clientSecret,
    kerberosPassword,
  ]) {
    expect(disclosed).not.toContain(hidden);
  }

  return await deleteConfig(admin, provider, config.id, {
    expectedRevision: rotated.revision,
  });
}

async function rebindsOnlyKdc(provider: Provider) {
  useSecretKmsProbe();
  const { admin } = await workspace();
  const rfbConfig = await createConfig(admin, provider);
  const kdcConfig = await createConfig(admin, provider);
  const replacement = await createConfig(admin, provider);
  const rfb = { type: provider, configId: rfbConfig.id };
  const created = await createHost(
    admin,
    kerberosHost(rfb, { type: provider, configId: kdcConfig.id }),
  );
  const hostsBefore = await listHosts(admin);
  const credentialsBefore = await listCredentials(admin);

  const unknown = await updateHost(admin, created, {
    transport: { type: provider, configId: randomUUID() },
    credential: kerberosCredential(),
  });
  expect(unknown.status).toBe(404);
  await expect(listHosts(admin)).resolves.toStrictEqual(hostsBefore);
  await expect(listCredentials(admin)).resolves.toStrictEqual(
    credentialsBefore,
  );

  const replacementSecurity = kerberosSecurity({
    type: provider,
    configId: replacement.id,
  });
  const rebound = await updateHost(admin, created, {
    security: replacementSecurity,
  });
  if (rebound.status !== 200) {
    throw new Error(
      `Expected the KDC rebind to succeed, got ${rebound.status}`,
    );
  }
  expect(rebound.body.generation).toBe(created.generation + 1);
  expect(rebound.body.transport).toStrictEqual(rfb);
  expect(rebound.body.security).toMatchObject(replacementSecurity);

  const byId = new Map(
    (await listConfigs(admin, provider)).map((config) => {
      return [config.id, config.vncHosts];
    }),
  );
  expect(byId.get(rfbConfig.id)).toStrictEqual(hostReference(created, ["rfb"]));
  expect(byId.get(replacement.id)).toStrictEqual(
    hostReference(created, ["kdc"]),
  );
  return byId.get(kdcConfig.id);
}

async function dropsKdcThenRfbBinding(provider: Provider) {
  useSecretKmsProbe();
  const { admin } = await workspace();
  const config = await createConfig(admin, provider);
  const route = { type: provider, configId: config.id };
  const created = await createHost(admin, kerberosHost(route, route));

  const profile = await updateHost(admin, created, {
    security: {
      type: "x509_none",
      trust: { mode: "system" },
      serverName: "desktop.example.com",
    },
    credential: { type: "none" },
  });
  if (profile.status !== 200) {
    throw new Error(`Expected the profile change, got ${profile.status}`);
  }
  expect(profile.body.security).toStrictEqual({
    type: "x509_none",
    trust: { mode: "system" },
    serverName: "desktop.example.com",
  });
  expect(profile.body.transport).toStrictEqual(route);
  await expect(vncHostsOf(admin, provider, config.id)).resolves.toStrictEqual(
    hostReference(created, ["rfb"]),
  );

  const direct = await updateHost(admin, profile.body, {
    transport: { type: "direct" },
    host: "direct.example.com",
    port: 5900,
  });
  if (direct.status !== 200) {
    throw new Error(`Expected the direct switch, got ${direct.status}`);
  }
  expect("transport" in direct.body).toBeFalsy();
  await expect(vncHostsOf(admin, provider, config.id)).resolves.toStrictEqual(
    [],
  );
  const saved = await listCredentials(admin);
  expect(saved).toHaveLength(1);
  return saved[0]?.hosts;
}

async function hidesAnotherMembersConfig(provider: Provider) {
  const kms = useSecretKmsProbe();
  const { member, other } = await workspace();
  const config = await createConfig(member, provider);
  const route = { type: provider, configId: config.id };
  const dataKeys = kms.generateDataKeyCalls;

  signIn(other);
  await accept(
    hosts().create({ headers, body: kerberosHost(route, route) }),
    [404],
  );

  expect(kms.generateDataKeyCalls).toBe(dataKeys);
  await expect(listConfigs(other, provider)).resolves.toStrictEqual([]);
  return await listCredentials(other);
}

async function detachesAfterReviewedDeletion(provider: Provider) {
  useSecretKmsProbe();
  const { admin, member } = await workspace();
  const shared = await createConfig(admin, provider, "organization");
  const route = { type: provider, configId: shared.id };
  const created = await createHost(member, kerberosHost(route, route));

  const stale = await previewDeletion(admin, provider, shared.id);
  expect(stale).toMatchObject({ ownHostCount: 0, otherHostCount: 1 });
  expect(
    stale.affectedOwners.map((owner) => {
      return owner.userId;
    }),
  ).toStrictEqual([member.userId]);
  expect(JSON.stringify(stale)).not.toContain(created.displayName);

  const renamed = await updateHost(member, created, {
    displayName: "Member desktop",
  });
  expect(renamed.status).toBe(200);
  await expect(
    deleteConfig(admin, provider, shared.id, {
      expectedRevision: stale.expectedRevision,
      impactSnapshot: stale.impactSnapshot,
    }),
  ).resolves.toBe(409);
  const current = await previewDeletion(admin, provider, shared.id);
  await expect(
    deleteConfig(admin, provider, shared.id, {
      expectedRevision: current.expectedRevision,
      impactSnapshot: current.impactSnapshot,
    }),
  ).resolves.toBe(204);

  const detached = await hostOf(member, created.id);
  if (!detached) {
    throw new Error("Expected the member's host to remain listed");
  }
  expect(detached.generation).toBe(created.generation + 2);
  expect(detached.transport).toStrictEqual({
    type: provider,
    needsRebind: true,
  });
  expect(detached.security).toMatchObject({
    kdc: { transport: { type: provider, needsRebind: true } },
  });

  const blocked = await updateHost(member, detached, {
    displayName: "Blocked rename",
  });
  expect(blocked.status).toBe(400);
  await expect(hostOf(member, created.id)).resolves.toStrictEqual(detached);

  const replacement = await createConfig(member, provider);
  const rebind = { type: provider, configId: replacement.id };
  const rebound = await updateHost(member, detached, {
    transport: rebind,
    security: kerberosSecurity(rebind),
  });
  if (rebound.status !== 200) {
    throw new Error(`Expected the rebind to succeed, got ${rebound.status}`);
  }
  expect(credentialIdOf(rebound.body)).toBe(credentialIdOf(created));
  expect(rebound.body.transport).toStrictEqual(rebind);
  expect(rebound.body.security).toMatchObject(kerberosSecurity(rebind));
  return rebound.body.generation - detached.generation;
}

async function independentAuthority(rfbType: Provider, kdcType: Provider) {
  useSecretKmsProbe();
  const { admin } = await workspace();
  const rfbConfig = await createConfig(admin, rfbType);
  const kdcConfig = await createConfig(admin, kdcType);
  const body = kerberosHost(
    { type: rfbType, configId: rfbConfig.id },
    { type: kdcType, configId: kdcConfig.id },
  );

  const created = await createHost(admin, body);

  expect(created.transport).toStrictEqual(body.transport);
  expect(created.security).toMatchObject(body.security);
  await expect(vncHostsOf(admin, rfbType, rfbConfig.id)).resolves.toStrictEqual(
    hostReference(created, ["rfb"]),
  );
  const kdcHosts = await vncHostsOf(admin, kdcType, kdcConfig.id);
  expect(kdcHosts).toStrictEqual(hostReference(created, ["kdc"]));
  return kdcHosts?.map((host) => {
    return host.roles;
  });
}

describe("independent RFB and KDC authority", () => {
  it("vnc-native-publication-021 keeps cloudflare_access RFB and tailscale KDC authority independent", async () => {
    await expect(
      independentAuthority("cloudflare_access", "tailscale"),
    ).resolves.toStrictEqual([["kdc"]]);
  });

  it("vnc-native-publication-022 keeps tailscale RFB and cloudflare_access KDC authority independent", async () => {
    await expect(
      independentAuthority("tailscale", "cloudflare_access"),
    ).resolves.toStrictEqual([["kdc"]]);
  });
});

describe("cloudflare_access public native publication", () => {
  it("vnc-native-publication-001 creates both roles once and rotates a dual-role Cloudflare Access host exactly once", async () => {
    await expect(rotatesDualRoleHostOnce("cloudflare_access")).resolves.toBe(
      409,
    );
  });

  it("vnc-native-publication-002 keeps a failed Cloudflare Access edit unchanged and rebinds only the KDC", async () => {
    await expect(rebindsOnlyKdc("cloudflare_access")).resolves.toStrictEqual(
      [],
    );
  });

  it("vnc-native-publication-003 drops the Cloudflare Access KDC role on a profile change and the RFB role on a direct switch", async () => {
    await expect(
      dropsKdcThenRfbBinding("cloudflare_access"),
    ).resolves.toStrictEqual([]);
  });

  it("vnc-native-publication-009 does not let another member use a personal Cloudflare Access configuration", async () => {
    await expect(
      hidesAnotherMembersConfig("cloudflare_access"),
    ).resolves.toStrictEqual([]);
  });

  it("vnc-native-publication-010 detaches both Cloudflare Access roles after a reviewed deletion and requires an explicit rebind", async () => {
    await expect(
      detachesAfterReviewedDeletion("cloudflare_access"),
    ).resolves.toBe(1);
  });
});

describe("tailscale public native publication", () => {
  it("vnc-native-publication-011 creates both roles once and rotates a dual-role Tailscale host exactly once", async () => {
    await expect(rotatesDualRoleHostOnce("tailscale")).resolves.toBe(409);
  });

  it("vnc-native-publication-012 keeps a failed Tailscale edit unchanged and rebinds only the KDC", async () => {
    await expect(rebindsOnlyKdc("tailscale")).resolves.toStrictEqual([]);
  });

  it("vnc-native-publication-013 drops the Tailscale KDC role on a profile change and the RFB role on a direct switch", async () => {
    await expect(dropsKdcThenRfbBinding("tailscale")).resolves.toStrictEqual(
      [],
    );
  });

  it("vnc-native-publication-019 does not let another member use a personal Tailscale configuration", async () => {
    await expect(hidesAnotherMembersConfig("tailscale")).resolves.toStrictEqual(
      [],
    );
  });

  it("vnc-native-publication-020 detaches both Tailscale roles after a reviewed deletion and requires an explicit rebind", async () => {
    await expect(detachesAfterReviewedDeletion("tailscale")).resolves.toBe(1);
  });
});

type RawProfile = Pick<CreateVncConnectionRequest, "security"> & {
  readonly authentication: Extract<
    CreateVncConnectionRequest["credential"],
    { create: unknown }
  >["create"]["authentication"];
};

async function admitsOnlyProtectedRoute(
  provider: Provider,
  profile: RawProfile,
) {
  useSecretKmsProbe();
  const { admin } = await workspace();
  const config = await createConfig(admin, provider);
  const route = providerRoute[provider].rfb;
  const body = (transport: CreateVncConnectionRequest["transport"]) => {
    return {
      id: randomUUID(),
      displayName: "Mac desktop",
      host: route.host,
      port: route.port,
      credential: {
        create: { name: "Mac login", authentication: profile.authentication },
      },
      security: profile.security,
      transport,
    };
  };
  const plain = { type: provider, configId: config.id };
  if (provider === "cloudflare_access") {
    signIn(admin);
    await accept(hosts().create({ headers, body: body(plain) }), [400]);
  }
  const protectedRoute =
    provider === "cloudflare_access"
      ? {
          ...plain,
          originTls: {
            serverName: "origin.example.com",
            trust: { mode: "system" as const },
          },
        }
      : plain;

  const created = await createHost(admin, body(protectedRoute));
  expect(created.transport).toStrictEqual(protectedRoute);
  expect(created.security).toStrictEqual(profile.security);

  const direct = await updateHost(admin, created, {
    transport: { type: "direct" },
    host: "public.example.com",
  });
  await expect(hostOf(admin, created.id)).resolves.toStrictEqual(created);
  return direct.status;
}

const serverKeySha256 = "0f".repeat(32);

describe("cloudflare_access raw-profile owner validation", () => {
  it("vnc-native-publication-023 admits apple_vnc_password only with origin TLS", async () => {
    await expect(
      admitsOnlyProtectedRoute("cloudflare_access", {
        security: { type: "apple_vnc_password" },
        authentication: { method: "vnc_password", password: "s3cret" },
      }),
    ).resolves.toBe(400);
  });

  it("vnc-native-publication-024 admits apple_dh only with origin TLS", async () => {
    await expect(
      admitsOnlyProtectedRoute("cloudflare_access", {
        security: { type: "apple_dh" },
        authentication: {
          method: "apple_dh_username_password",
          username: "alice",
          password: "s3cret",
        },
      }),
    ).resolves.toBe(400);
  });

  it("vnc-native-publication-025 admits apple_srp only with origin TLS", async () => {
    await expect(
      admitsOnlyProtectedRoute("cloudflare_access", {
        security: { type: "apple_srp" },
        authentication: {
          method: "apple_srp_username_password",
          username: "alice",
          password: "s3cret",
        },
      }),
    ).resolves.toBe(400);
  });

  it("vnc-native-publication-026 admits apple_rsa_srp only with origin TLS", async () => {
    await expect(
      admitsOnlyProtectedRoute("cloudflare_access", {
        security: { type: "apple_rsa_srp" },
        authentication: {
          method: "apple_rsa_srp_username_password",
          username: "alice",
          password: "s3cret",
        },
      }),
    ).resolves.toBe(400);
  });

  it("vnc-native-publication-027 admits rsa_aes_ra2ne only with origin TLS", async () => {
    await expect(
      admitsOnlyProtectedRoute("cloudflare_access", {
        security: { type: "rsa_aes_ra2ne", serverKeySha256 },
        authentication: { method: "rsa_aes_password", password: "s3cret" },
      }),
    ).resolves.toBe(400);
  });

  it("vnc-native-publication-029 admits rsa_aes_ra2ne_256 only with origin TLS", async () => {
    await expect(
      admitsOnlyProtectedRoute("cloudflare_access", {
        security: { type: "rsa_aes_ra2ne_256", serverKeySha256 },
        authentication: { method: "rsa_aes_password", password: "s3cret" },
      }),
    ).resolves.toBe(400);
  });
});

describe("tailscale raw-profile owner validation", () => {
  it("vnc-native-publication-031 admits apple_vnc_password through Tailscale but not a direct switch", async () => {
    await expect(
      admitsOnlyProtectedRoute("tailscale", {
        security: { type: "apple_vnc_password" },
        authentication: { method: "vnc_password", password: "s3cret" },
      }),
    ).resolves.toBe(400);
  });
});

describe("origin and inner certificate identities", () => {
  it("vnc-native-publication-039 validates origin and inner identities independently and keeps a failed trust edit unchanged", async () => {
    const { admin } = await workspace();
    const access = await createConfig(admin, "cloudflare_access");
    const tailnet = await createConfig(admin, "tailscale");
    const innerSecurity = {
      type: "x509_none" as const,
      trust: { mode: "system" as const },
      serverName: "inner.example.com",
    };
    const created = await createHost(admin, {
      id: randomUUID(),
      displayName: "Gateway desktop",
      host: "rfb-gateway.example.com",
      port: 443,
      credential: { type: "none" },
      security: innerSecurity,
      transport: {
        type: "cloudflare_access",
        configId: access.id,
        originTls: {
          serverName: "origin.example.com",
          trust: { mode: "custom_ca", caBundle: certificateChain },
        },
      },
    });
    expect(created.host).toBe("rfb-gateway.example.com");
    expect(created.security).toStrictEqual(innerSecurity);
    expect(created.transport).toMatchObject({
      type: "cloudflare_access",
      configId: access.id,
      originTls: { serverName: "origin.example.com" },
    });

    const invalid = await updateHost(admin, created, {
      transport: {
        type: "cloudflare_access",
        configId: access.id,
        originTls: {
          serverName: "origin.example.com",
          trust: {
            mode: "custom_ca",
            caBundle:
              "-----BEGIN CERTIFICATE-----\nbm90LWEtY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n",
          },
        },
      },
    });
    expect(invalid.status).toBe(400);
    await expect(hostOf(admin, created.id)).resolves.toStrictEqual(created);

    const moved = await updateHost(admin, created, {
      transport: { type: "tailscale", configId: tailnet.id },
      host: "desktop.tailnet",
      port: 5900,
    });
    if (moved.status !== 200) {
      throw new Error(`Expected the Tailscale switch, got ${moved.status}`);
    }
    expect(moved.body.security).toStrictEqual(innerSecurity);
    expect(moved.body.transport).toStrictEqual({
      type: "tailscale",
      configId: tailnet.id,
    });
    await expect(
      vncHostsOf(admin, "cloudflare_access", access.id),
    ).resolves.toStrictEqual([]);
  });
});
