import { describe, expect, it, vi } from "vitest";

import { testContext } from "./test-context";

const context = testContext();

async function importInstrument(
  configureEnv?: (
    envModule: Pick<typeof import("../lib/env"), "mockEnv">,
  ) => void,
): Promise<void> {
  vi.resetModules();
  const { mockEnv } = await import("../lib/env");
  configureEnv?.({ mockEnv });
  await import("../instrument");
}

describe("instrument", () => {
  it("registers OpenTelemetry with api metadata and an OTLP Axiom exporter", async () => {
    const { OTLPTraceExporter } =
      await import("@opentelemetry/exporter-trace-otlp-http");
    await importInstrument((envModule) => {
      envModule.mockEnv("GIT_COMMIT_SHA", "abc123");
    });

    expect(context.mocks.otel.registerOTel).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: {
          "service.version": "abc123",
        },
        serviceName: "vm0-api",
        traceExporter: expect.any(OTLPTraceExporter),
      }),
    );
  });

  it("does not initialize Sentry without a DSN", async () => {
    await importInstrument((envModule) => {
      envModule.mockEnv("SENTRY_DSN", undefined);
    });

    expect(context.mocks.sentry.init).not.toHaveBeenCalled();
  });

  it("does not initialize Sentry outside production", async () => {
    await importInstrument((envModule) => {
      envModule.mockEnv(
        "SENTRY_DSN",
        "https://examplePublicKey@o0.ingest.sentry.io/0",
      );
      envModule.mockEnv("ENV", "preview");
    });

    expect(context.mocks.sentry.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry with api metadata", async () => {
    await importInstrument((envModule) => {
      envModule.mockEnv(
        "SENTRY_DSN",
        "https://examplePublicKey@o0.ingest.sentry.io/0",
      );
      envModule.mockEnv("ENV", "production");
      envModule.mockEnv("GIT_COMMIT_SHA", "abc123");
    });

    expect(context.mocks.sentry.init).toHaveBeenCalledWith({
      dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
      enableLogs: false,
      environment: "production",
      initialScope: {
        tags: {
          app: "api",
        },
      },
      beforeSend: expect.any(Function),
      beforeBreadcrumb: expect.any(Function),
      integrations: [
        {
          name: "Http",
          options: {
            spans: false,
            tracePropagation: false,
            ignoreIncomingRequestBody: expect.any(Function),
          },
        },
        { name: "NodeFetch", options: { tracePropagation: false } },
      ],
      release: "abc123",
      sendDefaultPii: false,
      shutdownTimeout: 500,
      skipOpenTelemetrySetup: true,
      tracesSampleRate: 0,
    });
    expect(context.mocks.sentry.httpIntegration).toHaveBeenCalledWith({
      spans: false,
      tracePropagation: false,
      ignoreIncomingRequestBody: expect.any(Function),
    });
    expect(
      context.mocks.sentry.nativeNodeFetchIntegration,
    ).toHaveBeenCalledWith({
      tracePropagation: false,
    });
    // Body capture happens before beforeSend. Keep this collection boundary
    // covered in addition to the real transport assertions in instrument-export.
    const ignoreBody =
      context.mocks.sentry.httpIntegration.mock.calls[0]?.[0]
        ?.ignoreIncomingRequestBody;
    for (const url of [
      "/api/integrations/telegram/auth-callback?hash=synthetic",
      "/api/integrations/telegram/auth-callback?callbackProtocol=invalid",
      "/api/integrations/discord/oauth/callback?code=synthetic",
    ]) {
      expect(ignoreBody?.(url, {})).toBeTruthy();
    }
    expect(ignoreBody?.("/health", {})).toBeFalsy();
  });
});
