import { randomUUID } from "node:crypto";

import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { settleIncludingAbort } from "../../utils";
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
import {
  channelsPublishedTo,
  countPublishedTo,
} from "./helpers/realtime-publications";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-20T02:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;
const HOSTS_CHANGED = "computerUseHostsChanged";

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use host START requires an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

function startOptions(installationId: string, hostName: string) {
  return {
    installationId,
    hostName,
    appVersion: "2.3.4",
    osVersion: "macOS 16",
    supportedCapabilities: ["apps.list", "element.click"],
    permissions: { accessibility: true, screenRecording: false },
  };
}

async function clearPublications(): Promise<void> {
  await flushWaitUntilForTest();
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

async function expectOneOwnerPublication(userId: string): Promise<void> {
  await flushWaitUntilForTest();
  expect(
    countPublishedTo(context.mocks, {
      channel: `user:${userId}`,
      topic: HOSTS_CHANGED,
    }),
  ).toBe(1);
  expect(channelsPublishedTo(context.mocks, HOSTS_CHANGED)).toStrictEqual([
    `user:${userId}`,
  ]);
}

function startedBody(
  response: Awaited<ReturnType<typeof computerUse.requestStartComputerUseHost>>,
): { readonly hostId: string; readonly hostToken: string } {
  if (response.status !== 200) {
    throw new Error(`Expected host START 200, received ${response.status}`);
  }
  return response.body;
}

function hostById(
  hosts: Awaited<ReturnType<typeof computerUse.listComputerUseHosts>>["hosts"],
  hostId: string,
) {
  const host = hosts.find((candidate) => {
    return candidate.id === hostId;
  });
  if (!host) {
    throw new Error(`Expected Computer Use host ${hostId}`);
  }
  return host;
}

describe("Computer Use host START", () => {
  it(
    "preserves START auth, validation and normalization without importing the command capability gate",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());

      const unauthenticated = await computerUse.requestStartComputerUseHost(
        null,
        [401],
      );
      expectApiError(unauthenticated.body);
      const noOrganization = await computerUse.requestStartComputerUseHost(
        bdd.user({ orgId: null }),
        [401],
      );
      expectApiError(noOrganization.body);

      const session = await computerUse.requestStartComputerUseHost(
        actor,
        [200],
        {
          installationId: randomUUID(),
          hostName: "  Normalized Desktop  ",
          appVersion: " 1.2.3 ",
          osVersion: " macOS 16.0 ",
          supportedCapabilities: [
            " apps.list ",
            "apps.list",
            " element.click ",
          ],
          permissions: { accessibility: false, screenRecording: true },
        },
      );
      const normalized = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        startedBody(session).hostId,
      );
      expect(normalized).toMatchObject({
        displayName: "Normalized Desktop",
        appVersion: "1.2.3",
        osVersion: "macOS 16.0",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: false, screenRecording: true },
      });

      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      await computerUse.requestStartComputerUseHost({ bearer: pat }, [200], {
        installationId: randomUUID(),
        hostName: "PAT Desktop",
      });

      const agent = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: [],
      });
      const sandboxDenied = await computerUse.requestStartComputerUseHost(
        { bearer: agent.token },
        [403],
        { installationId: randomUUID(), hostName: "Agent Desktop" },
      );
      expect(sandboxDenied.body).toStrictEqual({
        error: {
          message: "This endpoint is not available for sandbox tokens",
          code: "FORBIDDEN",
        },
      });

      const beforeInvalid = await computerUse.listComputerUseHosts(actor);
      const invalid = await settleIncludingAbort(
        computerUse.requestStartComputerUseHost(actor, [200], {
          hostName: "   ",
        }),
      );
      expect(invalid.ok).toBeFalsy();
      if (!invalid.ok) {
        expect(String(invalid.error)).toMatch(/Unknown response status 400/);
      }
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(beforeInvalid);
    },
  );

  it(
    "retains installation identity, token rotation, partial-index ownership, revoked-row and concurrent upsert semantics",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const peer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreign = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      const installationId = randomUUID();
      const initial = await computerUse.startComputerUseHost(
        actor,
        startOptions(installationId, "Initial Desktop"),
      );
      const initialProjection = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        initial.hostId,
      );

      mockNow(STARTED_AT_MS + 1000);
      await clearPublications();
      const restarted = await computerUse.startComputerUseHost(
        actor,
        startOptions(installationId, "Restarted Desktop"),
      );
      expect(restarted.hostId).toBe(initial.hostId);
      const restartedProjection = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        restarted.hostId,
      );
      expect(restartedProjection.createdAt).toBe(initialProjection.createdAt);
      expect(restartedProjection).toMatchObject({
        displayName: "Restarted Desktop",
        appVersion: "2.3.4",
        osVersion: "macOS 16",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: true, screenRecording: false },
      });
      await expectOneOwnerPublication(actor.userId);
      await computerUse.requestComputerUseHeartbeat(initial.hostToken, [401]);
      await computerUse.requestComputerUseHeartbeat(restarted.hostToken, [200]);

      const peerHost = await computerUse.startComputerUseHost(
        peer,
        startOptions(installationId, "Peer Desktop"),
      );
      const foreignHost = await computerUse.startComputerUseHost(
        foreign,
        startOptions(installationId, "Foreign Desktop"),
      );
      expect(
        new Set([restarted.hostId, peerHost.hostId, foreignHost.hostId]).size,
      ).toBe(3);

      await computerUse.stopComputerUseHost(restarted.hostToken);
      const afterStop = await computerUse.startComputerUseHost(
        actor,
        startOptions(installationId, "After Stop"),
      );
      expect(afterStop.hostId).toBe(initial.hostId);
      expect(
        hostById(
          (await computerUse.listComputerUseHosts(actor)).hosts,
          afterStop.hostId,
        ).createdAt,
      ).toBe(initialProjection.createdAt);

      const concurrentInstallation = randomUUID();
      const [first, second] = await Promise.all([
        computerUse.startComputerUseHost(
          actor,
          startOptions(concurrentInstallation, "Concurrent A"),
        ),
        computerUse.startComputerUseHost(
          actor,
          startOptions(concurrentInstallation, "Concurrent B"),
        ),
      ]);
      expect(first.hostId).toBe(second.hostId);
      const credentialStatuses = await Promise.all([
        computerUse.requestComputerUseHeartbeat(first.hostToken, [200, 401]),
        computerUse.requestComputerUseHeartbeat(second.hostToken, [200, 401]),
      ]);
      expect(
        credentialStatuses
          .map((response) => {
            return response.status;
          })
          .sort(),
      ).toStrictEqual([200, 401]);
    },
  );
});
