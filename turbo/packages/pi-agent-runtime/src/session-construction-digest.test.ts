import { describe, expect, it } from "vitest";

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
