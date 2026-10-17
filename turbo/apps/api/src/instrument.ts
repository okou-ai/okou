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
  filterDiscordOauthSentryBreadcrumb,
  filterDiscordOauthSentryEvent,
  isDiscordOauthTelemetryUrl,
} from "./lib/discord-oauth-telemetry";
import {
  filterTelegramAuthSentryBreadcrumb,
  filterTelegramAuthSentryEvent,
  isTelegramAuthTelemetryUrl,
} from "./lib/telegram-auth-telemetry";
import {
  filterRunnerFileDownloadSentryBreadcrumb,
  filterRunnerFileDownloadSentryEvent,
  isRunnerFileDownloadTelemetryUrl,
} from "./lib/runner-file-download-telemetry";

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
    spanProcessors: ["auto"],
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
      httpIntegration({
        spans: false,
        tracePropagation: false,
        ignoreIncomingRequestBody: (url) => {
          return (
            isDiscordOauthTelemetryUrl(url) ||
            isTelegramAuthTelemetryUrl(url) ||
            isRunnerFileDownloadTelemetryUrl(url)
          );
        },
      }),
      nativeNodeFetchIntegration({ tracePropagation: false }),
    ],
    release,
    sendDefaultPii: false,
    beforeSend: (event) => {
      if (
        !filterTelegramAuthSentryEvent(event) ||
        !filterDiscordOauthSentryEvent(event)
      ) {
        return null;
      }
      return filterRunnerFileDownloadSentryEvent(event);
    },
    beforeBreadcrumb: (breadcrumb) => {
      if (
        !filterTelegramAuthSentryBreadcrumb(breadcrumb) ||
        !filterDiscordOauthSentryBreadcrumb(breadcrumb)
      ) {
        return null;
      }
      return filterRunnerFileDownloadSentryBreadcrumb(breadcrumb);
    },
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
