import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { BatchPublishSpec } from "ably";
import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);

async function prepareActor(tier: "pro" | "team" = "pro") {
  mockEnv("ABLY_API_KEY", "test.key:secret");
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor, { tier });
  await runs.ensureOrgModelProvider(actor);
  const { agentId } = await bdd.createAgent(actor);
  return { actor, agentId, runnerGroup };
}

async function startRun(
  actor: ApiTestUser,
  agentId: string,
  runnerGroup: string,
) {
  const run = await runs.createRun(actor, {
    agentId,
    prompt: "Exercise runtime wakeups",
    modelProvider: "anthropic-api-key",
  });
  await runs.heartbeatRunner(runnerGroup);
  await runs.claimRunnerJob(run.runId, {
    runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 1 },
  });
  return run.runId;
}

async function createConnector(actor: ApiTestUser, permissioned = false) {
  return await connectors.createCustomConnector(
    actor,
    manualHttpCustomConnectorCreateBody({
      slug: `_wakeup-${randomUUID()}`,
      displayName: "Runtime wakeup test",
      prefixTemplates: [`https://${randomUUID()}.wakeup.example.test/`],
      ...(permissioned ? { permissionBundleRef: "builtin:slack@1" } : {}),
    }),
  );
}

function message(runId: string, customConnectorId: string) {
  return {
    name: "connector-runtime-sync",
    data: JSON.stringify({
      runId,
      target: { kind: "custom", customConnectorId },
    }),
    encoding: "json",
  };
}

function acceptedBatch(spec: BatchPublishSpec) {
  return {
    successCount: 1,
    failureCount: 0,
    results: spec.channels.map((channel) => {
      return {
        channel,
        messageId: "accepted-batch",
        serials: spec.messages.map(() => {
          return null;
        }),
      };
    }),
  };
}

function expectWakeups(
  runnerGroup: string,
  runId: string,
  ids: readonly string[],
) {
  expect(context.mocks.ably.batchPublish).toHaveBeenCalledExactlyOnceWith({
    channels: [`runner-group:${runnerGroup}`],
    messages: expect.arrayContaining(
      ids.map((id) => {
        return message(runId, id);
      }),
    ),
  });
  expect(
    context.mocks.ably.batchPublish.mock.calls[0]?.[0].messages,
  ).toHaveLength(ids.length);
  context.mocks.ably.batchPublish.mockClear();
}

describe("connector runtime wakeups", () => {
  it("notifies semantic grant changes, including empty membership, but not unchanged or reordered saves", async () => {
    const { actor, agentId, runnerGroup } = await prepareActor();
    const first = await createConnector(actor, true);
    const second = await createConnector(actor);
    const runId = await startRun(actor, agentId, runnerGroup);
    context.mocks.ably.batchPublish.mockClear();

    await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agentId,
      [
        {
          customConnectorId: first.id,
          permissionNames: ["chat:write", "files:write"],
        },
        { customConnectorId: second.id, permissionNames: [] },
      ],
      [200],
    );
    expectWakeups(runnerGroup, runId, [first.id, second.id]);

    await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agentId,
      [
        { customConnectorId: second.id, permissionNames: [] },
        {
          customConnectorId: first.id,
          permissionNames: ["files:write", "chat:write"],
        },
      ],
      [200],
    );
    expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
    await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agentId,
      [{ customConnectorId: first.id, permissionNames: ["files:write"] }],
      [200],
      "add",
    );
    expectWakeups(runnerGroup, runId, [first.id]);

    await connectors.updateAgentCustomConnectors(
      actor,
      agentId,
      [second.id],
      "add",
    );
    await connectors.updateAgentCustomConnectors(
      actor,
      agentId,
      [randomUUID()],
      "remove",
    );
    expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
    await connectors.updateAgentCustomConnectors(
      actor,
      agentId,
      [second.id],
      "remove",
    );
    expectWakeups(runnerGroup, runId, [second.id]);
    await connectors.updateAgentCustomConnectors(
      actor,
      agentId,
      [second.id],
      "remove",
    );
    expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();

    await connectors.updateAgentCustomConnectors(actor, agentId, [second.id]);
    expectWakeups(runnerGroup, runId, [first.id, second.id]);
    await expect(
      connectors.readAgentCustomConnectorGrants(actor, agentId),
    ).resolves.toStrictEqual([
      { customConnectorId: second.id, permissionNames: [] },
    ]);
  });

  it("preserves unrequested grants during add/remove and does not notify rejected updates", async () => {
    const { actor, agentId, runnerGroup } = await prepareActor();
    const first = await createConnector(actor);
    const retained = await createConnector(actor);
    await connectors.updateAgentCustomConnectors(actor, agentId, [
      first.id,
      retained.id,
    ]);
    const runId = await startRun(actor, agentId, runnerGroup);
    context.mocks.ably.batchPublish.mockClear();

    await expect(
      connectors.updateAgentCustomConnectors(actor, agentId, [first.id], "add"),
    ).resolves.toStrictEqual(expect.arrayContaining([first.id, retained.id]));
    await connectors.updateAgentCustomConnectors(
      actor,
      agentId,
      [randomUUID()],
      "remove",
    );
    await connectors.requestUpdateAgentCustomConnectors(
      actor,
      agentId,
      [randomUUID()],
      [400],
    );
    await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agentId,
      [{ customConnectorId: first.id, permissionNames: ["invalid"] }],
      [400],
    );
    expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
    await expect(
      connectors.readAgentCustomConnectors(actor, agentId),
    ).resolves.toStrictEqual(expect.arrayContaining([first.id, retained.id]));
    await connectors.updateAgentCustomConnectors(actor, agentId, []);
    expectWakeups(runnerGroup, runId, [first.id, retained.id]);
  });

  it("keeps agent scope for grants and all running groups in org scope for definition deletion", async () => {
    const { actor, agentId, runnerGroup } = await prepareActor("team");
    const custom = await createConnector(actor);
    const runId = await startRun(actor, agentId, runnerGroup);
    const secondGroup = runs.configureRunnerGroup();
    const otherAgent = await bdd.createAgent(actor);
    const otherRun = await startRun(actor, otherAgent.agentId, secondGroup);
    const cancelled = await startRun(actor, agentId, secondGroup);
    await runs.requestCancelRun(actor, cancelled, [200]);
    const outsider = await prepareActor();
    await startRun(outsider.actor, outsider.agentId, outsider.runnerGroup);
    context.mocks.ably.batchPublish.mockClear();

    await connectors.updateAgentCustomConnectors(actor, agentId, [custom.id]);
    expectWakeups(runnerGroup, runId, [custom.id]);
    await connectors.deleteCustomConnector(actor, custom.id);
    expect(
      context.mocks.ably.batchPublish.mock.calls.map(([spec]) => {
        return spec;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        {
          channels: [`runner-group:${runnerGroup}`],
          messages: [message(runId, custom.id)],
        },
        {
          channels: [`runner-group:${secondGroup}`],
          messages: [message(otherRun, custom.id)],
        },
      ]),
    );
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(2);
  });

  it("bounds batch sizes and concurrency, continues after a rejected chunk, and keeps committed grants", async () => {
    const { actor, agentId, runnerGroup } = await prepareActor("team");
    const ids: string[] = [];
    // Small DB-only definitions and five API-created runs; no sandboxes are started.
    for (let index = 0; index < 20; index += 1) {
      const created = await Promise.all(
        Array.from({ length: 4 }, async () => {
          return await createConnector(actor);
        }),
      );
      ids.push(
        ...created.map((connector) => {
          return connector.id;
        }),
      );
    }
    const runIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      runIds.push(await startRun(actor, agentId, runnerGroup));
    }
    context.mocks.ably.batchPublish.mockClear();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let active = 0;
    let peak = 0;
    let calls = 0;
    context.mocks.ably.batchPublish.mockImplementation(async (spec) => {
      calls += 1;
      const reject = calls === 1;
      active += 1;
      peak = Math.max(peak, active);
      if (calls === 4) {
        started.resolve();
      }
      await release.promise;
      active -= 1;
      if (reject) {
        throw new Error("Rejected atomic batch");
      }
      return acceptedBatch(spec);
    });
    const saving = connectors.updateAgentCustomConnectors(actor, agentId, ids);
    const atGate = await Promise.race([started.promise, saving])
      .then(() => {
        return { calls, active };
      })
      .finally(() => {
        release.resolve();
      });
    await saving;
    expect(atGate).toStrictEqual({ calls: 4, active: 4 });
    expect(peak).toBe(4);
    expect(calls).toBeGreaterThan(4);
    const batches = context.mocks.ably.batchPublish.mock.calls.map(([spec]) => {
      return spec;
    });
    for (const batch of batches) {
      expect(batch.channels).toStrictEqual([`runner-group:${runnerGroup}`]);
      expect(batch.messages.length).toBeLessThanOrEqual(1000);
      expect(Buffer.byteLength(JSON.stringify([batch]))).toBeLessThanOrEqual(
        16 * 1024,
      );
    }
    const published = batches.flatMap((batch) => {
      return batch.messages;
    });
    expect(published).toHaveLength(runIds.length * ids.length);
    expect(published).toStrictEqual(
      expect.arrayContaining(
        runIds.flatMap((runId) => {
          return ids.map((id) => {
            return message(runId, id);
          });
        }),
      ),
    );
    await expect(
      connectors.readAgentCustomConnectors(actor, agentId),
    ).resolves.toStrictEqual(expect.arrayContaining(ids));
  }, 15_000);

  it.each([
    "accepted",
    "channel-rejected",
    "http-rejected",
    "missing-result",
  ] as const)(
    "uses the native Ably HTTP batch contract: %s",
    async (outcome) => {
      const { actor, agentId, runnerGroup } = await prepareActor();
      const custom = await createConnector(actor);
      const runId = await startRun(actor, agentId, runnerGroup);
      context.mocks.ably.batchPublish.mockClear();
      context.mocks.ably.useRealBatchPublish.mockReturnValue(true);
      const received: unknown[] = [];
      server.use(
        http.post(
          "https://main.realtime.ably.net/messages",
          async ({ request }) => {
            expect(request.headers.get("content-type")).toContain(
              "application/x-msgpack",
            );
            if (
              typeof MsgPack !== "object" ||
              MsgPack === null ||
              !("decode" in MsgPack) ||
              typeof MsgPack.decode !== "function" ||
              !("encode" in MsgPack) ||
              typeof MsgPack.encode !== "function"
            ) {
              throw new Error("Expected the Ably MessagePack codec");
            }
            const decoded: unknown = MsgPack.decode(
              await request.arrayBuffer(),
            );
            received.push(decoded);
            const specs = z
              .array(
                z.object({
                  channels: z.array(z.string()),
                  messages: z.array(
                    z.object({
                      name: z.string(),
                      data: z.string(),
                      encoding: z.string(),
                    }),
                  ),
                }),
              )
              .parse(decoded);
            expect(specs).toStrictEqual([
              {
                channels: [`runner-group:${runnerGroup}`],
                messages: [message(runId, custom.id)],
              },
            ]);
            if (outcome === "http-rejected") {
              return HttpResponse.json(
                {
                  error: {
                    code: 42_913,
                    statusCode: 429,
                    message: "Channel publish rate exceeded",
                  },
                },
                { status: 429 },
              );
            }
            const results =
              outcome === "missing-result"
                ? []
                : outcome === "channel-rejected"
                  ? [
                      {
                        channel: `runner-group:${runnerGroup}`,
                        error: {
                          code: 42_913,
                          statusCode: 429,
                          message: "Channel publish rate exceeded",
                        },
                      },
                    ]
                  : [
                      {
                        channel: `runner-group:${runnerGroup}`,
                        messageId: "accepted",
                        serials: [null],
                      },
                    ];
            const encoded: unknown = MsgPack.encode([
              {
                successCount: outcome === "accepted" ? 1 : 0,
                failureCount: outcome === "channel-rejected" ? 1 : 0,
                results,
              },
            ]);
            if (!(encoded instanceof ArrayBuffer)) {
              throw new Error("Expected an encoded MessagePack response");
            }
            return new HttpResponse(encoded, {
              headers: { "content-type": "application/x-msgpack" },
            });
          },
        ),
      );
      await connectors.updateAgentCustomConnectors(actor, agentId, [custom.id]);
      expect(received).toHaveLength(1);
      await expect(
        connectors.readAgentCustomConnectors(actor, agentId),
      ).resolves.toStrictEqual([custom.id]);
    },
  );
});
