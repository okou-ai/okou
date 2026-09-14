import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ErrorEvent, StackFrame } from "@sentry/node";
import { getCommandDiagnostic } from "./sentry-command.js";

declare const __CLI_VERSION__: string;
declare const __DEFAULT_SENTRY_DSN__: string;

const DSN = process.env.SENTRY_DSN ?? __DEFAULT_SENTRY_DSN__;

const OPERATIONAL_ERROR_PATTERNS = [
  /not authenticated/i,
  /not found/i,
  /agent not found/i,
  /version not found/i,
  /checkpoint not found/i,
  /session not found/i,
  /file not found/i,
  /environment file not found/i,
  /invalid format/i,
  /invalid.*config/i,
  /rate limit/i,
  /concurrent run limit/i,
  /insufficient.*credit/i,
  /no model provider/i,
  /network error/i,
  /network issue/i,
  /fetch failed/i,
  /connection refused/i,
  /timeout/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /forbidden/i,
  /access denied/i,
];

function isOperationalError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return OPERATIONAL_ERROR_PATTERNS.some((pattern) => {
    return pattern.test(message);
  });
}

if (DSN) {
  const Sentry = await import("@sentry/node");
  const diagnostics = new WeakMap<object, ErrorEvent & { event_id: string }>();
  const environment = [
    "production",
    "preview",
    "development",
    "test",
    "vercel-preview",
    "vercel-production",
  ].find((stage) => {
    return stage === (process.env.SENTRY_ENVIRONMENT ?? "production");
  });
  const errorTypes = [
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "AggregateError",
  ];
  // Only exact first-party module locations are recognized. Other chunks and
  // user/dependency paths are omitted, never reduced to an arbitrary basename.
  const sources = new Map<string, string>();
  for (const [url, name] of [
    [new URL(import.meta.url), "cli.js"],
    [new URL("./okou.js", import.meta.url), "okou.js"],
    [new URL("./okou.ts", import.meta.url), "okou.js"],
  ] as const) {
    sources.set(url.href, name);
    sources.set(fileURLToPath(url), name);
  }

  function sourceFrames(frames: StackFrame[] = []): StackFrame[] {
    return frames.slice(-50).flatMap((frame) => {
      const filename = frame.filename && sources.get(frame.filename);
      if (!filename) return [];
      return [
        {
          filename,
          in_app: true,
          lineno: coordinate(frame.lineno),
          colno: coordinate(frame.colno),
        },
      ];
    });
  }

  function coordinate(value: number | undefined): number | undefined {
    return value !== undefined &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= 10_000_000
      ? value
      : undefined;
  }

  Sentry.init({
    dsn: DSN,
    enableLogs: false,
    environment,
    release: __CLI_VERSION__,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    shutdownTimeout: 500,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    sendClientReports: false,
    // Do not install diagnostic request/child-process propagation or loaders.
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    spotlight: false,
    // Filter out operational errors - only send programmer errors (bugs)
    beforeSend(event, hint) {
      const error = hint.originalException;
      if (isOperationalError(error)) {
        return null; // Drop operational errors
      }
      const exception = event.exception?.values?.at(-1);
      if (!exception) return null;
      const type =
        errorTypes.find((name) => {
          return name === exception.type;
        }) ?? "Error";
      const command = getCommandDiagnostic(error);
      const frames = sourceFrames(exception.stacktrace?.frames);
      // Build a separate positive allowlist. The SDK still mutates its event
      // and adds envelope headers/items after beforeSend in Sentry 10.73.0.
      diagnostics.set(event, {
        type: undefined,
        event_id: randomUUID().replaceAll("-", ""),
        timestamp: Date.now() / 1000,
        platform: "node",
        level: event.level === "fatal" ? "fatal" : "error",
        release: __CLI_VERSION__,
        environment,
        tags: {
          app: "cli",
          "cli.phase": command.phase,
          "cli.operation": command.operation,
        },
        contexts: {
          runtime: {
            name: "node",
            version: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(process.versions.node)
              ? process.versions.node
              : undefined,
          },
        },
        exception: {
          values: [
            {
              type,
              value: type,
              ...(frames.length ? { stacktrace: { frames } } : {}),
            },
          ],
        },
        fingerprint: ["{{ default }}", command.operation ?? command.phase],
      });
      return event;
    },
    transport(options) {
      const transport = Sentry.makeNodeTransport(options);
      return {
        flush: (timeout) => {
          return transport.flush(timeout);
        },
        async send(envelope) {
          for (const [header, payload] of envelope[1]) {
            if (header.type !== "event" || !(payload instanceof Object))
              continue;
            const diagnostic = diagnostics.get(payload);
            if (!diagnostic) continue;
            // No inherited trace/baggage, attachment, session, log, span, SDK
            // extension or arbitrary item header can bypass this final boundary.
            await transport.send([
              {
                event_id: diagnostic.event_id,
                sent_at: new Date().toISOString(),
              },
              [[{ type: "event" }, diagnostic]],
            ]);
          }
          return {};
        },
      };
    },
  });
}

function handleEpipe(err: NodeJS.ErrnoException) {
  if (err.code === "EPIPE") {
    process.exit(0);
  }
  throw err;
}

process.stdout.on("error", handleEpipe);
process.stderr.on("error", handleEpipe);
