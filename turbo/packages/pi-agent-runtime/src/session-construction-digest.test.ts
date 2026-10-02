import { describe, expect, it } from "vitest";

import { PI_MODEL_LIMIT_OVERRIDES } from "./model-limits";
import { resolvePiAgentModel } from "./model";
import { PI_SESSION_CONSTRUCTION_DIGEST } from "./session-construction-digest";
import {
  computePiSessionConstructionDigest,
  computePiSessionConstructionDocument,
} from "./session-construction-digest-node";

describe("Pi session construction digest", () => {
  it("covers the plain and the memory-tool loadouts through the real entry", async () => {
    const document = await computePiSessionConstructionDocument();
    expect(
      document.profiles.map((profile) => {
        return profile.name;
      }),
    ).toStrictEqual(["no-memory", "memory-tools"]);
    const [plain, memory] = document.profiles;
    expect(plain?.systemPrompt).toContain("/home/user/workspace");
    expect(plain?.tools.length).toBeGreaterThan(0);
    expect(memory?.tools.length).toBeGreaterThan(plain?.tools.length ?? 0);
  });

  it("covers verified limit corrections as well as prompt and tool profiles", async () => {
    const document = await computePiSessionConstructionDocument();
    expect(document.version).toBe(2);
    expect(document.modelLimitOverrides).toStrictEqual(
      PI_MODEL_LIMIT_OVERRIDES,
    );
  });

  it("isolates returned limit snapshots from live models and later digests", async () => {
    const config = {
      provider: "openai",
      model: "gpt-6-luna",
      baseUrl: "https://snapshot.example.test",
      apiKey: "snapshot-isolation-test",
      dialect: "openai-responses",
      transport: "sse",
    } as const;
    const original = resolvePiAgentModel(config);
    if (!original) throw new Error("Missing snapshot test model");
    const limits = {
      contextWindow: original.contextWindow,
      maxTokens: original.maxTokens,
    };
    const digest = await computePiSessionConstructionDigest();
    const document = await computePiSessionConstructionDocument();

    // JavaScript tooling may transform the returned document despite readonly types.
    Object.assign(document.modelLimitOverrides.openai["gpt-6-luna"], {
      contextWindow: 4_096,
      maxTokens: 2_048,
    });

    expect(resolvePiAgentModel(config)).toMatchObject(limits);
    const next = await computePiSessionConstructionDocument();
    expect(next.modelLimitOverrides.openai["gpt-6-luna"]).toStrictEqual(limits);
    expect(await computePiSessionConstructionDigest()).toBe(digest);
  });

  it("is stable across constructions", async () => {
    expect(await computePiSessionConstructionDigest()).toBe(
      await computePiSessionConstructionDigest(),
    );
  });

  it("matches the committed session-construction-digest.json", async () => {
    const digest = await computePiSessionConstructionDigest();
    // Stale file: run `pnpm --filter @okouai/pi-agent-runtime update-session-construction-digest`.
    await expect(
      `${JSON.stringify({ digest }, null, 2)}\n`,
    ).toMatchFileSnapshot("../session-construction-digest.json");
    expect(PI_SESSION_CONSTRUCTION_DIGEST).toBe(digest);
  });
});
