import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { phoneUseContract as contract } from "@okouai/api-contracts/contracts/phone-use";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { phoneUseRoutes } from "../phone-use";

const context = testContext();
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
describe("Phone Use native connection authority", () => {
  it("replaces a connection without allowing its previous generation to become ready", async () => {
    authenticate();
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
  it("keeps device ownership private and prevents another account from disconnecting it", async () => {
    authenticate();
    const client = api();
    const registered = await accept(client.register({ headers, body }), [200]);
    authenticate();
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
  it("requires a native session and internal organization for device admission", async () => {
    authenticate(undefined, `org_external_${randomUUID()}`);
    const rejected = await accept(api().register({ headers, body }), [403]);
    expect(rejected.body.error.message).toContain("internal");
    authenticate();
    context.mocks.clerk.sessions.getSession.mockResolvedValue({
      id: "retired",
      userId: "another-user",
      status: "revoked",
    });
    await accept(api().register({ headers, body }), [403]);
  });
});

test(
  "binds real Run tokens to a replaceable chat grant and validates every native commit",
  { timeout: 30_000 },
  async () => {
    const scenario = createPublicComputerUseScenario(context);
    const actor = scenario.user({ orgId: staffOrg });
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
    const device = await scenario.run(() => {
      authenticate(actor.userId, staffOrg, sessionId);
      return accept(client.register({ headers, body }), [200]);
    });
    const params = { deviceId: device.body.id };
    const generation = device.body.generation;
    await scenario.run(async () => {
      authenticate(actor.userId, staffOrg, sessionId);
      await accept(
        client.grant({
          headers,
          body: { ...params, generation, threadId: thread.id, allow: true },
        }),
        [200],
      );
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
    const id = randomUUID();
    const action = { kind: "observe" as const };
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
      authenticate(actor.userId, staffOrg, sessionId);
      return accept(
        client.next({ headers, params, body: { generation } }),
        [200],
      );
    });
    expect(claimed.body.operation).toMatchObject({ id, status: "running" });
    await scenario.run(async () => {
      authenticate(actor.userId, staffOrg, sessionId);
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
    const pending = await scenario.run(() => {
      return accept(
        client.get({ headers: agentHeaders, params: { operationId: id } }),
        [200],
      );
    });
    expect(pending.body.status).toBe("approval_required");
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
      authenticate(actor.userId, staffOrg, sessionId);
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
      authenticate(actor.userId, staffOrg, sessionId);
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
  },
);
