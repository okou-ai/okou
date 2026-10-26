import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createWebhookCallbackApi(context);
const INGEST_URL = "https://api.axiom.co/v1/datasets/agent-run-events/ingest";
const TRACE_OUTPUT = "Accepted output survives optional trace recovery";

beforeEach(() => {
  context.mocks.signalTimers.delay.mockResolvedValue(undefined);
});

function ingested() {
  return HttpResponse.json({
    ingested: 1,
    failed: 0,
    failures: [],
    processedBytes: 1,
  });
}

async function traceRun() {
  const owned = await publicChatActor(context);
  owned.ownsFeatureSwitches();
  const run = await owned.sendChatRun(owned.actor, {
    agentId: owned.agentId,
    prompt: "deliver an optional diagnostic trace",
  });
  const { sandboxHeaders: headers } = await owned.claimChatRun(
    owned.runnerGroup,
    run.runId,
  );
  const body = {
    runId: run.runId,
    events: [
      {
        type: "assistant",
        sequenceNumber: 0,
        message: { content: [{ type: "text", text: TRACE_OUTPUT }] },
      },
    ],
  };
  return { owned, run, headers, body };
}

async function enableDebug(owned: Awaited<ReturnType<typeof publicChatActor>>) {
  await createBillingMediaApi(context).updateFeatureSwitches(owned.actor, {
    [FeatureSwitchKey.OkouDebug]: true,
  });
}

describe("optional agent trace recovery", () => {
  it.each([429, 500, 502, 503, 504, "transport"] as const)(
    "recovers %s with the same diagnostic batch while retaining accepted chat output",
    async (failure) => {
      const { owned, run, headers, body } = await traceRun();
      await owned.run(async () => {
        await enableDebug(owned);
        const requests: string[] = [];
        server.use(
          http.post(INGEST_URL, async ({ request }) => {
            requests.push(await request.text());
            if (requests.length === 1) {
              return failure === "transport"
                ? HttpResponse.error()
                : new HttpResponse(null, { status: failure });
            }
            return ingested();
          }),
        );

        const accepted = await api.requestAgentEvents(body, headers, [200]);
        expect(accepted.body).toStrictEqual({
          received: 1,
          firstSequence: 0,
          lastSequence: 0,
        });
        await flushWaitUntilForTest();
        expect(requests).toHaveLength(2);
        expect(requests[1]).toBe(requests[0]);
        const transcript = await createChatFilesBddApi(
          context,
        ).listThreadEvents(owned.actor, run.threadId);
        expect(JSON.stringify(transcript.events)).toContain(TRACE_OUTPUT);
      });
    },
  );

  it("stops after two temporary failures without replaying the accepted webhook", async () => {
    const { owned, headers, body } = await traceRun();
    await owned.run(async () => {
      await enableDebug(owned);
      let attempts = 0;
      server.use(
        http.post(INGEST_URL, () => {
          attempts += 1;
          return new HttpResponse(null, { status: 503 });
        }),
      );
      await api.requestAgentEvents(body, headers, [200]);
      await flushWaitUntilForTest();
      expect(attempts).toBe(2);
    });
  });

  it.each([400, 401, 403, 404, 413])(
    "does not retry permanent HTTP %s",
    async (status) => {
      const { owned, headers, body } = await traceRun();
      await owned.run(async () => {
        await enableDebug(owned);
        let attempts = 0;
        server.use(
          http.post(INGEST_URL, () => {
            attempts += 1;
            return new HttpResponse(null, {
              status,
            });
          }),
        );
        await api.requestAgentEvents(body, headers, [200]);
        await flushWaitUntilForTest();
        expect(attempts).toBe(1);
      });
    },
  );

  it.each(["invalid-json", "partial-ingest"] as const)(
    "does not replay %s responses",
    async (failure) => {
      const { owned, headers, body } = await traceRun();
      await owned.run(async () => {
        await enableDebug(owned);
        let attempts = 0;
        server.use(
          http.post(INGEST_URL, () => {
            attempts += 1;
            if (failure === "invalid-json") {
              return HttpResponse.text("not JSON");
            }
            return HttpResponse.json({
              ingested: 0,
              failed: 1,
              processedBytes: 1,
              failures: [],
            });
          }),
        );
        await api.requestAgentEvents(body, headers, [200]);
        await flushWaitUntilForTest();
        expect(attempts).toBe(1);
      });
    },
  );

  it("respects the provider's Retry-After minimum before recovering", async () => {
    const { owned, headers, body } = await traceRun();
    await owned.run(async () => {
      await enableDebug(owned);
      const startedAt = now();
      mockNow(startedAt);
      context.mocks.signalTimers.delay.mockImplementation((milliseconds) => {
        mockNow(now() + milliseconds);
        return Promise.resolve();
      });
      const requestsAt: number[] = [];
      server.use(
        http.post(INGEST_URL, () => {
          requestsAt.push(now());
          return requestsAt.length === 1
            ? new HttpResponse(null, {
                status: 429,
                headers: { "Retry-After": "1" },
              })
            : ingested();
        }),
      );
      await api.requestAgentEvents(body, headers, [200]);
      await flushWaitUntilForTest();
      expect(requestsAt).toStrictEqual([startedAt, startedAt + 1000]);
    });
  });

  it("stops retries on API lifetime cancellation during backoff", async () => {
    const { owned, headers, body } = await traceRun();
    await owned.run(async () => {
      await enableDebug(owned);
      const parent = new AbortController();
      context.mocks.signalTimers.delay.mockImplementation(() => {
        parent.abort(new DOMException("Caller cancelled", "AbortError"));
        return Promise.resolve();
      });
      let attempts = 0;
      server.use(
        http.post(INGEST_URL, () => {
          attempts += 1;
          return new HttpResponse(null, { status: 503 });
        }),
      );
      await api.requestAgentEvents(body, headers, [200], parent.signal);
      await settleIncludingAbort(flushWaitUntilForTest());
      expect(attempts).toBe(1);
    });
  });

  it("keeps required telemetry HTTP 503 outside optional trace recovery", async () => {
    const { owned, headers, run } = await traceRun();
    await owned.run(async () => {
      let attempts = 0;
      server.use(
        http.post(
          "https://api.axiom.co/v1/datasets/sandbox-telemetry-network/ingest",
          () => {
            attempts += 1;
            return new HttpResponse(null, { status: 503 });
          },
        ),
      );
      const failed = await api.requestAgentTelemetry(
        {
          runId: run.runId,
          networkLogs: [
            {
              timestamp: new Date(now()).toISOString(),
              host: "required-ingest.example.test",
            },
          ],
        },
        headers,
        [500],
      );
      expect(failed.status).toBe(500);
      expect(attempts).toBe(1);
    });
  });
});
