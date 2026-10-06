import { randomUUID } from "node:crypto";
import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { mockNow, now, withNowScopeForTest } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { cronExtractPiMemoryStage1RoutesForTest } from "../../cron-extract-pi-memory-stage1";
import { createPublicFirewallFixture } from "./public-firewall-fixture";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
} from "./chat-events-fixture";
import { expectCanonicalStorageManifest } from "./api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { completePublicPiHistory } from "./public-pi-history";

/** A completed native source, followed by an independent real next-day admission. */
export function createPublicPiMemorySource(context: TestContext) {
  const fixture = createPublicFirewallFixture(context);
  fixture.registerOwnedUserDeletion();
  const chat = createChatEventsFixture(context);
  const account = `public-memory-${randomUUID()}`;
  let memoryStorageId: string | undefined;
  async function prepare(at: Date) {
    // Callers schedule the first work one day ahead. A new Thread's activity
    // uses the database clock, so creating it under a past app clock cannot
    // make it satisfy the worker's six-hour idle boundary.
    const sourceTime = at.getTime() - 24 * 3_600_000;
    mockNow(sourceTime);
    chat.chatCallbacks.acceptChatObjectStorage();
    chat.chatCallbacks.disableVapid();
    chat.api.acceptStorageDownloads();
    chat.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    configureNativeCliArtifact();
    const runnerGroup = chat.api.configureRunnerGroup();
    await fixture.fund();
    if (!fixture.actor.orgId) {
      throw new Error("Expected an owned organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...fixture.actor, orgId: fixture.actor.orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    // Device consent is committed against the database wall clock. Authenticate
    // in that clock domain, then restore the historical source clock unchanged.
    await withNowScopeForTest(async () => {
      await chat.configureSubscriptionPiModel(fixture.actor, {
        accountId: account,
        refreshToken: `refresh-${account}`,
        accessTokenExpiresAt:
          Math.floor(Math.max(now(), at.getTime()) / 1000) + 72 * 3600,
      });
    });
    const agent = await chat.bdd.createAgent(fixture.actor, {
      displayName: "Public Memory source",
      visibility: "private",
    });
    fixture.registerAgent(agent.agentId);
    chat.mockPiCheckpointObjectStore();
    const source = await chat.sendChatRun(fixture.actor, {
      agentId: agent.agentId,
      prompt: "Remember this source",
      model: "gpt-6-luna",
    });
    fixture.registerRun(source.runId);
    const claimed = await chat.claimChatRun(runnerGroup, source.runId);
    fixture.registerClaim(source.runId, claimed.claim.sandboxToken);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.piSessionId).toBe(source.threadId);
    const memory = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory" && mount.storageId;
    });
    if (!memory || !fixture.actor.orgId) {
      throw new Error("Expected the real source Memory owner");
    }
    memoryStorageId = memory.storageId;
    await completePublicPiHistory(
      context,
      source,
      claimed.sandboxHeaders,
      "A completed source for lease and quota behavior",
    );
    expect((await chat.api.readRun(fixture.actor, source.runId)).status).toBe(
      "completed",
    );
    mockNow(at);
    const trigger = await chat.sendChatRun(fixture.actor, {
      agentId: agent.agentId,
      prompt: "Request the next Memory day",
      model: "gpt-6-luna",
    });
    fixture.registerRun(trigger.runId);
    await chat.api.requestCancelRun(fixture.actor, trigger.runId, [200]);
    await flushWaitUntilForTest();
    return {
      memoryStorageId,
      orgId: fixture.actor.orgId,
      userId: fixture.actor.userId,
    };
  }
  async function extract() {
    if (!memoryStorageId) {
      throw new Error("Expected the source Memory mount");
    }
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "true");
    const secret = "test-public-memory-source";
    mockEnv("CRON_SECRET", secret);
    const response = await accept(
      setupApp({
        context,
        routes: cronExtractPiMemoryStage1RoutesForTest({
          memoryStorageIds: [memoryStorageId],
        }),
      })(cronExtractPiMemoryStage1Contract).extract({
        headers: { authorization: `Bearer ${secret}` },
      }),
      [200],
    );
    return response.body;
  }
  function installExtractionProvider() {
    const text = JSON.stringify({
      raw_memory: "raw memory",
      rollout_summary: "rollout summary",
      rollout_slug: "source",
    });
    server.use(
      http.post(
        /https:\/\/chatgpt\.com\/.*\/responses/u,
        async ({ request }) => {
          await request.arrayBuffer();
          // The Codex reader cancels after the terminal event. Close the source
          // before cancellation can wait on an unconsumed response clone.
          return new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(extractionSse(text)),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
  }
  return { ...fixture, prepare, extract, installExtractionProvider, account };
}

function extractionSse(
  text: string,
  sequence = 1,
  usage = {
    input_tokens: 12,
    output_tokens: 8,
    cached_tokens: 2,
    cache_write_tokens: 3,
  },
  incomplete = false,
): string {
  const responseId = `resp_pi_memory_stage1_${sequence.toString()}`;
  const messageId = `msg_pi_memory_stage1_${sequence.toString()}`;
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: incomplete ? "response.incomplete" : "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: incomplete ? "incomplete" : "completed",
        ...(incomplete
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          input_tokens_details: {
            cached_tokens: usage.cached_tokens,
            cache_write_tokens: usage.cache_write_tokens,
          },
          total_tokens: usage.input_tokens + usage.output_tokens,
        },
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}
