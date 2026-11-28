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
import { now } from "../../../lib/time";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

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
        "svix-timestamp": String(Math.floor(now() / 1000)),
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
const x509Vnc = Object.freeze({
  type: "x509_vnc" as const,
  trust: { mode: "system" as const },
});

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

function membershipEvent(owner: Owner) {
  return {
    id: `orgmem_${owner.orgId}_${owner.userId}`,
    object: "organization_membership",
    organization: { id: owner.orgId },
    public_user_data: { user_id: owner.userId },
  };
}

function credentialFreeHost(owner: Owner, displayName: string) {
  return createHost(owner, {
    id: randomUUID(),
    displayName,
    host: `${displayName.toLowerCase().replaceAll(" ", "-")}.example.com`,
    credential: { type: "none" },
    security: { type: "x509_none", trust: { mode: "system" } },
  });
}

interface FormerResources {
  readonly hosts: readonly VncConnectionResponse[];
  readonly credentials: readonly { id: string; revision: number }[];
}

/** A member plus a peer and the same user elsewhere, each with an inline-credential host. */
async function departureScenario() {
  useSecretKmsProbe();
  const people = workspace();
  const directory = clerkDirectory(
    people.member,
    people.peer,
    people.elsewhere,
  );
  const peerHost = await inlineHost(people.peer, "Peer desk");
  const elsewhereHost = await inlineHost(people.elsewhere, "Elsewhere desk");
  return { ...people, directory, peerHost, elsewhereHost };
}

type DepartureScenario = Awaited<ReturnType<typeof departureScenario>>;

/** Two hosts sharing a saved password, an unused saved password and a credential-free host. */
async function mixedResources({
  member,
}: DepartureScenario): Promise<FormerResources> {
  const shared = await createSavedCredential(member, "Shared password");
  const unused = await createSavedCredential(member, "Unused password");
  const first = await savedCredentialHost(member, "First desk", shared.id);
  const second = await savedCredentialHost(member, "Second desk", shared.id);
  const open = await credentialFreeHost(member, "Open desk");
  return { hosts: [first, second, open], credentials: [shared, unused] };
}

async function credentialFreeResources({
  member,
}: DepartureScenario): Promise<FormerResources> {
  const open = await credentialFreeHost(member, "Open desk");
  return { hosts: [open], credentials: [] };
}

/** Removes the member in Clerk and delivers the signed departure twice. */
async function depart({ member, directory }: DepartureScenario) {
  directory.remove(member);
  const deliveries: unknown[] = [];
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const response = await deliverClerkEvent(
      "organizationMembership.deleted",
      membershipEvent(member),
    );
    deliveries.push(response.body);
  }
  return deliveries;
}

async function rejoin({ member, directory }: DepartureScenario) {
  directory.add(member);
  const delivered = await deliverClerkEvent(
    "organizationMembership.created",
    membershipEvent(member),
  );
  return delivered.body;
}

async function ownResourceIds(owner: Owner) {
  const hosts = await accept(listHosts(owner), [200]);
  const saved = await accept(listCredentials(owner), [200]);
  return {
    hosts: hosts.body.connections.map(({ id }) => {
      return id;
    }),
    credentials: saved.body.credentials.map(({ id }) => {
      return id;
    }),
  };
}

async function departedListStatuses(member: Owner) {
  return [
    (await listHosts(member)).status,
    (await listCredentials(member)).status,
  ];
}

async function renameFormerStatuses(member: Owner, former: FormerResources) {
  signIn(member);
  const statuses: number[] = [];
  for (const host of former.hosts) {
    const renamed = await connections().update({
      headers,
      params: { connectionId: host.id },
      body: { expectedGeneration: host.generation, displayName: "Renamed" },
    });
    statuses.push(renamed.status);
  }
  for (const credential of former.credentials) {
    const renamed = await credentials().update({
      headers,
      params: { credentialId: credential.id },
      body: { expectedRevision: credential.revision, name: "Renamed" },
    });
    statuses.push(renamed.status);
  }
  return statuses;
}

async function survivorsAfterRejoin(scenario: DepartureScenario) {
  return {
    peer: await ownResourceIds(scenario.peer),
    elsewhere: await ownResourceIds(scenario.elsewhere),
  };
}

function survivingResources(scenario: DepartureScenario) {
  return {
    peer: {
      hosts: [scenario.peerHost.id],
      credentials: [credentialIdOf(scenario.peerHost)],
    },
    elsewhere: {
      hosts: [scenario.elsewhereHost.id],
      credentials: [credentialIdOf(scenario.elsewhereHost)],
    },
  };
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

  it("vnc-lifecycle-001 (1/4) accepts both departure deliveries and refuses the departed member's mixed resource lists", async () => {
    const scenario = await departureScenario();
    await mixedResources(scenario);

    const deliveries = await depart(scenario);

    expect({
      deliveries,
      departed: await departedListStatuses(scenario.member),
    }).toStrictEqual({ deliveries: ["OK", "OK"], departed: [404, 404] });
  });

  it("vnc-lifecycle-001 (2/4) leaves the rejoined member no host or saved credential to list", async () => {
    const scenario = await departureScenario();
    await mixedResources(scenario);
    await depart(scenario);

    const rejoined = await rejoin(scenario);

    expect({
      rejoined,
      resources: await ownResourceIds(scenario.member),
    }).toStrictEqual({
      rejoined: "OK",
      resources: { hosts: [], credentials: [] },
    });
  });

  it("vnc-lifecycle-001 (3/4) refuses renaming every former host and saved credential after rejoining", async () => {
    const scenario = await departureScenario();
    const former = await mixedResources(scenario);
    await depart(scenario);
    await rejoin(scenario);

    await expect(
      renameFormerStatuses(scenario.member, former),
    ).resolves.toStrictEqual([404, 404, 404, 404, 404]);
  });

  it("vnc-lifecycle-001 (4/4) keeps the peer's and the other workspace's own hosts", async () => {
    const scenario = await departureScenario();
    await mixedResources(scenario);
    await depart(scenario);
    await rejoin(scenario);

    await expect(survivorsAfterRejoin(scenario)).resolves.toStrictEqual(
      survivingResources(scenario),
    );
  });

  it("vnc-lifecycle-003 (1/3) accepts both departure deliveries and refuses the departed member's credential-free host lists", async () => {
    const scenario = await departureScenario();
    await credentialFreeResources(scenario);

    const deliveries = await depart(scenario);

    expect({
      deliveries,
      departed: await departedListStatuses(scenario.member),
    }).toStrictEqual({ deliveries: ["OK", "OK"], departed: [404, 404] });
  });

  it("vnc-lifecycle-003 (2/3) leaves the rejoined member no credential-free host to list or rename", async () => {
    const scenario = await departureScenario();
    const former = await credentialFreeResources(scenario);
    await depart(scenario);

    const rejoined = await rejoin(scenario);

    expect({
      rejoined,
      resources: await ownResourceIds(scenario.member),
      renames: await renameFormerStatuses(scenario.member, former),
    }).toStrictEqual({
      rejoined: "OK",
      resources: { hosts: [], credentials: [] },
      renames: [404],
    });
  });

  it("vnc-lifecycle-003 (3/3) keeps the peer's and the other workspace's own hosts", async () => {
    const scenario = await departureScenario();
    await credentialFreeResources(scenario);
    await depart(scenario);
    await rejoin(scenario);

    await expect(survivorsAfterRejoin(scenario)).resolves.toStrictEqual(
      survivingResources(scenario),
    );
  });
});
