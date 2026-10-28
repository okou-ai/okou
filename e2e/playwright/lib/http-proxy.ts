import type { LaunchOptions } from "@playwright/test";

/** The wrapper owns upstream authentication; this URL has no credentials. */
export function browserHttpProxy(): LaunchOptions["proxy"] {
  const server = process.env.E2E_HTTP_PROXY_URL;
  return server ? { server, bypass: "<-loopback>" } : undefined;
}
