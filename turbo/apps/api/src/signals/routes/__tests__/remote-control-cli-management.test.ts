import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliAuthDeviceContract,
  cliAuthApproveContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cliAuthRoutes } from "../cli-auth";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncConnectionsRoutes } from "../vnc-connections";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
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

function connections() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
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
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

function vncConnections() {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
}

describe("remote control CLI management authorization", () => {
  it("allows a claimed Run to manage saved SSH credentials and bindings without exposing secrets", async () => {
    useSecretKmsProbe();
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const actor = owner();
    authenticate(actor);
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
      connections().create({
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
    expect(host.body).toMatchObject({ credentialId: created.body.id });
    const request = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    const omittedVersion = await request(
      `/api/ssh/connections/${host.body.id}`,
      {
        method: "DELETE",
        headers,
      },
    );
    expect(omittedVersion.status).toBe(400);
    expect(omittedVersion.body).toMatchObject({
      error: { code: "SSH_INVALID_INPUT" },
    });
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([host.body]);
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
    for (const response of [created, host, updated, listed]) {
      expectSafeMetadata(response.body);
    }
  });

  it("accepts a device-approved PAT for VNC configuration", async () => {
    useSecretKmsProbe();
    const actor = owner();
    const headers = await personalHeaders(actor);
    const created = await accept(
      credentials().create({ headers, body: credentialBody() }),
      [201],
    );
    expectSafeMetadata(created.body);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([created.body]);
    expect(
      (await accept(vncConnections().list({ headers }), [200])).body,
    ).toStrictEqual({ connections: [] });
    const sessionListed = await accept(
      credentials().list({ headers: sessionHeaders }),
      [200],
    );
    expect(sessionListed.body.credentials).toStrictEqual([created.body]);
  });

  it("requires a device-approved PAT to supply the reviewed SSH host generation", async () => {
    useSecretKmsProbe();
    const actor = owner();
    const headers = await personalHeaders(actor);
    const credential = await accept(
      credentials().create({ headers, body: credentialBody() }),
      [201],
    );
    const host = await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Reviewed PAT host",
          host: "ssh.example.com",
          credential: { id: credential.body.id },
        },
      }),
      [201],
    );
    const params = { connectionId: host.body.id };
    const request = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    const path = `/api/ssh/connections/${host.body.id}`;
    const omitted = await request(path, { method: "DELETE", headers });
    expect(omitted.status).toBe(400);
    expect(omitted.body).toMatchObject({
      error: { code: "SSH_INVALID_INPUT" },
    });
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([host.body]);

    await accept(
      connections().delete({
        headers,
        params,
        body: { expectedGeneration: host.body.generation },
      }),
      [204],
    );
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
  });

  it("keeps another organization member from accessing or modifying owned credentials", async () => {
    useSecretKmsProbe();
    const first = owner();
    const ownHeaders = await personalHeaders(first);
    const created = await accept(
      credentials().create({ headers: ownHeaders, body: credentialBody() }),
      [201],
    );
    const other = owner({ orgId: first.orgId });
    const headers = await personalHeaders(other);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    await accept(
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
  });
});
