import type { CloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";

type References = Pick<CloudflareAccessConfig, "sshHosts" | "vncHosts">;

/** B-to-G API transition; H (#40229) removes omission handling after drain/floor evidence. */
export function privateNetworkVncHosts(config: References) {
  return config.vncHosts ?? [];
}

export function privateNetworkHostCount(config: References) {
  return config.sshHosts.length + privateNetworkVncHosts(config).length;
}
