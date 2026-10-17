import { describe, expect, it } from "vitest";
import { runnerVncContract } from "./runner-vnc";
import {
  createVncConnectionRequestSchema,
  updateVncConnectionRequestSchema,
  vncConnectionResponseSchema,
} from "./vnc-connections";
import { cloudflareAccessContract } from "./cloudflare-access";
import { tailscaleContract } from "./tailscale";

const id = "10000000-0000-4000-8000-000000000001";
const request = {
  connectionId: id,
  runnerIdentity: { runnerId: id, heartbeatGeneration: 1 },
};
const routes = ["direct", "ssh", "cloudflare_access", "tailscale"] as const;
const profile = {
  authMethod: "none",
  securityType: "x509_none",
  transportType: "direct",
};
const originTls = {
  serverName: "origin.example.com",
  trust: { mode: "custom_ca", caBundle: "origin-roots" },
};
const host = {
  id,
  displayName: "Desktop",
  host: "gateway.example.com",
  port: 443,
  credentialId: id,
  credentialName: "Login",
  generation: 1,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  security: {
    type: "x509_vnc",
    trust: { mode: "system" },
    serverName: "rfb.example.com",
  },
};

describe("prepared native VNC contracts", () => {
  it("accepts the complete 100-tuple native declaration within the bounded request", () => {
    const profiles: object[] = [];
    for (const transportType of routes) {
      for (const [authMethod, securityType] of [
        ["none", "x509_none"],
        ["vnc_password", "x509_vnc"],
        ["username_password", "x509_plain"],
        ["qemu_scram_sha256", "qemu_x509_sasl"],
        ["client_certificate", "x509_none"],
        ["client_certificate_vnc_password", "x509_vnc"],
      ])
        profiles.push({ authMethod, securityType, transportType });
      for (const authMethod of [
        "rsa_aes_password",
        "rsa_aes_username_password",
      ]) {
        for (const securityType of [
          "rsa_aes_ra2",
          "rsa_aes_ra2_256",
          ...(transportType === "direct"
            ? []
            : ["rsa_aes_ra2ne", "rsa_aes_ra2ne_256"]),
        ]) {
          profiles.push({ authMethod, securityType, transportType });
        }
      }
      if (transportType !== "direct") {
        for (const [authMethod, securityType] of [
          ["vnc_password", "apple_vnc_password"],
          ["apple_dh_username_password", "apple_dh"],
          ["apple_srp_username_password", "apple_srp"],
          ["apple_rsa_srp_username_password", "apple_rsa_srp"],
        ])
          profiles.push({ authMethod, securityType, transportType });
      }
      profiles.push({
        authMethod: "qemu_kerberos_ticket",
        securityType: "qemu_x509_gssapi",
        transportType,
        kdcTransportType: "none",
      });
      for (const authMethod of [
        "qemu_kerberos_keytab",
        "qemu_kerberos_password",
      ]) {
        for (const kdcTransportType of routes)
          profiles.push({
            authMethod,
            securityType: "qemu_x509_gssapi",
            transportType,
            kdcTransportType,
          });
      }
    }
    expect(profiles).toHaveLength(100);
    expect(
      runnerVncContract.resolve.body.parse({
        ...request,
        supportedProfiles: profiles,
      }).supportedProfiles,
    ).toHaveLength(100);
    // Duplicate declarations remain harmless to exact capability matching and bounded by 128.
    expect(
      runnerVncContract.resolve.body.safeParse({
        ...request,
        supportedProfiles: Array.from({ length: 128 }, () => {
          return profile;
        }),
      }).success,
    ).toBe(true);
    expect(
      runnerVncContract.resolve.body.safeParse({
        ...request,
        supportedProfiles: Array.from({ length: 129 }, () => {
          return profile;
        }),
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      authMethod: "vnc_password",
      securityType: "apple_vnc_password",
      transportType: "direct",
    },
    {
      authMethod: "rsa_aes_password",
      securityType: "rsa_aes_ra2ne",
      transportType: "direct",
    },
    {
      ...profile,
      transportType: "cloudflare_access",
      securityType: "x509_vnc",
    },
    {
      authMethod: "qemu_kerberos_password",
      securityType: "qemu_x509_gssapi",
      transportType: "tailscale",
      kdcTransportType: "none",
    },
    { ...profile, kdcTransportType: "tailscale" },
  ])("rejects unsupported exact tuple %j", (unsupported) => {
    expect(
      runnerVncContract.resolve.body.safeParse({
        ...request,
        supportedProfiles: [unsupported],
      }).success,
    ).toBe(false);
  });

  it("preserves native, detached and independent origin/inner trust metadata", () => {
    for (const transport of [
      { type: "cloudflare_access", configId: id, originTls },
      { type: "cloudflare_access", needsRebind: true, originTls },
      { type: "tailscale", configId: id },
      { type: "tailscale", needsRebind: true },
    ]) {
      const response = { ...host, transport };
      expect(vncConnectionResponseSchema.parse(response)).toEqual(response);
    }
    expect(vncConnectionResponseSchema.parse(host)).toEqual(host);
  });

  it("accepts bound native RFB/KDC input while rejecting misplaced origin TLS and detached bindings", () => {
    const create = {
      id,
      displayName: host.displayName,
      host: host.host,
      port: host.port,
      credential: { id },
      security: host.security,
    };
    for (const type of ["cloudflare_access", "tailscale"]) {
      const transport = { type, configId: id };
      expect(
        createVncConnectionRequestSchema.safeParse({ ...create, transport })
          .success,
      ).toBe(true);
      expect(
        updateVncConnectionRequestSchema.safeParse({
          expectedGeneration: 1,
          transport,
        }).success,
      ).toBe(true);
      const security = {
        type: "qemu_x509_gssapi",
        trust: { mode: "system" },
        service: { realm: "EXAMPLE.COM", components: ["vnc", "desktop"] },
        kdc: { host: "kdc.example.com", port: 88, transport },
      };
      expect(
        createVncConnectionRequestSchema.safeParse({ ...create, security })
          .success,
      ).toBe(true);
      expect(
        updateVncConnectionRequestSchema.safeParse({
          expectedGeneration: 1,
          security,
        }).success,
      ).toBe(true);
    }
    expect(
      createVncConnectionRequestSchema.safeParse({
        ...create,
        transport: { type: "cloudflare_access", configId: id, originTls },
      }).success,
    ).toBe(true);
    for (const type of ["cloudflare_access", "tailscale"]) {
      expect(
        createVncConnectionRequestSchema.safeParse({
          ...create,
          transport: { type, needsRebind: true },
        }).success,
      ).toBe(false);
    }
    expect(
      createVncConnectionRequestSchema.safeParse({ ...create, originTls })
        .success,
    ).toBe(false);
    expect(
      createVncConnectionRequestSchema.safeParse({
        ...create,
        transport: { type: "direct", originTls },
      }).success,
    ).toBe(false);
  });

  it("limits provider secrets to resolution and keeps KDC protection independent", () => {
    const transport = {
      type: "cloudflare_access",
      configId: id,
      generation: 3,
    };
    const privateTransport = {
      ...transport,
      credentials: {
        clientId: "private-client",
        clientSecret: "private-secret",
      },
      originTls,
    };
    const resolved = {
      outcome: "resolved_transport",
      host: host.host,
      port: host.port,
      generation: 1,
      serverName: "rfb.example.com",
      transport: privateTransport,
      authentication: { method: "none" },
      security: { type: "x509_none", trust: { mode: "system" } },
    };
    expect(runnerVncContract.resolve.responses[200].parse(resolved)).toEqual(
      resolved,
    );
    const kdc = {
      host: "kdc.example.com",
      port: 443,
      transport: { ...transport, credentials: privateTransport.credentials },
      ticketLifetimeSeconds: 1200,
      renewableLifetimeSeconds: 7200,
    };
    const kerberos = {
      ...resolved,
      outcome: "resolved_kerberos",
      credentialRevision: 2,
      authentication: {
        method: "qemu_kerberos_password",
        initiator: { realm: "EXAMPLE.COM", components: ["operator"] },
        password: "private-password",
      },
      security: {
        type: "qemu_x509_gssapi",
        trust: { mode: "system" },
        service: { realm: "EXAMPLE.COM", components: ["vnc", "desktop"] },
        kdc,
      },
    };
    expect(runnerVncContract.resolve.responses[200].parse(kerberos)).toEqual(
      kerberos,
    );
    expect(
      runnerVncContract.resolve.responses[200].safeParse({
        ...kerberos,
        security: {
          ...kerberos.security,
          kdc: { ...kdc, transport: privateTransport },
        },
      }).success,
    ).toBe(false);
    expect(
      vncConnectionResponseSchema.safeParse({
        ...host,
        transport: privateTransport,
      }).success,
    ).toBe(false);
    const check = {
      ...request,
      expectedGeneration: 1,
      expectedTransport: transport,
      expectedKdcTransport: { type: "tailscale", configId: id, generation: 5 },
    };
    expect(runnerVncContract.check.body.parse(check)).toEqual(check);
    expect(
      runnerVncContract.check.body.safeParse({
        ...check,
        expectedTransport: privateTransport,
      }).success,
    ).toBe(false);
    expect(
      runnerVncContract.check.body.safeParse({
        ...check,
        expectedKdcTransport: { ...transport, originTls },
      }).success,
    ).toBe(false);
  });

  it("reads omitted, empty and mixed role-aware provider references without accepting duplicate roles", () => {
    for (const contract of [cloudflareAccessContract, tailscaleContract]) {
      const config = {
        id,
        name: "Network",
        scope: "personal",
        revision: 1,
        generation: 1,
        sshHosts: [{ id, displayName: "SSH" }],
        createdAt: host.createdAt,
        updatedAt: host.updatedAt,
        ...(contract === tailscaleContract ? { tags: ["tag:okou"] } : {}),
      };
      for (const references of [
        {},
        { vncHosts: [] },
        {
          vncHosts: [
            { id, displayName: "Desktop and KDC", roles: ["rfb", "kdc"] },
          ],
        },
      ]) {
        expect(
          contract.list.responses[200].parse({
            configs: [{ ...config, ...references }],
          }),
        ).toEqual({ configs: [{ ...config, ...references }] });
      }
      expect(
        contract.list.responses[200].safeParse({
          configs: [
            {
              ...config,
              vncHosts: [{ id, displayName: "Invalid", roles: ["rfb", "rfb"] }],
            },
          ],
        }).success,
      ).toBe(false);
    }
  });
});
