import { randomUUID } from "node:crypto";

import { webhookTelemetryContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { createBddApi } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";

const context = testContext();
const runnerSecret = "b".repeat(64);

function client() {
  return setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
    webhookTelemetryContract,
  );
}

function removalOperation() {
  return {
    ts: nowDate().toISOString(),
    action_type: "runner_home_image_removal",
    duration_ms: 0,
    success: true,
    outcome: "deleted",
    reason: "cache_budget",
    cache_key: "a".repeat(64),
    image_generation: randomUUID(),
    allocated_bytes: 0,
  };
}

describe("Runner sandbox operations without a Run", () => {
  it("accepts GC from a real user Runner token and rejects unowned Run correlation", async () => {
    const bdd = createBddApi(context);
    const auth = createAuthDeviceApiActions(context);
    const actor = bdd.user();
    const device = await auth.startCliDevice();
    await auth.requestCliApproval(
      actor,
      { device_code: device.device_code },
      [200],
    );
    const token = await auth.requestCliToken(device.device_code, [200]);
    if (token.status !== 200) {
      throw new Error("Expected public CLI token exchange");
    }
    const headers = { authorization: `Bearer ${token.body.access_token}` };
    const accepted = await accept(
      client().send({
        headers,
        body: { sandboxOperations: [removalOperation()] },
      }),
      [200],
    );
    expect(accepted.body).toStrictEqual({ success: true });
    const denied = await accept(
      client().send({
        headers,
        body: {
          sandboxOperations: [{ ...removalOperation(), run_id: randomUUID() }],
        },
      }),
      [401],
    );
    expect(denied.body.error.code).toBe("UNAUTHORIZED");
  });

  it("accepts authenticated GC without inventing a response Run", async () => {
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const response = await accept(
      client().send({
        headers: { authorization: `Bearer vm0_official_${runnerSecret}` },
        body: {
          runnerHostname: "runner.example.test",
          runnerVersion: "0.1.0",
          sandboxOperations: [removalOperation()],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true });
  });

  it("accepts known publication identity and a false first-run label from the official host", async () => {
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const response = await accept(
      client().send({
        headers: { authorization: `Bearer vm0_official_${runnerSecret}` },
        body: {
          sandboxOperations: [
            {
              ...removalOperation(),
              action_type: "runner_home_image_publication",
              outcome: "published",
              reason: "synced_commit",
              run_id: randomUUID(),
              is_first_run: false,
              profile_name: "default",
              reuse_key: "thread:known",
            },
          ],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true });
  });

  it("rejects invalid Runner credentials for unlinked operations", async () => {
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    for (const credential of [
      "vm0_official_wrong-secret",
      "unrecognized-token",
      "clerk-session",
    ]) {
      const response = await accept(
        client().send({
          headers: { authorization: `Bearer ${credential}` },
          body: { sandboxOperations: [removalOperation()] },
        }),
        [401],
      );
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("accepts settled startup source identity and candidate outcomes through the current endpoint", async () => {
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const generation = randomUUID();
    const source = {
      ts: nowDate().toISOString(),
      duration_ms: 0,
      success: true,
      cache_key: "a".repeat(64),
      profile_name: "vm0/default",
      image_generation: generation,
    };
    const response = await accept(
      client().send({
        headers: { authorization: `Bearer vm0_official_${runnerSecret}` },
        body: {
          sandboxOperations: [
            {
              ...source,
              action_type: "runner_sandbox_startup",
              run_id: randomUUID(),
              runner_startup_path: "home",
              home_reuse_result: "reused",
              is_first_run: false,
            },
            {
              ...source,
              action_type: "runner_home_image_consumption",
              outcome: "selected",
              reason: "cache_hit",
            },
            {
              ts: source.ts,
              action_type: "runner_home_image_consumption",
              duration_ms: 0,
              success: true,
              outcome: "busy",
              reason: "active",
            },
            {
              ts: source.ts,
              action_type: "runner_home_image_consumption",
              duration_ms: 0,
              success: true,
              outcome: "unavailable",
            },
          ],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true });
  });

  it("accepts unloaded inventory and Run-correlated admission through the normal Runner path", async () => {
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    const runnerId = randomUUID();
    const response = await accept(
      client().send({
        headers: { authorization: `Bearer vm0_official_${runnerSecret}` },
        body: {
          sandboxOperations: [
            {
              ts: nowDate().toISOString(),
              action_type: "runner_home_inventory",
              duration_ms: 0,
              success: true,
              outcome: "loading",
              runner_id: runnerId,
              runner_heartbeat_generation: 7,
              inventory_loaded: false,
            },
            {
              ts: nowDate().toISOString(),
              action_type: "runner_home_inventory",
              duration_ms: 0,
              success: true,
              outcome: "assembled",
              runner_id: runnerId,
              runner_heartbeat_generation: 7,
              inventory_loaded: true,
              inventory_observed_states: 0,
              inventory_output_states: 0,
              inventory_omitted_states: 0,
            },
            {
              ts: nowDate().toISOString(),
              action_type: "runner_home_admission",
              duration_ms: 0,
              success: true,
              outcome: "deferred",
              reason: "capacity_exhausted",
              runner_id: runnerId,
              runner_heartbeat_generation: 7,
              run_id: randomUUID(),
              profile_name: "vm0/default",
              reuse_key: "thread:known",
            },
          ],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true });
  });

  it("requires Run attribution for metrics and system logs", async () => {
    mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
    for (const fields of [
      { metrics: [] },
      { systemLog: "unlinked system log" },
    ]) {
      const response = await accept(
        client().send({
          headers: { authorization: `Bearer vm0_official_${runnerSecret}` },
          body: { ...fields, sandboxOperations: [removalOperation()] },
        }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
    }
  });
});
