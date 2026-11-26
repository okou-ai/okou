import { randomUUID } from "node:crypto";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cliAuthRoutes } from "../cli-auth";
import { sshConnectionsRoutes } from "../ssh-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

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
});
