import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  configureDiscordApp,
  createPublicDiscordBinding,
  mockDiscordApplication,
  uniqueDiscordSnowflake,
  type DiscordFixture,
} from "./helpers/discord";
import { launchPublicDiscordTestRun } from "./helpers/discord-run";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import {
  channelsPublishedTo,
  countPublishedTo,
} from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const TOPIC = "discord:changed";
const WORKSPACE_NAME = "Discord test workspace";
const GUILD_ID = "1559819014036000790";

interface Member {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

function discordApi() {
  return setupApp({ context, routes: integrationsDiscordRoutes })(
    integrationsDiscordContract,
  );
}

/** Real workspace members, as the identity provider reports them. */
function workspace() {
  const store = createStore();
  return {
    async member(
      role: "admin" | "member" = "admin",
      orgId = `org_${randomUUID()}`,
      userId = `user_${randomUUID()}`,
    ): Promise<Member> {
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role, name: WORKSPACE_NAME },
        context.signal,
      );
      return { userId, orgId, role };
    },
    async revoke(member: Member): Promise<void> {
      await store.set(deleteOrgMembership$, member, context.signal);
    },
  };
}

function signIn(member: Member): void {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.role === "admin" ? "org:admin" : "org:member",
  );
}

function bind(
  member: Member,
  args: {
    readonly flow: "install" | "connect";
    readonly guildId?: string;
    readonly guildName?: string;
    readonly discordUserId?: string;
  },
): Promise<DiscordFixture> {
  return createPublicDiscordBinding(context, {
    ...args,
    userId: member.userId,
    orgId: member.orgId,
    orgRole: member.role === "admin" ? "org:admin" : "org:member",
  });
}

async function readStatus(member: Member) {
  signIn(member);
  const response = await accept(
    discordApi().getStatus({ headers: SESSION }),
    [200],
  );
  return response.body;
}

function published(userId: string): number {
  return countPublishedTo(context.mocks, {
    channel: `user:${userId}`,
    topic: TOPIC,
  });
}

function publishedTotal(): number {
  return channelsPublishedTo(context.mocks, TOPIC).length;
}

interface InviteLookup {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | null;
}

function configureInstallLinks(): void {
  configureDiscordApp();
  mockEnv("DISCORD_OAUTH_CLIENT_SECRET", "discord-test-client-secret");
  mockEnv("APP_URL", "https://preview-app.example");
}

function mockInviteLookup(respond: () => Response): InviteLookup[] {
  const lookups: InviteLookup[] = [];
  server.use(
    http.get("https://discord.com/api/v10/invites/:code", ({ request }) => {
      lookups.push({
        method: request.method,
        url: new URL(request.url),
        authorization: request.headers.get("authorization"),
      });
      return respond();
    }),
  );
  return lookups;
}

function guildInvite(): Response {
  return HttpResponse.json({
    type: 0,
    code: "example",
    expires_at: null,
    guild: { id: GUILD_ID, name: "New server" },
  });
}

async function resolveInstallLink(invite: string) {
  const admin = await workspace().member("admin");
  signIn(admin);
  configureInstallLinks();
  const lookups = mockInviteLookup(guildInvite);

  const response = await accept(
    discordApi().installLink({ headers: SESSION, body: { invite } }),
    [200],
  );

  return {
    body: response.body,
    lookups: lookups.map((lookup) => {
      return {
        method: lookup.method,
        path: lookup.url.pathname,
        withExpiration: lookup.url.searchParams.get("with_expiration"),
        authorization: lookup.authorization,
      };
    }),
    published: publishedTotal(),
  };
}

const RESOLVED_INSTALL_LINK = Object.freeze({
  body: {
    url: `https://preview-app.example/settings/discord/install?guild_id=${GUILD_ID}`,
    guildId: GUILD_ID,
    guildName: "New server",
  },
  lookups: [
    {
      method: "GET",
      path: "/api/v10/invites/example",
      withExpiration: "true",
      authorization: null,
    },
  ],
  published: 0,
});

async function installLinkStatus(respond: () => Response): Promise<number> {
  const admin = await workspace().member("admin");
  signIn(admin);
  configureInstallLinks();
  mockInviteLookup(respond);
  const response = await accept(
    discordApi().installLink({
      headers: SESSION,
      body: { invite: "https://discord.gg/example" },
    }),
    [400, 404, 429],
  );
  return response.status;
}

async function rejectUnsupportedInvite(invite: string) {
  const admin = await workspace().member("admin");
  signIn(admin);
  configureInstallLinks();
  const lookups = mockInviteLookup(guildInvite);

  const response = await accept(
    discordApi().installLink({ headers: SESSION, body: { invite } }),
    [400],
  );

  return { code: response.body.error.code, lookups: lookups.length };
}

describe("Discord server installation links", () => {
  it("integrations-discord-004 rejects an unsupported attacker URL without fetching it", async () => {
    await expect(
      rejectUnsupportedInvite("https://attacker.example/invite/example"),
    ).resolves.toStrictEqual({
      code: "BAD_REQUEST",
      lookups: 0,
    });
  });

  it("integrations-discord-001 resolves a discord.gg invite into the app installation link", async () => {
    await expect(
      resolveInstallLink("https://discord.gg/example"),
    ).resolves.toStrictEqual(RESOLVED_INSTALL_LINK);
  });

  it("integrations-discord-002 resolves a discord.com invite with tracking parameters", async () => {
    await expect(
      resolveInstallLink("https://discord.com/invite/example?utm_source=share"),
    ).resolves.toStrictEqual(RESOLVED_INSTALL_LINK);
  });

  it("integrations-discord-003 resolves a discordapp.com invite with a trailing slash", async () => {
    await expect(
      resolveInstallLink("https://discordapp.com/invite/example/"),
    ).resolves.toStrictEqual(RESOLVED_INSTALL_LINK);
  });

  it("integrations-discord-010 rejects a Discord channel URL as an invite", async () => {
    await expect(
      rejectUnsupportedInvite("https://discord.com/channels/123"),
    ).resolves.toStrictEqual({
      code: "BAD_REQUEST",
      lookups: 0,
    });
  });

  it("integrations-discord-011 reports an unknown invite as not found", async () => {
    await expect(
      installLinkStatus(() => {
        return HttpResponse.json(
          { message: "Unknown Invite", code: 10_006 },
          { status: 404 },
        );
      }),
    ).resolves.toBe(404);
  });

  it("integrations-discord-012 rejects an invite that is not for a server", async () => {
    await expect(
      installLinkStatus(() => {
        return HttpResponse.json({ type: 1, code: "example", guild: null });
      }),
    ).resolves.toBe(400);
  });

  it("integrations-discord-013 reports an expired server invite as not found", async () => {
    await expect(
      installLinkStatus(() => {
        return HttpResponse.json({
          type: 0,
          code: "example",
          expires_at: "2020-01-01T00:00:00Z",
          guild: { id: GUILD_ID, name: "New server" },
        });
      }),
    ).resolves.toBe(404);
  });

  it("integrations-discord-014 reports Discord rate limiting as too many requests", async () => {
    await expect(
      installLinkStatus(() => {
        return HttpResponse.json(
          {
            message: "You are being rate limited.",
            retry_after: 5,
            global: false,
          },
          { status: 429 },
        );
      }),
    ).resolves.toBe(429);
  });
});

async function selectDm(member: Member, connectionId: string) {
  signIn(member);
  const response = await discordApi().setDmSelection({
    headers: SESSION,
    body: { connectionId },
  });
  return response.status;
}

/** Select one DM connection and read the caller's events and saved choice. */
async function selectAndRead(member: Member, connectionId: string) {
  const before = published(member.userId);
  const status = await selectDm(member, connectionId);
  const events = published(member.userId) - before;
  const { dmSelectionConnectionId } = await readStatus(member);
  return { status, events, selection: dmSelectionConnectionId };
}

function connectionIds(status: Awaited<ReturnType<typeof readStatus>>) {
  return status.dmBindings
    .map((binding) => {
      return binding.connectionId;
    })
    .sort();
}

/** One Okou user and Discord account installed into three organizations. */
async function sameUserInThreeOrganizations() {
  configureDiscordApp();
  const members = workspace();
  const userId = `user_${randomUUID()}`;
  const discordUserId = uniqueDiscordSnowflake();
  const firstOrg = await members.member("admin", `org_${randomUUID()}`, userId);
  const secondOrg = await members.member(
    "admin",
    `org_${randomUUID()}`,
    userId,
  );
  const thirdOrg = await members.member("admin", `org_${randomUUID()}`, userId);
  const firstBinding = await bind(firstOrg, { flow: "install", discordUserId });
  const secondBinding = await bind(secondOrg, {
    flow: "install",
    discordUserId,
  });
  const thirdBinding = await bind(thirdOrg, { flow: "install", discordUserId });
  return { firstOrg, secondOrg, firstBinding, secondBinding, thirdBinding };
}

describe("verified Discord integration settings", () => {
  it("integrations-discord-018 requires authenticated organization membership", async () => {
    configureDiscordApp();
    const api = discordApi();
    const connectionId = randomUUID();

    const statuses = [
      (await api.getStatus({ headers: {} })).status,
      (await api.disconnect({ headers: {}, query: {} })).status,
      (
        await api.setDmSelection({
          headers: {},
          body: { connectionId },
        })
      ).status,
    ];
    createRouteMocks(context).clerk.session(`user_${randomUUID()}`, null);
    statuses.push((await api.getStatus({ headers: SESSION })).status);

    expect(statuses).toStrictEqual([401, 401, 401, 401]);
    expect(publishedTotal()).toBe(0);
  });

  it("integrations-discord-020 reports verified guild identity and honest MESSAGE_CONTENT availability", async () => {
    configureDiscordApp();
    const admin = await workspace().member("admin");
    const fixture = await bind(admin, {
      flow: "install",
      guildName: "Customer workspace",
    });

    const first = await readStatus(admin);
    mockDiscordApplication(1 << 18);
    const second = await readStatus(admin);

    expect(first).toStrictEqual({
      isAvailable: true,
      isConnected: true,
      isAdmin: true,
      guildId: fixture.guildId,
      guildName: "Customer workspace",
      discordUserId: fixture.discordUserId,
      contextMode: "mentions_only",
      onboarding: "oauth",
      dmSelectionConnectionId: null,
      dmBindings: [
        {
          connectionId: fixture.connectionId,
          guildId: fixture.guildId,
          guildName: "Customer workspace",
          workspaceName: WORKSPACE_NAME,
        },
      ],
    });
    expect(second.contextMode).toBe("full");
  });

  it("integrations-discord-021 reports full context for Discord's actual 1 << 19 grant", async () => {
    configureDiscordApp();
    const admin = await workspace().member("admin");
    await bind(admin, { flow: "install" });
    mockDiscordApplication(524_288);

    const status = await readStatus(admin);

    expect(status.contextMode).toBe("full");
  });

  it("integrations-discord-031 disconnects only the caller while preserving the guild and another verified user", async () => {
    configureDiscordApp();
    const members = workspace();
    const admin = await members.member("admin");
    const peer = await members.member("member", admin.orgId);
    const installed = await bind(admin, { flow: "install" });
    const connected = await bind(peer, {
      flow: "connect",
      guildId: installed.guildId,
    });
    const before = publishedTotal();
    const adminBefore = published(admin.userId);

    signIn(admin);
    const first = await discordApi().disconnect({
      headers: SESSION,
      query: {},
    });

    expect(first.status).toBe(200);
    expect(published(admin.userId)).toBe(adminBefore + 1);
    expect(publishedTotal()).toBe(before + 1);
    const adminStatus = await readStatus(admin);
    expect(adminStatus).toMatchObject({
      isConnected: false,
      discordUserId: null,
      dmBindings: [],
      dmSelectionConnectionId: null,
    });
    const peerStatus = await readStatus(peer);
    expect(peerStatus).toMatchObject({
      isConnected: true,
      discordUserId: connected.discordUserId,
      guildId: installed.guildId,
    });

    signIn(admin);
    const second = await discordApi().disconnect({
      headers: SESSION,
      query: {},
    });

    expect(second.status).toBe(404);
    expect(publishedTotal()).toBe(before + 1);
  });

  it("integrations-discord-033 hides revoked membership and refuses subsequent binding mutations", async () => {
    configureDiscordApp();
    const members = workspace();
    const admin = await members.member("admin");
    const fixture = await bind(admin, { flow: "install" });
    await members.revoke(admin);
    const before = publishedTotal();

    const status = await readStatus(admin);
    signIn(admin);
    const selection = await discordApi().setDmSelection({
      headers: SESSION,
      body: { connectionId: fixture.connectionId },
    });
    signIn(admin);
    const disconnect = await discordApi().disconnect({
      headers: SESSION,
      query: {},
    });

    expect(status.isConnected).toBeFalsy();
    expect(status.dmBindings).toStrictEqual([]);
    expect(selection.status).toBe(404);
    expect(disconnect.status).toBe(404);
    expect(publishedTotal()).toBe(before);
  });

  it("integrations-discord-034 keeps DM bindings and saved choices isolated across successive user requests", async () => {
    configureDiscordApp();
    const members = workspace();
    const first = await members.member("admin");
    const second = await members.member("admin");
    const firstBinding = await bind(first, { flow: "install" });
    const secondBinding = await bind(second, { flow: "install" });

    const selections: number[] = [];
    for (const [member, binding] of [
      [first, firstBinding],
      [second, secondBinding],
    ] as const) {
      signIn(member);
      const selected = await discordApi().setDmSelection({
        headers: SESSION,
        body: { connectionId: binding.connectionId },
      });
      selections.push(selected.status);
    }
    const reads = [
      { binding: firstBinding, status: await readStatus(first) },
      { binding: secondBinding, status: await readStatus(second) },
      { binding: firstBinding, status: await readStatus(first) },
    ];

    expect(selections).toStrictEqual([200, 200]);
    for (const { binding, status } of reads) {
      expect(status.discordUserId).toBe(binding.discordUserId);
      expect(status.dmBindings).toStrictEqual([
        {
          connectionId: binding.connectionId,
          guildId: binding.guildId,
          guildName: binding.guildName,
          workspaceName: WORKSPACE_NAME,
        },
      ]);
      expect(status.dmSelectionConnectionId).toBe(binding.connectionId);
    }
  });

  it("integrations-discord-035 (1/3) starts without a DM choice and selects the second organization", async () => {
    const given = await sameUserInThreeOrganizations();

    const initial = await readStatus(given.firstOrg);
    expect(initial.dmSelectionConnectionId).toBeNull();
    expect(connectionIds(initial)).toStrictEqual(
      [
        given.firstBinding.connectionId,
        given.secondBinding.connectionId,
        given.thirdBinding.connectionId,
      ].sort(),
    );

    await expect(
      selectAndRead(given.firstOrg, given.secondBinding.connectionId),
    ).resolves.toStrictEqual({
      status: 200,
      events: 1,
      selection: given.secondBinding.connectionId,
    });
  });

  it("integrations-discord-035 (2/3) switches the DM choice to the third and back to the second organization", async () => {
    const given = await sameUserInThreeOrganizations();
    await selectDm(given.firstOrg, given.secondBinding.connectionId);

    await expect(
      selectAndRead(given.firstOrg, given.thirdBinding.connectionId),
    ).resolves.toStrictEqual({
      status: 200,
      events: 1,
      selection: given.thirdBinding.connectionId,
    });
    await expect(
      selectAndRead(given.firstOrg, given.secondBinding.connectionId),
    ).resolves.toStrictEqual({
      status: 200,
      events: 1,
      selection: given.secondBinding.connectionId,
    });
  });

  it("integrations-discord-035 (3/3) clears the choice when its organization disconnects and refuses it afterwards", async () => {
    const given = await sameUserInThreeOrganizations();
    await selectDm(given.firstOrg, given.secondBinding.connectionId);

    const beforeDisconnect = published(given.firstOrg.userId);
    signIn(given.secondOrg);
    const disconnected = await discordApi().disconnect({
      headers: SESSION,
      query: {},
    });
    expect(disconnected.status).toBe(200);
    expect(published(given.firstOrg.userId)).toBe(beforeDisconnect + 1);

    const after = await readStatus(given.firstOrg);
    expect(after.dmSelectionConnectionId).toBeNull();
    expect(connectionIds(after)).toStrictEqual(
      [given.firstBinding.connectionId, given.thirdBinding.connectionId].sort(),
    );
    const beforeReselect = publishedTotal();
    const reselected = await selectDm(
      given.firstOrg,
      given.secondBinding.connectionId,
    );
    expect(reselected).toBe(404);
    expect(publishedTotal()).toBe(beforeReselect);
  });

  it("integrations-discord-038 rejects DM selections for another Discord sender or another Okou user", async () => {
    configureDiscordApp();
    const members = workspace();
    const admin = await members.member("admin");
    const otherWorkspace = await members.member(
      "admin",
      `org_${randomUUID()}`,
      admin.userId,
    );
    const otherUser = await members.member("admin");
    const own = await bind(admin, { flow: "install" });
    const otherSender = await bind(otherWorkspace, { flow: "install" });
    const otherOwner = await bind(otherUser, { flow: "install" });
    const before = publishedTotal();

    const foreign: number[] = [];
    for (const binding of [otherSender, otherOwner]) {
      signIn(admin);
      const selected = await discordApi().setDmSelection({
        headers: SESSION,
        body: { connectionId: binding.connectionId },
      });
      foreign.push(selected.status);
    }
    expect(foreign).toStrictEqual([404, 404]);
    expect(publishedTotal()).toBe(before);
    const status = await readStatus(admin);
    expect(status.dmBindings).toStrictEqual([
      {
        connectionId: own.connectionId,
        guildId: own.guildId,
        guildName: own.guildName,
        workspaceName: WORKSPACE_NAME,
      },
    ]);

    const adminBefore = published(admin.userId);
    signIn(admin);
    const selected = await discordApi().setDmSelection({
      headers: SESSION,
      body: { connectionId: own.connectionId },
    });
    expect(selected.status).toBe(200);
    expect(published(admin.userId)).toBe(adminBefore + 1);
    expect(publishedTotal()).toBe(before + 1);
  });
});

describe("Discord installation link run access", () => {
  it(
    "integrations-discord-017 grants a run Discord installation link access without requiring a server binding",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const admin = await workspace().member("admin");
      const actor = createBddApi(context).user({
        userId: admin.userId,
        orgId: admin.orgId,
        orgRole: "org:admin",
      });
      configureInstallLinks();
      mockInviteLookup(guildInvite);

      const run = await launchPublicDiscordTestRun(context, actor);
      onTestFinished(async () => {
        await createRunsApi(context).requestCancelRun(
          actor,
          run.runId,
          [200, 400],
        );
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId: run.runId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${run.execution.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });

      expect(run.execution.appendSystemPrompt ?? "").not.toContain(
        "okou discord install-link",
      );

      const response = await accept(
        discordApi().installLink({
          headers: run.headers,
          body: { invite: "https://discord.gg/example" },
        }),
        [200],
      );
      expect(response.status).toBe(200);
    },
  );
});
