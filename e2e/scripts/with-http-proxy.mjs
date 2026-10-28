import { spawn } from "node:child_process";
import { constants } from "node:os";
import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";

const keys = [
  "E2E_HTTP_PROXY_SERVER",
  "E2E_HTTP_PROXY_PORT",
  "E2E_HTTP_PROXY_USERNAME",
  "E2E_HTTP_PROXY_PASSWORD",
];

function upstreamProxy() {
  const values = keys.map((key) => process.env[key] || "");
  if (values.every((value) => value === "")) return;
  if (values.some((value) => value === "")) {
    throw new Error(`Configure all four proxy secrets: ${keys.join(", ")}`);
  }
  const [server, port, username, password] = values;
  if (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > 65535) {
    throw new Error("E2E_HTTP_PROXY_PORT must be between 1 and 65535");
  }
  let url;
  try {
    url = new URL(server.includes("://") ? server : `http://${server}`);
  } catch {
    throw new Error("E2E_HTTP_PROXY_SERVER must be an HTTP proxy hostname");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Proxy server must be an HTTP(S) origin without credentials, port or path",
    );
  }
  url.port = port;
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(password);
  return url.href;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command)
    throw new Error("Usage: with-http-proxy.mjs <command> [arguments...]");
  const upstream = upstreamProxy();
  const environment = { ...process.env };
  // Only the bridge receives upstream credentials. Browser options, traces,
  // reports and child process arguments contain the credential-free local URL.
  for (const key of keys) delete environment[key];
  let localProxy;
  try {
    if (upstream) {
      localProxy = await anonymizeProxy(upstream);
      Object.assign(environment, {
        HTTP_PROXY: localProxy,
        http_proxy: localProxy,
        HTTPS_PROXY: localProxy,
        https_proxy: localProxy,
        ALL_PROXY: localProxy,
        all_proxy: localProxy,
        NO_PROXY: "",
        no_proxy: "",
        NODE_USE_ENV_PROXY: "1",
        AGENT_BROWSER_PROXY: localProxy,
        AGENT_BROWSER_PROXY_BYPASS: "<-loopback>",
        E2E_HTTP_PROXY_URL: localProxy,
      });
    }
    const child = spawn(command, args, { env: environment, stdio: "inherit" });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map((signal) => {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      return handler;
    });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      process.exitCode = result.code ?? 128 + constants.signals[result.signal];
    } finally {
      signals.forEach((signal, index) => process.off(signal, handlers[index]));
    }
  } finally {
    if (localProxy) await closeAnonymizedProxy(localProxy, true);
  }
}

main().catch(() => {
  // Errors from proxy libraries can contain the authenticated upstream URL.
  // Keep the CI failure actionable without publishing credentials or causes.
  console.error(
    "E2E HTTP proxy setup or command launch failed; check the four proxy secrets and command availability.",
  );
  process.exitCode = 1;
});
