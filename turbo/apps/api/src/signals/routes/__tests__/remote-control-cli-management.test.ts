import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  cliAuthDeviceContract,
  cliAuthApproveContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { cliAuthRoutes } from "../cli-auth";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { vncConnectionsRoutes } from "../vnc-connections";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const runnerSecret = "b".repeat(64);

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

function owner(overrides: Partial<Owner> = {}): Owner {
  return {
    userId: `user_cli_management_${randomUUID()}`,
    orgId: `org_cli_management_${randomUUID()}`,
    ...overrides,
  };
}

function authenticate(actor: Owner) {
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `om_${actor.orgId}_${actor.userId}`,
          role: "org:member",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    },
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role: "org:member",
        organization: { id: actor.orgId },
        publicUserData: { userId: actor.userId },
      },
    ],
  });
}

async function management(actor: Owner, enabled: boolean) {
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgRole: "org:member" },
    { [FeatureSwitchKey.RemoteControlCliManagement]: enabled },
  );
  authenticate(actor);
}

async function personalHeaders(actor: Owner) {
  authenticate(actor);
  const app = setupApp({ context, routes: cliAuthRoutes });
  const device = await accept(
    app(cliAuthDeviceContract).create({ body: {} }),
    [200],
  );
  await accept(
    app(cliAuthApproveContract).approve({
      headers: sessionHeaders,
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  const issued = await accept(
    app(cliAuthTokenContract).exchange({
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  return { authorization: `Bearer ${issued.body.access_token}` };
}

const claimed = createClaimedSshRuntimeApi(context, {
  runnerHeaders: { authorization: `Bearer vm0_official_${runnerSecret}` },
  authenticate,
});

afterEach(async () => {
  await claimed.cleanup();
});

function credentials() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
}

function credentialBody() {
  return {
    id: randomUUID(),
    name: "  CLI operations  ",
    username: "  deploy  ",
    authentication: {
      method: "password" as const,
      password: "cli-create-password-canary",
    },
  };
}

function expectSafeMetadata(body: unknown) {
  const serialized = JSON.stringify(body);
  for (const secret of [
    "cli-create-password-canary",
    "cli-rotated-password-canary",
    "authentication",
    "encryptedPassword",
    "encryptedPrivateKey",
    "encryptedDataKey",
    "vm0secret:",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

const managementSurfaces = ["ssh", "vnc", "cloudflare", "tailscale"] as const;

async function listManagement(
  surface: (typeof managementSurfaces)[number],
  headers: { authorization: string },
) {
  switch (surface) {
    case "ssh": {
      return await credentials().list({ headers });
    }
    case "vnc": {
      return await setupApp({ context, routes: vncConnectionsRoutes })(
        vncConnectionsContract,
      ).list({ headers });
    }
    case "cloudflare": {
      return await setupApp({ context, routes: cloudflareAccessRoutes })(
        cloudflareAccessContract,
      ).list({ headers });
    }
    case "tailscale": {
      return await setupApp({ context, routes: tailscaleRoutes })(
        tailscaleContract,
      ).list({ headers });
    }
  }
}

function expectManagementUnavailable(body: unknown) {
  expect(body).toStrictEqual({
    error: {
      code: "FORBIDDEN",
      message: "Remote control CLI management is not available",
    },
  });
}

describe("remote control CLI management authorization", () => {
  it("allows a claimed Run to manage saved SSH credentials and bindings without exposing secrets", async () => {
    useSecretKmsProbe();
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const actor = owner();
    await management(actor, true);
    const run = await claimed.runtime(actor);
    const headers = run.guestHeaders;
    const created = await accept(
      credentials().create({ headers, body: credentialBody() }),
      [201],
    );
    expect(created.body).toMatchObject({
      name: "CLI operations",
      authMethod: "password",
      revision: 1,
    });
    const host = await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "CLI host",
          host: "ssh.example.com",
          credential: { id: created.body.id },
        },
      }),
      [201],
    );
    expect(host.body.credentialId).toBe(created.body.id);
    const updated = await accept(
      credentials().update({
        headers,
        params: { credentialId: created.body.id },
        body: {
          expectedRevision: created.body.revision,
          name: "Rotated CLI operations",
          authentication: {
            method: "password",
            password: "cli-rotated-password-canary",
          },
        },
      }),
      [200],
    );
    expect(updated.body).toMatchObject({ id: created.body.id, revision: 2 });
    const listed = await accept(credentials().list({ headers }), [200]);
    expect(listed.body.credentials).toStrictEqual([updated.body]);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    for (const response of [created, host, updated, listed]) {
      expectSafeMetadata(response.body);
    }
    await management(actor, false);
    const denied = await accept(credentials().list({ headers }), [403]);
    expectManagementUnavailable(denied.body);
  });

  it("accepts a device-approved PAT only while management is enabled, without bypassing VNC availability", async () => {
    useSecretKmsProbe();
    const actor = owner();
    await management(actor, false);
    const headers = await personalHeaders(actor);
    for (const surface of managementSurfaces) {
      const denied = await accept(listManagement(surface, headers), [403]);
      expectManagementUnavailable(denied.body);
    }
    await management(actor, true);
    const created = await accept(
      credentials().create({ headers, body: credentialBody() }),
      [201],
    );
    expectSafeMetadata(created.body);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([created.body]);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgRole: "org:member" },
      { [FeatureSwitchKey.VncAccess]: false },
    );
    authenticate(actor);
    await accept(listManagement("vnc", headers), [404]);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgRole: "org:member" },
      { [FeatureSwitchKey.VncAccess]: true },
    );
    authenticate(actor);
    expect(
      (await accept(listManagement("vnc", headers), [200])).body,
    ).toStrictEqual({ connections: [] });
    await management(actor, false);
    await accept(
      credentials().update({
        headers,
        params: { credentialId: created.body.id },
        body: {
          expectedRevision: created.body.revision,
          name: "Denied PAT update",
        },
      }),
      [403],
    );
    const sessionListed = await accept(
      credentials().list({ headers: sessionHeaders }),
      [200],
    );
    expect(sessionListed.body.credentials).toStrictEqual([created.body]);
  });

  it("does not encrypt denied PAT writes and preserves the original session interface", async () => {
    const kms = useSecretKmsProbe();
    const actor = owner();
    await management(actor, false);
    const headers = await personalHeaders(actor);
    await accept(
      credentials().create({ headers, body: credentialBody() }),
      [403],
    );
    expect(kms.generateDataKeyCalls).toBe(0);
    const created = await accept(
      credentials().create({ headers: sessionHeaders, body: credentialBody() }),
      [201],
    );
    expectSafeMetadata(created.body);
    const updated = await accept(
      credentials().update({
        headers: sessionHeaders,
        params: { credentialId: created.body.id },
        body: {
          expectedRevision: created.body.revision,
          name: "Session update",
        },
      }),
      [200],
    );
    expect(updated.body.name).toBe("Session update");
  });

  it.each(["same-tenant", "other-tenant", "same-user-other-tenant"] as const)(
    "preserves credential ownership for %s PAT callers",
    async (scope) => {
      useSecretKmsProbe();
      const first = owner();
      await management(first, true);
      const ownHeaders = await personalHeaders(first);
      const created = await accept(
        credentials().create({ headers: ownHeaders, body: credentialBody() }),
        [201],
      );
      const other = owner(
        scope === "same-tenant"
          ? { orgId: first.orgId }
          : scope === "same-user-other-tenant"
            ? { userId: first.userId }
            : {},
      );
      await management(other, true);
      const headers = await personalHeaders(other);
      expect(
        (await accept(credentials().list({ headers }), [200])).body.credentials,
      ).toStrictEqual([]);
      const forbidden = await accept(
        credentials().update({
          headers,
          params: { credentialId: created.body.id },
          body: {
            expectedRevision: created.body.revision,
            name: "Other owner",
          },
        }),
        [404],
      );
      const missing = await accept(
        credentials().update({
          headers,
          params: { credentialId: randomUUID() },
          body: {
            expectedRevision: created.body.revision,
            name: "Other owner",
          },
        }),
        [404],
      );
      expect(forbidden.body).toStrictEqual(missing.body);
      await accept(
        credentials().delete({
          headers,
          params: { credentialId: created.body.id },
          body: { expectedRevision: created.body.revision },
        }),
        [404],
      );
      authenticate(first);
      expect(
        (await accept(credentials().list({ headers: ownHeaders }), [200])).body
          .credentials,
      ).toStrictEqual([created.body]);
    },
  );

  it("rejects the real Runner claim's sandbox token on every management surface", async () => {
    useSecretKmsProbe();
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const actor = owner();
    await management(actor, true);
    const run = await claimed.runtime(actor);
    const headers = { authorization: `Bearer ${run.sandboxToken}` };
    for (const surface of managementSurfaces) {
      const denied = await accept(listManagement(surface, headers), [401, 403]);
      expect(denied.body).toMatchObject({
        error: { code: expect.any(String) },
      });
    }
  });
});
