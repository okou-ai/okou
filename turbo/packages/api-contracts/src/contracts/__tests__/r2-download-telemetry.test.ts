import { describe, expect, it } from "vitest";

import { webhookTelemetryContract } from "../webhooks";

describe("R2 download telemetry attributes", () => {
  const operation = {
    ts: "2026-10-04T00:00:00.000Z",
    action_type: "storage_cache_fresh_delivery_headers",
    duration_ms: 7,
    success: false,
    error: "http",
  };

  it("accepts old producers and preserves optional identity on the same operation", () => {
    const body = { runId: "test-run", sandboxOperations: [operation] };
    expect(webhookTelemetryContract.send.body.parse(body)).toStrictEqual(body);
    const current = {
      ...body,
      sandboxOperations: [
        {
          ...operation,
          r2_bucket: "example-bucket",
          r2_key: "prefix/archive.tar.gz",
        },
      ],
    };
    expect(webhookTelemetryContract.send.body.parse(current)).toStrictEqual(
      current,
    );
  });

  it("rejects oversized keys without broadening bounded outcome fields", () => {
    for (const fields of [
      { r2_key: "k".repeat(1025) },
      { r2_bucket: "b".repeat(64) },
      { outcome: "o".repeat(65) },
    ]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId: "test-run",
          sandboxOperations: [{ ...operation, ...fields }],
        }).success,
      ).toBe(false);
    }
  });
});
