import { randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createBddApi } from "./helpers/api-bdd";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { inlineSshKey } from "./helpers/ssh-credential";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncRunnerHeaders,
  vncSessionHeaders,
} from "./helpers/vnc-runtime";

const context = testContext();
const vnc = createVncRuntimeApi(context);
const runs = createRunsApi(context);
const bdd = createBddApi(context);
const claimed = createClaimedSshRuntimeApi(context, {
  runnerHeaders: vncRunnerHeaders,
  authenticate: vnc.authenticate,
});
const remote = () => {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
};

describe("protocol-specific remote runtime invalidation", () => {
  afterEach(claimed.cleanup);

  it("isolates VNC defaults and chat overrides by owner and thread while SSH and Runs remain authorized", async () => {
    initializeVncRuntimeTest();
    const owner = {
      orgId: `org-${randomUUID()}`,
      userId: `user-${randomUUID()}`,
    };
    const group = runs.configureRunnerGroup();
    const first = await claimed.runtime(owner, { group });
    const second = await claimed.runtime(owner, { group });
    const otherUser = await claimed.runtime({
      orgId: owner.orgId,
      userId: `user-${randomUUID()}`,
    });
    const otherOrg = await claimed.runtime({
      orgId: `org-${randomUUID()}`,
      userId: owner.userId,
    });
    vnc.authenticate(owner);
    const desktop = await accept(
      vnc
        .connections()
        .create({ headers: vncSessionHeaders, body: vncConnectionBody() }),
      [201],
    );
    const sshId = randomUUID();
    await accept(
      setupApp({ context, routes: sshConnectionsRoutes })(
        sshConnectionsContract,
      ).create({
        headers: vncSessionHeaders,
        body: {
          id: sshId,
          displayName: "Independent SSH",
          host: "ssh.example.com",
          credential: inlineSshKey("deploy", "private-key", null),
        },
      }),
      [201],
    );
    await vnc.enableDefault(owner, "ssh", sshId);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
      expect.arrayContaining([
        [
          "ssh-authority-invalidated",
          { runId: first.runId, connectionId: sshId },
        ],
        [
          "ssh-authority-invalidated",
          { runId: second.runId, connectionId: sshId },
        ],
      ]),
    );

    const selectors = {
      threadId: first.threadId,
      protocol: "vnc" as const,
      connectionId: desktop.body.id,
    };
    for (const [change, recipients, available] of [
      [
        () => {
          return vnc.enableDefault(owner, "vnc", desktop.body.id);
        },
        [first, second],
        [true, true],
      ],
      [
        () => {
          return accept(
            remote().setThreadOverride({
              headers: vncSessionHeaders,
              params: selectors,
              body: { enabled: false },
            }),
            [200],
          );
        },
        [first],
        [false, true],
      ],
      [
        () => {
          return accept(
            remote().clearThreadOverride({
              headers: vncSessionHeaders,
              params: selectors,
            }),
            [200],
          );
        },
        [first],
        [true, true],
      ],
      [
        () => {
          return vnc.setDefault(owner, "vnc", desktop.body.id, false);
        },
        [first, second],
        [false, false],
      ],
    ] as const) {
      vnc.authenticate(owner);
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      await change();
      expect(context.mocks.ably.publish.mock.calls).toHaveLength(
        recipients.length + 1,
      );
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
        expect.arrayContaining([
          ["ssh:changed", { orgId: owner.orgId }],
          ...recipients.map((run) => {
            return [
              "vnc-authority-invalidated",
              { runId: run.runId, connectionId: desktop.body.id },
            ];
          }),
        ]),
      );
      expect(
        channelsPublishedTo(context.mocks, "ssh-authority-invalidated"),
      ).toStrictEqual([]);
      expect(
        channelsPublishedTo(context.mocks, "vnc-authority-invalidated"),
      ).toStrictEqual(
        recipients.map(() => {
          return `runner-group:${group}`;
        }),
      );
      for (const [index, run] of [first, second].entries()) {
        const authority = await vnc.resolve({
          ...run,
          connectionId: desktop.body.id,
        });
        expect(authority.outcome).toBe(
          available[index] ? "resolved_transport" : "unavailable",
        );
        const ssh = await accept(
          setupApp({ context, routes: runnerSshRoutes })(
            runnerSshContract,
          ).resolve({
            headers: vncRunnerHeaders,
            params: { runId: run.runId },
            body: { connectionId: sshId, runnerIdentity: run.runnerIdentity },
          }),
          [200],
        );
        expect(ssh.body.outcome).toBe("resolved");
      }
      for (const run of [first, second, otherUser, otherOrg]) {
        await expect(
          runs.readRun(bdd.user({ ...run, orgRole: "org:member" }), run.runId),
        ).resolves.toMatchObject({ status: "running" });
      }
    }
  });
});
