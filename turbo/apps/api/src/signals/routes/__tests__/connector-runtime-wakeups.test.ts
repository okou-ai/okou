import { randomUUID } from "node:crypto";
import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
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
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor, { tier });
  await runs.ensurePersonalSubscriptionModel(actor);
  const { agentId } = await bdd.createAgent(actor);
  return { actor, agentId, runnerGroup };
}

async function startRun(
  actor: ApiTestUser,
  agentId: string,
  runnerGroup: string,
) {
  const run = await runs.createThreadRun(actor, {
    agentId,
    prompt: "Exercise runtime wakeups",
  });
  await runs.heartbeatRunner(runnerGroup);
  await runs.executionInput(run.runId);
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

describe("connector runtime wakeups", () => {
  it("notifies every active Runner group in the workspace after deleting a connector", async () => {
    const { actor, agentId, runnerGroup } = await prepareActor("team");
    const custom = await createConnector(actor);
    const runId = await startRun(actor, agentId, runnerGroup);
    const secondGroup = await runs.configureRunnerGroup();
    const otherAgent = await bdd.createAgent(actor);
    const otherRun = await startRun(actor, otherAgent.agentId, secondGroup);
    const cancelled = await startRun(actor, agentId, secondGroup);
    await runs.requestCancelRun(actor, cancelled, [200]);
    const outsider = await prepareActor();
    await startRun(outsider.actor, outsider.agentId, outsider.runnerGroup);
    context.mocks.ably.batchPublish.mockClear();

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
            const specs = array(
              object({
                channels: array(string()),
                messages: array(
                  object({
                    name: string(),
                    data: string(),
                    encoding: string(),
                  }),
                ),
              }),
            ).parse(decoded);
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
      await connectors.deleteCustomConnector(actor, custom.id);
      expect(received).toHaveLength(1);
      await expect(
        connectors.listCustomConnectors(actor),
      ).resolves.not.toContainEqual(expect.objectContaining({ id: custom.id }));
    },
  );
});
