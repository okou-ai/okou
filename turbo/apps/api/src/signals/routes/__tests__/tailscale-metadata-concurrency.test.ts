import { createHash, randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import {
  tailscaleContract,
  type TailscaleConfig,
  type UpdateTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
}

async function person(
  role: Actor["role"],
  orgId = `org_${randomUUID()}`,
): Promise<Actor> {
  const actor = { userId: `user_${randomUUID()}`, orgId, role };
  await clerkDirectory.set(seedOrgMembership$, actor, context.signal);
  return actor;
}

function signIn(actor: Actor): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role === "admin" ? "org:admin" : "org:member",
  );
}

function tailscale() {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
}

function hosts() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

function logins() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
}

async function createSharedConfig(
  actor: Actor,
  name = "Shared private network",
): Promise<TailscaleConfig> {
  signIn(actor);
  const id = randomUUID();
  const response = await accept(
    tailscale().create({
      headers,
      body: {
        id,
        name,
        scope: "organization",
        credentials: {
          clientId: `client-${randomUUID()}`,
          clientSecret: `secret-${randomUUID()}`,
        },
        tags: ["tag:prod", "tag:ci"],
      },
    }),
    [201],
  );
  return response.body;
}

async function createLogin(actor: Actor): Promise<string> {
  signIn(actor);
  const response = await accept(
    logins().create({
      headers,
      body: {
        id: randomUUID(),
        name: `Login ${randomUUID().slice(0, 8)}`,
        username: "deploy",
        authentication: { method: "password", password: `pw-${randomUUID()}` },
      },
    }),
    [201],
  );
  return response.body.id;
}

async function createHost(
  actor: Actor,
  configId: string,
  loginId: string,
  displayName: string,
): Promise<SshConnectionResponse> {
  signIn(actor);
  const response = await accept(
    hosts().create({
      headers,
      body: {
        id: randomUUID(),
        displayName,
        host: `${displayName.toLowerCase().replace(/\s+/gu, "-")}.example.com`,
        credential: { id: loginId },
        transport: { type: "tailscale", configId },
      },
    }),
    [201],
  );
  return response.body;
}

async function listConfigs(actor: Actor): Promise<readonly TailscaleConfig[]> {
  signIn(actor);
  return (await accept(tailscale().list({ headers }), [200])).body.configs;
}

async function listHosts(
  actor: Actor,
): Promise<readonly SshConnectionResponse[]> {
  signIn(actor);
  return (await accept(hosts().list({ headers }), [200])).body.connections;
}

function updateConfig(configId: string, body: UpdateTailscaleRequest) {
  return accept(
    tailscale().update({ headers, params: { configId }, body }),
    [200, 409],
  );
}

/** Sends two identical concurrent edits and separates the winner from the loser. */
async function raceIdenticalEdits(
  actor: Actor,
  configId: string,
  body: UpdateTailscaleRequest,
) {
  signIn(actor);
  const responses = await Promise.all([
    updateConfig(configId, body),
    updateConfig(configId, body),
  ]);
  const winner = responses.find((response) => {
    return response.status === 200;
  });
  const loser = responses.find((response) => {
    return response.status === 409;
  });
  if (winner?.status !== 200 || loser?.status !== 409) {
    throw new Error(
      `Expected one 200 and one 409, received ${responses
        .map((response) => {
          return response.status;
        })
        .join(", ")}`,
    );
  }
  return { winner: winner.body, loserCode: loser.body.error.code };
}

/** An admin's shared config used by two of the admin's own SSH hosts. */
async function sharedConfigWithTwoHosts() {
  const admin = await person("admin");
  const config = await createSharedConfig(admin);
  const loginId = await createLogin(admin);
  const first = await createHost(admin, config.id, loginId, "Build one");
  const second = await createHost(admin, config.id, loginId, "Build two");
  const [listed] = await listConfigs(admin);
  expect(listed?.revision).toBe(config.revision);
  expect(
    listed?.sshHosts.map((host) => {
      return host.id;
    }),
  ).toStrictEqual(expect.arrayContaining([first.id, second.id]));
  return { admin, config, hosts: [first, second] };
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Hosts keep every field except a bumped generation and one shared timestamp. */
async function expectHostsBumped(
  admin: Actor,
  before: readonly SshConnectionResponse[],
) {
  const after = [...(await listHosts(admin))].sort(byId);
  const previous = [...before].sort(byId);
  const [firstAfter] = after;
  if (!firstAfter) {
    throw new Error("Expected the admin's hosts");
  }
  expect(after).toStrictEqual(
    previous.map((host) => {
      return {
        ...host,
        generation: host.generation + 1,
        updatedAt: firstAfter.updatedAt,
      };
    }),
  );
  for (const host of previous) {
    expect(Date.parse(firstAfter.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(host.updatedAt),
    );
  }
}

/** A shared config reviewed by the admin, with only a member's host on it. */
async function reviewedConfigWithMemberHost(operation: "convert" | "delete") {
  const admin = await person("admin");
  const member = await person("member", admin.orgId);
  const config = await createSharedConfig(admin);
  const memberLogin = await createLogin(member);
  await createHost(member, config.id, memberLogin, "Member box");
  const memberHosts = await listHosts(member);
  signIn(admin);
  const preview = await accept(
    tailscale().impactPreview({
      headers,
      params: { configId: config.id },
      query: { operation },
    }),
    [200],
  );
  return { admin, member, config, memberHosts, preview: preview.body };
}

async function renameAfterReview(admin: Actor, config: TailscaleConfig) {
  signIn(admin);
  const renamed = await accept(
    tailscale().update({
      headers,
      params: { configId: config.id },
      body: {
        expectedRevision: config.revision,
        name: "Renamed private network",
      },
    }),
    [200],
  );
  return renamed.body;
}

/** The member cannot rename shared config and still sees it with their host. */
async function memberView(member: Actor, config: TailscaleConfig) {
  signIn(member);
  await accept(
    tailscale().update({
      headers,
      params: { configId: config.id },
      body: { expectedRevision: config.revision + 1, name: "Member rename" },
    }),
    [403],
  );
  return {
    hosts: await listHosts(member),
    configs: await listConfigs(member),
  };
}

describe("Tailscale metadata concurrency", () => {
  beforeAll(() => {
    setupApp({
      context,
      routes: [
        ...tailscaleRoutes,
        ...sshConnectionsRoutes,
        ...chatRemoteAccessRoutes,
        ...runnerSshRoutes,
      ],
    });
  });

  it("tailscale-metadata-concurrency-004 commits one concurrent rename for the same revision", async () => {
    const admin = await person("admin");
    const config = await createSharedConfig(admin);

    const { winner, loserCode } = await raceIdenticalEdits(admin, config.id, {
      expectedRevision: config.revision,
      name: "Renamed private network",
    });

    expect(winner).toMatchObject({
      name: "Renamed private network",
      tags: ["tag:prod", "tag:ci"],
      revision: config.revision + 1,
      generation: config.generation,
    });
    expect(loserCode).toBe("TAILSCALE_REVISION_CONFLICT");
    await expect(listConfigs(admin)).resolves.toStrictEqual([winner]);
  });

  it("tailscale-metadata-concurrency-005 commits one concurrent tag reorder for the same revision", async () => {
    const admin = await person("admin");
    const config = await createSharedConfig(admin);

    const { winner, loserCode } = await raceIdenticalEdits(admin, config.id, {
      expectedRevision: config.revision,
      tags: ["tag:ci", "tag:prod"],
    });

    expect(winner).toMatchObject({
      tags: ["tag:ci", "tag:prod"],
      revision: config.revision + 1,
      generation: config.generation,
    });
    expect(loserCode).toBe("TAILSCALE_REVISION_CONFLICT");
    await expect(listConfigs(admin)).resolves.toStrictEqual([winner]);
  });

  it("tailscale-metadata-concurrency-001 commits one concurrent credential replacement with every host generation", async () => {
    const { admin, config, hosts: before } = await sharedConfigWithTwoHosts();

    const { winner, loserCode } = await raceIdenticalEdits(admin, config.id, {
      expectedRevision: config.revision,
      credentials: {
        clientId: `client-${randomUUID()}`,
        clientSecret: `secret-${randomUUID()}`,
      },
    });

    expect(winner).toMatchObject({
      tags: ["tag:prod", "tag:ci"],
      revision: config.revision + 1,
      generation: config.generation + 1,
    });
    expect([...winner.sshHosts].sort(byId)).toStrictEqual(
      before
        .map((host) => {
          return { id: host.id, displayName: host.displayName };
        })
        .sort(byId),
    );
    expect(loserCode).toBe("TAILSCALE_REVISION_CONFLICT");
    await expect(listConfigs(admin)).resolves.toStrictEqual([winner]);
    await expectHostsBumped(admin, before);
  });

  it("tailscale-metadata-concurrency-002 commits one concurrent tag addition with every host generation", async () => {
    const { admin, config, hosts: before } = await sharedConfigWithTwoHosts();

    const { winner, loserCode } = await raceIdenticalEdits(admin, config.id, {
      expectedRevision: config.revision,
      tags: ["tag:prod", "tag:ci", "tag:ops"],
    });

    expect(winner).toMatchObject({
      tags: ["tag:prod", "tag:ci", "tag:ops"],
      revision: config.revision + 1,
      generation: config.generation + 1,
    });
    expect([...winner.sshHosts].sort(byId)).toStrictEqual(
      before
        .map((host) => {
          return { id: host.id, displayName: host.displayName };
        })
        .sort(byId),
    );
    expect(loserCode).toBe("TAILSCALE_REVISION_CONFLICT");
    await expect(listConfigs(admin)).resolves.toStrictEqual([winner]);
    await expectHostsBumped(admin, before);
  });

  it("tailscale-metadata-concurrency-006 renames the config alongside host edits without exposing another owner's hosts", async () => {
    const admin = await person("admin");
    const member = await person("member", admin.orgId);
    const config = await createSharedConfig(admin);
    const adminLogin = await createLogin(admin);
    const own = await createHost(admin, config.id, adminLogin, "Admin box");
    const memberLogin = await createLogin(member);
    const memberHost = await createHost(
      member,
      config.id,
      memberLogin,
      "Member box",
    );
    const newHostId = randomUUID();

    signIn(admin);
    const [configUpdate, hostEdit, created] = await Promise.all([
      accept(
        tailscale().update({
          headers,
          params: { configId: config.id },
          body: { expectedRevision: config.revision, name: "Renamed network" },
        }),
        [200],
      ),
      accept(
        hosts().update({
          headers,
          params: { connectionId: own.id },
          body: { expectedGeneration: own.generation, displayName: "Edited" },
        }),
        [200],
      ),
      accept(
        hosts().create({
          headers,
          body: {
            id: newHostId,
            displayName: "Admin new box",
            host: "admin-new-box.example.com",
            credential: { id: adminLogin },
            transport: { type: "tailscale", configId: config.id },
          },
        }),
        [201],
      ),
    ]);
    const adminHosts = await listHosts(admin);

    expect(configUpdate.body).toMatchObject({
      name: "Renamed network",
      revision: config.revision + 1,
      generation: config.generation,
    });
    const listedIds = configUpdate.body.sshHosts.map((host) => {
      return host.id;
    });
    expect(listedIds).toContain(own.id);
    expect(
      listedIds.every((id) => {
        return id === own.id || id === newHostId;
      }),
    ).toBeTruthy();
    expect(hostEdit.body).toStrictEqual({
      ...own,
      displayName: "Edited",
      generation: own.generation + 1,
      updatedAt: hostEdit.body.updatedAt,
    });
    expect(
      adminHosts.find((host) => {
        return host.id === own.id;
      }),
    ).toStrictEqual(hostEdit.body);
    expect(
      adminHosts.find((host) => {
        return host.id === newHostId;
      }),
    ).toStrictEqual(created.body);
    await expect(listHosts(member)).resolves.toStrictEqual([memberHost]);
  });

  it("tailscale-metadata-concurrency-012 invalidates a reviewed conversion after a rename and keeps management admin-only", async () => {
    const { admin, member, config, memberHosts, preview } =
      await reviewedConfigWithMemberHost("convert");

    const renamed = await renameAfterReview(admin, config);
    signIn(admin);
    await accept(
      tailscale().convertToPersonal({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [409],
    );
    const view = await memberView(member, config);

    expect(renamed).toMatchObject({
      revision: config.revision + 1,
      generation: config.generation,
      sshHosts: [],
    });
    expect(view.hosts).toStrictEqual(memberHosts);
    expect(view.configs).toMatchObject([
      {
        id: config.id,
        name: "Renamed private network",
        revision: config.revision + 1,
        sshHosts: memberHosts.map((host) => {
          return { id: host.id, displayName: host.displayName };
        }),
      },
    ]);
  });

  it("tailscale-metadata-concurrency-013 invalidates a reviewed deletion after a rename and keeps management admin-only", async () => {
    const { admin, member, config, memberHosts, preview } =
      await reviewedConfigWithMemberHost("delete");

    const renamed = await renameAfterReview(admin, config);
    signIn(admin);
    await accept(
      tailscale().delete({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [409],
    );
    const view = await memberView(member, config);

    expect(renamed).toMatchObject({
      revision: config.revision + 1,
      generation: config.generation,
      sshHosts: [],
    });
    expect(view.hosts).toStrictEqual(memberHosts);
    expect(view.configs).toMatchObject([
      {
        id: config.id,
        name: "Renamed private network",
        revision: config.revision + 1,
        sshHosts: memberHosts.map((host) => {
          return { id: host.id, displayName: host.displayName };
        }),
      },
    ]);
  });

  it(
    "tailscale-metadata-concurrency-008 preserves winning-Runner pin and observation authority during a concurrent name update",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const adminActor = bdd.user({ orgRole: "org:admin" });
      if (!adminActor.orgId) {
        throw new Error("Expected organization admin actor");
      }
      const admin: Actor = {
        userId: adminActor.userId,
        orgId: adminActor.orgId,
        role: "admin",
      };
      const owner = publicRunOwner(context, adminActor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      await Promise.all([
        runs.configureRunnerGroup(),
        clerkDirectory.set(seedOrgMembership$, admin, context.signal),
        owner.run(() => {
          return bdd.bootstrapLimitedFreeOnboarding(adminActor);
        }),
      ]);

      const config = await createSharedConfig(admin);
      const loginId = await createLogin(admin);
      const host = await createHost(admin, config.id, loginId, "Pinned box");
      const remoteAccessApi = setupApp({
        context,
        routes: chatRemoteAccessRoutes,
      })(chatRemoteAccessContract);
      signIn(admin);
      await accept(
        remoteAccessApi.updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: true },
        }),
        [200],
      );

      const launched = await owner.run(() => {
        return fixture.sendChatRun(adminActor, {
          prompt: "Connect to Pinned box over Tailscale",
          model: null,
        });
      });
      await owner.executionInput(launched.runId);
      const selected = runs.dispatchedRun(launched.runId);
      const runnerIdentity = {
        runnerId: selected.runnerId,
        heartbeatGeneration: selected.heartbeatGeneration,
      };
      const runnerHeaders = {
        authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
      };
      const runnerSshApi = setupApp({ context, routes: runnerSshRoutes })(
        runnerSshContract,
      );
      const observedHostKey = {
        algorithm: "ssh-ed25519" as const,
        fingerprint: `SHA256:${createHash("sha256")
          .update(`host-key-${host.id}`)
          .digest("base64")
          .replace(/=+$/u, "")}`,
      };

      signIn(admin);
      const [renamed, pinned] = await Promise.all([
        accept(
          tailscale().update({
            headers,
            params: { configId: config.id },
            body: {
              expectedRevision: config.revision,
              name: "Renamed private network",
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: launched.runId },
            body: {
              connectionId: host.id,
              runnerIdentity,
              expectedGeneration: host.generation,
              observedHostKey,
            },
          }),
          [200],
        ),
      ]);

      expect(renamed.body).toMatchObject({
        id: config.id,
        name: "Renamed private network",
        revision: config.revision + 1,
        generation: config.generation,
      });
      expect(pinned.body).toStrictEqual({
        outcome: "pinned",
        generation: host.generation + 1,
      });

      const [stored] = await listHosts(admin);
      expect(stored).toStrictEqual({
        ...host,
        generation: host.generation + 1,
        learnedHostKey: observedHostKey,
        updatedAt: stored?.updatedAt,
      });

      const observed = await accept(
        runnerSshApi.observe({
          headers: runnerHeaders,
          params: { runId: launched.runId },
          body: {
            connectionId: host.id,
            runnerIdentity,
            expectedGeneration: host.generation + 1,
            expectedCreatedAt: host.createdAt,
            observedAt: nowDate().toISOString(),
            failureReason: null,
          },
        }),
        [200],
      );
      expect(observed.body).toStrictEqual({ outcome: "recorded" });
    },
  );
});
