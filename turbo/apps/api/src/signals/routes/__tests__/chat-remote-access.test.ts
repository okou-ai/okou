import { randomUUID } from "node:crypto";

import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncConnectionsRoutes } from "../vnc-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { inlineSshKey } from "./helpers/ssh-credential";
import { vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

const clerkDirectory = createStore();

/** A current Clerk organization member; remote access reads check membership. */
async function member(
  orgId = `org_${randomUUID()}`,
  userId = `user_${randomUUID()}`,
): Promise<Actor> {
  const actor = { userId, orgId };
  await clerkDirectory.set(
    seedOrgMembership$,
    { ...actor, role: "admin" },
    context.signal,
  );
  return actor;
}

function signIn(actor: Actor): void {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
}

function createClients() {
  return {
    access: setupApp({ context, routes: chatRemoteAccessRoutes })(
      chatRemoteAccessContract,
    ),
    ssh: setupApp({ context, routes: sshConnectionsRoutes })(
      sshConnectionsContract,
    ),
    threads: setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ),
  };
}

/** Each request authenticates as the last signed-in actor. */
function api() {
  return createClients();
}

function accessApi() {
  return api().access;
}

function sshApi() {
  return api().ssh;
}

/** Requests run as whichever actor signed in last. */
async function createThread(): Promise<string> {
  const thread = await accept(
    api().threads.create({ headers, body: { model: null } }),
    [201],
  );
  return thread.body.id;
}

/** Requests run as whichever actor signed in last. */
async function createSshHost(displayName: string, id: string = randomUUID()) {
  const created = await accept(
    sshApi().create({
      headers,
      body: {
        id,
        displayName,
        host: `host-${id.slice(0, 8)}.example.test`,
        credential: inlineSshKey("deploy", `key-${randomUUID()}`),
      },
    }),
    [201],
  );
  return created.body;
}

async function threadAccess(threadId: string) {
  return (
    await accept(
      accessApi().listThreadAccess({ headers, params: { threadId } }),
      [200],
    )
  ).body;
}

async function hostDefaults() {
  return (await accept(accessApi().listHostDefaults({ headers }), [200])).body;
}

async function setSshDefault(connectionId: string, enabled: boolean) {
  return (
    await accept(
      accessApi().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId },
        body: { enabled },
      }),
      [200],
    )
  ).body;
}

async function setSshOverride(
  threadId: string,
  connectionId: string,
  enabled: boolean,
) {
  return (
    await accept(
      accessApi().setThreadOverride({
        headers,
        params: { threadId, protocol: "ssh", connectionId },
        body: { enabled },
      }),
      [200],
    )
  ).body;
}

function entry(
  id: string,
  displayName: string,
  defaultEnabled: boolean,
  overrideEnabled: boolean | null,
) {
  return {
    connectionId: id,
    displayName,
    defaultEnabled,
    overrideEnabled,
    enabled: overrideEnabled ?? defaultEnabled,
    source: overrideEnabled === null ? "default" : "override",
  };
}

describe("chat remote access", () => {
  it("chat-remote-access-003 exposes VNC host defaults and thread overrides", async () => {
    signIn(await member());
    const threadId = await createThread();
    const created = await accept(
      setupApp({ context, routes: vncConnectionsRoutes })(
        vncConnectionsContract,
      ).create({
        headers,
        body: { ...vncConnectionBody(), displayName: "VNC desktop" },
      }),
      [201],
    );
    const connectionId = created.body.id;
    const vncOverride = async (enabled: boolean) => {
      return (
        await accept(
          accessApi().setThreadOverride({
            headers,
            params: { threadId, protocol: "vnc", connectionId },
            body: { enabled },
          }),
          [200],
        )
      ).body;
    };

    expect((await hostDefaults()).vnc).toStrictEqual([
      { connectionId, displayName: "VNC desktop", defaultEnabled: false },
    ]);
    await expect(vncOverride(true)).resolves.toMatchObject({
      enabled: true,
      source: "override",
    });
    await accept(
      accessApi().updateHostDefault({
        headers,
        params: { protocol: "vnc", connectionId },
        body: { enabled: true },
      }),
      [200],
    );
    await expect(vncOverride(false)).resolves.toStrictEqual(
      entry(connectionId, "VNC desktop", true, false),
    );
    const cleared = await accept(
      accessApi().clearThreadOverride({
        headers,
        params: { threadId, protocol: "vnc", connectionId },
      }),
      [200],
    );
    expect(cleared.body).toStrictEqual(
      entry(connectionId, "VNC desktop", true, null),
    );
  });

  it("chat-remote-access-001 inherits SSH host defaults per Chat and keeps explicit allow or deny", async () => {
    signIn(await member());
    const [firstThread, secondThread, first, second] = await Promise.all([
      createThread(),
      createThread(),
      createSshHost("First host"),
      createSshHost("Second host"),
    ]);
    const byId = (
      entries: readonly { readonly connectionId: string }[],
    ): string[] => {
      return entries.map((host) => {
        return host.connectionId;
      });
    };
    const initial = await threadAccess(firstThread);
    expect(initial.vnc).toStrictEqual([]);
    expect(initial.ssh).toHaveLength(2);
    expect(initial.ssh).toStrictEqual(
      expect.arrayContaining([
        entry(first.id, "First host", false, null),
        entry(second.id, "Second host", false, null),
      ]),
    );

    await setSshDefault(first.id, true);
    await Promise.all([
      setSshOverride(firstThread, first.id, false),
      setSshOverride(firstThread, second.id, true),
    ]);
    const [overridden, inherited] = await Promise.all([
      threadAccess(firstThread),
      threadAccess(secondThread),
    ]);
    expect(overridden.ssh).toStrictEqual(
      expect.arrayContaining([
        entry(first.id, "First host", true, false),
        entry(second.id, "Second host", false, true),
      ]),
    );
    expect(inherited.ssh).toStrictEqual(
      expect.arrayContaining([
        entry(first.id, "First host", true, null),
        entry(second.id, "Second host", false, null),
      ]),
    );

    const cleared = await accept(
      accessApi().clearThreadOverride({
        headers,
        params: {
          threadId: firstThread,
          protocol: "ssh",
          connectionId: first.id,
        },
      }),
      [200],
    );
    expect(cleared.body).toMatchObject({
      enabled: true,
      overrideEnabled: null,
      source: "default",
    });
    await setSshDefault(first.id, false);
    expect((await threadAccess(firstThread)).ssh).toStrictEqual(
      expect.arrayContaining([
        entry(first.id, "First host", false, null),
        entry(second.id, "Second host", false, true),
      ]),
    );

    await accept(
      sshApi().delete({
        headers,
        params: { connectionId: second.id },
        body: { expectedGeneration: second.generation },
      }),
      [204],
    );
    expect(byId((await threadAccess(firstThread)).ssh)).toStrictEqual([
      first.id,
    ]);
    await createSshHost("Recreated host", second.id);
    expect((await threadAccess(firstThread)).ssh).toStrictEqual(
      expect.arrayContaining([entry(second.id, "Recreated host", false, null)]),
    );
  });

  it("chat-remote-access-002 hides another owner's threads and hosts behind the same not-found result", async () => {
    const owner = await member();
    signIn(owner);
    const ownerThread = await createThread();
    const ownerHost = await createSshHost("Private host");
    expect((await hostDefaults()).ssh).toStrictEqual([
      {
        connectionId: ownerHost.id,
        displayName: "Private host",
        defaultEnabled: false,
      },
    ]);

    const other = await member();
    const elsewhere = await member(undefined, other.userId);
    signIn(elsewhere);
    const elsewhereThread = await createThread();
    const elsewhereHost = await createSshHost("Elsewhere host");
    signIn(other);
    const otherThread = await createThread();

    const ownerThreadRead = await accessApi().listThreadAccess({
      headers,
      params: { threadId: ownerThread },
    });
    expect(ownerThreadRead.status).toBe(404);
    expect(
      (
        await accessApi().updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: ownerHost.id },
          body: { enabled: true },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await accessApi().setThreadOverride({
          headers,
          params: {
            threadId: otherThread,
            protocol: "ssh",
            connectionId: ownerHost.id,
          },
          body: { enabled: true },
        })
      ).status,
    ).toBe(404);
    const elsewhereThreadRead = await accessApi().listThreadAccess({
      headers,
      params: { threadId: elsewhereThread },
    });
    expect(elsewhereThreadRead.status).toBe(404);
    expect(elsewhereThreadRead.body).toStrictEqual(ownerThreadRead.body);
    expect(
      (
        await accessApi().updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: elsewhereHost.id },
          body: { enabled: true },
        })
      ).status,
    ).toBe(404);
  });

  it("chat-remote-access-004 rejects a same-organization peer's changes to the owner's SSH access and keeps both owners' choices", async () => {
    const owner = await member();
    signIn(owner);
    const ownerThread = await createThread();
    const ownerHost = await createSshHost("Owner host");
    await setSshOverride(ownerThread, ownerHost.id, true);
    const ownerDefaults = await hostDefaults();
    const ownerAccess = await threadAccess(ownerThread);

    const peer = await member(owner.orgId);
    signIn(peer);
    const peerThread = await createThread();
    const peerHost = await createSshHost("Peer host");
    await setSshOverride(peerThread, peerHost.id, true);

    const peerDefaults = await hostDefaults();
    const peerAccess = await threadAccess(peerThread);
    expect(
      peerDefaults.ssh.map((host) => {
        return host.connectionId;
      }),
    ).toStrictEqual([peerHost.id]);
    expect(
      peerAccess.ssh.map((host) => {
        return host.connectionId;
      }),
    ).toStrictEqual([peerHost.id]);

    const unknownHost = randomUUID();
    const [
      ownerDefaultChange,
      unknownDefaultChange,
      ownerHostOverride,
      ownerHostClear,
      unknownHostClear,
      ownerThreadRead,
      unknownThreadRead,
      peerHostOnOwnerThread,
      ownerOverrideClear,
    ] = await Promise.all([
      accessApi().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: ownerHost.id },
        body: { enabled: true },
      }),
      accessApi().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId: unknownHost },
        body: { enabled: true },
      }),
      accessApi().setThreadOverride({
        headers,
        params: {
          threadId: peerThread,
          protocol: "ssh",
          connectionId: ownerHost.id,
        },
        body: { enabled: true },
      }),
      accessApi().clearThreadOverride({
        headers,
        params: {
          threadId: peerThread,
          protocol: "ssh",
          connectionId: ownerHost.id,
        },
      }),
      accessApi().clearThreadOverride({
        headers,
        params: {
          threadId: peerThread,
          protocol: "ssh",
          connectionId: unknownHost,
        },
      }),
      accessApi().listThreadAccess({
        headers,
        params: { threadId: ownerThread },
      }),
      accessApi().listThreadAccess({
        headers,
        params: { threadId: randomUUID() },
      }),
      accessApi().setThreadOverride({
        headers,
        params: {
          threadId: ownerThread,
          protocol: "ssh",
          connectionId: peerHost.id,
        },
        body: { enabled: false },
      }),
      accessApi().clearThreadOverride({
        headers,
        params: {
          threadId: ownerThread,
          protocol: "ssh",
          connectionId: ownerHost.id,
        },
      }),
    ]);
    expect(
      [
        ownerDefaultChange,
        ownerHostOverride,
        ownerHostClear,
        ownerThreadRead,
        peerHostOnOwnerThread,
        ownerOverrideClear,
      ].map((response) => {
        return response.status;
      }),
    ).toStrictEqual([404, 404, 404, 404, 404, 404]);
    expect(ownerDefaultChange.body).toStrictEqual(unknownDefaultChange.body);
    expect(ownerHostClear.body).toStrictEqual(unknownHostClear.body);
    expect(ownerThreadRead.body).toStrictEqual(unknownThreadRead.body);
    await expect(hostDefaults()).resolves.toStrictEqual(peerDefaults);
    await expect(threadAccess(peerThread)).resolves.toStrictEqual(peerAccess);

    signIn(owner);
    await expect(hostDefaults()).resolves.toStrictEqual(ownerDefaults);
    await expect(threadAccess(ownerThread)).resolves.toStrictEqual(ownerAccess);
    const cleared = await accept(
      accessApi().clearThreadOverride({
        headers,
        params: {
          threadId: ownerThread,
          protocol: "ssh",
          connectionId: ownerHost.id,
        },
      }),
      [200],
    );
    expect(cleared.body).toStrictEqual({
      ...ownerAccess.ssh[0],
      overrideEnabled: null,
      enabled: false,
      source: "default",
    });
    await setSshDefault(ownerHost.id, true);
    expect((await threadAccess(ownerThread)).ssh).toStrictEqual([
      entry(ownerHost.id, "Owner host", true, null),
    ]);
  });
});
