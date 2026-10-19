import { describe, expect, it } from "vitest";
import {
  CHAT_RUN_TRANSIENT_ERROR_MESSAGE,
  formatRunErrorForExternalSurface,
} from "../errors";
import { knownRunFailureReasonSchema } from "../run-failure-reasons";
import { webhookCompleteContract, webhookTelemetryContract } from "../webhooks";

const metric = {
  ts: "2026-10-10T00:00:00Z",
  cpu: 1,
  mem_used: 10,
  mem_total: 100,
};
const rootfs = {
  used_bytes: 20,
  total_bytes: 100,
  available_bytes: 70,
  used_inodes: 4,
  total_inodes: 10,
  available_inodes: 5,
};
const home = {
  used_bytes: 0,
  total_bytes: 200,
  available_bytes: 190,
  used_inodes: 0,
  total_inodes: 20,
  available_inodes: 19,
};

function parse(metric: unknown) {
  return webhookTelemetryContract.send.body.parse({
    runId: "run",
    systemLog: "preserved",
    metrics: [metric],
  });
}

describe("independent filesystem telemetry", () => {
  it("preserves separate byte/inode observations and real zero", () => {
    const observed = { ...metric, rootfs, home };
    expect(parse(observed).metrics).toStrictEqual([observed]);
    expect(parse({ ...metric, rootfs }).metrics).toStrictEqual([
      { ...metric, rootfs },
    ]);
    expect(parse({ ...metric, home }).metrics).toStrictEqual([
      { ...metric, home },
    ]);
    expect(parse(metric).metrics).toStrictEqual([metric]);
  });

  it("preserves independent and unavailable observations in one batch", () => {
    const metrics = [
      { ...metric, rootfs, home },
      { ...metric, rootfs },
      { ...metric, home },
      metric,
    ];
    const body = webhookTelemetryContract.send.body.parse({
      runId: "run",
      systemLog: "preserved",
      metrics,
    });
    expect(body.systemLog).toBe("preserved");
    expect(body.metrics).toStrictEqual(metrics);
  });

  it.each([
    null,
    {},
    "unavailable",
    { ...home, total_bytes: -1 },
    { ...home, used_bytes: 1.5 },
    { ...home, used_bytes: 201 },
    { ...home, available_bytes: 201 },
    { ...home, total_bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...home, used_inodes: 21 },
    { ...home, available_inodes: 21 },
    { ...home, used_bytes: 20, available_bytes: 190 },
  ])(
    "drops a malformed optional observation without rejecting its batch: %j",
    (invalid) => {
      const body = parse({ ...metric, rootfs, home: invalid });
      expect(body.systemLog).toBe("preserved");
      expect(body.metrics).toStrictEqual([
        { ...metric, rootfs, home: undefined },
      ]);
      expect(parse({ ...metric, rootfs: invalid, home }).metrics).toStrictEqual(
        [{ ...metric, rootfs: undefined, home }],
      );
    },
  );

  it("strips extra path-bearing observation fields", () => {
    expect(
      parse({ ...metric, rootfs: { ...rootfs, path: "private" } }).metrics,
    ).toStrictEqual([{ ...metric, rootfs }]);
  });
});

describe("bounded disk failure reasons", () => {
  it("recognizes home exhaustion while retaining open receiver tokens and generic display", () => {
    expect(
      knownRunFailureReasonSchema.parse("guest_home_filesystem_full"),
    ).toBe("guest_home_filesystem_full");
    expect(
      formatRunErrorForExternalSurface({
        code: "RUN_FAILED",
        message: "disk full",
        failureReason: "guest_home_filesystem_full",
      }),
    ).toBe(CHAT_RUN_TRANSIENT_ERROR_MESSAGE);
    for (const failureReason of [
      "guest_root_filesystem_full",
      "guest_home_filesystem_full",
      "future_disk_reason",
    ]) {
      expect(
        webhookCompleteContract.complete.body.parse({
          runId: "run",
          exitCode: 1,
          failureReason,
        }).failureReason,
      ).toBe(failureReason);
    }
    expect(
      webhookCompleteContract.complete.body.safeParse({
        runId: "run",
        exitCode: 1,
        failureReason: "private/".repeat(100),
      }).success,
    ).toBe(false);
  });
});
