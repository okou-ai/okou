import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createDeferredPromise, joinAll, onRejection } from "../../utils";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createClaimedSshRuntimeApi } from "./helpers/claimed-ssh-runtime";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const runnerSecret = "b".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
const credentials = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};
const connections = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};

describe("SSH host edits overlapping credential rotation", () => {
  const ordinary = createClaimedSshRuntimeApi(context, {
    runnerHeaders,
    authenticate: (owner) => {
      mocks.clerk.session(owner.userId, owner.orgId);
    },
  });
  afterEach(async () => {
    await ordinary.cleanup();
  });

  it.each(["uncontrolled", "host first", "rotation first"] as const)(
    "keeps the published credential usable with %s ordering",
    async (ordering) => {
      useSecretKmsProbe();
      const owner = {
        orgId: `org_ssh_${randomUUID()}`,
        userId: `user_ssh_${randomUUID()}`,
      };
      mocks.clerk.session(owner.userId, owner.orgId);
      const password = "  original-password-canary\n";
      const rotatedPassword = "  rotated-password-canary\n";
      const created = await accept(
        credentials().create({
          headers,
          body: {
            id: randomUUID(),
            name: "Operations",
            username: "deploy",
            authentication: { method: "password", password },
          },
        }),
        [201],
      );
      const host = await accept(
        connections().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Original",
            host: "ssh.example.com",
            credential: { id: created.body.id },
          },
        }),
        [201],
      );
      const edit = () => {
        return connections().update({
          headers,
          params: { connectionId: host.body.id },
          body: {
            expectedGeneration: host.body.generation,
            displayName: "Edited",
          },
        });
      };
      const rotate = () => {
        return credentials().update({
          headers,
          params: { credentialId: created.body.id },
          body: {
            expectedRevision: created.body.revision,
            username: "rotated-user",
            // Keep the original username-only race; KMS gates the host-first case.
            ...(ordering === "host first"
              ? {
                  authentication: {
                    method: "password" as const,
                    password: rotatedPassword,
                  },
                }
              : {}),
          },
        });
      };
      const [edited, rotated] = await (async () => {
        if (ordering === "uncontrolled") {
          return await joinAll([
            accept(edit(), [200, 409]),
            accept(rotate(), [200, 409]),
          ]);
        }
        const entered = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        const releaseOnFailure = () => {
          if (!release.settled()) {
            release.resolve();
          }
        };
        const rejectEntry = (error: unknown) => {
          if (!entered.settled()) {
            entered.reject(error);
          }
        };
        if (ordering === "host first") {
          useSecretKmsProbe(async (request) => {
            entered.resolve();
            await release.promise;
            return {
              keyId: request.keyId,
              plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
              encryptedDataKey: Buffer.from("test-wrapped-key"),
            };
          });
          return await joinAll([
            onRejection(
              (async () => {
                await entered.promise;
                const result = await accept(edit(), [200]);
                release.resolve();
                return result;
              })(),
              releaseOnFailure,
            ),
            onRejection(accept(rotate(), [200]), rejectEntry),
          ]);
        }
        context.mocks.clerk.authenticateRequest.mockImplementationOnce(
          async () => {
            entered.resolve();
            await release.promise;
            return {
              isAuthenticated: true,
              toAuth: () => {
                return { ...owner, orgRole: "org:admin" };
              },
            };
          },
        );
        return await joinAll([
          onRejection(accept(edit(), [409]), rejectEntry),
          onRejection(
            (async () => {
              await entered.promise;
              const result = await accept(rotate(), [200]);
              release.resolve();
              return result;
            })(),
            releaseOnFailure,
          ),
        ]);
      })();
      // The ordering gate belongs only to rotation, not later Run setup encryption.
      useSecretKmsProbe();
      // A conflict rejects publication; it must not partially rotate the credential.
      expect(edited.status === 200 || rotated.status === 200).toBeTruthy();
      if (edited.status === 409) {
        expect(edited.body.error.code).toBe("SSH_GENERATION_CONFLICT");
      }
      if (rotated.status === 409) {
        expect(rotated.body.error.code).toBe(
          "SSH_CREDENTIAL_REVISION_CONFLICT",
        );
      }
      const username =
        rotated.status === 200 ? "rotated-user" : created.body.username;
      const displayName =
        edited.status === 200 ? "Edited" : host.body.displayName;
      const generation =
        host.body.generation +
        Number(edited.status === 200) +
        Number(rotated.status === 200);
      const listed = await accept(connections().list({ headers }), [200]);
      expect(listed.body.connections).toStrictEqual([
        {
          ...host.body,
          displayName,
          username,
          generation,
          updatedAt: expect.any(String),
        },
      ]);
      const current = await accept(credentials().list({ headers }), [200]);
      expect(current.body.credentials).toStrictEqual([
        {
          ...created.body,
          username,
          revision: created.body.revision + Number(rotated.status === 200),
          updatedAt:
            rotated.status === 200
              ? rotated.body.updatedAt
              : created.body.updatedAt,
          hosts: [{ id: host.body.id, displayName }],
        },
      ]);

      await accept(
        setupApp({ context, routes: chatRemoteAccessRoutes })(
          chatRemoteAccessContract,
        ).updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: host.body.id },
          body: { enabled: true },
        }),
        [200],
      );
      mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
      const runtime = await ordinary.runtime(owner);
      const resolved = await accept(
        setupApp({ context, routes: runnerSshRoutes })(
          runnerSshContract,
        ).resolve({
          headers: runnerHeaders,
          params: { runId: runtime.runId },
          body: {
            connectionId: host.body.id,
            runnerIdentity: runtime.runnerIdentity,
          },
        }),
        [200],
      );
      expect(resolved.body).toStrictEqual({
        outcome: "resolved_password",
        host: host.body.host,
        port: host.body.port,
        username,
        generation,
        learnedHostKey: null,
        password: ordering === "host first" ? rotatedPassword : password,
      });
    },
  );
});
