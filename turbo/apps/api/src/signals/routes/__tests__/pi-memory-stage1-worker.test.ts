import { randomUUID } from "node:crypto";
import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { cronExtractPiMemoryStage1Routes } from "../cron-extract-pi-memory-stage1";
import { createBddApi } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const fixture = createPiMemoryMaintenanceFixture(context);

const firstEvidence = Object.freeze({
  prompt: "Remember the amber orchard inventory review on Tuesdays.",
  answer: "I will review amber orchard inventory every Tuesday.",
});
const peerEvidence = Object.freeze({
  prompt: "Remember the violet harbor sales review on Fridays.",
  answer: "I will review violet harbor sales every Friday.",
});

function captureStage1Requests() {
  const requests: { readonly model: string; readonly messages: string }[] = [];
  server.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        const body = z
          .object({ model: z.string(), messages: z.array(z.unknown()) })
          .parse(await request.json());
        requests.push({
          model: body.model,
          messages: JSON.stringify(body.messages),
        });
        const base = {
          id: `chatcmpl_${randomUUID()}`,
          object: "chat.completion.chunk",
          model: body.model,
        };
        const chunks = [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  content: JSON.stringify({
                    raw_memory: "The user keeps a weekly business review.",
                    rollout_summary:
                      "Remember the user's requested review cadence.",
                    rollout_slug: "weekly-review",
                  }),
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 8 },
          },
        ];
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const body =
                chunks
                  .map((chunk) => {
                    return `data: ${JSON.stringify(chunk)}\n\n`;
                  })
                  .join("") + "data: [DONE]\n\n";
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    ),
  );
  return requests;
}

describe("Pi memory public boundaries", () => {
  it("authenticates the production cron route before the disabled breaker", async () => {
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    mockEnv("CRON_SECRET", "test-pi-memory-stage1-secret");
    context.mocks.s3.send.mockClear();
    const response = await accept(
      setupApp({ context, routes: cronExtractPiMemoryStage1Routes })(
        cronExtractPiMemoryStage1Contract,
      ).extract({ headers: { authorization: "Bearer invalid-secret" } }),
      [401],
    );
    expect(response.status).toBe(401);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("exposes only fixed Auto as a platform chat route", async () => {
    const actor = createBddApi(context).user();
    const models = await createMiscRoutesApi(context).listRunModels(actor);
    expect(
      models.models
        .filter((model) => {
          return model.memberEffective.providerType === "built-in";
        })
        .map(({ model }) => {
          return model;
        }),
    ).toStrictEqual(["auto"]);
  });

  it("extracts each distinct owner's genuine prompt and answer without mixing evidence", async () => {
    const sources = await fixture.prepareSources({
      independentOwner: true,
      sourceEvidence: firstEvidence,
      peerEvidence,
    });
    const requests = captureStage1Requests();
    const response = await accept(
      sources.stage1.extract({ headers: fixture.cronHeaders() }),
      [200],
    );
    expect(response.body).toMatchObject({
      success: true,
      claimed: 2,
      succeeded: 2,
      terminalFailure: 0,
      retryableFailure: 0,
      staleDiscarded: 0,
    });
    expect(requests).toHaveLength(2);
    for (const [own, other] of [
      [firstEvidence, peerEvidence],
      [peerEvidence, firstEvidence],
    ] as const) {
      const request = requests.find(({ messages }) => {
        return messages.includes(own.prompt);
      });
      expect(request?.model).toBe("@preset/memory");
      expect(request?.messages).toContain(own.answer);
      expect(request?.messages).not.toContain(other.prompt);
      expect(request?.messages).not.toContain(other.answer);
    }
  });

  it.each(["feature off", "deleted source", "new activity"] as const)(
    "excludes a source with precompleted %s while preserving another owner",
    async (invalidation) => {
      const sources = await fixture.prepareSources({
        independentOwner: true,
        sourceEvidence: firstEvidence,
        peerEvidence,
      });
      if (invalidation === "feature off") {
        await updateFeatureSwitchesForUser(context, sources.actor, {
          [FeatureSwitchKey.PiMemory]: false,
        });
      } else if (invalidation === "deleted source") {
        const deleted = await fixture.chat.chat.requestDeleteThread(
          sources.actor,
          sources.source.threadId,
          [204],
        );
        expect(deleted.status).toBe(204);
        const missing = await fixture.chat.chat.requestReadThreadMetadata(
          sources.actor,
          sources.source.threadId,
          [404],
        );
        expect(missing.status).toBe(404);
      } else {
        const activity = await fixture.chat.sendChatRun(sources.actor, {
          agentId: sources.agentId,
          threadId: sources.source.threadId,
          prompt: "Update the amber orchard review with today's inventory.",
          model: "gpt-6-luna",
        });
        expect(activity.threadId).toBe(sources.source.threadId);
        await fixture.runs.requestCancelRun(
          sources.actor,
          activity.runId,
          [200],
        );
      }
      const requests = captureStage1Requests();
      const response = await accept(
        sources.stage1.extract({ headers: fixture.cronHeaders() }),
        [200],
      );
      expect(response.body).toMatchObject({
        success: true,
        succeeded: 1,
        retryableFailure: 0,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.messages).toContain(peerEvidence.prompt);
      expect(requests[0]?.messages).toContain(peerEvidence.answer);
      expect(requests[0]?.messages).not.toContain(firstEvidence.prompt);
      expect(requests[0]?.messages).not.toContain(firstEvidence.answer);
    },
  );

  it("extracts new genuine evidence in a subsequent HTTP request", async () => {
    const sources = await fixture.prepareSources({
      sourceEvidence: firstEvidence,
    });
    const requests = captureStage1Requests();
    const first = await accept(
      sources.stage1.extract({ headers: fixture.cronHeaders() }),
      [200],
    );
    expect(first.body).toMatchObject({
      success: true,
      claimed: 1,
      succeeded: 1,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toContain(firstEvidence.prompt);
    expect(requests[0]?.messages).toContain(firstEvidence.answer);

    const fresh = await sources.createSource(sources.sourceActor, peerEvidence);
    expect(fresh.source.threadId).not.toBe(sources.source.threadId);
    mockNow(now() + 24 * 60 * 60 * 1000);
    const trigger = await fixture.chat.sendChatRun(sources.actor, {
      agentId: sources.agentId,
      prompt: "Start the next day's business review.",
      model: "gpt-6-luna",
    });
    await fixture.runs.requestCancelRun(sources.actor, trigger.runId, [200]);
    const second = await accept(
      sources.stage1.extract({ headers: fixture.cronHeaders() }),
      [200],
    );
    expect(second.body).toMatchObject({
      success: true,
      claimed: 1,
      succeeded: 1,
      terminalFailure: 0,
      retryableFailure: 0,
      staleDiscarded: 0,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.model).toBe("@preset/memory");
    expect(requests[1]?.messages).toContain(peerEvidence.prompt);
    expect(requests[1]?.messages).toContain(peerEvidence.answer);
    expect(requests[1]?.messages).not.toContain(firstEvidence.prompt);
    expect(requests[1]?.messages).not.toContain(firstEvidence.answer);
  });
});
