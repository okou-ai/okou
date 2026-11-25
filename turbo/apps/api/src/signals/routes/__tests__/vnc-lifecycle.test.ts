import { randomUUID } from "node:crypto";

import {
  type VncConnectionResponse,
  vncConnectionsContract,
} from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { vncConnectionsRoutes } from "../vnc-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

const connections = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
};
const credentials = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
};
const clerkWebhooks = () => {
  return setupApp({ context, routes: webhooksClerkRoutes })(
    webhookClerkContract,
  );
};

const key = (owner: Owner) => {
  return `${owner.orgId}:${owner.userId}`;
};

function argField(args: unknown, field: string): unknown {
  return typeof args === "object" && args !== null && field in args
    ? (args as Record<string, unknown>)[field]
    : undefined;
}

/** Clerk's membership directory, edited the way an admin console would. */
function clerkDirectory(...initial: Owner[]) {
  const members = new Map<string, Owner>(
    initial.map((owner) => {
      return [key(owner), owner];
    }),
  );
  const toClerk = (owner: Owner) => {
    return {
      id: `orgmem_${owner.orgId}_${owner.userId}`,
      role: "org:admin",
      organization: { id: owner.orgId },
      publicUserData: { userId: owner.userId },
    };
  };
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const orgId = argField(args, "organizationId");
      const userIds = argField(args, "userId");
      const data = [...members.values()]
        .filter((owner) => {
          return (
            owner.orgId === orgId &&
            (!Array.isArray(userIds) || userIds.includes(owner.userId))
          );
        })
        .map(toClerk);
      return Promise.resolve({ data, totalCount: data.length });
    },
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const userId = argField(args, "userId");
      const data = [...members.values()]
        .filter((owner) => {
          return owner.userId === userId;
        })
        .map(toClerk);
      return Promise.resolve({ data, totalCount: data.length });
    },
  );
  return {
    remove(owner: Owner) {
      members.delete(key(owner));
    },
    add(owner: Owner) {
      members.set(key(owner), owner);
    },
  };
}

function signIn(owner: Owner) {
  createRouteMocks(context).clerk.session(owner.userId, owner.orgId);
}

async function deliverClerkEvent(type: string, data: Record<string, unknown>) {
  context.mocks.clerk.verifyWebhook.mockResolvedValue({ type, data });
  const delivered = await accept(
    clerkWebhooks().post({
      body: JSON.stringify({ type, data }),
      extraHeaders: {
        "svix-id": `msg_${randomUUID()}`,
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,signed-by-clerk",
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  return delivered;
}

const passwordAuthentication = (password: string) => {
  return { method: "vnc_password" as const, password };
};
const x509Vnc = {
  type: "x509_vnc" as const,
  trust: { mode: "system" as const },
};

async function createSavedCredential(owner: Owner, name: string) {
  signIn(owner);
  const created = await accept(
    credentials().create({
      headers,
      body: {
        id: randomUUID(),
        name,
        authentication: passwordAuthentication("s3cret"),
      },
    }),
    [201],
  );
  return created.body;
}

async function createHost(
  owner: Owner,
  body: Parameters<ReturnType<typeof connections>["create"]>[0]["body"],
) {
  signIn(owner);
  const created = await accept(connections().create({ headers, body }), [201]);
  return created.body;
}

function inlineHost(owner: Owner, displayName: string) {
  return createHost(owner, {
    id: randomUUID(),
    displayName,
    host: `${displayName.toLowerCase().replaceAll(" ", "-")}.example.com`,
    credential: {
      create: {
        name: `${displayName} password`,
        authentication: passwordAuthentication("s3cret"),
      },
    },
    security: x509Vnc,
  });
}

function savedCredentialHost(
  owner: Owner,
  displayName: string,
  credentialId: string,
) {
  return createHost(owner, {
    id: randomUUID(),
    displayName,
    host: `${displayName.toLowerCase().replaceAll(" ", "-")}.example.com`,
    credential: { id: credentialId },
    security: x509Vnc,
  });
}

function credentialIdOf(host: VncConnectionResponse): string {
  if (!("credentialId" in host)) {
    throw new Error("Expected a credential-bound VNC host");
  }
  return host.credentialId;
}

async function listHosts(owner: Owner) {
  signIn(owner);
  return await connections().list({ headers });
}

async function listCredentials(owner: Owner) {
  signIn(owner);
  return await credentials().list({ headers });
}

async function expectOnlyOwnHost(owner: Owner, host: VncConnectionResponse) {
  const hosts = await accept(listHosts(owner), [200]);
  expect(
    hosts.body.connections.map(({ id }) => {
      return id;
    }),
  ).toStrictEqual([host.id]);
  const saved = await accept(listCredentials(owner), [200]);
  expect(
    saved.body.credentials.map(({ id }) => {
      return id;
    }),
  ).toStrictEqual([credentialIdOf(host)]);
}

function workspace() {
  const orgId = `org_${randomUUID()}`;
  const otherOrgId = `org_${randomUUID()}`;
  const member: Owner = { orgId, userId: `user_${randomUUID()}` };
  const peer: Owner = { orgId, userId: `user_${randomUUID()}` };
  const elsewhere: Owner = { orgId: otherOrgId, userId: member.userId };
  return { member, peer, elsewhere };
}

describe("VNC lifecycle", () => {
  it("vnc-lifecycle-007 deleting a user keeps a surviving colleague's VNC host and credential", async () => {
    useSecretKmsProbe();
    const { member, peer: survivor, elsewhere } = workspace();
    const directory = clerkDirectory(member, survivor, elsewhere);
    await inlineHost(member, "Member desk");
    await createSavedCredential(member, "Unused password");
    await inlineHost(elsewhere, "Elsewhere desk");
    const survivorHost = await inlineHost(survivor, "Survivor desk");
    directory.remove(member);
    directory.remove(elsewhere);

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await deliverClerkEvent("user.deleted", {
        id: member.userId,
        deleted: true,
        object: "user",
      });
      expect(response.body).toBe("OK");
    }

    await expectOnlyOwnHost(survivor, survivorHost);
  });

  it("vnc-lifecycle-008 deleting an organization keeps the same user's VNC host in another organization", async () => {
    useSecretKmsProbe();
    const { member, peer, elsewhere: survivor } = workspace();
    const directory = clerkDirectory(member, peer, survivor);
    await inlineHost(member, "Member desk");
    await createSavedCredential(member, "Unused password");
    await inlineHost(peer, "Peer desk");
    const survivorHost = await inlineHost(survivor, "Survivor desk");
    directory.remove(member);
    directory.remove(peer);

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await deliverClerkEvent("organization.deleted", {
        id: member.orgId,
        deleted: true,
        object: "organization",
      });
      expect(response.body).toBe("OK");
    }

    await expectOnlyOwnHost(survivor, survivorHost);
  });

  it("vnc-lifecycle-009 a removed member is refused until restored, then finds the same VNC configuration", async () => {
    useSecretKmsProbe();
    const { member } = workspace();
    const directory = clerkDirectory(member);
    const host = await inlineHost(member, "Member desk");
    const credentialId = credentialIdOf(host);
    directory.remove(member);

    await accept(listHosts(member), [404]);
    await accept(listCredentials(member), [404]);
    signIn(member);
    await accept(
      connections().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "While away",
          host: host.host,
          credential: { id: credentialId },
          security: x509Vnc,
        },
      }),
      [404],
    );

    directory.add(member);
    const hosts = await accept(listHosts(member), [200]);
    expect(hosts.body.connections).toStrictEqual([host]);
    const saved = await accept(listCredentials(member), [200]);
    expect(
      saved.body.credentials.map(({ id }) => {
        return id;
      }),
    ).toStrictEqual([credentialId]);

    const again = await createHost(member, {
      id: randomUUID(),
      displayName: "Member desk again",
      host: host.host,
      port: host.port,
      credential: {
        create: {
          name: "Second password",
          authentication: passwordAuthentication("another"),
        },
      },
      security: x509Vnc,
    });
    expect({ host: again.host, port: again.port }).toStrictEqual({
      host: host.host,
      port: host.port,
    });

    const [original] = saved.body.credentials;
    signIn(member);
    const renamed = await accept(
      credentials().update({
        headers,
        params: { credentialId },
        body: { expectedRevision: original!.revision, name: "Rejoined" },
      }),
      [200],
    );
    expect(renamed.body.name).toBe("Rejoined");

    await savedCredentialHost(member, "Shared desk", credentialId);
  });
});
