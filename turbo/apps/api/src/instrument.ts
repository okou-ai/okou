import { LangfuseSpanProcessor } from "@langfuse/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  httpIntegration,
  init,
  nativeNodeFetchIntegration,
} from "@sentry/node";
import { registerOTel } from "@vercel/otel";

import { env } from "./lib/env";
import {
  createPiLangfuseCredentialMask,
  piLangfuseTracingEnvironment,
  readPiLangfuseServerConfig,
} from "./lib/pi-langfuse-debug";
import {
  piLangfuseIdGenerator,
  PI_LANGFUSE_API_OBSERVATION_NAMES,
} from "./lib/pi-langfuse-tracing";
import { safeSync } from "./signals/utils";

const OTEL_SERVICE_NAME = "vm0-api";

function buildAxiomTraceExporter(): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: "https://api.axiom.co/v1/traces",
    headers: {
      authorization: `Bearer ${env("AXIOM_TOKEN_TELEMETRY")}`,
      "x-axiom-dataset": `vm0-traces-${env("AXIOM_DATASET_SUFFIX")}`,
    },
  });
}

function buildLangfuseSpanProcessor(): LangfuseSpanProcessor | undefined {
  const config = readPiLangfuseServerConfig();
  if (!config) {
    return undefined;
  }
  const processor = safeSync(() => {
    return new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      environment: piLangfuseTracingEnvironment(),
      release: env("GIT_COMMIT_SHA"),
      mediaUploadEnabled: false,
      mask: createPiLangfuseCredentialMask(config),
      shouldExportSpan: ({ otelSpan }) => {
        // Filtering is evaluated when each span starts, before later custom
        // attributes exist. Keep the explicit complete ancestor name set.
        return (
          otelSpan.instrumentationScope.name === "langfuse-sdk" &&
          PI_LANGFUSE_API_OBSERVATION_NAMES.includes(otelSpan.name)
        );
      },
    });
  });
  // Optional debug telemetry must never prevent API instrumentation startup.
  return "ok" in processor ? processor.ok : undefined;
}

function setupOpenTelemetry() {
  const langfuseProcessor = buildLangfuseSpanProcessor();
  const spanProcessors = langfuseProcessor
    ? ["auto" as const, langfuseProcessor]
    : ["auto" as const];

  registerOTel({
    serviceName: OTEL_SERVICE_NAME,
    attributes: { [ATTR_SERVICE_VERSION]: env("GIT_COMMIT_SHA") },
    traceExporter: buildAxiomTraceExporter(),
    spanProcessors,
    idGenerator: piLangfuseIdGenerator,
  });
}

function setupSentry() {
  const dsn = env("SENTRY_DSN");
  const environment = env("ENV");

  if (!dsn || environment !== "production") {
    return;
  }

  const release = env("GIT_COMMIT_SHA");

  init({
    dsn,
    enableLogs: false,
    environment,
    initialScope: {
      tags: {
        app: "api",
      },
    },
    integrations: [
      httpIntegration({ spans: false, tracePropagation: false }),
      nativeNodeFetchIntegration({ tracePropagation: false }),
    ],
    release,
    sendDefaultPii: false,
    shutdownTimeout: 500,
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
  });
}

function instrument() {
  setupOpenTelemetry();
  setupSentry();
}

instrument();
