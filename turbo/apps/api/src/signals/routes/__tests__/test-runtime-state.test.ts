import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { expectApiError } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedBuiltInModelKey } from "./helpers/runtime-state";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";

const context = testContext();
const runs = createRunsApi(context);

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

describe("POST /api/runners/runs/:runId/model-provider-failures", () => {
  it("authenticates and ignores reports from runners released before the cooldown retirement", async () => {
    const runId = randomUUID();

    await expect(
      runs.reportRunnerModelProviderFailure(runId, { failureKind: "billing" }),
    ).resolves.toStrictEqual({ outcome: "ignored" });

    const missingAuth = await runs.requestRunnerModelProviderFailureAs(
      undefined,
      runId,
      [401],
      { failureKind: "connection", connectionSource: "provider_response" },
    );
    expectApiError(missingAuth.body);
  });
});
