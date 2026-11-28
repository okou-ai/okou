import { randomUUID } from "node:crypto";
import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { array, object, string } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
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
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor, { tier });
  await runs.ensurePersonalSubscriptionModel(actor);

  return { actor, runnerGroup };
}

async function startRun(actor: ApiTestUser) {
  const run = await runs.createThreadRun(actor, {
    prompt: "Exercise runtime wakeups",
  });
  await runs.executionInput(run.runId);
  return run.runId;
}

async function createConnector(actor: ApiTestUser) {
  return await connectors.createCustomConnector(
    actor,
    manualHttpCustomConnectorCreateBody({
      slug: `_wakeup-${randomUUID()}`,
      displayName: "Runtime wakeup test",
      prefixTemplates: [`https://${randomUUID()}.wakeup.example.test/`],
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
  it("notifies eligible Runner groups after connector deletion even if one batch fails", async () => {
    const { actor, runnerGroup } = await prepareActor("team");
    const custom = await createConnector(actor);
    const runId = await startRun(actor);
    const secondGroup = await runs.configureRunnerGroup();

    const otherRun = await startRun(actor);
    const cancelled = await startRun(actor);
    await runs.requestCancelRun(actor, cancelled, [200]);
    const expected = [
      { runnerGroup, runId },
      { runnerGroup: secondGroup, runId: otherRun },
    ];
    for (let index = 0; index < 3; index += 1) {
      const group = await runs.configureRunnerGroup();
      expected.push({
        runnerGroup: group,
        runId: await startRun(actor),
      });
    }
    const { actor: outsider } = await prepareActor();
    await startRun(outsider);
    context.mocks.ably.batchPublish.mockClear();

    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let active = 0;
    let peak = 0;
    context.mocks.ably.batchPublish.mockImplementation(async (spec) => {
      const first = !started.settled();
      active += 1;
      peak = Math.max(peak, active);
      if (first) {
        started.resolve();
      }
      await release.promise;
      active -= 1;
      if (first) {
        throw new Error("Ably rejected the first batch");
      }
      return {
        successCount: spec.channels.length,
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
    });
    const deleting = connectors.deleteCustomConnector(actor, custom.id);
    const firstOutcome = await settleIncludingAbort(
      Promise.race([started.promise, deleting]),
    );
    if (!release.settled()) {
      release.resolve();
    }
    await deleting;
    if (!firstOutcome.ok) {
      throw firstOutcome.error;
    }
    expect(peak).toBeLessThanOrEqual(4);
    expect(
      context.mocks.ably.batchPublish.mock.calls.map(([spec]) => {
        return spec;
      }),
    ).toStrictEqual(
      expect.arrayContaining(
        expected.map((run) => {
          return {
            channels: [`runner-group:${run.runnerGroup}`],
            messages: [message(run.runId, custom.id)],
          };
        }),
      ),
    );
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(
      expected.length,
    );
    await expect(
      connectors.listCustomConnectors(actor),
    ).resolves.not.toContainEqual(expect.objectContaining({ id: custom.id }));
  });

  it.each([
    "accepted",
    "channel-rejected",
    "http-rejected",
    "missing-result",
  ] as const)(
    "uses the native Ably HTTP batch contract: %s",
    async (outcome) => {
      const { actor, runnerGroup } = await prepareActor();
      const custom = await createConnector(actor);
      const runId = await startRun(actor);
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
