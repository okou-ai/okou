import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import {
  httpIntegration,
  init,
  nativeNodeFetchIntegration,
} from "@sentry/node";
import { registerOTel } from "@vercel/otel";

import { env } from "./lib/env";

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

function setupOpenTelemetry() {
  registerOTel({
    serviceName: OTEL_SERVICE_NAME,
    attributes: { [ATTR_SERVICE_VERSION]: env("GIT_COMMIT_SHA") },
    traceExporter: buildAxiomTraceExporter(),
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
