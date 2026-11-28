import { randomUUID } from "node:crypto";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
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
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:member",
  );
}

function runnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

const sshApp = () => {
  return setupApp({ context, routes: sshConnectionsRoutes });
};
const hosts = () => {
  return sshApp()(sshConnectionsContract);
};
const logins = () => {
  return sshApp()(sshCredentialsContract);
};
const remoteAccess = () => {
  return setupApp({ context, routes: chatRemoteAccessRoutes })(
    chatRemoteAccessContract,
  );
};
const runnerSsh = () => {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
};

async function createMemberWithHost(initialPassword: string) {
  const actor: Actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await clerkDirectory.set(
    seedOrgMembership$,
    { ...actor, role: "member" },
    context.signal,
  );
  signIn(actor);
  const credential = (
    await accept(
      logins().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Operations",
          username: "deploy",
          authentication: { method: "password", password: initialPassword },
        },
      }),
      [201],
    )
  ).body;
  const host = (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Primary SSH",
          host: "ssh.example.com",
          port: 22,
          credential: { id: credential.id },
        },
      }),
      [201],
    )
  ).body;
  return { actor, credential, host };
}

async function enableAndResolveOnRun(actor: Actor, connectionId: string) {
  const fixture = createChatEventsFixture(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const apiUser: ApiTestUser = bdd.user({
    userId: actor.userId,
    orgId: actor.orgId,
    orgRole: "org:member",
  });
  const owner = publicRunOwner(context, apiUser);
  fixture.chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();

  signIn(actor);
  await Promise.all([
    accept(
      remoteAccess().updateHostDefault({
        headers,
        params: { protocol: "ssh", connectionId },
        body: { enabled: true },
      }),
      [200],
    ),
    runs.configureRunnerGroup(),
    owner.run(() => {
      return bdd.bootstrapLimitedFreeOnboarding(apiUser);
    }),
  ]);

  const launched = await owner.run(() => {
    return fixture.sendChatRun(apiUser, {
      prompt: "Resolve my SSH host after credential rotation",
      model: null,
    });
  });
  await owner.executionInput(launched.runId);
  const dispatched = runs.dispatchedRun(launched.runId);
  const resolved = await accept(
    runnerSsh().resolve({
      headers: runnerHeaders(),
      params: { runId: launched.runId },
      body: {
        connectionId,
        runnerIdentity: {
          runnerId: dispatched.runnerId,
          heartbeatGeneration: dispatched.heartbeatGeneration,
        },
      },
    }),
    [200],
  );
  return resolved.body;
}

describe("SSH host edits overlapping credential rotation", () => {
  beforeAll(() => {
    setupApp({
      context,
      routes: [
        ...sshConnectionsRoutes,
        ...chatRemoteAccessRoutes,
        ...runnerSshRoutes,
      ],
    });
  });

  it(
    "ssh-credential-rotation-race-002 keeps the published credential usable with host first ordering",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const hold: { callNumber: number | undefined } = {
        callNumber: undefined,
      };
      const enteredKms = createDeferredPromise<void>(context.signal);
      const releaseKms = createDeferredPromise<void>(context.signal);
      const kms = useSecretKmsProbe((request, callNumber) => {
        if (callNumber !== hold.callNumber) {
          return undefined;
        }
        return (async () => {
          enteredKms.resolve();
          await releaseKms.promise;
          return {
            keyId: request.keyId,
            plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
            encryptedDataKey: Buffer.from(
              `encrypted-data-key:${request.keyId}`,
              "utf8",
            ),
          };
        })();
      });

      const initialPassword = `pw-init-${randomUUID()}`;
      const rotatedPassword = `pw-rot-${randomUUID()}`;
      const { actor, credential, host } =
        await createMemberWithHost(initialPassword);

      hold.callNumber = kms.generateDataKeyCalls + 1;
      signIn(actor);
      const rotationPromise = accept(
        logins().update({
          headers,
          params: { credentialId: credential.id },
          body: {
            expectedRevision: credential.revision,
            username: "rotated-user",
            authentication: { method: "password", password: rotatedPassword },
          },
        }),
        [200],
      );
      await enteredKms.promise;

      const hostRename = await accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: host.generation,
            displayName: "Edited",
          },
        }),
        [200],
      );
      releaseKms.resolve();
      const rotation = await rotationPromise;

      expect(hostRename.status).toBe(200);
      expect(rotation.status).toBe(200);

      const [listedHosts, listedCredentials] = await Promise.all([
        accept(hosts().list({ headers }), [200]),
        accept(logins().list({ headers }), [200]),
      ]);
      expect(listedHosts.body.connections).toStrictEqual([
        expect.objectContaining({
          id: host.id,
          displayName: "Edited",
          username: "rotated-user",
          generation: host.generation + 2,
        }),
      ]);
      expect(listedCredentials.body.credentials).toStrictEqual([
        expect.objectContaining({
          id: credential.id,
          username: "rotated-user",
          revision: credential.revision + 1,
          hosts: [{ id: host.id, displayName: "Edited" }],
        }),
      ]);

      const resolved = await enableAndResolveOnRun(actor, host.id);
      expect(resolved).toStrictEqual({
        outcome: "resolved_password",
        host: "ssh.example.com",
        port: 22,
        username: "rotated-user",
        generation: host.generation + 2,
        learnedHostKey: null,
        password: rotatedPassword,
      });
    },
  );

  it(
    "ssh-credential-rotation-race-003 keeps the published credential usable with rotation first ordering",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      useSecretKmsProbe();
      const initialPassword = `pw-init-${randomUUID()}`;
      const { actor, credential, host } =
        await createMemberWithHost(initialPassword);

      const enteredAuth = createDeferredPromise<void>(context.signal);
      const releaseAuth = createDeferredPromise<void>(context.signal);
      signIn(actor);
      context.mocks.clerk.authenticateRequest.mockImplementationOnce(
        async () => {
          enteredAuth.resolve();
          await releaseAuth.promise;
          return {
            isAuthenticated: true,
            toAuth: () => {
              return {
                userId: actor.userId,
                orgId: actor.orgId,
                orgRole: "org:member",
              };
            },
          };
        },
      );

      const stalledHostEdit = accept(
        hosts().update({
          headers,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: host.generation,
            displayName: "Edited",
          },
        }),
        [409],
      );
      await enteredAuth.promise;

      const rotation = await accept(
        logins().update({
          headers,
          params: { credentialId: credential.id },
          body: {
            expectedRevision: credential.revision,
            username: "rotated-user",
          },
        }),
        [200],
      );
      releaseAuth.resolve();
      const staleEdit = await stalledHostEdit;

      expect(rotation.status).toBe(200);
      expect(staleEdit.status).toBe(409);
      expect(staleEdit.body).toMatchObject({
        error: { code: "SSH_GENERATION_CONFLICT" },
      });

      const [listedHosts, listedCredentials] = await Promise.all([
        accept(hosts().list({ headers }), [200]),
        accept(logins().list({ headers }), [200]),
      ]);
      expect(listedHosts.body.connections).toStrictEqual([
        expect.objectContaining({
          id: host.id,
          displayName: host.displayName,
          username: "rotated-user",
          generation: host.generation + 1,
        }),
      ]);
      expect(listedCredentials.body.credentials).toStrictEqual([
        expect.objectContaining({
          id: credential.id,
          username: "rotated-user",
          revision: credential.revision + 1,
        }),
      ]);

      const resolved = await enableAndResolveOnRun(actor, host.id);
      expect(resolved).toStrictEqual({
        outcome: "resolved_password",
        host: "ssh.example.com",
        port: 22,
        username: "rotated-user",
        generation: host.generation + 1,
        learnedHostKey: null,
        password: initialPassword,
      });
    },
  );
});
