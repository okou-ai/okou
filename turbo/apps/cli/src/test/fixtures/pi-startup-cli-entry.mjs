import process from "node:process";
import { URL } from "node:url";

// Exercise the production entry through a real process, with build constants
// supplied by the test host just as tsup supplies them in the release bundle.
globalThis.__CLI_VERSION__ = "0.0.0-test";
globalThis.__DEFAULT_SENTRY_DSN__ = "";
const entry = new URL("../../okou.ts", import.meta.url);
process.argv[1] = entry.pathname;
await import(entry.href);
