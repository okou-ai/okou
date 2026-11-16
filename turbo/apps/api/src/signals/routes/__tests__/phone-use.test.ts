import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { phoneUseContract as contract } from "@okouai/api-contracts/contracts/phone-use";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { phoneUseRoutes } from "../phone-use";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitchesRoutes } from "../feature-switches";

const context = testContext();
afterEach(clearMockNow);
const staffOrg = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const headers = Object.freeze({ authorization: "Bearer native-session" });
function authenticate(
  userId = `user_${randomUUID()}`,
  orgId = staffOrg,
  sessionId = `sess_${randomUUID()}`,
) {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { userId, orgId, sessionId, orgRole: "org:admin" };
    },
  });
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: sessionId,
    userId,
    status: "active",
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          organization: { id: orgId },
          publicUserData: { userId },
          role: "org:admin",
        },
      ],
      totalCount: 1,
    },
  );
  return { userId, orgId, sessionId };
}
const body = Object.freeze({
  installationId: randomUUID(),
  displayName: "Owner iPhone",
  osVersion: "27.1",
  appVersion: "1" as const,
  protocolVersion: 1 as const,
});
function api() {
  return setupApp({ context, routes: phoneUseRoutes })(contract);
}
function featureApi() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}
function setPhoneUse(enabled: boolean) {
  return accept(
    featureApi().update({
      headers,
      body: { switches: { [FeatureSwitchKey.PhoneUse]: enabled } },
    }),
    [200],
  );
}
describe("Phone Use native connection authority", () => {
  it("replaces a connection without allowing its previous generation to become ready", async () => {
    authenticate();
    await setPhoneUse(true);
    const client = api();
    const first = await accept(client.register({ headers, body }), [200]);
    await accept(
      client.heartbeat({
        headers,
        params: { deviceId: first.body.id },
        body: { generation: first.body.generation, ready: true },
      }),
      [200],
    );
    const second = await accept(client.register({ headers, body }), [200]);
    expect(second.body).toMatchObject({
      id: first.body.id,
      generation: first.body.generation + 1,
      ready: false,
    });
    await accept(
      client.heartbeat({
        headers,
        params: { deviceId: first.body.id },
        body: { generation: first.body.generation, ready: true },
      }),
      [409],
    );
    const listed = await accept(client.devices({ headers }), [200]);
    expect(listed.body.devices).toStrictEqual([
      expect.objectContaining({ id: first.body.id, ready: false }),
    ]);
  });
  it("fences a delayed disconnect after a replacement connection becomes ready", async () => {
    const actor = authenticate();
    await setPhoneUse(true);
    const client = api();
    const first = await accept(client.register({ headers, body }), [200]);
    const entered = createDeferredPromise<void>(context.signal),
      release = createDeferredPromise<void>(context.signal);
    context.mocks.clerk.sessions.getSession.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { id: actor.sessionId, userId: actor.userId, status: "active" };
    });
    const pending = client.disconnect({
      headers,
      params: { deviceId: first.body.id },
      body: { generation: first.body.generation },
    });
    await entered.promise;
    const replacement = await settleIncludingAbort(async () => {
      const registered = await accept(
        client.register({ headers, body }),
        [200],
      );
      await accept(
        client.heartbeat({
          headers,
          params: { deviceId: registered.body.id },
          body: { generation: registered.body.generation, ready: true },
        }),
        [200],
      );
      return registered.body;
    });
    release.resolve();
    const disconnected = await settleIncludingAbort(pending);
    if (!replacement.ok) {
      throw replacement.error;
    }
    if (!disconnected.ok) {
      throw disconnected.error;
    }
    expect(disconnected.value.status).toBe(409);
    const listed = await accept(client.devices({ headers }), [200]);
    expect(listed.body.devices).toStrictEqual([
      expect.objectContaining({
        id: first.body.id,
        generation: replacement.value.generation,
        ready: true,
      }),
    ]);
  });
  it("keeps device ownership private and prevents another account from disconnecting it", async () => {
    authenticate();
    await setPhoneUse(true);
    const client = api();
    const registered = await accept(client.register({ headers, body }), [200]);
    authenticate();
    await setPhoneUse(true);
    const other = await accept(client.devices({ headers }), [200]);
    expect(other.body.devices).toStrictEqual([]);
    await accept(
      client.disconnect({
        headers,
        params: { deviceId: registered.body.id },
        body: { generation: registered.body.generation },
      }),
      [409],
    );
  });
  it.each([
    { name: "a staff organization", orgId: staffOrg },
    { name: "another organization", orgId: `org_${randomUUID()}` },
  ])(
    "requires explicit opt-in and a live native session in $name",
    async ({ orgId }) => {
      authenticate(undefined, orgId);
      const initial = await accept(featureApi().get({ headers }), [200]);
      expect(
        initial.body.effectiveSwitches[FeatureSwitchKey.PhoneUse],
      ).toBeFalsy();
      const disabled = await accept(api().register({ headers, body }), [403]);
      expect(disabled.body.error.message).toContain("disabled");

      const enabled = await setPhoneUse(true);
      expect(
        enabled.body.effectiveSwitches[FeatureSwitchKey.PhoneUse],
      ).toBeTruthy();
      const registered = await accept(api().register({ headers, body }), [200]);

      await setPhoneUse(false);
      await accept(api().devices({ headers }), [403]);
      // Turning the feature off must still let the owner retire the connection.
      await accept(
        api().disconnect({
          headers,
          params: { deviceId: registered.body.id },
          body: { generation: registered.body.generation },
        }),
        [200],
      );

      await setPhoneUse(true);
      context.mocks.clerk.sessions.getSession.mockResolvedValue({
        id: "retired",
        userId: "another-user",
        status: "revoked",
      });
      await accept(api().register({ headers, body }), [403]);
    },
  );
});

test("chat consent stays owner-scoped and can be revoked without native readiness", async () => {
  const scenario = createPublicComputerUseScenario(context);
  const orgId = `org_${randomUUID()}`;
  const actor = scenario.user({ orgId });
  const setup = await scenario.prepareActor(actor);
  const chat = createChatFilesBddApi(context);
  const thread = await scenario.run(() => {
    return chat.createThread(actor, { agentId: setup.agentId });
  });
  const nativeSession = `sess_native_${randomUUID()}`;
  const client = api();
  const registered = await scenario.run(async () => {
    authenticate(actor.userId, orgId, nativeSession);
    await setPhoneUse(true);
    return accept(client.register({ headers, body }), [200]);
  });
  const selection = {
    deviceId: registered.body.id,
    generation: registered.body.generation,
  };
  await scenario.run(async () => {
    authenticate(actor.userId, orgId, `sess_web_${randomUUID()}`);
    context.mocks.clerk.sessions.getSession.mockResolvedValue({
      id: nativeSession,
      userId: actor.userId,
      status: "active",
    });
    await accept(
      client.grant({
        headers,
        body: {
          ...selection,
          generation: selection.generation + 1,
          threadId: thread.id,
          allow: true,
        },
      }),
      [404],
    );
    await accept(
      client.grant({
        headers,
        body: { ...selection, threadId: thread.id, allow: true },
      }),
      [200],
    );
    const current = await accept(
      client.chatGrant({ headers, params: { threadId: thread.id } }),
      [200],
    );
    expect(current.body.selection).toStrictEqual(selection);
  });
  await scenario.run(async () => {
    authenticate(undefined, orgId);
    await setPhoneUse(true);
    await accept(
      client.chatGrant({ headers, params: { threadId: thread.id } }),
      [404],
    );
    await accept(
      client.grant({
        headers,
        body: { ...selection, threadId: thread.id, allow: true },
      }),
      [404],
    );
  });
  await scenario.run(async () => {
    authenticate(actor.userId, orgId, `sess_web_${randomUUID()}`);
    context.mocks.clerk.sessions.getSession.mockResolvedValue({
      id: nativeSession,
      userId: actor.userId,
      status: "revoked",
    });
    await accept(
      client.grant({
        headers,
        body: { ...selection, threadId: thread.id, allow: true },
      }),
      [403],
    );
    await setPhoneUse(false);
    await accept(
      client.grant({
        headers,
        body: { ...selection, threadId: thread.id, allow: false },
      }),
      [200],
    );
    const revoked = await accept(
      client.chatGrant({ headers, params: { threadId: thread.id } }),
      [200],
    );
    expect(revoked.body.selection).toBeNull();
  });
});

test(
  "binds real Run tokens to a replaceable chat grant and validates every native commit",
  { timeout: 30_000 },
  async () => {
    const orgId = `org_${randomUUID()}`;
    const scenario = createPublicComputerUseScenario(context);
    const actor = scenario.user({ orgId });
    const setup = await scenario.prepareActor(actor);
    const chat = createChatFilesBddApi(context);
    const thread = await scenario.run(() => {
      return chat.createThread(actor, {
        agentId: setup.agentId,
        title: "Phone task",
      });
    });
    const sessionId = `sess_${randomUUID()}`;
    const client = api();
    const device = await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await setPhoneUse(true);
      return accept(client.register({ headers, body }), [200]);
    });
    const params = { deviceId: device.body.id };
    const generation = device.body.generation;
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, `sess_web_${randomUUID()}`);
      context.mocks.clerk.sessions.getSession.mockResolvedValue({
        id: sessionId,
        userId: actor.userId,
        status: "active",
      });
      await accept(
        client.grant({
          headers,
          body: { ...params, generation, threadId: thread.id, allow: true },
        }),
        [200],
      );
      const selection = await accept(
        client.chatGrant({ headers, params: { threadId: thread.id } }),
        [200],
      );
      expect(selection.body.selection).toStrictEqual({
        deviceId: device.body.id,
        generation,
      });
      // Browser consent must not become device lifecycle authority.
      await accept(
        client.heartbeat({
          headers,
          params,
          body: { generation, ready: true },
        }),
        [409],
      );
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.heartbeat({
          headers,
          params,
          body: { generation, ready: true },
        }),
        [200],
      );
    });
    const run = await scenario.launchRun(actor, undefined, thread.id);
    const agentHeaders = { authorization: `Bearer ${run.token}` };
    await scenario.run(async () => {
      // Retrying the same owner selection preserves the Run's captured grant.
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.grant({
          headers,
          body: { ...params, generation, threadId: thread.id, allow: true },
        }),
        [200],
      );
      await accept(
        client.grant({
          headers: agentHeaders,
          body: { ...params, generation, threadId: thread.id, allow: true },
        }),
        [403],
      );
    });
    const id = randomUUID();
    const action = {
      kind: "tap" as const,
      app: "com.example.notes",
      snapshotId: randomUUID(),
      elementId: "0",
      confirmation: "Send the reviewed message",
    };
    const submitted = await scenario.run(() => {
      return accept(
        client.create({ headers: agentHeaders, body: { id, action } }),
        [200],
      );
    });
    expect(submitted.body).toMatchObject({
      id,
      runId: run.runId,
      deviceId: device.body.id,
      status: "queued",
    });
    const duplicate = await scenario.run(() => {
      return accept(
        client.create({ headers: agentHeaders, body: { id, action } }),
        [200],
      );
    });
    expect(duplicate.body.id).toBe(id);
    await scenario.run(() => {
      return accept(
        client.create({
          headers: agentHeaders,
          body: { id, action: { kind: "session.stop" } },
        }),
        [409],
      );
    });
    const claimed = await scenario.run(() => {
      authenticate(actor.userId, orgId, sessionId);
      return accept(
        client.next({
          headers,
          params,
          body: { generation },
        }),
        [200],
      );
    });
    expect(claimed.body.operation).toMatchObject({ id, status: "running" });
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.validate({
          headers,
          params,
          body: { generation, operationId: id },
        }),
        [200],
      );
      await accept(
        client.complete({
          headers,
          params,
          body: {
            generation,
            operationId: id,
            result: {
              status: "approval_required",
              data: { target: "Send" },
              screenshotBase64: "iVBORw0KGgo=",
            },
          },
        }),
        [200],
      );
    });
    const pending = await scenario.run(() => {
      return accept(
        client.get({ headers: agentHeaders, params: { operationId: id } }),
        [200],
      );
    });
    expect(pending.body.status).toBe("approval_required");
    expect(pending.body.result).toMatchObject({
      target: "Send",
      screenshotPhase: "before_input",
    });
    // Review remains possible after the ordinary 45-second dispatch deadline.
    mockNow(new Date(submitted.body.expiresAt).getTime() + 15_000);
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.validate({
          headers,
          params,
          body: { generation, operationId: id },
        }),
        [200],
      );
      await accept(
        client.complete({
          headers,
          params,
          body: {
            generation,
            operationId: id,
            result: { status: "approval_required", data: { target: "Send" } },
          },
        }),
        [200],
      );
    });
    const repeated = await scenario.run(() => {
      return accept(
        client.get({ headers: agentHeaders, params: { operationId: id } }),
        [200],
      );
    });
    expect(repeated.body.expiresAt).toBe(pending.body.expiresAt);
    mockNow(new Date(pending.body.expiresAt).getTime() + 1);
    const uncertain = await scenario.run(() => {
      return accept(
        client.get({ headers: agentHeaders, params: { operationId: id } }),
        [200],
      );
    });
    expect(uncertain.body.status).toBe("unknown");
    // A native result that arrives after review expiry cannot turn uncertainty
    // into a failure that invites replay, or overwrite the settled receipt.
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.complete({
          headers,
          params,
          body: {
            generation,
            operationId: id,
            result: {
              status: "succeeded",
              data: { nativeAcknowledged: true, outcomeVerified: false },
            },
          },
        }),
        [200],
      );
    });
    const lateReceipt = await scenario.run(() => {
      return accept(
        client.get({ headers: agentHeaders, params: { operationId: id } }),
        [200],
      );
    });
    expect(lateReceipt.body.status).toBe("unknown");
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.validate({
          headers,
          params,
          body: { generation, operationId: id },
        }),
        [403],
      );
    });
    const loggedOut = await scenario.run(() => {
      context.mocks.clerk.sessions.getSession.mockResolvedValue({
        id: sessionId,
        userId: actor.userId,
        status: "revoked",
      });
      return accept(
        client.get({ headers: agentHeaders, params: { operationId: id } }),
        [403],
      );
    });
    expect(loggedOut.body.error.message).toContain("session has ended");
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.grant({
          headers,
          body: { ...params, generation, threadId: thread.id, allow: false },
        }),
        [200],
      );
      await accept(
        client.grant({
          headers,
          body: { ...params, generation, threadId: thread.id, allow: true },
        }),
        [200],
      );
      await accept(
        client.validate({
          headers,
          params,
          body: { generation, operationId: id },
        }),
        [403],
      );
    });
    const retired = await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      return await accept(
        client.next({
          headers,
          params,
          body: {
            generation,
            activeRunId: run.runId,
            activeGrantId: submitted.body.grantId,
          },
        }),
        [200],
      );
    });
    expect(retired.body).toMatchObject({ operation: null, sessionEnded: true });
    const stale = await scenario.run(() => {
      return accept(
        client.create({
          headers: agentHeaders,
          body: { id: randomUUID(), action },
        }),
        [403],
      );
    });
    expect(stale.body.error.message).toContain("grant");
    // A completed/replaced Run must not leave a pending approval blocking the phone.
    const following = await scenario.launchRun(actor, undefined, thread.id);
    const followingHeaders = { authorization: `Bearer ${following.token}` };
    const followingId = randomUUID();
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.heartbeat({
          headers,
          params,
          body: { generation, ready: true },
        }),
        [200],
      );
    });
    await scenario.run(() => {
      return accept(
        client.create({
          headers: followingHeaders,
          body: { id: followingId, action: { kind: "observe" } },
        }),
        [200],
      );
    });
    const nextTask = await scenario.run(() => {
      authenticate(actor.userId, orgId, sessionId);
      return accept(
        client.next({
          headers,
          params,
          body: { generation, threadId: thread.id },
        }),
        [200],
      );
    });
    expect(nextTask.body.operation).toMatchObject({
      id: followingId,
      runId: following.runId,
      status: "running",
    });
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.complete({
          headers,
          params,
          body: {
            generation,
            operationId: followingId,
            result: {
              status: "succeeded",
              data: { bundleID: "com.apple.Preferences" },
            },
          },
        }),
        [200],
      );
    });
    const recovered = await scenario.run(() => {
      return accept(
        client.get({
          headers: followingHeaders,
          params: { operationId: followingId },
        }),
        [200],
      );
    });
    expect(recovered.body).toMatchObject({
      status: "succeeded",
      result: { bundleID: "com.apple.Preferences" },
    });
    const reviewId = randomUUID();
    await scenario.run(() => {
      return accept(
        client.create({
          headers: followingHeaders,
          body: { id: reviewId, action },
        }),
        [200],
      );
    });
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.next({
          headers,
          params,
          body: { generation, threadId: thread.id },
        }),
        [200],
      );
      await accept(
        client.complete({
          headers,
          params,
          body: {
            generation,
            operationId: reviewId,
            result: { status: "approval_required", data: { target: "Send" } },
          },
        }),
        [200],
      );
    });
    const stopped = await scenario.run(() => {
      return accept(
        client.create({
          headers: followingHeaders,
          body: { id: randomUUID(), action: { kind: "session.stop" } },
        }),
        [200],
      );
    });
    expect(stopped.body).toMatchObject({
      status: "succeeded",
      result: { admissionClosed: true, nativeAcknowledged: false },
    });
    await scenario.run(async () => {
      authenticate(actor.userId, orgId, sessionId);
      await accept(
        client.validate({
          headers,
          params,
          body: { generation, operationId: reviewId },
        }),
        [403],
      );
    });
    const closed = await scenario.run(() => {
      return accept(
        client.get({
          headers: followingHeaders,
          params: { operationId: reviewId },
        }),
        [200],
      );
    });
    expect(closed.body.status).toBe("unknown");
    const stopSignal = await scenario.run(() => {
      authenticate(actor.userId, orgId, sessionId);
      return accept(
        client.next({
          headers,
          params,
          body: {
            generation,
            threadId: thread.id,
            activeRunId: following.runId,
            activeGrantId: stopped.body.grantId,
          },
        }),
        [200],
      );
    });
    expect(stopSignal.body).toMatchObject({
      operation: null,
      sessionEnded: true,
      stopRequested: true,
    });
    await scenario.run(() => {
      return accept(
        client.create({
          headers: followingHeaders,
          body: { id: randomUUID(), action: { kind: "observe" } },
        }),
        [409],
      );
    });
  },
);
