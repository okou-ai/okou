import { describe, expect, it } from "vitest";

import homeStartupTelemetry from "./fixtures/runner-home-startup-telemetry.json";

import {
  knownRunFailureReasonSchema,
  runFailureReasonTokenSchema,
} from "../run-failure-reasons";
import {
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
  storageManifestFilesSchema,
} from "../storages";
import {
  webhookCompleteContract,
  webhookEventsContract,
  webhookSessionOutputContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "../webhooks";

const storageId = "00000000-0000-4000-8000-000000000000";
const manifestHash = "a".repeat(64);

describe("captured runtime usage identities", () => {
  it.each(["okou-1.0", "@preset/okou-1-0", "@preset/" + "x".repeat(247)])(
    "accepts complete billing identity %s",
    (provider) => {
      const body = {
        runId: storageId,
        events: [
          {
            idempotencyKey: storageId,
            kind: "model",
            provider,
            category: "tokens.input",
            quantity: 1,
          },
        ],
      };
      expect(webhookUsageEventContract.send.body.parse(body)).toEqual(body);
      expect(
        webhookUsageEventContract.send.body.safeParse({
          ...body,
          events: [{ ...body.events[0], provider: "x".repeat(256) }],
        }).success,
      ).toBe(false);
    },
  );
});

describe("archive size mismatch telemetry", () => {
  const operation = {
    ts: "2026-09-18T00:00:00Z",
    action_type: "storage_cache_fresh_delivery_headers",
    duration_ms: 183,
    success: false,
    error: "response-size-mismatch",
  };
  const diagnostic = {
    expected_bytes: "5",
    response_bytes: "18446744073709551615",
    source_kind: "storage",
    source_index: 0,
    content_encoding: "other",
  };

  it("preserves exact byte strings and zero index while accepting legacy operations", () => {
    const measured = { ...operation, archive_size_mismatch: diagnostic };
    const parsed = webhookTelemetryContract.send.body.parse({
      runId: "run",
      sandboxOperations: [
        operation,
        {
          ...measured,
          archive_size_mismatch: {
            ...diagnostic,
            archive_url: "https://private.example/archive?secret=private",
            raw_content_encoding: "private-header",
          },
        },
      ],
    });
    expect(parsed.sandboxOperations).toStrictEqual([operation, measured]);
  });

  it("rejects malformed or incomplete diagnostic objects", () => {
    for (const invalid of [
      { ...diagnostic, expected_bytes: 5 },
      { ...diagnostic, expected_bytes: "-1" },
      { ...diagnostic, response_bytes: "01" },
      { ...diagnostic, response_bytes: "1.5" },
      { ...diagnostic, response_bytes: "1e20" },
      { ...diagnostic, response_bytes: "1".repeat(21) },
      { ...diagnostic, response_bytes: "" },
      { ...diagnostic, source_kind: "private-path" },
      { ...diagnostic, source_index: -1 },
      { ...diagnostic, source_index: Number.MAX_SAFE_INTEGER + 1 },
      { ...diagnostic, content_encoding: "private-header" },
      { expected_bytes: "5", response_bytes: "7" },
    ]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId: "run",
          sandboxOperations: [{ ...operation, archive_size_mismatch: invalid }],
        }).success,
      ).toBe(false);
    }
  });
});

describe("archive connection attempt telemetry", () => {
  const operation = {
    ts: "2026-09-20T00:00:00Z",
    action_type: "storage_cache_fresh_delivery_headers",
    duration_ms: 168,
    success: true,
  };
  const diagnostic = {
    started: 2,
    succeeded: 1,
    failed: 0,
    dropped: 0,
    active_at_headers: 1,
    terminal_duration_ms: 37,
    saturated: false,
  };

  it("accepts bounded observations, strips private fields, and accepts legacy operations", () => {
    const measured = { ...operation, archive_connection_attempt: diagnostic };
    const parsed = webhookTelemetryContract.send.body.parse({
      runId: "run",
      sandboxOperations: [
        operation,
        {
          ...measured,
          archive_connection_attempt: {
            ...diagnostic,
            origin: "https://private.example",
            raw_error: "private",
          },
        },
      ],
    });
    expect(parsed.sandboxOperations).toStrictEqual([operation, measured]);
  });

  it("accepts zero and maximum boundaries", () => {
    for (const bounded of [
      {
        started: 0,
        succeeded: 0,
        failed: 0,
        dropped: 0,
        active_at_headers: 0,
        terminal_duration_ms: 0,
        saturated: false,
      },
      {
        started: 255,
        succeeded: 255,
        failed: 255,
        dropped: 255,
        active_at_headers: 255,
        terminal_duration_ms: 4_294_967_295,
        saturated: true,
      },
    ]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId: "run",
          sandboxOperations: [
            { ...operation, archive_connection_attempt: bounded },
          ],
        }).success,
      ).toBe(true);
    }
  });

  it("rejects incomplete, non-integer, and out-of-range observations", () => {
    for (const invalid of [
      { ...diagnostic, started: -1 },
      { ...diagnostic, started: 256 },
      { ...diagnostic, succeeded: 1.5 },
      { ...diagnostic, failed: "0" },
      { ...diagnostic, dropped: -1 },
      { ...diagnostic, active_at_headers: 256 },
      { ...diagnostic, terminal_duration_ms: -1 },
      { ...diagnostic, terminal_duration_ms: 4_294_967_296 },
      { ...diagnostic, saturated: "false" },
      { started: 1, succeeded: 1 },
    ]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId: "run",
          sandboxOperations: [
            { ...operation, archive_connection_attempt: invalid },
          ],
        }).success,
      ).toBe(false);
    }
  });
});

describe("storage batch timing telemetry", () => {
  const operation = {
    ts: "2026-09-24T00:00:00Z",
    action_type: "runner_storage_manifest_batch_apply",
    duration_ms: 42,
    success: true,
    outcome: "dedicated_middle",
    reason: "32_to_64_kib",
  };

  it("keeps bounded durations and fixed timing states while accepting legacy batches", () => {
    const measured = {
      ...operation,
      storage_batch_guest_duration_ms: 0,
      storage_batch_outer_residual_ms: 42,
      storage_batch_timing: "paired",
      storage_batch_admission_ms: 0,
      storage_batch_request_setup_ms: 1,
      storage_batch_frame_builder_wait_ms: 2,
      storage_batch_frame_encode_ms: 3,
      storage_batch_writer_wait_ms: 4,
      storage_batch_frame_write_ms: 5,
      storage_batch_response_wait_ms: 6,
      storage_batch_result_decode_ms: 7,
      storage_batch_resource_log_ms: 8,
      storage_batch_host_timing: "complete",
      storage_batch_guest_timing: "complete",
      storage_batch_resources: "complete",
      storage_batch_guest_request_ownership_us: 0,
      storage_batch_guest_worker_wait_us: 1,
      storage_batch_guest_response_prepare_us: 2,
      storage_batch_containment_wall_us: 3,
      storage_batch_resource_collection_us: 4,
      storage_batch_cpu_usage_us: 5,
      storage_batch_cpu_throttled_us: 6,
      storage_batch_memory_peak_bytes: Number.MAX_SAFE_INTEGER,
      storage_batch_memory_events_oom: 0,
      storage_batch_memory_events_oom_kill: 0,
      storage_batch_memory_events_oom_group_kill: 0,
      storage_batch_pids_events_max: 0,
      storage_batch_payload_size_bucket: "64_to_256_kib",
    };
    const parsed = webhookTelemetryContract.send.body.parse({
      runId: "run",
      sandboxOperations: [
        operation,
        { ...measured, manifest_json: "private manifest" },
      ],
    });
    expect(parsed.sandboxOperations).toStrictEqual([operation, measured]);
    // Previous API's tolerant object reader accepts the new Runner payload and
    // preserves its own fields. Runner/Guest internal artifacts deploy together.
    const olderOperationReader =
      webhookTelemetryContract.send.body.shape.sandboxOperations
        .unwrap()
        .element.omit({
          storage_batch_guest_timing: true,
          storage_batch_resources: true,
          storage_batch_guest_request_ownership_us: true,
          storage_batch_guest_worker_wait_us: true,
          storage_batch_guest_response_prepare_us: true,
          storage_batch_containment_wall_us: true,
          storage_batch_resource_collection_us: true,
          storage_batch_cpu_usage_us: true,
          storage_batch_cpu_throttled_us: true,
          storage_batch_memory_peak_bytes: true,
          storage_batch_memory_events_oom: true,
          storage_batch_memory_events_oom_kill: true,
          storage_batch_memory_events_oom_group_kill: true,
          storage_batch_pids_events_max: true,
        });
    expect(olderOperationReader.parse(measured)).toStrictEqual({
      ...operation,
      storage_batch_guest_duration_ms: 0,
      storage_batch_outer_residual_ms: 42,
      storage_batch_timing: "paired",
      storage_batch_admission_ms: 0,
      storage_batch_request_setup_ms: 1,
      storage_batch_frame_builder_wait_ms: 2,
      storage_batch_frame_encode_ms: 3,
      storage_batch_writer_wait_ms: 4,
      storage_batch_frame_write_ms: 5,
      storage_batch_response_wait_ms: 6,
      storage_batch_result_decode_ms: 7,
      storage_batch_resource_log_ms: 8,
      storage_batch_host_timing: "complete",
      storage_batch_payload_size_bucket: "64_to_256_kib",
    });
  });

  it("rejects negative, oversized, and unbounded timing values", () => {
    for (const field of [
      "storage_batch_guest_request_ownership_us",
      "storage_batch_guest_worker_wait_us",
      "storage_batch_guest_response_prepare_us",
      "storage_batch_containment_wall_us",
      "storage_batch_resource_collection_us",
      "storage_batch_cpu_usage_us",
      "storage_batch_cpu_throttled_us",
      "storage_batch_memory_peak_bytes",
      "storage_batch_memory_events_oom",
      "storage_batch_memory_events_oom_kill",
      "storage_batch_memory_events_oom_group_kill",
      "storage_batch_pids_events_max",
    ]) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
        expect(
          webhookTelemetryContract.send.body.safeParse({
            runId: "run",
            sandboxOperations: [{ ...operation, [field]: value }],
          }).success,
        ).toBe(false);
      }
    }
    for (const invalid of [
      { storage_batch_guest_duration_ms: -1 },
      { storage_batch_guest_duration_ms: 4_294_967_296 },
      { storage_batch_guest_duration_ms: 1.5 },
      { storage_batch_outer_residual_ms: -1 },
      { storage_batch_outer_residual_ms: "42" },
      { storage_batch_timing: "private diagnostic" },
      { storage_batch_admission_ms: -1 },
      { storage_batch_admission_ms: 4_294_967_296 },
      { storage_batch_admission_ms: 1.5 },
      { storage_batch_request_setup_ms: -1 },
      { storage_batch_request_setup_ms: 4_294_967_296 },
      { storage_batch_request_setup_ms: 1.5 },
      { storage_batch_frame_builder_wait_ms: -1 },
      { storage_batch_frame_builder_wait_ms: 4_294_967_296 },
      { storage_batch_frame_builder_wait_ms: 1.5 },
      { storage_batch_frame_encode_ms: -1 },
      { storage_batch_frame_encode_ms: 4_294_967_296 },
      { storage_batch_frame_encode_ms: 1.5 },
      { storage_batch_writer_wait_ms: -1 },
      { storage_batch_writer_wait_ms: 4_294_967_296 },
      { storage_batch_writer_wait_ms: 1.5 },
      { storage_batch_frame_write_ms: -1 },
      { storage_batch_frame_write_ms: 4_294_967_296 },
      { storage_batch_frame_write_ms: 1.5 },
      { storage_batch_response_wait_ms: -1 },
      { storage_batch_response_wait_ms: 4_294_967_296 },
      { storage_batch_response_wait_ms: 1.5 },
      { storage_batch_result_decode_ms: -1 },
      { storage_batch_result_decode_ms: 4_294_967_296 },
      { storage_batch_result_decode_ms: 1.5 },
      { storage_batch_resource_log_ms: -1 },
      { storage_batch_resource_log_ms: 4_294_967_296 },
      { storage_batch_resource_log_ms: 1.5 },
      { storage_batch_host_timing: "private diagnostic" },
      { storage_batch_guest_timing: "private diagnostic" },
      { storage_batch_resources: "private diagnostic" },
      { storage_batch_payload_size_bucket: "private path" },
    ]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId: "run",
          sandboxOperations: [{ ...operation, ...invalid }],
        }).success,
      ).toBe(false);
    }
  });
});

describe("Sandbox transient session output", () => {
  const body = {
    runId: "00000000-0000-4000-8000-000000000001",
    threadId: "00000000-0000-4000-8000-000000000002",
    runEventId: "sandbox:00000000-0000-4000-8000-000000000003:0",
    chunkIndex: 0,
    delta: "hello",
  };

  it("accepts one bounded text delta", () => {
    expect(webhookSessionOutputContract.send.body.safeParse(body).success).toBe(
      true,
    );
  });

  it("rejects channel authority, empty text, and oversized fields", () => {
    for (const invalid of [
      { ...body, userId: "another-user" },
      { ...body, orgId: "another-org" },
      { ...body, channel: "run-output:another" },
      { ...body, delta: "" },
      { ...body, delta: "x".repeat(4097) },
      { ...body, runEventId: "x".repeat(513) },
      { ...body, chunkIndex: -1 },
      { ...body, chunkIndex: 2 ** 32 },
    ]) {
      expect(
        webhookSessionOutputContract.send.body.safeParse(invalid).success,
      ).toBe(false);
    }
  });
});

describe("Run completion metadata", () => {
  const completion = {
    cliAgentType: "codex",
    cliAgentSessionId: "native-session",
    cliAgentSessionHistoryDisposition: "native_only",
  };
  const body = { runId: "run", exitCode: 0 };
  it("accepts native Guest finalization and metadata-free Runner fallback", () => {
    for (const metadata of [{ completion }, {}]) {
      expect(
        webhookCompleteContract.complete.body.parse({ ...body, ...metadata }),
      ).toStrictEqual({ ...body, ...metadata });
    }
  });
  it("accepts authorized writeback Storage outputs", () => {
    for (const outputs of [
      [],
      [
        {
          name: "memory",
          version: manifestHash,
          mountPath: "/memory",
          missingRootPolicy: "preserveParentVersion",
        },
      ],
    ]) {
      const request = {
        ...body,
        completion: { ...completion, storageOutputs: outputs },
      };
      expect(
        webhookCompleteContract.complete.body.parse(request),
      ).toStrictEqual(request);
    }
  });
  it("requires complete native identity metadata", () => {
    for (const invalid of [
      { ...completion, cliAgentSessionId: "" },
      { ...completion, cliAgentType: "" },
      { ...completion, cliAgentSessionHistoryDisposition: undefined },
      { ...completion, cliAgentSessionHistoryDisposition: "unknown" },
    ]) {
      expect(
        webhookCompleteContract.complete.body.safeParse({
          ...body,
          completion: invalid,
        }).success,
      ).toBe(false);
    }
  });
});

function manifestFile(path: string) {
  return { path, hash: manifestHash, size: 0 };
}

describe("storage webhook manifest limits", () => {
  it("accepts the exact file-count boundary and rejects one more file", () => {
    const exactFiles = Array.from(
      { length: STORAGE_MANIFEST_MAX_FILES },
      (_, index) => {
        return manifestFile(`f-${index}`);
      },
    );
    const overFiles = [...exactFiles, manifestFile("over-limit")];

    expect(storageManifestFilesSchema.safeParse(exactFiles).success).toBe(true);
    expect(
      webhookStoragesPrepareContract.prepare.body.safeParse({
        runId: "run-id",
        storageId,
        files: overFiles,
      }).success,
    ).toBe(false);
  });

  it("accepts the exact path-byte boundary and rejects one more byte", () => {
    const exactFiles = [
      manifestFile("é".repeat(STORAGE_MANIFEST_MAX_PATH_BYTES / 2)),
    ];
    const overFiles = [
      manifestFile(`${"é".repeat(STORAGE_MANIFEST_MAX_PATH_BYTES / 2)}a`),
    ];

    expect(storageManifestFilesSchema.safeParse(exactFiles).success).toBe(true);
    expect(
      webhookStoragesCommitContract.commit.body.safeParse({
        runId: "run-id",
        storageId,
        versionId: manifestHash,
        files: overFiles,
      }).success,
    ).toBe(false);
  });
});

describe("agent completion failure reasons", () => {
  const baseBody = {
    runId: "00000000-0000-4000-8000-000000000000",
    exitCode: 1,
  };

  it("accepts known reasons, future tokens, and omission", () => {
    expect(knownRunFailureReasonSchema.options).toStrictEqual([
      "session_history_limit",
      "guest_root_filesystem_full",
      "guest_home_filesystem_full",
      "execution_timeout",
      "insufficient_credits",
      "provider_insufficient_credits",
      "invalid_api_key",
      "invalid_credentials",
      "terms_acceptance_required",
      "context_window_exceeded",
      "input_too_large",
      "provider_image_too_large",
      "output_token_limit",
      "provider_rate_limited",
      "provider_overloaded",
      "provider_stream_timeout",
      "provider_queue_timeout",
      "provider_server_error",
      "response_connection_lost",
      "safety_policy_refusal",
      "reconnect_required",
      "codex_access_program_unavailable",
      "unsupported_model",
      "usage_limit",
    ]);
    for (const failureReason of knownRunFailureReasonSchema.options) {
      expect(
        webhookCompleteContract.complete.body.parse({
          ...baseBody,
          failureReason,
        }),
      ).toMatchObject({ failureReason });
    }
    for (const failureReason of ["future_reason", "a", "a".repeat(64)]) {
      expect(runFailureReasonTokenSchema.parse(failureReason)).toBe(
        failureReason,
      );
      expect(
        webhookCompleteContract.complete.body.parse({
          ...baseBody,
          failureReason,
        }),
      ).toMatchObject({ failureReason });
    }
    expect(
      webhookCompleteContract.complete.body.safeParse(baseBody).success,
    ).toBe(true);
  });

  it("rejects malformed and oversized reason tokens", () => {
    for (const failureReason of [
      "",
      "ProviderOverloaded",
      "provider-overloaded",
      "_provider_overloaded",
      "provider_overloaded_",
      "provider__overloaded",
      "1_provider_overloaded",
      "a".repeat(65),
    ]) {
      expect(
        webhookCompleteContract.complete.body.safeParse({
          ...baseBody,
          failureReason,
        }).success,
      ).toBe(false);
    }
  });
});

describe("webhook telemetry contract", () => {
  it("preserves complete and partial filesystem metric payloads", () => {
    const runId = "00000000-0000-4000-8000-000000000000";
    const metric = {
      ts: "2026-09-01T00:00:00.000Z",
      cpu: 91.25,
      mem_used: 1024,
      mem_total: 2048,
    };
    const fullMetric = {
      ...metric,
      rootfs: {
        used_bytes: 4096,
        total_bytes: 8192,
        available_bytes: 3072,
        used_inodes: 4,
        total_inodes: 8,
        available_inodes: 3,
      },
      cpu_steal_percent: 12.5,
      scheduled_lag_ms: 17,
      control_cpu_usage_usec: 101,
      control_cpu_nr_throttled: 2,
      control_cpu_throttled_usec: 3,
      workload_cpu_usage_usec: 201,
      workload_cpu_nr_throttled: 4,
      workload_cpu_throttled_usec: 5,
    };
    const partialMetric = {
      ...metric,
      scheduled_lag_ms: 29,
      workload_cpu_usage_usec: 301,
    };

    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        metrics: [fullMetric],
      }).metrics,
    ).toStrictEqual([fullMetric]);
    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        metrics: [partialMetric],
      }).metrics,
    ).toStrictEqual([partialMetric]);

    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        metrics: [{ ...fullMetric, future_scheduler_queue_depth: 7 }],
      }).metrics,
    ).toStrictEqual([fullMetric]);
  });

  it("accepts optional bounded canonical runner dimensions", () => {
    const runId = "00000000-0000-4000-8000-000000000000";
    const minimalPayload = webhookTelemetryContract.send.body.parse({ runId });
    expect(minimalPayload).not.toHaveProperty("runnerHostname");
    expect(minimalPayload).not.toHaveProperty("runnerVersion");

    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        runnerHostname: "prod-1.aws.vm3.ai",
        runnerVersion: "0.168.14",
      }),
    ).toMatchObject({
      runnerHostname: "prod-1.aws.vm3.ai",
      runnerVersion: "0.168.14",
    });

    for (const runnerHostname of ["", "x".repeat(256)]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId,
          runnerHostname,
        }).success,
      ).toBe(false);
    }
    for (const runnerVersion of ["", "x".repeat(129)]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId,
          runnerVersion,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts bounded sandbox operation outcome dimensions", () => {
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "session_history_prune",
          duration_ms: 10,
          success: true,
          outcome: "ineligible",
          reason: "source_within_guard",
        },
      ],
    });

    expect(result.sandboxOperations?.[0]).toMatchObject({
      outcome: "ineligible",
      reason: "source_within_guard",
    });
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "session_history_prune",
            duration_ms: 10,
            success: true,
            outcome: "x".repeat(65),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts fresh delivery scan summary dimensions", () => {
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "storage_cache_fresh_delivery_scan_suffix",
          duration_ms: 0,
          success: true,
          outcome: "5_8",
          reason: "3_4",
        },
      ],
    });

    expect(result.sandboxOperations?.[0]).toMatchObject({
      action_type: "storage_cache_fresh_delivery_scan_suffix",
      outcome: "5_8",
      reason: "3_4",
    });
  });

  it("accepts the actual Runner home-cache startup payload", () => {
    expect(
      webhookTelemetryContract.send.body.parse(homeStartupTelemetry),
    ).toStrictEqual(homeStartupTelemetry);
  });

  it("preserves false first-run context and actual home-use evidence", () => {
    const payload = {
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-10-14T03:00:00.000Z",
          action_type: "runner_sandbox_startup",
          duration_ms: 0,
          success: true,
          runner_startup_path: "blank",
          is_first_run: false,
          reuse_key: "thread:00000000-0000-4000-8000-000000000000",
          sandbox_reuse_result: "poolMiss",
          home_reuse_result: "cacheMiss",
        },
      ],
    };
    expect(webhookTelemetryContract.send.body.parse(payload)).toStrictEqual(
      payload,
    );
    expect(
      webhookTelemetryContract.send.body.safeParse({
        ...payload,
        sandboxOperations: [
          { ...payload.sandboxOperations[0], is_first_run: "false" },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded startup outcomes and keeps them optional", () => {
    const startupOutcomes = [
      ["sandbox", "reused"],
      ["workspace", "noReuseKey"],
      ["home", "poolMiss"],
      ["blank", "poolMiss"],
      ["blank", "noReuseKey"],
      ["cold", "poolMiss"],
      ["cold", "profileMismatch"],
      ["cold", "deviceLimitMismatch"],
      ["cold", "unparkFailed"],
    ] as const;
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        ...startupOutcomes.map(([runnerStartupPath, sandboxReuseResult]) => {
          return {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "api_to_spawn",
            duration_ms: 10,
            success: true,
            runner_startup_path: runnerStartupPath,
            sandbox_reuse_result: sandboxReuseResult,
          };
        }),
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "sandbox_create",
          duration_ms: 5,
          success: true,
        },
      ],
    });

    expect(
      result.sandboxOperations?.slice(0, startupOutcomes.length).map((op) => {
        return [op.runner_startup_path, op.sandbox_reuse_result];
      }),
    ).toStrictEqual(startupOutcomes);
    expect(result.sandboxOperations?.at(-1)).not.toHaveProperty(
      "runner_startup_path",
    );
  });

  it("rejects unknown startup outcomes", () => {
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "api_to_spawn",
            duration_ms: 10,
            success: true,
            runner_startup_path: "warm",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded runner pre-spawn concurrency and keeps it optional", () => {
    const buckets = ["1", "2", "3_4", "5_8", "9_plus"] as const;
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        ...buckets.map((bucket) => {
          return {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_pre_spawn_concurrency_bucket: bucket,
          };
        }),
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "agent_execute",
          duration_ms: 20,
          success: true,
        },
      ],
    });

    expect(
      result.sandboxOperations?.slice(0, buckets.length).map((operation) => {
        return operation.runner_pre_spawn_concurrency_bucket;
      }),
    ).toStrictEqual(buckets);
    expect(result.sandboxOperations?.at(-1)).not.toHaveProperty(
      "runner_pre_spawn_concurrency_bucket",
    );
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_pre_spawn_concurrency_bucket: "10_plus",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded runner resource-budget occupancy and keeps it optional", () => {
    const utilizationBuckets = [
      "0_25",
      "26_50",
      "51_75",
      "76_100",
      "over_100",
    ] as const;
    const leaseCountBuckets = ["0", "1", "2", "3_4", "5_8", "9_plus"] as const;
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        ...leaseCountBuckets.map((leaseCount, index) => {
          const utilization =
            utilizationBuckets[index % utilizationBuckets.length];
          return {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_resource_budget_vcpu_utilization_bucket: utilization,
            runner_resource_budget_memory_utilization_bucket: utilization,
            runner_resource_budget_lease_count_bucket: leaseCount,
          };
        }),
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "agent_execute",
          duration_ms: 20,
          success: true,
        },
      ],
    });

    expect(
      result.sandboxOperations
        ?.slice(0, leaseCountBuckets.length)
        .map((operation) => {
          return [
            operation.runner_resource_budget_vcpu_utilization_bucket,
            operation.runner_resource_budget_memory_utilization_bucket,
            operation.runner_resource_budget_lease_count_bucket,
          ];
        }),
    ).toStrictEqual(
      leaseCountBuckets.map((leaseCount, index) => {
        const utilization =
          utilizationBuckets[index % utilizationBuckets.length];
        return [utilization, utilization, leaseCount];
      }),
    );
    expect(result.sandboxOperations?.at(-1)).not.toHaveProperty(
      "runner_resource_budget_vcpu_utilization_bucket",
    );
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_resource_budget_vcpu_utilization_bucket: "101_plus",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_resource_budget_lease_count_bucket: "10_plus",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

it("accepts existing Pi and Codex shapes used by bounded delivery", () => {
  const notice = "[event content truncated for delivery]";
  const imageNotice = "[image omitted for delivery]";
  const events = [
    {
      type: "assistant",
      sequenceNumber: 1,
      message: {
        content: [
          {
            type: "tool_use",
            id: "pi-call",
            name: "read",
            input: { _delivery_notice: notice },
          },
        ],
      },
    },
    {
      type: "user",
      sequenceNumber: 2,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "pi-call",
            is_error: true,
            content: [
              { type: "text", text: notice },
              { type: "text", text: imageNotice },
            ],
          },
        ],
      },
    },
    {
      type: "item.completed",
      sequenceNumber: 3,
      thread_id: "thread",
      turn_id: "turn",
      item: {
        type: "function_call_output",
        id: "codex-call",
        name: "read",
        namespace: "tools",
        output: [
          { type: "input_text", text: notice },
          { type: "input_text", text: imageNotice },
        ],
      },
    },
  ];
  const payload = { runId: "bounded-delivery", events };
  expect(webhookEventsContract.send.body.parse(payload)).toStrictEqual(payload);
});
