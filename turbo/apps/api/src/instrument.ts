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
  containsTelegramBotTelemetryUrl,
  filterTelegramSentryBreadcrumb,
  filterTelegramSentryEvent,
  isTelegramAuthTelemetryUrl,
  TELEGRAM_BOT_TELEMETRY_URL,
} from "./lib/telegram-auth-telemetry";

const OTEL_SERVICE_NAME = "vm0-api";
// Axiom ingest calls are the telemetry writes themselves. Tracing them adds a
// span per write to the same Axiom org; ingest failures already surface as
// Axiom client errors.
const AXIOM_INGEST_URL =
  /^https:\/\/api\.axiom\.co\/v1\/datasets\/[^/?#]+\/ingest(?:[?#]|$)/u;

class AxiomTraceExporter extends OTLPTraceExporter {
  override export(
    spans: Parameters<OTLPTraceExporter["export"]>[0],
    callback: Parameters<OTLPTraceExporter["export"]>[1],
  ): void {
    // Ignoring the outbound fetch does not protect a parent span that records
    // its exception. Inspect the public OTLP content, not SDK object internals.
    super.export(
      spans.filter((span) => {
        return !containsTelegramBotTelemetryUrl({
          name: span.name,
          attributes: span.attributes,
          status: span.status,
          events: span.events,
          links: span.links,
          resource: span.resource.attributes,
          scope: span.instrumentationScope,
        });
      }),
      callback,
    );
  }
}

function buildAxiomTraceExporter(): OTLPTraceExporter {
  return new AxiomTraceExporter({
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
    instrumentationConfig: {
      fetch: {
        ignoreUrls: [AXIOM_INGEST_URL, TELEGRAM_BOT_TELEMETRY_URL],
      },
    },
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
        ignoreOutgoingRequests: (url) => {
          return TELEGRAM_BOT_TELEMETRY_URL.test(url);
        },
        ignoreIncomingRequestBody: (url) => {
          return (
            isDiscordOauthTelemetryUrl(url) || isTelegramAuthTelemetryUrl(url)
          );
        },
      }),
      nativeNodeFetchIntegration({
        tracePropagation: false,
        ignoreOutgoingRequests: (url) => {
          return TELEGRAM_BOT_TELEMETRY_URL.test(url);
        },
      }),
    ],
    release,
    sendDefaultPii: false,
    beforeSend: (event) => {
      return filterTelegramSentryEvent(event)
        ? filterDiscordOauthSentryEvent(event)
        : null;
    },
    beforeBreadcrumb: (breadcrumb) => {
      return filterTelegramSentryBreadcrumb(breadcrumb)
        ? filterDiscordOauthSentryBreadcrumb(breadcrumb)
        : null;
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
