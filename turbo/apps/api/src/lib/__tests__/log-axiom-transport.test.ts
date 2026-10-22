import { gunzipSync } from "node:zlib";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { encodeHTML } from "entities";
import { webhookTelemetryContract } from "@okouai/api-contracts/contracts/webhooks";
import { accept, testContext } from "../../__tests__/test-context";

import { withRealAxiomLoggingForTest } from "../../__tests__/mocks";
import { setupApp } from "../../__tests__/test-helpers";
import { server } from "../../mocks/server";
import { createChatEventsFixture } from "../../signals/routes/__tests__/helpers/chat-events-fixture";
import { publicChatActor } from "../../signals/routes/__tests__/helpers/public-chat-actor";
import { useSecretKmsProbe } from "../../signals/routes/__tests__/helpers/secret-kms-probe";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../signals/routes/webhooks-agent-health-usage-telemetry";
import { createDeferredPromise } from "../../signals/utils";
import { mockOptionalEnv } from "../env";

const context = testContext();
const FAILURE_MESSAGE =
  "Fal built-in generation webhook reported failed generation";

async function ownedTelemetryUpload() {
  const owned = await publicChatActor(context);
  const { runId } = await owned.sendChatRun(owned.actor, {
    agentId: owned.agentId,
    prompt: "Exercise Axiom error diagnostics",
  });
  const { claim } = await owned.claimChatRun(owned.runnerGroup, runId);
  const client = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookTelemetryContract);
  return {
    owned,
    runId,
    send: () => {
      return client.send({
        headers: { authorization: `Bearer ${claim.sandboxToken}` },
        body: {
          runId,
          metrics: [
            {
              ts: "2026-10-21T15:53:23.000Z",
              cpu: 1,
              mem_used: 10,
              mem_total: 100,
            },
          ],
        },
      });
    },
  };
}

// Logger-owned transport exception: the real webhook/error boundary must retain
// useful sanitized provider details without exposing them to its Guest caller.
describe("Axiom ingest HTTP error diagnostics", () => {
  it.each(["json", "html"])(
    "logs bounded %s upstream details and permits a later successful upload",
    async (format) => {
      const upload = await ownedTelemetryUpload();
      await upload.owned.run(async () => {
        const token = "xaat-private-error-diagnostic-token";
        mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", token);
        const privateEcho = "private-echoed-metric-payload";
        const message = `no healthy upstream; ${token}; Bearer another-private-token; password="private password"; https://provider.example/private;private-signed-url-path?token=secret; https://provider.example/O'Reilly-private-apostrophe-path?signature=private-url-signature; owner@example.test; ${"upstream context ".repeat(40)}`;
        let requestBytes = 0;
        server.use(
          http.post(
            "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
            async ({ request }) => {
              const sentBody = await request.text();
              requestBytes = Buffer.byteLength(sentBody, "utf8");
              const responseMessage = message.replace(
                "no healthy upstream",
                `no healthy upstream for payload=${sentBody}`,
              );
              const headers = {
                "x-request-id": "axiom-upstream-request-42186",
                "retry-after": "2",
              };
              return format === "json"
                ? HttpResponse.json(
                    {
                      error: { message: responseMessage },
                      echoedEvents: privateEcho,
                    },
                    { status: 503, headers },
                  )
                : new HttpResponse(
                    `<html><body>${encodeHTML(responseMessage).replace(encodeHTML("Bearer another-private-token"), "<span>Bearer&#32;another-private-token</span>")}</body></html>`,
                    {
                      status: 503,
                      headers: { ...headers, "content-type": "text/html" },
                    },
                  );
            },
          ),
        );

        const failed = await accept(upload.send(), [500]);
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
        expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
          "Unhandled request error: Axiom ingest failed with status 503",
          expect.objectContaining({
            error: expect.objectContaining({
              reason: "http_status",
              status: 503,
              dataset: "sandbox-telemetry-metrics",
              retryAfterMs: 2000,
              eventCount: 1,
              requestBytes,
              timeoutMs: expect.any(Number),
              elapsedMs: expect.any(Number),
              upstreamRequestId: "axiom-upstream-request-42186",
              responseContentType:
                format === "json" ? "application/json" : "text/html",
              responseBodySummary: expect.stringContaining(
                "no healthy upstream",
              ),
            }),
          }),
        );
        const fields = z
          .object({
            error: z.object({ responseBodySummary: z.string().max(512) }),
          })
          .parse(
            context.mocks.axiomLogging.error.mock.calls.find(([logMessage]) => {
              return (
                logMessage ===
                "Unhandled request error: Axiom ingest failed with status 503"
              );
            })?.[1],
          );
        expect(fields.error.responseBodySummary).toContain(
          "[redacted authorization]",
        );
        expect(fields.error.responseBodySummary).toContain(
          "[redacted telemetry payload]",
        );
        expect(fields.error.responseBodySummary).not.toContain(upload.runId);
        expect(fields.error.responseBodySummary).toMatch(/\.\.\.$/u);
        const logged = JSON.stringify(
          context.mocks.axiomLogging.error.mock.calls,
        );
        for (const secret of [
          token,
          "another-private-token",
          "private password",
          "private-signed-url-path",
          "private-apostrophe-path",
          "private-url-signature",
          "owner@example.test",
          privateEcho,
        ]) {
          expect(logged).not.toContain(secret);
        }

        server.use(
          http.post(
            "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
            () => {
              return HttpResponse.json({
                ingested: 1,
                failed: 0,
                processedBytes: requestBytes,
              });
            },
          ),
        );
        const accepted = await accept(upload.send(), [200]);
        expect(accepted.body).toStrictEqual({
          success: true,
          id: upload.runId,
        });
      });
    },
  );

  it.each(["oversized", "interrupted", "deadline"])(
    "preserves the known HTTP failure when the error body is %s",
    async (mode) => {
      const upload = await ownedTelemetryUpload();
      await upload.owned.run(async () => {
        const diagnosticStarted = createDeferredPromise<void>(context.signal);
        const diagnosticDeadline = new AbortController();
        context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
          if (milliseconds === 200) {
            diagnosticStarted.resolve(undefined);
            return diagnosticDeadline.signal;
          }
          return undefined;
        });
        let bodyController:
          ReadableStreamDefaultController<Uint8Array> | undefined;
        let bodyFinished = false;
        onTestFinished(() => {
          if (!bodyFinished) {
            bodyFinished = true;
            bodyController?.close();
          }
        });
        server.use(
          http.post(
            "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
            () => {
              if (mode === "oversized") {
                return HttpResponse.json(
                  { message: "x".repeat(5000) },
                  { status: 503 },
                );
              }
              return new HttpResponse(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    bodyController = controller;
                  },
                  cancel() {
                    bodyFinished = true;
                  },
                }),
                { status: 503 },
              );
            },
          ),
        );

        const pending = upload.send();
        await diagnosticStarted.promise;
        if (mode === "interrupted") {
          bodyFinished = true;
          bodyController?.error(
            new Error("private provider body read failure"),
          );
        } else if (mode === "deadline") {
          diagnosticDeadline.abort(
            new DOMException("body deadline", "TimeoutError"),
          );
        }
        const failed = await accept(pending, [500]);
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
        expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
          "Unhandled request error: Axiom ingest failed with status 503",
          expect.objectContaining({
            error: expect.objectContaining({
              reason: "http_status",
              status: 503,
              responseBodySummary: undefined,
              ...(mode === "oversized" ? { responseBodyTruncated: true } : {}),
            }),
          }),
        );
      });
    },
  );
});

// Logger-owned transport exception: verify the selected-eager operation payload
// at the existing external SDK ingest boundary, using real connect/send/claim
// endpoints. Ordinary API route tests must not inspect incidental diagnostics.
describe("selected eager Axiom operation payload", () => {
  it.each([0, 1, 2])(
    "reports %i selected decrypts with both completed intervals",
    async (expectedCount) => {
      const fixture = createChatEventsFixture(context);
      const { actor, agentId, runnerGroup } = await fixture.entitledChatActor();
      await fixture.api.updateUserModelPreference(actor, "claude-fable-5-1");
      await fixture.connectors.connectManualGrant(
        actor,
        "figma",
        "api-token",
        {
          accessToken: "deferred-transport-token",
        },
        agentId,
      );
      if (expectedCount) {
        await fixture.connectors.connectManualGrant(
          actor,
          "openai",
          "api-token",
          {
            apiKey: "eager-transport-token",
          },
          agentId,
        );
      }
      if (expectedCount === 2) {
        await fixture.connectors.connectManualGrant(
          actor,
          "parallel",
          "api-token",
          { apiKey: "parallel-transport-token" },
          agentId,
        );
      }
      context.mocks.axiom.useRealTelemetry.mockReturnValue(true);
      const kms = useSecretKmsProbe();
      const run = await fixture.sendChatRun(actor, {
        agentId,
        model: "claude-fable-5-1",
        prompt: "Verify selected eager observations",
      });
      const actualDecrypts = kms.decryptCalls;
      const claimed = await fixture.claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.environment).toMatchObject({
        FIGMA_TOKEN: "fixture-figma-token",
        ...(expectedCount ? { OPENAI_TOKEN: "eager-transport-token" } : {}),
        ...(expectedCount === 2
          ? { PARALLEL_API_KEY: "parallel-transport-token" }
          : {}),
      });
      expect(actualDecrypts).toBe(expectedCount);
      const eventSchema = z.object({
        run_id: z.string().optional(),
        op_type: z.string().optional(),
        connector_context_schema: z.string().optional(),
        connector_context_builtin_decrypt_count: z.number().optional(),
        connector_context_builtin_decrypt_count_bucket: z.string().optional(),
        duration_ms: z.number().optional(),
        _time: z.string().optional(),
      });
      const events = context.mocks.axiom.sdkIngest.mock.calls
        .flatMap(([, payload]) => {
          return z.array(eventSchema).parse(payload);
        })
        .filter((event) => {
          return event.run_id === run.runId;
        });
      const selected = events.filter((event) => {
        return event.connector_context_schema === "selected_eager_v1";
      });
      expect(selected).toHaveLength(2);
      for (const suffix of ["builtin_resolve", "builtin_decrypt"]) {
        const matches = selected.filter((event) => {
          return (
            event.op_type ===
            `api_dispatch_prepare_context_connector_context_${suffix}`
          );
        });
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({
          connector_context_builtin_decrypt_count: actualDecrypts,
          connector_context_builtin_decrypt_count_bucket:
            expectedCount === 2 ? "2_4" : String(expectedCount),
          duration_ms: expect.any(Number),
          _time: expect.any(String),
        });
        expect(matches[0]!.duration_ms).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(Date.parse(matches[0]!._time!))).toBeTruthy();
      }
      const shared = events.filter((event) => {
        return event.connector_context_schema === "shared_v2";
      });
      expect(shared.length).toBeGreaterThan(0);
      expect(
        shared.every((event) => {
          return (
            event.connector_context_builtin_decrypt_count === undefined &&
            event.connector_context_builtin_decrypt_count_bucket === undefined
          );
        }),
      ).toBeTruthy();
      await fixture.cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    },
  );
});

describe("Axiom logging transport", () => {
  it("sends Fal info/warn diagnostics with the default SDK transport and restores mocks", async () => {
    const sentEvents: unknown[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/vm0-web-logs-dev/ingest",
        async ({ request }) => {
          expect(request.headers.get("content-type")).toBe(
            "application/x-ndjson",
          );
          const body = gunzipSync(
            Buffer.from(await request.arrayBuffer()),
          ).toString("utf8");
          const events = body.split("\n").map((line): unknown => {
            return JSON.parse(line);
          });
          sentEvents.push(...events);
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            failures: [],
            processedBytes: body.length,
            blocksCreated: 1,
            walLength: 0,
          });
        },
      ),
    );

    await withRealAxiomLoggingForTest(async () => {
      // These imports must follow the SDK switch to avoid reusing the logger's
      // singleton or environment overrides from the centralized mock setup.
      const {
        logger,
        flushLogs,
        __resetForTest: resetLogs,
      } = await import("../log");
      const { mockEnv, clearMockedEnv } = await import("../env");
      mockEnv("AXIOM_TOKEN_TELEMETRY", "xaat-fal-logging-test");
      mockEnv("AXIOM_DATASET_SUFFIX", "dev");
      mockEnv("OKOU_DEBUG", "");
      resetLogs();

      const fields = {
        provider: "fal",
        generationId: "test-generation",
        type: "image",
        providerStatus: "ERROR",
        providerHttpStatus: 422,
        providerErrorType: "content_policy_violation",
        failureKind: "output_safety_blocked",
        failureStage: "output",
        classificationSource: "normalized_message_exact",
        publicErrorCode: "GENERATION_OUTPUT_SAFETY_BLOCKED",
        retryPolicy: "manual_once",
        billingDisposition: "not_charged",
        artifactRecorded: false,
        usageRecorded: false,
        admissionStatus: "failed",
        expected: true,
      };
      const unknownFields = {
        ...fields,
        providerHttpStatus: undefined,
        providerErrorType: "unknown",
        failureKind: "unknown",
        failureStage: "unknown",
        classificationSource: "fallback",
        publicErrorCode: "GENERATION_FAILED",
        retryPolicy: "retry_once",
        expected: false,
      };

      const cleanupLogs = async (): Promise<void> => {
        await flushLogs();
        resetLogs();
        clearMockedEnv();
      };
      await Promise.resolve()
        .then(() => {
          const log = logger("BuiltInGenerationWebhooks");
          log.debug(FAILURE_MESSAGE, fields);
          log.info(FAILURE_MESSAGE, fields);
          log.warn(FAILURE_MESSAGE, unknownFields);
        })
        .then(cleanupLogs, async (error: unknown) => {
          await cleanupLogs();
          throw error;
        });

      expect(sentEvents).toStrictEqual([
        expect.objectContaining({
          level: "info",
          message: FAILURE_MESSAGE,
          source: "api",
          fields: { ...fields, context: "BuiltInGenerationWebhooks" },
        }),
        expect.objectContaining({
          level: "warn",
          message: FAILURE_MESSAGE,
          source: "api",
          fields: {
            provider: "fal",
            generationId: "test-generation",
            type: "image",
            providerStatus: "ERROR",
            providerErrorType: "unknown",
            failureKind: "unknown",
            failureStage: "unknown",
            classificationSource: "fallback",
            publicErrorCode: "GENERATION_FAILED",
            retryPolicy: "retry_once",
            billingDisposition: "not_charged",
            artifactRecorded: false,
            usageRecorded: false,
            admissionStatus: "failed",
            expected: false,
            context: "BuiltInGenerationWebhooks",
          },
        }),
      ]);
    });

    const { logger, __resetForTest: resetLogs } = await import("../log");
    onTestFinished(resetLogs);
    logger("RestoredAxiomMock").info("restored logging mock");
    expect(context.mocks.axiomLogging.info).toHaveBeenCalledWith(
      "restored logging mock",
      expect.objectContaining({ context: "RestoredAxiomMock" }),
    );
    expect(sentEvents).toHaveLength(2);
  });
});
