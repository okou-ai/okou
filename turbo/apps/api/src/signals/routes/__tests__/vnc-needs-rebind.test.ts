import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { runnerVncContract } from "@okouai/api-contracts/contracts/runner-vnc";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { createStore } from "ccstate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { runnerVncRoutes } from "../runner-vnc";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncAccessRoutes } from "../vnc-access";
import { createClaimedVncApi } from "./helpers/claimed-vnc-runtime";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncRunnerHeaders,
  vncSecurity,
  vncSessionHeaders,
  vncProfiles,
} from "./helpers/vnc-runtime";

const context = testContext();

describe("VNC depends on current SSH binding", () => {
  const claimed = createClaimedVncApi(context);
  const query = { view: "scoped" as const };
  const configs = () => {
    return setupApp({ context, routes: cloudflareAccessRoutes })(
      cloudflareAccessContract,
    );
  };
  const sshHosts = () => {
    return setupApp({ context, routes: sshConnectionsRoutes })(
      sshConnectionsContract,
    );
  };
  const inventory = () => {
    return setupApp({ context, routes: vncAccessRoutes })(vncHostsContract);
  };
  const runner = () => {
    return setupApp({ context, routes: runnerVncRoutes })(runnerVncContract);
  };

  beforeEach(initializeVncRuntimeTest);
  afterEach(claimed.cleanup);

  it("keeps an SSH provider dependency separate from native VNC role authority", async () => {
    mockNow(new Date("2026-10-14T00:00:30.000Z"));
    const api = createVncRuntimeApi(context);
    const f = await claimed.fixture();
    const config = await accept(
      configs().create({
        headers: vncSessionHeaders,
        query,
        body: {
          id: randomUUID(),
          name: "SSH carrier gateway",
          credentials: {
            clientId: "synthetic-carrier-client",
            clientSecret: "synthetic-carrier-secret",
          },
        },
      }),
      [201],
    );
    const ssh = await accept(
      sshHosts().create({
        headers: vncSessionHeaders,
        body: {
          id: randomUUID(),
          displayName: "SSH carrier",
          host: "gateway.example.com",
          port: 443,
          credential: {
            create: {
              name: "SSH login",
              username: "deploy",
              authentication: {
                method: "password",
                password: "synthetic-password",
              },
            },
          },
          transport: { type: "cloudflare_access", configId: config.body.id },
        },
      }),
      [201],
    );
    const connection = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: {
          ...vncConnectionBody(),
          host: "127.0.0.1",
          transport: { type: "ssh", connectionId: ssh.body.id },
        },
      }),
      [201],
    );
    await api.enableDefault(f, "ssh", ssh.body.id);
    await api.enableDefault(f, "vnc", connection.body.id);
    const target = { ...f, connectionId: connection.body.id };
    const expectedTransport = {
      type: "ssh" as const,
      connectionId: ssh.body.id,
      generation: ssh.body.generation,
    };
    const nativeTransport = {
      type: "cloudflare_access" as const,
      configId: config.body.id,
      generation: config.body.generation,
    };
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(target, {
        supportedProfiles: [
          {
            authMethod: "vnc_password",
            securityType: "x509_vnc",
            transportType: "cloudflare_access",
          },
          {
            authMethod: "vnc_password",
            securityType: "x509_vnc",
            transportType: "tailscale",
          },
        ],
      }),
    ).resolves.toStrictEqual({ outcome: "unsupported_profile" });
    expect(kms.decryptCalls).toBe(0);
    const checked = await accept(
      runner().check({
        headers: vncRunnerHeaders,
        params: { runId: f.runId },
        body: {
          connectionId: connection.body.id,
          runnerIdentity: f.runnerIdentity,
          expectedGeneration: connection.body.generation,
          expectedTransport: nativeTransport,
        },
      }),
      [200],
    );
    expect(checked.body).toStrictEqual({ outcome: "configuration_changed" });
    for (const failureReason of [
      "access_rejected",
      "access_tls_failure",
      "access_protocol_failure",
      "origin_tls_failure",
      "tailscale_unavailable",
    ] as const) {
      const observed = await accept(
        runner().observe({
          headers: vncRunnerHeaders,
          params: { runId: f.runId },
          body: {
            connectionId: connection.body.id,
            runnerIdentity: f.runnerIdentity,
            expectedGeneration: connection.body.generation,
            expectedCreatedAt: connection.body.createdAt,
            expectedTransport,
            observedAt: "2026-10-14T00:00:00.000Z",
            failureReason,
          },
        }),
        [200],
      );
      expect(observed.body).toStrictEqual({ outcome: "ignored" });
    }
    const mistakenKdc = await accept(
      runner().observe({
        headers: vncRunnerHeaders,
        params: { runId: f.runId },
        body: {
          connectionId: connection.body.id,
          runnerIdentity: f.runnerIdentity,
          expectedGeneration: connection.body.generation,
          expectedCreatedAt: connection.body.createdAt,
          expectedTransport,
          expectedKdcTransport: nativeTransport,
          observedAt: "2026-10-14T00:00:00.000Z",
          failureReason: "network_failure",
        },
      }),
      [200],
    );
    expect(mistakenKdc.body).toStrictEqual({ outcome: "ignored" });
    expect(
      (
        await accept(
          api.connections().observations({ headers: vncSessionHeaders }),
          [200],
        )
      ).body.observations,
    ).toStrictEqual([]);
    const resolved = await api.resolve(target);
    expect(resolved).toMatchObject({
      outcome: "resolved_transport",
      transport: expectedTransport,
    });
    expect(JSON.stringify(resolved)).not.toContain("synthetic-carrier");
  });

  it.each(["convert", "delete"] as const)(
    "%s blocks VNC over a retained SSH host and allows explicit SSH recovery",
    async (transition) => {
      const api = createVncRuntimeApi(context);
      const f = await claimed.fixture();
      const store = createStore();
      const admin = {
        orgId: f.orgId,
        userId: `admin_${randomUUID()}`,
        membershipId: `orgmem_${randomUUID()}`,
      };
      await store.set(
        seedOrgMembership$,
        { ...admin, role: "admin" },
        context.signal,
      );
      api.authenticate(admin);
      const config = await accept(
        configs().create({
          headers: vncSessionHeaders,
          query,
          body: {
            id: randomUUID(),
            scope: "organization",
            name: "Shared gateway",
            credentials: {
              clientId: "synthetic-client-id",
              clientSecret: "synthetic-client-secret",
            },
          },
        }),
        [201],
      );
      api.authenticate(f);
      const ssh = await accept(
        sshHosts().create({
          headers: vncSessionHeaders,
          body: {
            id: randomUUID(),
            displayName: "Protected gateway",
            host: "gateway.example.com",
            port: 443,
            credential: {
              create: {
                name: "SSH login",
                username: "deploy",
                authentication: {
                  method: "password",
                  password: "synthetic-password",
                },
              },
            },
            transport: { type: "cloudflare_access", configId: config.body.id },
          },
        }),
        [201],
      );
      const tunneled = await accept(
        api.connections().create({
          headers: vncSessionHeaders,
          body: {
            ...vncConnectionBody(),
            displayName: "Tunneled desktop",
            host: "127.0.0.1",
            security: { ...vncSecurity, serverName: "desktop.internal" },
            transport: { type: "ssh", connectionId: ssh.body.id },
          },
        }),
        [201],
      );
      const target = { ...f, connectionId: tunneled.body.id };
      await api.enableDefault(f, "ssh", ssh.body.id);
      await api.enableDefault(f, "vnc", tunneled.body.id);
      const guestHeaders = claimed.agentHeaders(f);
      const listHosts = async () => {
        return (
          await accept(inventory().list({ headers: guestHeaders }), [200])
        ).body.hosts;
      };
      const listIds = async () => {
        return (await listHosts())
          .map(({ id }) => {
            return id;
          })
          .sort();
      };
      const expectedTransport = {
        type: "ssh" as const,
        connectionId: ssh.body.id,
        generation: ssh.body.generation,
      };
      const check = async (transport = expectedTransport) => {
        return (
          await accept(
            runner().check({
              headers: vncRunnerHeaders,
              params: { runId: f.runId },
              body: {
                connectionId: target.connectionId,
                runnerIdentity: f.runnerIdentity,
                expectedGeneration: tunneled.body.generation,
                expectedTransport: transport,
              },
            }),
            [200],
          )
        ).body;
      };

      await expect(listIds()).resolves.toStrictEqual(
        [f.connectionId, target.connectionId].sort(),
      );
      await expect(listHosts()).resolves.toContainEqual(
        expect.objectContaining({
          id: target.connectionId,
          availability: { status: "ready" },
        }),
      );
      await expect(
        api.resolve(target, { supportedProfiles: [...vncProfiles] }),
      ).resolves.toMatchObject({ outcome: "resolved_transport" });
      await expect(check()).resolves.toStrictEqual({ outcome: "valid" });

      api.authenticate(admin);
      if (transition === "convert") {
        const preview = await accept(
          configs().impactPreview({
            headers: vncSessionHeaders,
            params: { configId: config.body.id },
            query: { operation: "convert" },
          }),
          [200],
        );
        await accept(
          configs().convertToPersonal({
            headers: vncSessionHeaders,
            params: { configId: config.body.id },
            body: {
              expectedRevision: preview.body.expectedRevision,
              impactSnapshot: preview.body.impactSnapshot,
            },
          }),
          [200],
        );
      } else {
        const preview = await accept(
          configs().impactPreview({
            headers: vncSessionHeaders,
            params: { configId: config.body.id },
            query: { operation: "delete" },
          }),
          [200],
        );
        await accept(
          configs().delete({
            headers: vncSessionHeaders,
            query,
            params: { configId: config.body.id },
            body: {
              expectedRevision: preview.body.expectedRevision,
              impactSnapshot: preview.body.impactSnapshot,
            },
          }),
          [204],
        );
      }
      api.authenticate(f);
      expect(
        (await accept(sshHosts().list({ headers: vncSessionHeaders }), [200]))
          .body.connections,
      ).toContainEqual(
        expect.objectContaining({
          id: ssh.body.id,
          generation: ssh.body.generation + 1,
          transport: { type: "cloudflare_access", needsRebind: true },
        }),
      );
      expect(
        (
          await accept(
            api.connections().list({ headers: vncSessionHeaders }),
            [200],
          )
        ).body.connections,
      ).toContainEqual(expect.objectContaining({ id: target.connectionId }));
      const kms = useSecretKmsProbe();
      await expect(listIds()).resolves.toStrictEqual(
        [f.connectionId, target.connectionId].sort(),
      );
      await expect(listHosts()).resolves.toContainEqual(
        expect.objectContaining({
          id: target.connectionId,
          availability: { status: "blocked", reason: "needs_rebind" },
        }),
      );
      await expect(listHosts()).resolves.toContainEqual(
        expect.objectContaining({
          id: f.connectionId,
          availability: { status: "ready" },
        }),
      );
      await expect(
        api.resolve(target, { supportedProfiles: [...vncProfiles] }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      await expect(check()).resolves.toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(0);
      await expect(api.resolve(f)).resolves.toMatchObject({
        outcome: "resolved_transport",
      });

      await accept(
        sshHosts().update({
          headers: vncSessionHeaders,
          params: { connectionId: ssh.body.id },
          body: {
            expectedGeneration: ssh.body.generation + 1,
            transport: { type: "direct" },
            port: 22,
          },
        }),
        [200],
      );
      await expect(listIds()).resolves.toStrictEqual(
        [f.connectionId, target.connectionId].sort(),
      );
      await expect(listHosts()).resolves.toContainEqual(
        expect.objectContaining({
          id: target.connectionId,
          availability: { status: "ready" },
        }),
      );
      await expect(
        api.resolve(target, { supportedProfiles: [...vncProfiles] }),
      ).resolves.toMatchObject({
        outcome: "resolved_transport",
        transport: {
          type: "ssh",
          connectionId: ssh.body.id,
          generation: ssh.body.generation + 2,
        },
      });
      await expect(
        check({ ...expectedTransport, generation: ssh.body.generation + 2 }),
      ).resolves.toStrictEqual({ outcome: "valid" });
    },
  );
});
