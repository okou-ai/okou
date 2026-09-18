import { randomUUID } from "node:crypto";

import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import { webhookTelemetryContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi } from "../../routes/__tests__/helpers/api-bdd";
import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import { createDeferredPromise } from "../../utils";

const context = testContext();

function sdkClientForDataset(
  mocks: ReturnType<typeof getApiTestMocks>,
  dataset: string,
) {
  const client = mocks.axiom.clients.find((candidate) => {
    return candidate.ingest.mock.calls.some(([actualDataset]) => {
      return actualDataset === dataset;
    });
  });
  if (!client) {
    throw new Error(`Expected Axiom SDK client for ${dataset}`);
  }
  return client;
}

describe("shared SDK ingestion", () => {
  it("preserves archive mismatch diagnostics through the sandbox-operation SDK transport", async () => {
    // Logger-suite exception: ingestion is the subject and no read endpoint
    // exposes it. Use the real webhook to cover validation and projection.
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: `Archive mismatch telemetry ${randomUUID()}`,
      visibility: "private",
    });
    const { runId } = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "check archive startup",
      modelProvider: "anthropic-api-key",
    });
    const token = runs.sandboxTokenForRun(actor, runId);
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
      archive_url: "https://private.example/archive?secret=private",
      raw_content_encoding: "private-header",
    } as const;
    const response = await accept(
      setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
        webhookTelemetryContract,
      ).send({
        headers: { authorization: `Bearer ${token}` },
        body: {
          runId,
          sandboxOperations: [
            operation,
            { ...operation, archive_size_mismatch: diagnostic },
          ],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, id: runId });
    const expected = {
      _time: operation.ts,
      source: "sandbox",
      sandbox_type: "runner",
      op_type: operation.action_type,
      duration_ms: operation.duration_ms,
      success: false,
      error: operation.error,
      run_id: runId,
    };
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [expected],
    );
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [
        {
          ...expected,
          archive_size_mismatch_expected_bytes: "5",
          archive_size_mismatch_response_bytes: "18446744073709551615",
          archive_size_mismatch_source_kind: "storage",
          archive_size_mismatch_source_index: 0,
          archive_size_mismatch_content_encoding: "other",
        },
      ],
    );
  });

  it("preserves workspace restore measurements through the sandbox-operation SDK transport", async () => {
    // Logger-suite exception: the SDK ingestion record is the subject, and no
    // production read endpoint exposes it. Exercise the real webhook so its
    // validation and field projection remain part of this transport contract.
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: `Workspace history telemetry ${randomUUID()}`,
      visibility: "private",
    });
    const { runId } = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "restore workspace history",
      modelProvider: "anthropic-api-key",
    });
    const token = runs.sandboxTokenForRun(actor, runId);
    const ts = "2026-09-15T00:00:00Z";
    const metadata = {
      session_history_framework: "codex",
      session_history_raw_bytes: RESUME_SESSION_HISTORY_MAX_BYTES,
      session_history_source_bytes: 1024,
      session_history_source_representation: "codex_zstd",
      session_history_restore_representation: "raw",
      session_history_restore_reason: "codex_pruning_guard",
    } as const;
    const operation = {
      ts,
      action_type: "session_history_workspace_cache_guest_restore",
      duration_ms: 1234,
      success: true,
    };
    const measured = {
      ...operation,
      ...metadata,
      session_history_guest_bytes: RESUME_SESSION_HISTORY_MAX_BYTES,
      session_history_ref_hash: "must-not-reach-axiom",
    };
    const zero = {
      session_history_raw_bytes: 0,
      session_history_source_bytes: 0,
      session_history_guest_bytes: 0,
    };
    const transfer = {
      ...operation,
      action_type: "session_history_transfer",
      session_history_framework: "codex",
      session_history_restore_representation: "raw",
      session_history_transfer_source: "workspace_cache",
      session_history_wire_codec: "zstd",
      session_history_codec_reason: "sample_accepted",
      session_history_transfer_bytes: RESUME_SESSION_HISTORY_MAX_BYTES,
      session_history_wire_bytes: 1024,
      session_history_write_requests: 9,
      session_history_selection_ms: 0,
      session_history_file_gate_wait_ms: 0,
      session_history_requests_ms: 1200,
      session_history_encoder_pipeline_ms: 1000,
      session_history_publication_ms: 0,
    } as const;
    const emptyTransfer = {
      ...transfer,
      session_history_transfer_source: "inline",
      session_history_transfer_bytes: 0,
      session_history_wire_bytes: 0,
      session_history_write_requests: 1,
      session_history_wire_codec: "none",
      session_history_codec_reason: "below_threshold",
      session_history_encoder_pipeline_ms: 0,
    } as const;
    const failedTransfer = {
      ...operation,
      action_type: "session_history_transfer",
      success: false,
      session_history_framework: "codex",
      session_history_transfer_source: "downloaded",
    } as const;
    const largeInlineTransfer = {
      ...transfer,
      session_history_transfer_source: "inline",
      session_history_transfer_bytes: 256 * 1024 * 1024,
      session_history_wire_bytes: 288 * 1024 * 1024,
      session_history_write_requests: 18,
    } as const;
    const response = await accept(
      setupApp({ context, routes: webhooksAgentHealthUsageTelemetryRoutes })(
        webhookTelemetryContract,
      ).send({
        headers: { authorization: `Bearer ${token}` },
        body: {
          runId,
          sandboxOperations: [
            measured,
            { ...operation, ...metadata, success: false },
            { ...operation, ...zero },
            { ...operation, action_type: "legacy_operation" },
            transfer,
            emptyTransfer,
            failedTransfer,
            largeInlineTransfer,
          ],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, id: runId });

    const expected = {
      _time: ts,
      source: "sandbox",
      sandbox_type: "runner",
      op_type: operation.action_type,
      duration_ms: operation.duration_ms,
      success: true,
      run_id: runId,
    };
    for (const event of [
      {
        ...expected,
        ...metadata,
        session_history_guest_bytes: RESUME_SESSION_HISTORY_MAX_BYTES,
      },
      { ...expected, ...metadata, success: false },
      { ...expected, ...zero },
      { ...expected, op_type: "legacy_operation" },
    ]) {
      expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
        "vm0-sandbox-op-log-dev",
        [event],
      );
    }
    for (const { ts: transferTime, action_type: opType, ...fields } of [
      transfer,
      emptyTransfer,
      failedTransfer,
      largeInlineTransfer,
    ]) {
      expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
        "vm0-sandbox-op-log-dev",
        [{ ...expected, ...fields, _time: transferTime, op_type: opType }],
      );
    }
  });

  it("attributes dataset failures and flushes every selected client", async () => {
    const { flushAxiom, ingestToAxiom } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    const mocks = getApiTestMocks();
    const restoreConsole = mocks.console.capture();
    onTestFinished(restoreConsole);

    const telemetryToken = "xaat-private-telemetry-token";
    const sessionsToken = "xaat-private-sessions-token";
    const requestDataset = "okou-request-log-shared-test";
    const contextDataset = "okou-run-context-shared-test";
    const sessionsDataset = "okou-agent-run-events-shared-test";
    const requestPayload = "private-request-payload";
    const secondRequestPayload = "private-second-request-payload";
    const contextPayload = "private-context-payload";
    const sessionsPayload = "private-sessions-payload";
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", telemetryToken);
    mockOptionalEnv("AXIOM_TOKEN_SESSIONS", sessionsToken);

    expect(
      ingestToAxiom(requestDataset, [{ value: requestPayload }]),
    ).toBeTruthy();
    expect(
      ingestToAxiom(contextDataset, [{ value: contextPayload }]),
    ).toBeTruthy();
    expect(
      ingestToAxiom(sessionsDataset, [{ value: sessionsPayload }]),
    ).toBeTruthy();
    expect(
      ingestToAxiom(requestDataset, [{ value: secondRequestPayload }]),
    ).toBeTruthy();

    const requestClient = sdkClientForDataset(mocks, requestDataset);
    const contextClient = sdkClientForDataset(mocks, contextDataset);
    const sessionsClient = sdkClientForDataset(mocks, sessionsDataset);
    expect(
      mocks.axiom.clients.filter((client) => {
        return client.ingest.mock.calls.length > 0;
      }),
    ).toHaveLength(3);
    expect(requestClient.options.token).toBe(telemetryToken);
    expect(contextClient.options.token).toBe(telemetryToken);
    expect(sessionsClient.options.token).toBe(sessionsToken);
    expect(requestClient.ingest.mock.calls).toStrictEqual([
      [requestDataset, [{ value: requestPayload }]],
      [requestDataset, [{ value: secondRequestPayload }]],
    ]);

    const requestError = new Error("The operation was aborted due to timeout");
    requestError.name = "TimeoutError";
    const contextError = new Error("connection refused");
    const requestOnError = requestClient.options.onError;
    const contextOnError = contextClient.options.onError;
    if (!requestOnError || !contextOnError) {
      throw new Error("Expected dataset-bound Axiom error callbacks");
    }
    requestOnError(requestError);
    contextOnError(contextError);

    const operationLogs = mocks.axiomLogging.error.mock.calls.filter(
      ([message]) => {
        return message === "Axiom client operation failed";
      },
    );
    expect(operationLogs).toStrictEqual([
      [
        "Axiom client operation failed",
        expect.objectContaining({
          client: "telemetry",
          dataset: requestDataset,
          failureKind: "timeout",
          error: requestError,
        }),
      ],
      [
        "Axiom client operation failed",
        expect.objectContaining({
          client: "telemetry",
          dataset: contextDataset,
          failureKind: "transport_error",
          error: contextError,
        }),
      ],
    ]);
    const serializedOperationLogs = JSON.stringify(operationLogs);
    for (const secret of [
      telemetryToken,
      sessionsToken,
      requestPayload,
      secondRequestPayload,
      contextPayload,
      sessionsPayload,
    ]) {
      expect(serializedOperationLogs).not.toContain(secret);
    }

    const flushController = new AbortController();
    onTestFinished(() => {
      flushController.abort();
    });
    const requestFlush = createDeferredPromise<void>(flushController.signal);
    const contextFlush = createDeferredPromise<void>(flushController.signal);
    requestClient.flush.mockReturnValueOnce(requestFlush.promise);
    contextClient.flush.mockReturnValueOnce(contextFlush.promise);
    sessionsClient.flush.mockResolvedValue(undefined);
    const telemetryFlush = flushAxiom({ client: "telemetry" });
    expect(requestClient.flush).toHaveBeenCalledOnce();
    expect(contextClient.flush).toHaveBeenCalledOnce();
    expect(sessionsClient.flush).not.toHaveBeenCalled();
    requestFlush.resolve();
    contextFlush.resolve();
    await expect(telemetryFlush).resolves.toBeUndefined();

    requestClient.flush.mockClear();
    contextClient.flush.mockClear();
    sessionsClient.flush.mockClear();
    await expect(flushAxiom({ client: "sessions" })).resolves.toBeUndefined();
    expect(requestClient.flush).not.toHaveBeenCalled();
    expect(contextClient.flush).not.toHaveBeenCalled();
    expect(sessionsClient.flush).toHaveBeenCalledOnce();

    requestClient.flush.mockClear();
    contextClient.flush.mockClear();
    sessionsClient.flush.mockClear();
    mocks.axiom.flush.mockResolvedValue(undefined);
    await expect(flushAxiom()).resolves.toBeUndefined();
    expect(requestClient.flush).toHaveBeenCalledOnce();
    expect(contextClient.flush).toHaveBeenCalledOnce();
    expect(sessionsClient.flush).toHaveBeenCalledOnce();

    requestClient.flush.mockClear();
    contextClient.flush.mockClear();
    sessionsClient.flush.mockClear();
    mocks.axiomLogging.error.mockClear();
    const flushError = new Error("flush rejected");
    requestClient.flush.mockRejectedValueOnce(flushError);
    contextClient.flush.mockResolvedValueOnce(undefined);
    await expect(flushAxiom({ client: "telemetry" })).resolves.toBeUndefined();
    expect(requestClient.flush).toHaveBeenCalledOnce();
    expect(contextClient.flush).toHaveBeenCalledOnce();
    expect(sessionsClient.flush).not.toHaveBeenCalled();
    expect(mocks.axiomLogging.error).toHaveBeenCalledWith(
      "Axiom client flush failed",
      expect.objectContaining({
        client: "telemetry",
        dataset: requestDataset,
        error: flushError,
      }),
    );
  });
});

describe("queryAxiom", () => {
  it("keeps the Axiom match timestamp when event data contains _time", async () => {
    const { queryAxiom } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    const mocks = getApiTestMocks();
    mocks.axiom.query.mockResolvedValue({
      matches: [
        {
          _time: "2026-06-10T11:00:00Z",
          data: {
            _time: "not-a-timestamp",
            host: "api.example.com",
          },
        },
      ],
    });

    const rows = await createStore().get(
      queryAxiom("['vm0-sandbox-telemetry-network-dev']"),
    );

    expect(rows).toStrictEqual([
      {
        _time: "2026-06-10T11:00:00Z",
        host: "api.example.com",
      },
    ]);
  });

  it("sends pagination cursor reads without using the Axiom cache", async () => {
    const { queryAxiom } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    const mocks = getApiTestMocks();
    const apl = "['vm0-agent-run-events-dev'] | limit 1";
    const requests: {
      readonly authorization: string | null;
      readonly body: unknown;
      readonly url: string;
    }[] = [];

    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/_apl",
        async ({ request }) => {
          requests.push({
            authorization: request.headers.get("authorization"),
            body: await request.json(),
            url: request.url,
          });

          return HttpResponse.json({
            matches: [
              {
                _time: "2026-06-10T12:00:00Z",
                data: {
                  _time: "not-a-timestamp",
                  log: "next page",
                },
              },
            ],
          });
        },
      ),
    );

    const rows = await createStore().get(
      queryAxiom(apl, {
        cursor: "cursor-next-page",
        noCache: true,
      }),
    );

    expect(mocks.axiom.query).not.toHaveBeenCalled();
    expect(requests).toStrictEqual([
      {
        authorization: "Bearer xaat-test-sessions",
        body: {
          apl,
          cursor: "cursor-next-page",
        },
        url: "https://api.axiom.co/v1/datasets/_apl?format=legacy&nocache=true",
      },
    ]);
    expect(rows).toStrictEqual([
      {
        _time: "2026-06-10T12:00:00Z",
        log: "next page",
      },
    ]);
  });
});
