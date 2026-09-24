import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { runnerVncContract } from "@okouai/api-contracts/contracts/runner-vnc";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { runnerVncRoutes } from "../runner-vnc";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncAccessRoutes } from "../vnc-access";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncRunnerHeaders,
  vncSecurity,
  vncSessionHeaders,
  vncTransportProfiles,
} from "./helpers/vnc-runtime";

describe("VNC depends on current SSH binding", () => {
  const context = testContext();
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

  it.each(["convert", "delete"] as const)(
    "%s blocks VNC over a retained SSH host and allows explicit SSH recovery",
    async (transition) => {
      const api = createVncRuntimeApi(context);
      const f = await api.fixture();
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
      await api.grantSsh(f, true);
      const seconds = Math.floor(now() / 1000);
      const guestHeaders = {
        authorization: `Bearer ${signSandboxJwtForTests({
          scope: "okou",
          orgId: f.orgId,
          userId: f.userId,
          runId: f.runId,
          capabilities: ["vnc:read"],
          iat: seconds,
          exp: seconds + 3600,
        })}`,
      };
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
        api.resolve(target, { supportedProfiles: [...vncTransportProfiles] }),
      ).resolves.toMatchObject({ outcome: "resolved_transport" });
      await expect(check()).resolves.toStrictEqual({ outcome: "valid" });

      api.authenticate(admin);
      if (transition === "convert") {
        const preview = await accept(
          configs().conversionPreview({
            headers: vncSessionHeaders,
            params: { configId: config.body.id },
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
          configs().deletionPreview({
            headers: vncSessionHeaders,
            params: { configId: config.body.id },
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
        api.resolve(target, { supportedProfiles: [...vncTransportProfiles] }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      await expect(check()).resolves.toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(0);
      await expect(api.resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
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
        api.resolve(target, { supportedProfiles: [...vncTransportProfiles] }),
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
