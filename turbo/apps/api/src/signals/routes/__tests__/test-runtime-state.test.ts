import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { seedBuiltInModelKey } from "./helpers/runtime-state";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

const context = testContext();

describe("POST /api/test/runtime-state/action", () => {
  it("keeps overlapping built-in model-key fixtures independently releasable", async () => {
    const first = await seedBuiltInModelKey(
      context,
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    const second = await seedBuiltInModelKey(
      context,
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );

    expect(first.selectedModel).toBe(SEEDED_SYSTEM_DEFAULT_MODEL);
    expect(second.selectedModel).toBe(SEEDED_SYSTEM_DEFAULT_MODEL);

    await expect(first.release()).resolves.toBeUndefined();
    await expect(second.release()).resolves.toBeUndefined();
  });
});
