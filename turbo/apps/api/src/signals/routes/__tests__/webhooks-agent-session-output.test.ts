import { randomUUID } from "node:crypto";

import { webhookSessionOutputContract } from "@okouai/api-contracts/contracts/webhooks";
import { sessionOutputDeltaSchema } from "@okouai/api-contracts/contracts/realtime";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { generateSandboxToken } from "../../auth/tokens";
import { createDeferredPromise } from "../../utils";
import { webhooksAgentSessionOutputRoutes } from "../webhooks-agent-session-output";

const context = testContext();

beforeEach(() => {
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  context.mocks.ably.publish.mockResolvedValue(undefined);
});

function sandboxFixture(tokenRunId?: string) {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const runId = randomUUID();
  const threadId = randomUUID();
  const runEventId = `sandbox:${randomUUID()}:2`;
  const token = generateSandboxToken(userId, tokenRunId ?? runId, orgId);
  return { orgId, runEventId, runId, threadId, token, userId };
}

function send(fixture: ReturnType<typeof sandboxFixture>, chunkIndex = 3) {
  return setupApp({
    context,
    routes: webhooksAgentSessionOutputRoutes,
  })(webhookSessionOutputContract).send({
    headers: { authorization: `Bearer ${fixture.token}` },
    body: {
      runId: fixture.runId,
      threadId: fixture.threadId,
      runEventId: fixture.runEventId,
      chunkIndex,
      delta: "visible delta",
    },
  });
}

function request(tokenRunId?: string) {
  const fixture = sandboxFixture(tokenRunId);
  return { ...fixture, response: send(fixture) };
}

describe("Sandbox transient session output webhook", () => {
  it("publishes an unpersisted run through the token-owned channel", async () => {
    const args = request();
    const response = await accept(args.response, [204]);

    expect(response.body).toBeUndefined();
    expect(context.mocks.ably.channelGet).toHaveBeenCalledExactlyOnceWith(
      `run-output:${args.userId}:${args.orgId}:${args.runId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    const [topic, rawPayload] = context.mocks.ably.publish.mock.calls[0] ?? [];
    expect(topic).toBe(args.runId);
    const payload = sessionOutputDeltaSchema.parse(rawPayload);
    expect(payload).toMatchObject({
      threadId: args.threadId,
      runId: args.runId,
      eventId: expect.any(String),
      runEventId: args.runEventId,
      chunkIndex: 3,
      delta: "visible delta",
    });
  });

  it("derives a stable reconciliation event ID for a run event", async () => {
    const fixture = sandboxFixture();
    await Promise.all([
      accept(send(fixture, 0), [204]),
      accept(send(fixture, 1), [204]),
    ]);

    const payloads = context.mocks.ably.publish.mock.calls.map(
      ([, payload]) => {
        return sessionOutputDeltaSchema.parse(payload);
      },
    );
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.eventId).toBe(payloads[1]?.eventId);
  });

  it("rejects a token for another run before selecting a channel", async () => {
    const args = request(randomUUID());
    const response = await accept(args.response, [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(context.mocks.ably.channelGet).not.toHaveBeenCalled();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("rejects body-supplied channel authority", async () => {
    const args = sandboxFixture();
    const raw = setupRawAppRequest({
      context,
      routes: webhooksAgentSessionOutputRoutes,
    });
    const response = await raw("/api/webhooks/agent/session-output", {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runId: args.runId,
        threadId: args.threadId,
        runEventId: args.runEventId,
        chunkIndex: 0,
        delta: "must not publish",
        userId: "another-user",
        orgId: "another-org",
        channel: "run-output:another-user:another-org:another-run",
      }),
    });

    expect(response.status).toBe(400);
    expect(context.mocks.ably.channelGet).not.toHaveBeenCalled();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("bounds an uncertain publication without issuing a second publish", async () => {
    const publish = createDeferredPromise<void>(context.signal);
    context.mocks.ably.publish.mockReturnValue(publish.promise);
    context.mocks.abortSignal.timeout.mockImplementation(() => {
      const controller = new AbortController();
      controller.abort(
        new DOMException("The operation timed out", "TimeoutError"),
      );
      return controller.signal;
    });

    const response = await accept(request().response, [503]);
    publish.resolve(undefined);

    expect(response.body.error.code).toBe("EVENT_DELIVERY_UNAVAILABLE");
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
  });
});
