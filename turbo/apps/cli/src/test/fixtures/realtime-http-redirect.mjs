import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";
import { URL, urlToHttpOptions } from "node:url";

const origin = new URL(process.env.OKOU_API_BACKEND_URL);
const originalRequest = https.request;

// Route external Ably requests to the test server. Keep the real SDK,
// native sockets, cancellation, and event-loop ownership in the child process.
https.request = function (input, optionsOrCallback, callback) {
  const options =
    input instanceof URL || typeof input === "string"
      ? {
          ...urlToHttpOptions(new URL(input)),
          ...(typeof optionsOrCallback === "object" ? optionsOrCallback : {}),
        }
      : input;
  const onResponse =
    typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
  if (
    options.path?.includes("/requestToken") ||
    options.headers?.Upgrade?.toLowerCase() === "websocket"
  ) {
    return http.request(
      {
        ...options,
        protocol: "http:",
        hostname: origin.hostname,
        port: origin.port,
        agent: false,
        createConnection: undefined,
      },
      onResponse,
    );
  }
  return originalRequest.apply(this, arguments);
};
syncBuiltinESMExports();

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof globalThis.Request ? input.url : input);
  if (url.pathname.endsWith("/requestToken")) {
    return originalFetch(new URL(url.pathname, origin), init);
  }
  return originalFetch(input, init);
};
