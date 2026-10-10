import type { BuiltinConnectorExternalCodeSessionStartResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";

const context = testContext();
const connectors = createConnectorBddApi(context);
const tokenUrl = "https://us-east-1.signin.aws.amazon.com/v1/token";
const rejectedCodeMessage =
  "External-code authorization code was rejected. Check it and try again.";

function createActor(beforeDrain?: () => void) {
  return createPublicConnectorActor(context, {
    beforeDrain,
    beforeWorkspaceCleanup: () => {
      clearMockNow();
      return Promise.resolve();
    },
  });
}

function completionInput(
  session: BuiltinConnectorExternalCodeSessionStartResponse,
  code = "AWS-CODE",
) {
  return {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    code: awsVerificationCode(session.authorizationUrl, code),
  };
}

function expectNoSecrets(body: unknown, sessionToken: string): void {
  const serialized = JSON.stringify(body);
  for (const secret of [
    sessionToken,
    "aws-secret-access-key",
    "aws-login-refresh-token",
    "aws-session-token",
    "aws-id-token",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

async function completeSession(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
) {
  const completed = await connectors.completeExternalCode(
    actor,
    "aws",
    completionInput(session),
  );
  expect(completed).toMatchObject({
    status: "complete",
    connector: {
      slug: "aws",
      authMethod: "cli",
      connectionStatus: "connected",
    },
  });
  expectNoSecrets(completed, session.sessionToken);
  return completed;
}

async function expectAccounts(
  actor: ApiTestUser,
  expected: readonly { readonly id: string; readonly isDefault: boolean }[],
): Promise<void> {
  const accounts = await connectors.listBuiltinConnectorAccounts(actor, "aws");
  const byId = (
    left: { readonly id: string },
    right: { readonly id: string },
  ) => {
    return left.id.localeCompare(right.id);
  };
  expect(
    accounts
      .map(({ id, isDefault }) => {
        return { id, isDefault };
      })
      .sort(byId),
  ).toStrictEqual([...expected].sort(byId));
}

function mockHttpFailure(status: number): void {
  server.use(
    http.post(
      tokenUrl,
      () => {
        return HttpResponse.json(
          { error: "temporarily_unavailable" },
          { status },
        );
      },
      { once: true },
    ),
  );
}

function holdHttpFailure(status: 400 | 503) {
  const started = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const release = () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
  };
  onTestFinished(release);
  server.use(
    http.post(tokenUrl, async () => {
      if (!started.settled()) {
        started.resolve(undefined);
      }
      await released.promise;
      return HttpResponse.json(
        {
          error: status === 400 ? "invalid_grant" : "temporarily_unavailable",
        },
        { status },
      );
    }),
  );
  return { started: started.promise, release };
}

async function expectExpired(
  actor: ApiTestUser,
  session: BuiltinConnectorExternalCodeSessionStartResponse,
): Promise<void> {
  const response = await connectors.requestExternalCodeComplete(
    actor,
    "aws",
    completionInput(session),
    [400],
  );
  expect(response.body).toStrictEqual({
    error: {
      code: "BAD_REQUEST",
      message: "External-code authorization session expired",
    },
  });
  expectNoSecrets(response.body, session.sessionToken);
}

describe("Builtin external-code claimed completion", () => {
  it("retries HTTP rejections into the exact non-default account and preserves both accounts through completed replay", async () => {
    mockAwsExternalCodeProvider();
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      mockNow(now());
      const defaultSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        { intent: "add" },
      );
      const defaultAccount = await completeSession(actor, defaultSession);
      const siblingSession = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        { intent: "add" },
      );
      const siblingAccount = await completeSession(actor, siblingSession);
      expect(siblingAccount.connector.id).not.toBe(defaultAccount.connector.id);
      const expected = [
        { id: defaultAccount.connector.id, isDefault: true },
        { id: siblingAccount.connector.id, isDefault: false },
      ];
      const reconnect = await connectors.startExternalCode(
        actor,
        "aws",
        "cli",
        {
          intent: "reconnect",
          connectionId: siblingAccount.connector.id,
        },
      );
      const rejected = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(reconnect, "AWS-BAD"),
        [400],
      );
      expect(rejected.body).toStrictEqual({
        error: { code: "BAD_REQUEST", message: rejectedCodeMessage },
      });
      expectNoSecrets(rejected.body, reconnect.sessionToken);
      await expectAccounts(actor, expected);
      for (const status of [429, 503]) {
        mockHttpFailure(status);
        const failed = await connectors.requestExternalCodeComplete(
          actor,
          "aws",
          completionInput(reconnect),
          [500],
        );
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
        expectNoSecrets(failed.body, reconnect.sessionToken);
        await expectAccounts(actor, expected);
      }
      const completed = await completeSession(actor, reconnect);
      expect(completed.connector.id).toBe(siblingAccount.connector.id);
      await expect(completeSession(actor, reconnect)).resolves.toStrictEqual(
        completed,
      );
      await expectAccounts(actor, expected);
      await expect(
        connectors.readConnectorBySlug(actor, "aws"),
      ).resolves.toMatchObject({ id: defaultAccount.connector.id });
    });
  });

  it("keeps malformed provider success terminal and recovers only with a new public session", async () => {
    mockAwsExternalCodeProvider();
    const owned = createActor();
    await owned.run(async () => {
      const actor = owned.actor;
      owned.ownsFeatureSwitches();
      await connectors.updateFeatureSwitches(actor, {});
      const session = await connectors.startExternalCode(actor, "aws", "cli");
      server.use(
        http.post(
          tokenUrl,
          () => {
            return HttpResponse.json({});
          },
          { once: true },
        ),
      );
      const failed = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(session),
        [500],
      );
      expect(failed.body).toStrictEqual({ error: "Internal server error" });
      expectNoSecrets(failed.body, session.sessionToken);
      const terminal = await connectors.requestExternalCodeComplete(
        actor,
        "aws",
        completionInput(session),
        [400],
      );
      expect(terminal.body).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: expect.stringMatching(/^Invalid AWS Sign-In token response/),
        },
      });
      expectNoSecrets(terminal.body, session.sessionToken);
      await expectAccounts(actor, []);
      const recovery = await connectors.startExternalCode(actor, "aws", "cli");
      const completed = await completeSession(actor, recovery);
      await expectAccounts(actor, [
        { id: completed.connector.id, isDefault: true },
      ]);
      await expect(completeSession(actor, recovery)).resolves.toStrictEqual(
        completed,
      );
    });
  });

  it.each([400, 503] as const)(
    "returns the original late provider HTTP %i outcome after strict stale expiry without publishing an account",
    async (status) => {
      mockAwsExternalCodeProvider();
      const provider = holdHttpFailure(status);
      const owned = createActor(provider.release);
      await owned.run(async () => {
        const actor = owned.actor;
        owned.ownsFeatureSwitches();
        await connectors.updateFeatureSwitches(actor, {});
        const startedAt = now();
        mockNow(startedAt);
        const session = await connectors.startExternalCode(actor, "aws", "cli");
        const deadline = startedAt + session.expiresIn * 1000;
        const staleBoundary = startedAt + 30 * 60_000;
        expect(deadline).toBeLessThan(staleBoundary);
        const inFlight = owned.run(() => {
          return connectors.requestExternalCodeComplete(
            actor,
            "aws",
            completionInput(session),
            status === 400 ? [400] : [500],
          );
        });
        onTestFinished(async () => {
          provider.release();
          await inFlight;
        });
        await (async () => {
          await Promise.race([
            provider.started,
            inFlight.then(() => {
              throw new Error(
                "Completion finished before the AWS exchange started",
              );
            }),
          ]);
          mockNow(staleBoundary);
          const exclusive = await connectors.requestExternalCodeComplete(
            actor,
            "aws",
            completionInput(session),
            [400],
          );
          expect(exclusive.body).toStrictEqual({
            error: {
              code: "BAD_REQUEST",
              message:
                "External-code authorization session is already completing",
            },
          });
          mockNow(staleBoundary + 1);
          await expectExpired(actor, session);
          provider.release();
          const late = await inFlight;
          expect(late.status).toBe(status === 400 ? 400 : 500);
          expect(late.body).toStrictEqual(
            status === 400
              ? { error: { code: "BAD_REQUEST", message: rejectedCodeMessage } }
              : { error: "Internal server error" },
          );
          expectNoSecrets(late.body, session.sessionToken);
          await expectExpired(actor, session);
          await expectAccounts(actor, []);
        })().finally(provider.release);
      });
    },
  );
});
