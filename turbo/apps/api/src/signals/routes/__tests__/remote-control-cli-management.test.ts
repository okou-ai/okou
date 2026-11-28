import { randomUUID } from "node:crypto";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { cliAuthRoutes } from "../cli-auth";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createBddApi } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const clerkDirectory = createStore();
const clerkHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

async function issueDeviceToken(
  orgId: string,
  userId: string,
): Promise<string> {
  await clerkDirectory.set(
    seedOrgMembership$,
    { orgId, userId, role: "member" },
    context.signal,
  );
  const deviceApp = setupApp({ context, routes: cliAuthRoutes });
  const device = (
    await accept(deviceApp(cliAuthDeviceContract).create({ body: {} }), [200])
  ).body;
  createRouteMocks(context).clerk.session(userId, orgId, "org:member");
  await accept(
    deviceApp(cliAuthApproveContract).approve({
      headers: clerkHeaders,
      body: { device_code: device.device_code },
    }),
    [200],
  );
  const exchanged = await accept(
    deviceApp(cliAuthTokenContract).exchange({
      body: { device_code: device.device_code },
    }),
    [200],
  );
  return exchanged.body.access_token;
}

const credentials = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};

describe("remote control CLI management authorization", () => {
  beforeAll(() => {
    setupApp({ context, routes: [...cliAuthRoutes, ...sshConnectionsRoutes] });
  });

  it("remote-control-cli-management-004 keeps another organization member from accessing or modifying owned credentials", async () => {
    const orgId = `org_${randomUUID()}`;
    const ownerToken = await issueDeviceToken(orgId, `user_${randomUUID()}`);
    const otherToken = await issueDeviceToken(orgId, `user_${randomUUID()}`);
    const ownerHeaders = { authorization: `Bearer ${ownerToken}` };
    const otherHeaders = { authorization: `Bearer ${otherToken}` };

    const created = (
      await accept(
        credentials().create({
          headers: ownerHeaders,
          body: {
            id: randomUUID(),
            name: "Owner deploy login",
            username: "deploy",
            authentication: {
              method: "password",
              password: `pw-${randomUUID()}`,
            },
          },
        }),
        [201],
      )
    ).body;

    const otherList = await accept(
      credentials().list({ headers: otherHeaders }),
      [200],
    );
    expect(otherList.body.credentials).toStrictEqual([]);

    await accept(
      credentials().update({
        headers: otherHeaders,
        params: { credentialId: created.id },
        body: {
          expectedRevision: created.revision,
          name: "Tampered name",
        },
      }),
      [404],
    );
    await accept(
      credentials().delete({
        headers: otherHeaders,
        params: { credentialId: created.id },
        body: { expectedRevision: created.revision },
      }),
      [404],
    );

    const ownerList = await accept(
      credentials().list({ headers: ownerHeaders }),
      [200],
    );
    expect(ownerList.body.credentials).toStrictEqual([created]);
  });

  it(
    "remote-control-cli-management-001 allows a dispatched Run to manage saved SSH credentials and bindings without exposing secrets",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(actor);
        }),
      ]);

      const launched = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Manage saved SSH credentials from the CLI",
          model: null,
        });
      });
      const execution = await owner.executionInput(launched.runId);
      const okouToken = execution.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected OKOU_TOKEN in Run execution input");
      }
      const runHeaders = {
        authorization: `Bearer ${okouToken}`,
      };

      const sshApp = setupApp({ context, routes: sshConnectionsRoutes });
      const credentialsApi = sshApp(sshCredentialsContract);
      const connectionsApi = sshApp(sshConnectionsContract);
      const rawSshRequest = setupRawAppRequest({
        context,
        routes: sshConnectionsRoutes,
      });

      const initialPassword = `pw-init-${randomUUID()}`;
      const rotatedPassword = `pw-rot-${randomUUID()}`;

      const createdCredential = await accept(
        credentialsApi.create({
          headers: runHeaders,
          body: {
            id: randomUUID(),
            name: "  CLI operations  ",
            username: "deploy",
            authentication: {
              method: "password",
              password: initialPassword,
            },
          },
        }),
        [201],
      );
      expect(createdCredential.body).toMatchObject({
        name: "CLI operations",
        authMethod: "password",
        revision: 1,
      });

      const createdHost = await accept(
        connectionsApi.create({
          headers: runHeaders,
          body: {
            id: randomUUID(),
            displayName: "CLI managed bastion",
            host: "cli-bastion.example.com",
            credential: { id: createdCredential.body.id },
          },
        }),
        [201],
      );
      expect(createdHost.body).toMatchObject({
        credentialId: createdCredential.body.id,
      });

      const versionlessDelete = await rawSshRequest(
        `/api/ssh/connections/${createdHost.body.id}`,
        {
          method: "DELETE",
          headers: runHeaders,
        },
      );
      expect(versionlessDelete.status).toBe(400);
      expect(versionlessDelete.body).toMatchObject({
        error: { code: "SSH_INVALID_INPUT" },
      });

      const listedHosts = await accept(
        connectionsApi.list({ headers: runHeaders }),
        [200],
      );
      expect(listedHosts.body.connections).toStrictEqual([createdHost.body]);

      const rotatedCredential = await accept(
        credentialsApi.update({
          headers: runHeaders,
          params: { credentialId: createdCredential.body.id },
          body: {
            expectedRevision: createdCredential.body.revision,
            authentication: {
              method: "password",
              password: rotatedPassword,
            },
          },
        }),
        [200],
      );
      expect(rotatedCredential.body).toMatchObject({
        id: createdCredential.body.id,
        name: "CLI operations",
        authMethod: "password",
        revision: 2,
      });

      const listedCredentials = await accept(
        credentialsApi.list({ headers: runHeaders }),
        [200],
      );
      expect(listedCredentials.body.credentials).toStrictEqual([
        rotatedCredential.body,
      ]);

      const serialized = [
        JSON.stringify(createdCredential.body),
        JSON.stringify(createdHost.body),
        JSON.stringify(versionlessDelete.body),
        JSON.stringify(listedHosts.body),
        JSON.stringify(rotatedCredential.body),
        JSON.stringify(listedCredentials.body),
      ].join("\n");
      expect(serialized).not.toContain(initialPassword);
      expect(serialized).not.toContain(rotatedPassword);
    },
  );
});
