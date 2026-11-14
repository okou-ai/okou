import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();

describe("canonical Runner protocol execution", () => {
  it("rejects an incomplete whole-state heartbeat", async () => {
    const api = createRunsApi(context);
    const response = await api.requestRawHeartbeatRunner(true, [400], {
      runnerId: randomUUID(),
      group: await api.configureRunnerGroup(),
      snapshotGeneration: 7,
      snapshotSequence: 42,
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: 2,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: 0,
      admittableProfiles: ["vm0/default"],
      heldSandboxStates: [],
      activeReuseProducers: [],
      mode: "running",
    });
    expect(response.status).toBe(400);
  });
});
