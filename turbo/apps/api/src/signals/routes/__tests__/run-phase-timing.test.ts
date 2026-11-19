import { describe, expect, it } from "vitest";
import {
  runPhaseTimingContract,
  type RunPhaseMark,
} from "@okouai/api-contracts/contracts/run-phase-timing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { runPhaseTimingRoutes } from "../run-phase-timing";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";

const context = testContext();
const runs = createRunsApi(context);
const features = createAuthDeviceSupportApi(context);
const client = () => {
  return setupApp({ context, routes: runPhaseTimingRoutes })(
    runPhaseTimingContract,
  );
};
const receipt = Object.freeze({ schemaVersion: 2, status: "accepted" });

async function fixture(enabled?: boolean) {
  const owned = await publicChatActor(context);
  owned.ownsFeatureSwitches();
  return await owned.run(async () => {
    if (enabled !== undefined) {
      await features.updateFeatureSwitches(owned.actor, {
        [FeatureSwitchKey.ArtifactGenerationTiming]: enabled,
      });
    }
    const run = await runs.createThreadRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Create a report",
      model: "claude-fable-5-1",
    });
    const execution = await owned.executionInput(run.runId);
    const token = execution.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected a minted Run token");
    }
    const headers = {
      authorization: `Bearer ${token}`,
    };
    return {
      owned,
      run,
      execution,
      headers,
      async mark(body: RunPhaseMark) {
        return (await accept(client().mark({ headers, body }), [202])).body;
      },
    };
  });
}

describe("current Run phase timing", () => {
  it("enables timing by default and accepts legal observations without requiring phase order", async () => {
    const f = await fixture();
    expect(f.execution.appendSystemPrompt).toContain(
      "okou run mark research-start",
    );
    expect(f.execution.appendSystemPrompt).toContain(
      "okou run mark generation-start --kind <kind>",
    );
    for (const mark of [
      { phase: "generation-start", kind: "report", skipResearch: false },
      { phase: "research-start" },
      { phase: "generation-start", kind: "image", skipResearch: true },
      { phase: "research-start" },
    ] satisfies readonly RunPhaseMark[]) {
      await expect(f.mark(mark)).resolves.toStrictEqual(receipt);
    }
  });

  it("accepts a generation observation with the default skip declaration", async () => {
    const f = await fixture();
    const response = await accept(
      client().mark({
        headers: f.headers,
        body: { phase: "generation-start", kind: "document" },
      }),
      [202],
    );
    expect(response.body).toStrictEqual(receipt);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts late legal observations after the completion callback", async () => {
    const f = await fixture();
    await f.owned.run(() => {
      return completePublicClaudeRun(
        context,
        f.run,
        { authorization: `Bearer ${f.execution.sandboxToken}` },
        "Report ready",
      );
    });
    const completed = await runs.readRun(f.owned.actor, f.run.runId);
    expect(completed.status).toBe("completed");
    await expect(f.mark({ phase: "research-start" })).resolves.toStrictEqual(
      receipt,
    );
    await expect(
      f.mark({
        phase: "generation-start",
        kind: "report",
        skipResearch: false,
      }),
    ).resolves.toStrictEqual(receipt);
  });

  it("honors an explicit false override for prompts, capabilities and mark authorization", async () => {
    const f = await fixture(false);
    expect(f.execution.appendSystemPrompt).not.toContain("okou run mark");
    await accept(
      client().mark({ headers: f.headers, body: { phase: "research-start" } }),
      [403],
    );
    await features.updateFeatureSwitches(f.owned.actor, {
      [FeatureSwitchKey.ArtifactGenerationTiming]: true,
    });
    await accept(
      client().mark({ headers: f.headers, body: { phase: "research-start" } }),
      [403],
    );
  });

  it("honors a live kill switch for an already issued Run token", async () => {
    const f = await fixture();
    await features.updateFeatureSwitches(f.owned.actor, {
      [FeatureSwitchKey.ArtifactGenerationTiming]: false,
    });
    const response = await accept(
      client().mark({ headers: f.headers, body: { phase: "research-start" } }),
      [404],
    );
    expect(response.status).toBe(404);
  });

  it("reserves completion-callback for the authenticated Agent completion protocol", async () => {
    const f = await fixture();
    const response = await setupRawAppRequest({
      context,
      routes: runPhaseTimingRoutes,
    })(runPhaseTimingContract.mark.path, {
      method: "POST",
      headers: { ...f.headers, "content-type": "application/json" },
      body: JSON.stringify({ phase: "completion-callback" }),
    });
    expect(response.status).toBe(400);
    await expect(
      f.mark({
        phase: "generation-start",
        kind: "report",
        skipResearch: false,
      }),
    ).resolves.toStrictEqual(receipt);
  });

  it("requires kind and rejects caller-supplied identity and timestamps", async () => {
    const f = await fixture();
    const request = setupRawAppRequest({
      context,
      routes: runPhaseTimingRoutes,
    });
    for (const body of [
      { phase: "generation-start" },
      { phase: "generation-start", skipResearch: true },
      { phase: "research-start", runId: f.run.runId },
      { phase: "research-start", recordedAt: "2026-01-01T00:00:00Z" },
    ]) {
      const result = await request(runPhaseTimingContract.mark.path, {
        method: "POST",
        headers: { ...f.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(400);
    }
    await expect(f.mark({ phase: "research-start" })).resolves.toStrictEqual(
      receipt,
    );
  });

  it("rejects session and Sandbox credentials even for the owner", async () => {
    const f = await fixture();
    for (const authorization of [
      "Bearer clerk-session",
      `Bearer ${f.execution.sandboxToken}`,
    ]) {
      const response = await accept(
        client().mark({
          headers: { authorization },
          body: { phase: "research-start" },
        }),
        [403],
      );
      expect(response.status).toBe(403);
    }
  });
});
