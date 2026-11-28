import { randomUUID } from "node:crypto";

import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  chatThreadComputerUseHostContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { chatThreadComputerUseHostRoutes } from "../chat-threads-computer-use-host";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { remotesRoutes } from "../remotes";
import { sshConnectionsRoutes } from "../ssh-connections";
import { userPreferencesRoutes } from "../user-preferences";
import { vncConnectionsRoutes } from "../vnc-connections";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { inlineSshKey } from "./helpers/ssh-credential";
import { vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function member(
  orgId = `org_${randomUUID()}`,
  userId = `user_${randomUUID()}`,
): ApiTestUser {
  return {
    userId,
    orgId,
    orgRole: "org:admin",
    email: `${userId}@example.test`,
  };
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId ?? "");
}

async function readOverview(actor: ApiTestUser) {
  signIn(actor);
  const response = await accept(
    setupApp({ context, routes: remotesRoutes })(remotesContract).overview({
      headers,
    }),
    [200],
  );
  return response.body;
}

/** Requests run as whichever member signed in last. */
async function createChat(): Promise<string> {
  const thread = await accept(
    setupApp({ context, routes: chatThreadCreateRoutes })(
      chatThreadsContract,
    ).create({ headers, body: { model: null } }),
    [201],
  );
  return thread.body.id;
}

function remoteAccess() {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
}

/** Enabled for all chats by default, then disabled for one conversation. */
async function addHostDisabledInChat(
  protocol: "ssh" | "vnc",
  connectionId: string,
  threadId: string,
) {
  await Promise.all([
    accept(
      remoteAccess().updateHostDefault({
        headers,
        params: { protocol, connectionId },
        body: { enabled: true },
      }),
      [200],
    ),
    accept(
      remoteAccess().setThreadOverride({
        headers,
        params: { threadId, protocol, connectionId },
        body: { enabled: false },
      }),
      [200],
    ),
  ]);
}

function selectChatHost(
  threadId: string,
  body: { computerUseHostId: string | null; cloudBrowserEnabled?: boolean },
) {
  return accept(
    setupApp({ context, routes: chatThreadComputerUseHostRoutes })(
      chatThreadComputerUseHostContract,
    ).update({ headers, params: { id: threadId }, body }),
    [204],
  );
}

describe("GET /api/remotes/overview", () => {
  it("remotes-004 lists only the member's own Desktop hosts", async () => {
    const desktops = createComputerUseBddApi(context);
    const owner = member();
    const colleague = member(owner.orgId ?? undefined);
    const otherOrgSelf = member(undefined, owner.userId);
    await desktops.startComputerUseHost(owner, { hostName: "Owned Desktop" });
    await desktops.startComputerUseHost(colleague, {
      hostName: "Colleague Desktop",
    });
    await desktops.startComputerUseHost(otherOrgSelf, {
      hostName: "Other Org Desktop",
    });

    const overview = await readOverview(owner);

    expect(overview.computerUseHosts).toStrictEqual([
      expect.objectContaining({
        displayName: "Owned Desktop",
        hostName: "Owned Desktop",
        status: "online",
      }),
    ]);
  });

  it("remotes-005 returns host defaults without thread overrides or credentials", async () => {
    const owner = member();
    const colleague = member(owner.orgId ?? undefined);
    const otherOrgSelf = member(undefined, owner.userId);
    const clerkDirectory = createStore();
    await Promise.all(
      [owner, colleague, otherOrgSelf].map((actor) => {
        return clerkDirectory.set(
          seedOrgMembership$,
          { userId: actor.userId, orgId: actor.orgId ?? "", role: "admin" },
          context.signal,
        );
      }),
    );
    signIn(owner);
    const sshId = randomUUID();
    const [threadId, , vnc] = await Promise.all([
      createChat(),
      accept(
        setupApp({ context, routes: sshConnectionsRoutes })(
          sshConnectionsContract,
        ).create({
          headers,
          body: {
            id: sshId,
            displayName: "SSH server",
            host: `ssh-${sshId.slice(0, 8)}.example.test`,
            credential: inlineSshKey("deploy", `key-${randomUUID()}`),
          },
        }),
        [201],
      ),
      accept(
        setupApp({ context, routes: vncConnectionsRoutes })(
          vncConnectionsContract,
        ).create({ headers, body: vncConnectionBody() }),
        [201],
      ),
    ]);
    await Promise.all([
      addHostDisabledInChat("ssh", sshId, threadId),
      addHostDisabledInChat("vnc", vnc.body.id, threadId),
    ]);

    const ownerView = await readOverview(owner);
    const colleagueView = await readOverview(colleague);
    const otherOrgView = await readOverview(otherOrgSelf);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    const afterLeaving = await readOverview(owner);

    const sshHosts = [
      { connectionId: sshId, displayName: "SSH server", defaultEnabled: true },
    ];
    expect({
      ssh: ownerView.sshHosts,
      vnc: ownerView.vncHosts,
      cloudBrowserEnabledByDefault: ownerView.cloudBrowserEnabledByDefault,
    }).toStrictEqual({
      ssh: sshHosts,
      vnc: [
        {
          connectionId: vnc.body.id,
          displayName: "VNC desktop",
          defaultEnabled: true,
        },
      ],
      cloudBrowserEnabledByDefault: true,
    });
    for (const view of [colleagueView, otherOrgView]) {
      expect({ ssh: view.sshHosts, vnc: view.vncHosts }).toStrictEqual({
        ssh: [],
        vnc: [],
      });
    }
    expect(afterLeaving.vncHosts).toStrictEqual([]);
    expect(afterLeaving.sshHosts).toStrictEqual(sshHosts);
  });

  it("remotes-003 keeps browser defaults apart from a chat's selections", async () => {
    const owner = member();
    await createBddApi(context).bootstrapLimitedFreeOnboarding(owner);
    signIn(owner);
    const [desktop, threadId] = await Promise.all([
      createComputerUseBddApi(context).startComputerUseHost(owner, {
        hostName: "Selected Desktop",
      }),
      createChat(),
    ]);
    await selectChatHost(threadId, { computerUseHostId: desktop.hostId });

    const before = await readOverview(owner);
    await Promise.all([
      accept(
        setupApp({ context, routes: userPreferencesRoutes })(
          userPreferencesContract,
        ).update({ headers, body: { cloudBrowserEnabledByDefault: false } }),
        [200],
      ),
      selectChatHost(threadId, {
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    ]);
    const after = await readOverview(owner);

    const desktops = [
      expect.objectContaining({
        id: desktop.hostId,
        hostName: "Selected Desktop",
        displayName: "Selected Desktop",
        status: "online",
      }),
    ];
    expect({
      available: before.cloudBrowserAvailable,
      enabledByDefault: before.cloudBrowserEnabledByDefault,
      desktops: before.computerUseHosts,
    }).toStrictEqual({ available: true, enabledByDefault: true, desktops });
    expect({
      available: after.cloudBrowserAvailable,
      enabledByDefault: after.cloudBrowserEnabledByDefault,
      desktops: after.computerUseHosts,
    }).toStrictEqual({
      available: true,
      enabledByDefault: false,
      desktops: before.computerUseHosts,
    });
  });
});
