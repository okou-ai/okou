import { randomUUID } from "node:crypto";

import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  computerUseToken,
  createComputerUseBddApi,
} from "./helpers/api-bdd-computer-use";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-18T12:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

/** Fails immediately when the operation terminates before its expected gate. */
aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use host directories require an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

/** Projects one dormant B1 closure and retires exactly that test-owned job. */
function clearPublications(): void {
  context.mocks.ably.publish.mockClear();
}

function expectNoPublications(): void {
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
}

async function startRetainedHost(actor: ApiTestUser, hostName: string) {
  return await computerUse.startComputerUseHost(actor, {
    installationId: randomUUID(),
    hostName,
    supportedCapabilities: ["apps.list", "element.click"],
    permissions: { accessibility: true, screenRecording: false },
  });
}

describe("standalone Computer Use host directory", () => {
  it(
    "preserves session, PAT and Agent auth controls at the route boundary",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startRetainedHost(actor, "Auth Desktop");

      const unauthenticated = await computerUse.requestListComputerUseHosts(
        null,
        [401],
      );
      expectApiError(unauthenticated.body);

      const noOrganization = bdd.user({ orgId: null });
      const missingOrganization = await computerUse.requestListComputerUseHosts(
        noOrganization,
        [401],
      );
      expectApiError(missingOrganization.body);

      const session = await computerUse.listComputerUseHosts(actor);
      expect(
        session.hosts.map((item) => {
          return item.id;
        }),
      ).toStrictEqual([host.hostId]);

      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      const personalAccessToken = await computerUse.listComputerUseHosts({
        bearer: pat,
      });
      expect(personalAccessToken).toStrictEqual(session);

      const missingCapability = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: [],
        computerUseHostId: host.hostId,
      });
      const capabilityDenied = await computerUse.requestListComputerUseHosts(
        { bearer: missingCapability.token },
        [403],
      );
      expectApiError(capabilityDenied.body);

      const unbound = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: ["computer-use:write"],
      });
      const bindingDenied = await computerUse.requestListComputerUseHosts(
        { bearer: unbound.token },
        [403],
      );
      expect(bindingDenied.body).toStrictEqual({
        error: {
          message: "Computer-use host is not authorized for this run",
          code: "FORBIDDEN",
        },
      });
    },
  );

  it(
    "returns the complete ordered online, stale and stopped-installation directory without foreign hosts",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreignOrg = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));

      const stale = await computerUse.startComputerUseHost(actor, {
        hostName: "Stale Desktop",
        supportedCapabilities: ["apps.list"],
        permissions: { accessibility: false, screenRecording: true },
      });
      mockNow(STARTED_AT_MS + 1000);
      const stopped = await startRetainedHost(actor, "Stopped Desktop");
      await computerUse.stopComputerUseHost(stopped.hostToken);
      mockNow(STARTED_AT_MS + 2000);
      const current = await computerUse.startComputerUseHost(actor, {
        hostName: "Current Desktop",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: true, screenRecording: false },
      });
      const peer = await computerUse.startComputerUseHost(sameOrgPeer, {
        hostName: "Peer Desktop",
      });
      const foreign = await computerUse.startComputerUseHost(foreignOrg, {
        hostName: "Foreign Desktop",
      });

      mockNow(STARTED_AT_MS + 120_000);
      await computerUse.heartbeatComputerUseHost(current.hostToken, {
        hostName: "Current Desktop",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: true, screenRecording: false },
      });
      clearPublications();

      const directory = await computerUse.listComputerUseHosts(actor);
      expect(
        directory.hosts.map((host) => {
          return host.id;
        }),
      ).toStrictEqual([current.hostId, stopped.hostId, stale.hostId]);
      expect(
        directory.hosts.map((host) => {
          return host.status;
        }),
      ).toStrictEqual(["online", "offline", "offline"]);
      expect(directory.hosts[0]).toStrictEqual({
        id: current.hostId,
        hostName: "Current Desktop",
        displayName: "Current Desktop",
        appVersion: "0.1.0",
        osVersion: "macOS 15",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: {
          accessibility: true,
          screenRecording: false,
          automation: {
            chrome: { status: "unknown", updatedAt: null, reason: null },
            safari: { status: "unknown", updatedAt: null, reason: null },
          },
        },
        status: "online",
        lastSeenAt: new Date(STARTED_AT_MS + 120_000).toISOString(),
        createdAt: new Date(STARTED_AT_MS + 2000).toISOString(),
      });
      expect(JSON.stringify(directory)).not.toContain(peer.hostId);
      expect(JSON.stringify(directory)).not.toContain(foreign.hostId);
      expectNoPublications();
    },
  );

  it(
    "keeps Agent discovery bound to its one valid host without requiring a persisted run, Agent or thread",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const peer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const other = await startRetainedHost(actor, "Other Desktop");
      const bound = await startRetainedHost(actor, "Bound Offline Desktop");
      await computerUse.stopComputerUseHost(bound.hostToken);
      const foreign = await startRetainedHost(peer, "Peer Desktop");
      mockClerkMembership(context, actor, "org:admin");

      const tokenFor = (computerUseHostId: string) => {
        return computerUseToken({
          userId: actor.userId,
          orgId: actor.orgId,
          capabilities: ["computer-use:write"],
          computerUseHostId,
          // This run label deliberately has no persisted Run, Agent or thread.
          runId: randomUUID(),
        }).token;
      };

      const listed = await computerUse.listComputerUseHosts({
        bearer: tokenFor(bound.hostId),
      });
      expect(listed.hosts).toStrictEqual([
        expect.objectContaining({
          id: bound.hostId,
          hostName: "Bound Offline Desktop",
          status: "offline",
        }),
      ]);
      expect(JSON.stringify(listed)).not.toContain(other.hostId);

      for (const absentBinding of [randomUUID(), foreign.hostId]) {
        const absent = await computerUse.listComputerUseHosts({
          bearer: tokenFor(absentBinding),
        });
        expect(absent.hosts).toStrictEqual([]);
      }
    },
  );
});
