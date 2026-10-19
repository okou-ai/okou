import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { tailscaleRoutes } from "../tailscale";
import { createClaimedVncApi } from "./helpers/claimed-vnc-runtime";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncSessionHeaders,
} from "./helpers/vnc-runtime";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const claimed = createClaimedVncApi(context);
const api = createVncRuntimeApi(context);
beforeEach(initializeVncRuntimeTest);
afterEach(async () => {
  await claimed.cleanup();
});
type Provider = "cloudflare_access" | "tailscale";
const combinations = [
  ["cloudflare_access", "cloudflare_access"],
  ["cloudflare_access", "tailscale"],
  ["tailscale", "cloudflare_access"],
  ["tailscale", "tailscale"],
] as const;
const headers = vncSessionHeaders;
const query = Object.freeze({ view: "scoped" as const });
const privateCredentials = Object.freeze({
  clientId: "native-private-client",
  clientSecret: "native-private-secret",
});
const access = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const tailscale = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};
async function config(provider: Provider) {
  const body = {
    id: randomUUID(),
    name: "Authorized native network",
    credentials: privateCredentials,
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
async function fixture(rfbProvider: Provider, kdcProvider: Provider) {
  const owner = await claimed.paidOwner();
  const rfb = await config(rfbProvider);
  const kdc = rfbProvider === kdcProvider ? rfb : await config(kdcProvider);
  const host = (
    await accept(
      api.connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "VNC-only native authority",
          host:
            rfbProvider === "cloudflare_access"
              ? "rfb-gateway.example.com"
              : "desktop.tailnet",
          port: rfbProvider === "cloudflare_access" ? 443 : 5900,
          transport:
            rfbProvider === "cloudflare_access"
              ? { type: "cloudflare_access", configId: rfb.id }
              : { type: "tailscale", configId: rfb.id },
          credential: {
            create: {
              name: "Native Kerberos credential",
              authentication: {
                method: "qemu_kerberos_password",
                initiator: { realm: "EXAMPLE.COM", components: ["operator"] },
                password: "private-kerberos-password",
              },
            },
          },
          security: {
            type: "qemu_x509_gssapi",
            serverName: "inner.example.com",
            trust: { mode: "system" },
            service: {
              realm: "EXAMPLE.COM",
              components: ["vnc", "inner.example.com"],
            },
            kdc: {
              host:
                kdcProvider === "cloudflare_access"
                  ? "kdc-gateway.example.com"
                  : "kdc.tailnet",
              port: kdcProvider === "cloudflare_access" ? 443 : 88,
              transport:
                kdcProvider === "cloudflare_access"
                  ? { type: "cloudflare_access", configId: kdc.id }
                  : { type: "tailscale", configId: kdc.id },
              ticketLifetimeSeconds: 1200,
              renewableLifetimeSeconds: 7200,
            },
          },
        },
      }),
      [201],
    )
  ).body;
  await api.enableDefault(owner, "vnc", host.id);
  const running = await claimed.runtime(owner);
  return {
    ...running,
    connectionId: host.id,
    host,
    rfb,
    kdc,
    supportedProfiles: [
      {
        authMethod: "qemu_kerberos_password" as const,
        securityType: "qemu_x509_gssapi" as const,
        transportType: rfbProvider,
        kdcTransportType: kdcProvider,
      },
    ],
  };
}

test.each(combinations)(
  "authorizes %s RFB/%s KDC through genuine owner publication and only a VNC chat grant",
  async (rfbProvider, kdcProvider) => {
    const f = await fixture(rfbProvider, kdcProvider);
    const probe = useSecretKmsProbe();
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    expect(probe.decryptCalls).toBe(0);
    const result = await api.resolve(f, {
      supportedProfiles: f.supportedProfiles,
    });
    expect(result).toMatchObject({
      outcome: "resolved_kerberos",
      serverName: "inner.example.com",
      transport: {
        type: rfbProvider,
        configId: f.rfb.id,
        generation: f.rfb.generation,
        credentials: privateCredentials,
      },
      authentication: {
        method: "qemu_kerberos_password",
        password: "private-kerberos-password",
      },
      security: {
        service: {
          realm: "EXAMPLE.COM",
          components: ["vnc", "inner.example.com"],
        },
        kdc: {
          transport: {
            type: kdcProvider,
            configId: f.kdc.id,
            generation: f.kdc.generation,
            credentials: privateCredentials,
          },
        },
      },
    });
    expect(probe.decryptCalls).toBeGreaterThan(0);
    const metadata = (await accept(api.connections().list({ headers }), [200]))
      .body;
    for (const secret of [
      ...Object.values(privateCredentials),
      "private-kerberos-password",
    ]) {
      expect(JSON.stringify(metadata)).not.toContain(secret);
    }
  },
);

test.each(combinations)(
  "rechecks final authority after secret work for %s RFB/%s KDC without releasing stale payloads",
  async (rfbProvider, kdcProvider) => {
    const f = await fixture(rfbProvider, kdcProvider);
    useSecretKmsProbe(undefined, async (_request, call) => {
      if (call === 1) {
        const params = { configId: f.kdc.id };
        const body = {
          expectedRevision: f.kdc.revision,
          credentials: { clientId: "replacement", clientSecret: "replacement" },
        };
        if (kdcProvider === "cloudflare_access") {
          await accept(
            access().update({ headers, query, params, body }),
            [200],
          );
        } else {
          await accept(tailscale().update({ headers, params, body }), [200]);
        }
      }
      return Buffer.from("0123456789abcdef0123456789abcdef");
    });
    // Resolve preserves its existing privacy-safe unavailable outcome when the
    // captured handoff loses authority; it never returns the stale private DTO.
    await expect(
      api.resolve(f, { supportedProfiles: f.supportedProfiles }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    useSecretKmsProbe();
    await expect(
      api.resolve(f, { supportedProfiles: f.supportedProfiles }),
    ).resolves.toMatchObject({
      outcome: "resolved_kerberos",
      generation: f.host.generation + 1,
    });
  },
);
