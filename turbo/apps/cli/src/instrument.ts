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
  const [Sentry, os] = await Promise.all([
    import("@sentry/node"),
    import("node:os"),
  ]);

  Sentry.init({
    dsn: DSN,
    enableLogs: false,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    release: __CLI_VERSION__,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    shutdownTimeout: 500,
    initialScope: {
      tags: {
        app: "cli",
      },
    },
    // Filter out operational errors - only send programmer errors (bugs)
    beforeSend(event, hint) {
      const error = hint.originalException;
      if (isOperationalError(error)) {
        return null; // Drop operational errors
      }
      return event;
    },
  });

  Sentry.setContext("cli", {
    version: __CLI_VERSION__,
    command: process.argv.slice(2).join(" "),
  });

  Sentry.setContext("runtime", {
    node_version: process.version,
    os_platform: os.platform(),
    os_release: os.release(),
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
