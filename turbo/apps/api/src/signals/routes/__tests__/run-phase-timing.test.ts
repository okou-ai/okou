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

async function fixture(enabled = true) {
  const owned = await publicChatActor(context);
  owned.ownsFeatureSwitches();
  return await owned.run(async () => {
    if (enabled) {
      await features.updateFeatureSwitches(owned.actor, {
        [FeatureSwitchKey.ArtifactGenerationTiming]: true,
      });
    }
    const run = await runs.createThreadRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Create a report",
      model: "claude-fable-5-1",
    });
    const execution = await owned.executionInput(run.runId);
    const headers = {
      authorization: `Bearer ${execution.platformEnvironment.OKOU_TOKEN}`,
    };
    return {
      owned,
      run,
      execution,
      headers,
      async mark(body: RunPhaseMark) {
        return (await accept(client().mark({ headers, body }), [200])).body;
      },
    };
  });
}

describe("current Run phase timing", () => {
  it("records research then generation, preserving the first timestamps and kind", async () => {
    const f = await fixture();
    expect(f.execution.appendSystemPrompt).toContain(
      "okou run mark research-start",
    );
    expect(f.execution.appendSystemPrompt).toContain("--kind");
    const research = await f.mark({ phase: "research-start" });
    expect(research.status).toBe("recorded");
    expect(research.timing?.researchStartedAt).toBeTruthy();
    const generated = await f.mark({
      phase: "generation-start",
      kind: "report",
      skipResearch: false,
    });
    expect(generated).toMatchObject({
      status: "recorded",
      timing: {
        researchStartedAt: research.timing?.researchStartedAt,
        generationKind: "report",
        researchSkipped: false,
      },
    });
    expect(generated.timing?.generationStartedAt).toBeTruthy();
    await expect(
      f.mark({
        phase: "generation-start",
        kind: "image",
        skipResearch: true,
      }),
    ).resolves.toStrictEqual({ ...generated, status: "duplicate" });
    await expect(f.mark({ phase: "research-start" })).resolves.toStrictEqual({
      ...generated,
      status: "duplicate",
    });
  });

  it("keeps missing research distinct from explicit zero research and ignores late research", async () => {
    const f = await fixture();
    const generated = await f.mark({
      phase: "generation-start",
      kind: "document",
      skipResearch: false,
    });
    expect(generated).toMatchObject({
      status: "recorded",
      timing: {
        researchStartedAt: null,
        researchSkipped: false,
        generationKind: "document",
      },
    });
    await expect(f.mark({ phase: "research-start" })).resolves.toStrictEqual({
      ...generated,
      status: "ignored",
      reason: "generation-already-started",
    });
  });

  it("records an explicit skipped research phase without inventing T0", async () => {
    const f = await fixture();
    await expect(
      f.mark({
        phase: "generation-start",
        kind: "image",
        skipResearch: true,
      }),
    ).resolves.toMatchObject({
      status: "recorded",
      timing: {
        researchStartedAt: null,
        researchSkipped: true,
        generationKind: "image",
      },
    });
    expect((await f.mark({ phase: "research-start" })).status).toBe("ignored");
  });

  it("does not let skip-research overwrite a real research phase", async () => {
    const f = await fixture();
    const research = await f.mark({ phase: "research-start" });
    await expect(
      f.mark({
        phase: "generation-start",
        kind: "image",
        skipResearch: true,
      }),
    ).resolves.toStrictEqual({
      ...research,
      status: "ignored",
      reason: "research-already-started",
    });
    expect(
      (
        await f.mark({
          phase: "generation-start",
          kind: "image",
          skipResearch: false,
        })
      ).status,
    ).toBe("recorded");
  });

  it("returns one immutable receipt to concurrent callers", async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => {
        return f.mark({
          phase: "generation-start",
          kind: "report",
          skipResearch: true,
        });
      }),
    );
    expect(
      results.filter((result) => {
        return result.status === "recorded";
      }),
    ).toHaveLength(1);
    expect(
      results.filter((result) => {
        return result.status === "duplicate";
      }),
    ).toHaveLength(7);
    for (const result of results) {
      expect(result.timing).toStrictEqual(results[0]?.timing);
    }
  });

  it("uses the existing Run completion and accepts no new boundary after completion", async () => {
    const f = await fixture();
    const research = await f.mark({ phase: "research-start" });
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
    expect(completed.completedAt).toBeTruthy();
    await expect(f.mark({ phase: "research-start" })).resolves.toStrictEqual({
      ...research,
      status: "duplicate",
    });
    await expect(
      f.mark({
        phase: "generation-start",
        kind: "report",
        skipResearch: false,
      }),
    ).resolves.toStrictEqual({
      ...research,
      status: "ignored",
      reason: "run-not-running",
    });
  });

  it("leaves prompts and credentials uninstrumented by default", async () => {
    const f = await fixture(false);
    expect(f.execution.appendSystemPrompt).not.toContain("okou run mark");
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

  it("requires kind and rejects caller-supplied identity and timestamps", async () => {
    const f = await fixture();
    const request = setupRawAppRequest({
      context,
      routes: runPhaseTimingRoutes,
    });
    for (const body of [
      { phase: "generation-start" },
      { phase: "generation-start", skipResearch: true },
      { phase: "generation-start", kind: "unknown" },
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
    expect((await f.mark({ phase: "research-start" })).status).toBe("recorded");
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

  it("keeps marks scoped to the Run in each owner's issued token", async () => {
    const first = await fixture();
    const second = await fixture();
    await first.mark({
      phase: "generation-start",
      kind: "image",
      skipResearch: true,
    });
    await second.mark({
      phase: "generation-start",
      kind: "report",
      skipResearch: true,
    });
    await expect(
      first.mark({
        phase: "generation-start",
        kind: "other",
        skipResearch: false,
      }),
    ).resolves.toMatchObject({
      status: "duplicate",
      timing: { generationKind: "image" },
    });
    await expect(
      second.mark({
        phase: "generation-start",
        kind: "other",
        skipResearch: false,
      }),
    ).resolves.toMatchObject({
      status: "duplicate",
      timing: { generationKind: "report" },
    });
  });
});
