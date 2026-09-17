import { settleIncludingAbort } from "../../signals/utils";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createUsagePricingFixture,
  upsertUsagePricingRows,
} from "../../test-fixtures/usage-pricing";
import { accept, testContext } from "../../__tests__/test-context";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { withRealAxiomLoggingForTest } from "../../__tests__/mocks";
import { server } from "../../mocks/server";

const context = testContext();
const FAILURE_MESSAGE =
  "Fal built-in generation webhook reported failed generation";

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
          const body = await request.text();
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

// Module resets re-import the real route graph; allow its initial transform.
// Logger-owned exception: this tests the SDK's actual NDJSON transport and
// price-observation mapping, never enabling a live Axiom transport or monitor.
test("transports one priced Stage 1 observation and an unpriced replay at the original accounting time", async () => {
  const sent: unknown[] = [];
  server.use(
    http.post(
      "https://api.axiom.co/v1/datasets/vm0-web-logs-prod/ingest",
      async ({ request }) => {
        const body = await request.text();
        const events: unknown[] = body.split("\n").map((line) => {
          return JSON.parse(line);
        });
        sent.push(...events);
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
  const rows = [
    "tokens.input",
    "tokens.output",
    "tokens.cache_read",
    "tokens.cache_creation",
  ].map((category) => {
    return {
      kind: "model",
      provider: "gpt-5.6-luna",
      category,
      unitPrice: 1000,
      unitSize: 1_000_000,
    };
  });
  const pricing = await createUsagePricingFixture({ configured: rows });
  onTestFinished(pricing.cleanup);
  const owner = {
    memory_storage_id: randomUUID(),
    pi_session_id: randomUUID(),
    org_id: randomUUID(),
    user_id: randomUUID(),
  };
  await withRealAxiomLoggingForTest(async () => {
    const {
      logger,
      flushLogs,
      __resetForTest: resetLogs,
    } = await import("../log");
    const { mockEnv, clearMockedEnv } = await import("../env");
    mockEnv("AXIOM_TOKEN_TELEMETRY", "xaat-cost-transport-test");
    mockEnv("AXIOM_DATASET_SUFFIX", "prod");
    resetLogs();
    onTestFinished(() => {
      resetLogs();
      clearMockedEnv();
    });
    // The route graph must follow the SDK module reset too.
    const { setupApp: realSetupApp } =
      await import("../../__tests__/test-helpers");
    const {
      testPiMemoryStage1StateContract: realContract,
      testPiMemoryStage1StateRoutes: realRoutes,
    } = await import("../../signals/routes/test-pi-memory-stage1-state");
    const realApi = realSetupApp({
      context,
      routes: realRoutes,
      usagePricingResolution: pricing.resolution,
    })(realContract);
    const body = {
      ...owner,
      action: "record-usage" as const,
      source_history_hash: "a".repeat(64),
      response_source_id: "opaque-provider-response",
      billing_mode: "builtin" as const,
      usage: { input: 10, output: 8, cacheRead: 2, cacheWrite: 3 },
    };
    const work = await settleIncludingAbort(
      (async () => {
        const first = await accept(realApi.action({ body }), [200]);
        await upsertUsagePricingRows(
          rows.map((row) => {
            return {
              ...row,
              provider: pricing.resolution[0]!.lookupProvider,
              unitPrice: 9000,
            };
          }),
        );
        const replay = await accept(realApi.action({ body }), [200]);
        expect(replay.body.receipt).toStrictEqual({
          ...first.body.receipt,
          disposition: "replay",
        });
      })(),
    );
    await accept(
      realApi.action({
        body: {
          ...owner,
          action: "cleanup",
          source_history_hashes: [],
          agent_session_ids: [],
        },
      }),
      [200],
    );
    if (!work.ok) {
      throw work.error;
    }
    logger("PiMemoryStage1Cost").debug("Pi memory Stage 1 cost observed", {
      operation: "pi_memory_stage1",
    });
    await flushLogs();
    resetLogs();
    clearMockedEnv();
  });
  const eventSchema = z.object({
    _time: z.iso.datetime(),
    message: z.string(),
    level: z.string(),
    source: z.string(),
    fields: z.record(z.string(), z.unknown()),
  });
  const events = sent.flatMap((event) => {
    const parsed = eventSchema.safeParse(event);
    return parsed.success &&
      parsed.data.message === "Pi memory Stage 1 cost observed"
      ? [parsed.data]
      : [];
  });
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    level: "info",
    source: "api",
    fields: {
      operation: "pi_memory_stage1",
      context: "PiMemoryStage1Cost",
      ledgerStatus: "new",
      pricingStatus: "available",
      grossCreditValueUsd: 0.000023,
      grossCreditValueNanoUsd: "23000",
      pricingProvider: pricing.resolution[0]!.lookupProvider,
      inputTokens: 10,
      outputTokens: 8,
      cacheReadTokens: 2,
      cacheCreationTokens: 3,
      currency: "USD",
      unit: "gross_credit_value",
      creditsPerUsd: 1000,
    },
  });
  expect(events[1]).toMatchObject({
    level: "info",
    source: "api",
    fields: {
      ledgerStatus: "replay",
      pricingStatus: "replay",
      grossCreditValueUsd: null,
      accountingAt: events[0]!.fields.accountingAt,
      accountingId: events[0]!.fields.accountingId,
    },
  });
  expect(JSON.stringify(events)).not.toContain("opaque-provider-response");
}, 30_000);
